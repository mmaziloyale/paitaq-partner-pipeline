"""SQLite storage: targets, contacts, research profiles, drafts, calls, action items,
opportunities, agent runs (tokens + cost) and safety events.

The database file is created on first run and seeded from the CSVs in data/sample/
(or the files named in .env). Delete data/paitaq.db to start fresh.
"""

from __future__ import annotations

import csv
import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import config

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    state TEXT DEFAULT '',
    region TEXT DEFAULT '',
    project_focus TEXT DEFAULT '',
    rationale TEXT DEFAULT '',
    rank_score REAL,
    data_json TEXT DEFAULT '{}',        -- every other column from the mapping / ranker export
    stage TEXT DEFAULT 'Identified',
    interest_level INTEGER,             -- 1-5, set by the Follow-up Tracker after calls
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT, last_name TEXT, company TEXT, position TEXT,
    url TEXT DEFAULT '', email TEXT DEFAULT '',
    owner TEXT DEFAULT 'Mary',          -- whose relationship this is
    relationship TEXT DEFAULT '',       -- how we know them
    strength TEXT DEFAULT '',           -- strong / medium / weak (optional)
    source TEXT DEFAULT 'import',       -- import / linkedin / meeting / manual
    connected_on TEXT DEFAULT '',
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS network_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT, rows INTEGER, filename TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS profiles (
    target_id INTEGER PRIMARY KEY, profile_json TEXT, verified_json TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS warm_paths (
    target_id INTEGER PRIMARY KEY, paths_json TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, target_id INTEGER, source TEXT, text TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id INTEGER, call_id INTEGER,
    kind TEXT,                          -- intro_request / outreach / follow_up
    recipient TEXT, recipient_email TEXT DEFAULT '', subject TEXT, body TEXT,
    review_json TEXT DEFAULT '{}',
    status TEXT DEFAULT 'needs_review', -- needs_review / approved / sent / discarded
    created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id INTEGER, title TEXT, scheduled_at TEXT,
    attendees_json TEXT DEFAULT '[]', agenda TEXT DEFAULT '',
    consent_to_record INTEGER DEFAULT 0,
    brief_json TEXT, brief_status TEXT DEFAULT 'pending', brief_generated_at TEXT, brief_refreshed_at TEXT,
    transcript TEXT,                    -- Zoom's own meeting summary (or Mary's notes), stored as given
    summary_source TEXT,                -- zoom_paste / zoom_api / notes
    zoom_meeting_id TEXT,
    meeting_json TEXT,                  -- follow-ups extracted from it
    status TEXT DEFAULT 'scheduled',
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS action_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id INTEGER, call_id INTEGER, action TEXT, owner TEXT, owner_detail TEXT DEFAULT '', due_date TEXT,
    priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'open',
    source TEXT DEFAULT 'zoom',         -- zoom / manual
    completed_at TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS opportunities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, organizer TEXT, kind TEXT, start_date TEXT, date_text TEXT, location TEXT,
    why_relevant TEXT, suggested_action TEXT, source_url TEXT, verified INTEGER DEFAULT 0,
    status TEXT DEFAULT 'new', created_at TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT, target_id INTEGER, call_id INTEGER,
    status TEXT DEFAULT 'running',      -- running / done / error
    steps_json TEXT DEFAULT '[]', error TEXT, created_at TEXT, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER, agent TEXT, target_id INTEGER, model TEXT,
    input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER,
    requests INTEGER, tool_calls INTEGER, cost_usd REAL, duration_ms INTEGER,
    ok INTEGER DEFAULT 1, error TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS safety_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT,                          -- injection_blocked / unverified_fact / invented_contact / budget / compliance / consent / ...
    agent TEXT, target_id INTEGER, detail TEXT, evidence TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS deals (          -- from the Deal Team's to_partner_pipeline.json
    opportunity_id TEXT PRIMARY KEY, target_id INTEGER, nation TEXT, site TEXT, state TEXT, project_type TEXT,
    size TEXT, score REAL, stage TEXT, one_line TEXT, what_the_tribe_would_receive TEXT,
    questions_json TEXT DEFAULT '[]', proposal_file TEXT, approved_to_share INTEGER DEFAULT 0, imported_at TEXT
);
CREATE TABLE IF NOT EXISTS touches (        -- every contact with someone at (or about) a nation
    id INTEGER PRIMARY KEY AUTOINCREMENT, target_id INTEGER, person TEXT, contact_id INTEGER,
    kind TEXT,                              -- call / email / intro / event / other
    note TEXT DEFAULT '', happened_on TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS snoozes (
    key TEXT PRIMARY KEY, until TEXT
);
CREATE TABLE IF NOT EXISTS search_cache (
    query TEXT PRIMARY KEY, results_json TEXT, created_at TEXT
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def query(sql: str, params: tuple = ()) -> list[dict]:
    with _lock, connect() as conn:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]


def one(sql: str, params: tuple = ()) -> dict | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params: tuple = ()) -> int:
    with _lock, connect() as conn:
        cur = conn.execute(sql, params)
        conn.commit()
        return cur.lastrowid


def loads(text: str | None, default: Any = None) -> Any:
    if not text:
        return default
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return default


def dumps(obj: Any) -> str:
    if hasattr(obj, "model_dump"):
        obj = obj.model_dump()
    return json.dumps(obj, ensure_ascii=False)


# ---------- seeding ----------

TARGET_FIELDS = {"name", "state", "region", "project_focus", "rationale", "rank_score"}
NAME_KEYS = ("name", "tribe", "tribe_name", "nation", "tribal_nation", "aiannh_name", "namelsad")


def _pick(row: dict, keys: tuple[str, ...]) -> str:
    low = {k.strip().lower(): (v or "").strip() for k, v in row.items() if k}
    for k in keys:
        if low.get(k):
            return low[k]
    return ""


def import_targets_csv(path: Path) -> int:
    """Load a target list. Works with the Paitaq mapping/ranker export: any column it doesn't
    know is kept in data_json and shown to the agents as project data."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    n = 0
    for row in rows:
        name = _pick(row, NAME_KEYS)
        if not name:
            continue
        low = {k.strip().lower(): (v or "").strip() for k, v in row.items() if k}
        score = low.get("rank_score") or low.get("score") or ""
        extra = {k: v for k, v in low.items() if k not in TARGET_FIELDS and k not in NAME_KEYS and v}
        execute(
            "INSERT INTO targets (name, state, region, project_focus, rationale, rank_score, data_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (name, low.get("state", ""), low.get("region", ""), low.get("project_focus", ""), low.get("rationale", ""),
             float(score) if score.replace(".", "", 1).isdigit() else None, json.dumps(extra), now()),
        )
        n += 1
    return n


def import_dealteam_json(text: str) -> dict:
    """Load the Deal Team's to_partner_pipeline.json: the deals to pursue, ranked.
    Creates or updates one target per nation and one row per opportunity."""
    data = json.loads(text)
    rows = data if isinstance(data, list) else (data.get("deals") or data.get("opportunities") or [])
    added = updated = 0
    for d in rows:
        oid, nation = str(d.get("opportunity_id") or "").strip(), (d.get("nation") or "").strip()
        if not oid or not nation:
            continue
        t = one("SELECT id FROM targets WHERE lower(name) = lower(?)", (nation,))
        tid = t["id"] if t else execute(
            "INSERT INTO targets (name, state, project_focus, rationale, rank_score, data_json, created_at) VALUES (?,?,?,?,?,?,?)",
            (nation, d.get("state", ""), d.get("project_type", ""), d.get("one_line", ""), d.get("score"), "{}", now()))
        existed = one("SELECT opportunity_id FROM deals WHERE opportunity_id = ?", (oid,))
        execute("""INSERT OR REPLACE INTO deals (opportunity_id, target_id, nation, site, state, project_type, size, score, stage, one_line,
                   what_the_tribe_would_receive, questions_json, proposal_file, approved_to_share, imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (oid, tid, nation, d.get("site", ""), d.get("state", ""), d.get("project_type", ""), str(d.get("size", "")),
                 d.get("score"), d.get("stage", ""), d.get("one_line", ""), d.get("what_the_tribe_would_receive", ""),
                 json.dumps(d.get("questions_to_learn_in_meetings") or []), d.get("proposal_file", ""),
                 1 if d.get("approved_to_share") is True else 0, now()))
        best = one("SELECT MAX(score) AS s, GROUP_CONCAT(DISTINCT project_type) AS p FROM deals WHERE target_id = ?", (tid,))
        top = one("SELECT one_line FROM deals WHERE target_id = ? ORDER BY score DESC LIMIT 1", (tid,))
        execute("UPDATE targets SET rank_score = ?, project_focus = ?, rationale = ? WHERE id = ?",
                (best["s"], best["p"] or "", top["one_line"] if top else "", tid))
        updated += bool(existed)
        added += not existed
    return {"added": added, "updated": updated}


def import_contacts_csv(path_or_text: Path | str, owner: str | None = None, source: str = "import", filename: str = "") -> int:
    """Load contacts. Accepts LinkedIn's Connections.csv as downloaded (it has a few note lines
    above the header) or a plain CSV with first_name, last_name, company, position, ..."""
    text = path_or_text.read_text(encoding="utf-8-sig") if isinstance(path_or_text, Path) else path_or_text
    lines = text.splitlines()
    start = next((i for i, l in enumerate(lines) if l.lower().replace(" ", "_").startswith("first_name")), 0)
    reader = csv.DictReader(lines[start:])
    n = 0
    for row in reader:
        low = {(k or "").strip().lower().replace(" ", "_"): (v or "").strip() for k, v in row.items()}
        if not (low.get("first_name") or low.get("last_name")):
            continue
        execute(
            """INSERT INTO contacts (first_name, last_name, company, position, url, email, owner, relationship, strength,
               source, connected_on, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (low.get("first_name", ""), low.get("last_name", ""), low.get("company", ""), low.get("position", ""),
             low.get("url", ""), low.get("email_address", "") or low.get("email", ""), owner or low.get("owner") or "Mary",
             low.get("relationship", ""), low.get("strength", ""), "linkedin" if start else source,
             low.get("connected_on", ""), now()),
        )
        n += 1
    owners = {owner} if owner else {r["owner"] for r in query("SELECT DISTINCT owner FROM contacts")}
    for o in owners:
        execute("INSERT INTO network_imports (owner, rows, filename, created_at) VALUES (?,?,?,?)", (o, n, filename, now()))
    return n


MIGRATIONS = [  # columns added after v1; safe to re-run
    "ALTER TABLE calls ADD COLUMN summary_source TEXT",
    "ALTER TABLE calls ADD COLUMN zoom_meeting_id TEXT",
    "ALTER TABLE action_items ADD COLUMN owner_detail TEXT DEFAULT ''",
    "ALTER TABLE action_items ADD COLUMN source TEXT DEFAULT 'zoom'",
    "ALTER TABLE action_items ADD COLUMN completed_at TEXT",
    "ALTER TABLE calls ADD COLUMN opportunity_id TEXT",
    "ALTER TABLE contacts ADD COLUMN target_id INTEGER",
    "ALTER TABLE drafts ADD COLUMN recipient_email_source TEXT DEFAULT ''",
]


def init() -> None:
    with _lock, connect() as conn:
        conn.executescript(SCHEMA)
        for m in MIGRATIONS:
            try:
                conn.execute(m)
            except sqlite3.OperationalError:
                pass  # column already there
        # Dollar costs always follow pricing.json: re-price every logged run from its token counts,
        # so a price update (e.g. replacing placeholder prices) applies to past runs too.
        p = config.pricing()
        conn.execute("""UPDATE agent_runs SET cost_usd = ((MAX(input_tokens - cached_input_tokens, 0) * ?)
                        + (cached_input_tokens * ?) + (output_tokens * ?)) / 1000000.0""",
                     (p["input_per_m"], p["cached_input_per_m"], p["output_per_m"]))
        conn.commit()
    if not one("SELECT id FROM targets LIMIT 1"):
        if config.DEALTEAM_JSON.exists():
            import_dealteam_json(config.DEALTEAM_JSON.read_text(encoding="utf-8"))
        elif config.TARGETS_CSV.exists():
            import_targets_csv(config.TARGETS_CSV)
    if not one("SELECT id FROM contacts LIMIT 1") and config.CONTACTS_CSV.exists():
        import_contacts_csv(config.CONTACTS_CSV, filename=config.CONTACTS_CSV.name)
