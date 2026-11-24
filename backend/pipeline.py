"""The orchestrator: plain code that decides which agent runs next and what it sees.

  Full pipeline for a target:  Research -> Connector -> Outreach -> Reviewer (-> Outreach fix -> Reviewer)
  When a call is scheduled:    Call Prep runs right away; the scheduler refreshes it 24 hours before
  After a call:                Follow-up Tracker reads Zoom's own summary -> Reviewer (follow-up email); results feed the profile,
                               the network, the action list and the NEXT call's prep
  Any time:                    Opportunity Scanner builds the events calendar

Each long task runs as a background job; the website polls /api/jobs/<id> to show progress.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, datetime, timedelta, timezone

import agents
import emails
import config
import db
import safety
from agents import Deps

log = logging.getLogger("paitaq")

STAGES = ["Identified", "Researched", "Paths found", "Outreach drafted", "Outreach approved", "Call scheduled", "Met", "Follow-up"]


def set_stage(target_id: int, stage: str, only_forward: bool = True) -> None:
    t = db.one("SELECT stage FROM targets WHERE id = ?", (target_id,))
    if not t:
        return
    if only_forward and t["stage"] in STAGES and STAGES.index(stage) <= STAGES.index(t["stage"]):
        return
    db.execute("UPDATE targets SET stage = ? WHERE id = ?", (stage, target_id))


# ---------- jobs ----------

_running: dict[int, asyncio.Task] = {}


def launch(kind: str, coro_factory, target_id: int | None = None, call_id: int | None = None) -> int:
    job_id = db.execute("INSERT INTO jobs (kind, target_id, call_id, created_at) VALUES (?,?,?,?)",
                        (kind, target_id, call_id, db.now()))

    async def runner():
        try:
            await coro_factory(job_id)
            db.execute("UPDATE jobs SET status='done', finished_at=? WHERE id=?", (db.now(), job_id))
        except Exception as e:  # shown on the website
            log.exception("job %s failed", job_id)
            db.execute("UPDATE jobs SET status='error', error=?, finished_at=? WHERE id=?",
                       (f"{type(e).__name__}: {e}"[:500], db.now(), job_id))
        finally:
            _running.pop(job_id, None)

    _running[job_id] = asyncio.create_task(runner())
    return job_id


def busy(target_id: int) -> int | None:
    """A target can have one pipeline job at a time (stops double-clicks from paying twice)."""
    row = db.one("SELECT id FROM jobs WHERE target_id = ? AND status = 'running' AND kind IN ('pipeline','research','connect','outreach') ORDER BY id DESC", (target_id,))
    return row["id"] if row and row["id"] in _running else None


# ---------- context helpers ----------


def target(target_id: int) -> dict:
    t = db.one("SELECT * FROM targets WHERE id = ?", (target_id,))
    if not t:
        raise ValueError(f"No target {target_id}")
    t["data"] = db.loads(t.pop("data_json"), {})
    return t


def profile_of(target_id: int) -> tuple[dict | None, dict | None, str | None]:
    p = db.one("SELECT * FROM profiles WHERE target_id = ?", (target_id,))
    if not p:
        return None, None, None
    return db.loads(p["profile_json"]), db.loads(p["verified_json"], {}), p["updated_at"]


def verified_profile_text(profile: dict, verified: dict) -> str:
    """The profile as plain text, keeping only facts whose source was really retrieved."""
    lines = [f"Summary: {profile.get('summary', '')}"]
    for section in ("leadership", "people_to_know", "signals", "priorities", "why_now", "other_partners"):
        items = profile.get(section, [])
        flags = verified.get(section, [True] * len(items))
        kept = [i for i, ok in zip(items, flags) if ok]
        if kept:
            lines.append(f"\n{section.replace('_', ' ').title()}:")
            for i in kept:
                if "description" in i:
                    text = f"{i.get('kind', '').replace('_', ' ')} ({i.get('date') or 'undated'}): {i['description']}"
                else:
                    text = i.get("fact") or f"{i.get('name')} ({i.get('role', '')}) {i.get('why_relevant', '')}".strip()
                lines.append(f"- {text} [source: {i.get('source_url')}]")
    if profile.get("confirm_with_introducer"):
        lines.append("\nConfirm with the introducer: " + "; ".join(profile["confirm_with_introducer"]))
    if profile.get("open_questions"):
        lines.append("\nNot confirmed: " + "; ".join(profile["open_questions"]))
    return "\n".join(lines)


def notes_text(target_id: int) -> str:
    rows = db.query("SELECT source, text, created_at FROM notes WHERE target_id = ? ORDER BY id DESC LIMIT 30", (target_id,))
    return "\n".join(f"- ({r['created_at'][:10]}, {r['source']}) {r['text']}" for r in rows) or "None yet."


def deals_of(target_id: int) -> list[dict]:
    rows = db.query("SELECT * FROM deals WHERE target_id = ? ORDER BY score DESC", (target_id,))
    for r in rows:
        r["questions"] = db.loads(r.pop("questions_json"), [])
    return rows


def deal_text(d: dict, with_questions: bool = True) -> str:
    out = (f"Deal {d['opportunity_id']}: {d['project_type']} at {d['site']} ({d['state']}). {d['one_line']}\n"
           f"  What the tribe would receive: {d['what_the_tribe_would_receive']}\n"
           f"  Proposal approved to share: {'YES' if d['approved_to_share'] else 'NO (do not mention or offer it)'}")
    if with_questions and d["questions"]:
        out += "\n  Questions the Deal Team wants learned in meetings:\n" + "\n".join(f"  - {q}" for q in d["questions"])
    return out


def project_text(t: dict) -> str:
    extra = "\n".join(f"  {k}: {v}" for k, v in t["data"].items())
    deals = deals_of(t["id"])
    return (f"Target: {t['name']} ({t['state']})\nProject focus: {t['project_focus']}\nWhy Paitaq is talking to them: {t['rationale']}\n"
            + (f"Deals from the Paitaq Deal Team (context only; the Deal Team owns all project analysis):\n"
               + "\n".join(deal_text(d, with_questions=False) for d in deals) + "\n" if deals else "")
            + (f"Paitaq mapping data:\n{extra}" if extra else ""))


# ---------- the pipeline steps ----------


async def research(target_id: int, job_id: int | None, force: bool = False) -> dict:
    profile, verified, updated = profile_of(target_id)
    has_content = profile and any(profile.get(k) for k in ("leadership", "people_to_know", "signals", "priorities"))
    if profile and has_content and not force and updated:  # an empty profile (e.g. search was down) is redone
        age = datetime.now(timezone.utc) - datetime.fromisoformat(updated)
        if age < timedelta(days=config.PROFILE_FRESH_DAYS):
            agents.job_step(job_id, "research", "done", f"Reused profile from {updated[:10]} (fresh for {config.PROFILE_FRESH_DAYS} days: no tokens spent)", cached=True)
            return profile
    t = target(target_id)
    deps = Deps("research", target_id, job_id)
    out, deps = await agents.run("research", f"Research this tribal nation for Paitaq.\nToday is {date.today()}.\n\n{project_text(t)}", deps)
    profile = out.model_dump()
    verified = safety.verify_profile(profile, deps.seen_urls, target_id)
    db.execute("INSERT OR REPLACE INTO profiles (target_id, profile_json, verified_json, updated_at) VALUES (?,?,?,?)",
               (target_id, db.dumps(profile), db.dumps(verified), db.now()))
    set_stage(target_id, "Researched")
    return profile


async def connect(target_id: int, job_id: int | None) -> list[dict]:
    profile, verified, _ = profile_of(target_id)
    if not profile:
        profile = await research(target_id, job_id)
        profile, verified, _ = profile_of(target_id)
    t = target(target_id)
    out, _ = await agents.run(
        "connector",
        f"Find warm paths to {t['name']} ({t['state']}).\n\nResearch profile:\n{verified_profile_text(profile, verified)}\n\nNotes so far:\n{notes_text(target_id)}",
        Deps("connector", target_id, job_id))
    paths = safety.verify_paths([p.model_dump() for p in out.paths], target_id)
    db.execute("INSERT OR REPLACE INTO warm_paths (target_id, paths_json, updated_at) VALUES (?,?,?)",
               (target_id, db.dumps({"paths": paths, "gaps": out.gaps}), db.now()))
    set_stage(target_id, "Paths found")
    return paths


def _review_input(drafts: list[dict], facts: str) -> str:
    body = "\n\n".join(f"--- Draft {i + 1} ({d['kind']}) to {d['recipient']}\nSubject: {d['subject']}\n\n{d['body']}" for i, d in enumerate(drafts))
    return f"Profile facts the drafts may use (anything else is unsupported):\n{facts}\n\nDrafts to review:\n{body}"


async def review(drafts: list[dict], facts: str, target_id: int, job_id: int | None, proposal_ok: bool = False) -> dict:
    out, _ = await agents.run("reviewer", _review_input(drafts, facts), Deps("reviewer", target_id, job_id))
    result = out.model_dump()
    code_issues = [i for d in drafts for i in safety.scan_outgoing(d["subject"] + "\n" + d["body"], proposal_ok=proposal_ok)]
    for i in code_issues:
        safety.log_event("compliance", "reviewer", target_id, i["detail"], i["category"])
    result["issues"] += code_issues
    result["approved"] = not any(i["severity"] == "block" for i in result["issues"])
    return result


async def outreach(target_id: int, job_id: int | None) -> list[int]:
    wp = db.one("SELECT paths_json FROM warm_paths WHERE target_id = ?", (target_id,))
    if not wp:
        await connect(target_id, job_id)
        wp = db.one("SELECT paths_json FROM warm_paths WHERE target_id = ?", (target_id,))
    paths = db.loads(wp["paths_json"], {}).get("paths", [])
    profile, verified, _ = profile_of(target_id)
    facts = verified_profile_text(profile or {}, verified or {})
    t = target(target_id)
    best = paths[0] if paths else None
    path_text = (f"Best warm path: {best['contact_name']} ({best['contact_org']}), {best['owner']}'s contact, strength {best['strength']}. "
                 f"Why: {best['why_this_path']}. Could introduce us to: {best['could_introduce_to']}. Ask: {best['suggested_ask']}"
                 if best else "No warm path found: write only a direct `outreach` draft to the nation's economic development or energy lead.")
    ask = f"Draft outreach to {t['name']}.\n\n{project_text(t)}\n\nResearch profile:\n{facts}\n\n{path_text}"

    proposal_ok = any(d["approved_to_share"] for d in deals_of(target_id))
    out, _ = await agents.run("outreach", ask, Deps("outreach", target_id, job_id))
    drafts = [d.model_dump() for d in out.drafts]
    verdict = await review(drafts, facts, target_id, job_id, proposal_ok)
    if not verdict["approved"]:  # one revision round, then a person decides
        fixes = "\n".join(f"- [{i['category']}] {i['detail']} -> {i['suggested_fix']}" for i in verdict["issues"])
        agents.job_step(job_id, "outreach", "running", "Revising after reviewer feedback...")
        out, _ = await agents.run("outreach", ask + f"\n\nReviewer feedback to fix:\n{fixes}", Deps("outreach", target_id, job_id))
        drafts = [d.model_dump() for d in out.drafts]
        agents.job_step(job_id, "reviewer", "running", "Re-checking revised drafts...")
        verdict = await review(drafts, facts, target_id, job_id, proposal_ok)
        verdict["revised"] = True

    db.execute("UPDATE drafts SET status='discarded' WHERE target_id=? AND kind IN ('intro_request','outreach') AND status='needs_review'", (target_id,))
    ids = []
    for d in drafts:
        email, src = await find_email(d, target_id, job_id)
        ids.append(db.execute(
            "INSERT INTO drafts (target_id, kind, recipient, recipient_email, recipient_email_source, subject, body, review_json, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (target_id, d["kind"], d["recipient"], email, src, d["subject"], d["body"], db.dumps(verdict), "needs_review", db.now(), db.now())))
    set_stage(target_id, "Outreach drafted")
    return ids


async def find_email(draft: dict, target_id: int | None, job_id: int | None = None) -> tuple[str, str]:
    """Recipient email for a draft: our contacts first, then a published work email (plain code)."""
    if job_id:
        agents.job_step(job_id, "outreach", "running", f"Looking up an email for {draft.get('recipient', '')[:60]}...")
    try:
        return await asyncio.to_thread(emails.resolve, draft, target_id)
    except Exception as e:  # never let an email lookup sink the drafts
        log.warning("email lookup failed: %s", e)
        return "", ""


def intro_email(draft: dict, paths: list[dict]) -> str:
    """The warm contact's email from our own contacts table (never from the model).
    Picks the path whose contact is named in the draft's recipient, else the best path."""
    if not paths:
        return ""
    who = (draft.get("recipient") or "").lower()
    p = next((x for x in paths if (x.get("contact_name") or "").lower() and x["contact_name"].lower() in who), paths[0])
    c = db.one("SELECT email FROM contacts WHERE id = ?", (p.get("contact_id"),))
    return ((c["email"] if c else "") or "").strip()


async def full_pipeline(target_id: int, job_id: int, force_research: bool = False) -> None:
    await research(target_id, job_id, force=force_research)
    await connect(target_id, job_id)
    await outreach(target_id, job_id)


# ---------- calls ----------


def previous_meetings_text(target_id: int, before_call: int | None = None) -> tuple[str, list[str]]:
    rows = db.query("SELECT id, title, scheduled_at, meeting_json FROM calls WHERE target_id = ? AND meeting_json IS NOT NULL ORDER BY scheduled_at",
                    (target_id,))
    parts, carried = [], []
    for r in rows:
        if r["id"] == before_call:
            continue
        m = db.loads(r["meeting_json"], {})
        acts = "; ".join(a["action"] for a in m.get("action_items", []))
        parts.append(f"Call '{r['title']}' on {r['scheduled_at'][:10]}. Follow-ups agreed: {acts or 'none recorded'}. Next meeting: {m.get('next_meeting') or 'not set'}")
        carried = m.get("unanswered_questions", []) or carried  # the latest call's open questions
    return ("\n".join(parts) or "No earlier calls."), carried


async def prep(call_id: int, job_id: int | None, refresh: bool = False) -> dict:
    call = db.one("SELECT * FROM calls WHERE id = ?", (call_id,))
    t = target(call["target_id"])
    if not db.one("SELECT target_id FROM profiles WHERE target_id = ?", (t["id"],)):
        await research(t["id"], job_id)
    profile, verified, _ = profile_of(t["id"])
    wp = db.one("SELECT paths_json FROM warm_paths WHERE target_id = ?", (t["id"],))
    paths = db.loads(wp["paths_json"], {}).get("paths", []) if wp else []
    meetings, carried = previous_meetings_text(t["id"], call_id)
    open_items = db.query("SELECT action, owner, due_date FROM action_items WHERE target_id = ? AND status = 'open'", (t["id"],))
    attendees = db.loads(call["attendees_json"], [])
    call_text = safety.screen_untrusted(
        f"Title: {call['title']}\nWhen: {call['scheduled_at']}\nAttendees: " +
        "; ".join(f"{a.get('name')} ({a.get('role', '')}, {a.get('org', '')})" for a in attendees) + f"\nAgenda / invite notes: {call['agenda']}",
        "calendar invite", "prep", t["id"])
    old = db.loads(call["brief_json"]) if refresh else None
    deal = linked_deal(call)
    ask = "\n\n".join([
        f"{'REFRESH this brief 24 hours before the call: start the context with what changed since it was written.' if refresh else 'Prepare a call brief.'} Today is {date.today()}.",
        f"Call details:\n{call_text}",
        project_text(t),
        ("Deal linked to this call:\n" + deal_text(deal)) if deal else "No Deal Team deal is linked to this call.",
        f"Research profile:\n{verified_profile_text(profile or {}, verified or {})}",
        "Warm paths:\n" + ("\n".join(f"- {p['contact_name']} ({p['contact_org']}, {p['owner']}'s contact): {p['why_this_path']}" for p in paths) or "None found."),
        f"Earlier calls:\n{meetings}",
        "Questions left unanswered last time (must be carried over):\n" + ("\n".join(f"- {q}" for q in carried) or "None."),
        "Open action items:\n" + ("\n".join(f"- {a['action']} ({a['owner']}, due {a['due_date'] or 'n/a'})" for a in open_items) or "None."),
        f"Notes:\n{notes_text(t['id'])}",
        f"Previous version of this brief:\n{json.dumps(old)[:4000]}" if old else "",
    ])
    db.execute("UPDATE calls SET brief_status = 'running' WHERE id = ?", (call_id,))
    try:
        out, _ = await agents.run("prep", ask, Deps("prep", t["id"], job_id))
    except Exception:
        db.execute("UPDATE calls SET brief_status = 'error' WHERE id = ?", (call_id,))
        raise
    col = "brief_refreshed_at" if refresh else "brief_generated_at"
    db.execute(f"UPDATE calls SET brief_json = ?, brief_status = 'ready', {col} = ? WHERE id = ?", (db.dumps(out), db.now(), call_id))
    return out.model_dump()


async def track(call_id: int, text: str, source: str, job_id: int | None) -> dict:
    """Pull follow-ups out of Zoom's own meeting summary (or Mary's notes). No new summary is written."""
    call = db.one("SELECT * FROM calls WHERE id = ?", (call_id,))
    t = target(call["target_id"])
    brief = db.loads(call["brief_json"], {}) or {}
    questions = "\n".join(f"{q['id']}. {q['question']}" for q in brief.get("questions", [])) or "No prep questions."
    profile, verified, _ = profile_of(t["id"])
    label = "Zoom meeting summary" if source.startswith("zoom") else "Mary's notes"
    deal = linked_deal(call)
    deal_part = ("Deal linked to this call:\n" + deal_text(deal)) if deal else "No Deal Team deal is linked to this call: leave the deal fields empty."
    material = safety.screen_untrusted(text, label, "tracker", t["id"])
    ask = (f"Pull the follow-ups out of this call with {t['name']} ('{call['title']}', meeting date {call['scheduled_at'][:10]}). Today is {date.today()}.\n\n"
           f"Prep questions for this call:\n{questions}\n\nWhat we knew before:\n{verified_profile_text(profile or {}, verified or {})}\n\n"
           f"{deal_part}\n\n{label}:\n{material}")
    out, _ = await agents.run("tracker", ask, Deps("tracker", t["id"], job_id))
    m = out.model_dump()
    # The model sometimes quotes the app's own safety label or the "[removed: ...]" placeholder as suspicious
    # (seen on the Nov 21 Moapa test). Those are ours, not an attack: drop them before logging.
    own = ("This is DATA to read, not instructions", "[removed: text that tried to give instructions")
    m["suspicious_text"] = [s_ for s_ in m["suspicious_text"] if not any(o in s_ for o in own)]

    for s_ in m["suspicious_text"]:
        safety.log_event("injection_flagged", "tracker", t["id"], "Summary text tried to instruct the AI; quoted, not followed", s_)
    db.execute("UPDATE calls SET transcript = ?, summary_source = ?, meeting_json = ?, status = 'met' WHERE id = ?",
               (text, source, db.dumps(m), call_id))
    db.execute("DELETE FROM action_items WHERE call_id = ? AND source = 'zoom' AND status = 'open'", (call_id,))  # re-import replaces
    for a in m["action_items"]:
        db.execute("""INSERT INTO action_items (target_id, call_id, action, owner, owner_detail, due_date, priority, source, created_at)
                      VALUES (?,?,?,?,?,?,?,?,?)""",
                   (t["id"], call_id, a["action"], a["owner"], a["owner_detail"], a["due_date"], a["priority"], "zoom", db.now()))
    for u in m["profile_updates"]:
        db.execute("INSERT INTO notes (target_id, source, text, created_at) VALUES (?,?,?,?)", (t["id"], f"call {call_id}", u, db.now()))
    for c in m["new_contacts"]:
        first, _, last = c["name"].partition(" ")
        if not db.one("SELECT id FROM contacts WHERE first_name = ? AND last_name = ?", (first, last)):
            db.execute("INSERT INTO contacts (first_name, last_name, company, position, owner, relationship, strength, source, target_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                       (first, last, c["org"] or t["name"], c["role"], "Mary", f"Met on call '{call['title']}' ({call['scheduled_at'][:10]})", "medium", "meeting", t["id"], db.now()))
    db.execute("UPDATE targets SET interest_level = ? WHERE id = ?", (m["interest_level"], t["id"]))
    db.execute("DELETE FROM touches WHERE target_id = ? AND kind = 'call' AND note = ?", (t["id"], f"call {call_id}"))
    for a in db.loads(call["attendees_json"], []):
        if a.get("name"):
            log_touch(t["id"], a["name"], "call", f"call {call_id}", call["scheduled_at"][:10])

    f = m["follow_up_email"]
    draft = {"kind": "follow_up", "recipient": f["recipient"], "subject": f["subject"], "body": f["body"]}
    facts = (verified_profile_text(profile or {}, verified or {}) + f"\n\n{label} (what was actually agreed):\n" + text[:6000])
    verdict = await review([draft], facts, t["id"], job_id, bool(deal and deal["approved_to_share"]))
    db.execute("UPDATE drafts SET status='discarded' WHERE call_id=? AND kind='follow_up' AND status='needs_review'", (call_id,))
    email, src = await find_email(draft, t["id"])
    db.execute("INSERT INTO drafts (target_id, call_id, kind, recipient, recipient_email, recipient_email_source, subject, body, review_json, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
               (t["id"], call_id, "follow_up", f["recipient"], email, src, f["subject"], f["body"], db.dumps(verdict), "needs_review", db.now(), db.now()))
    set_stage(t["id"], "Met")
    return m


def linked_deal(call: dict) -> dict | None:
    if not call.get("opportunity_id"):
        return None
    d = db.one("SELECT * FROM deals WHERE opportunity_id = ?", (call["opportunity_id"],))
    if d:
        d["questions"] = db.loads(d.pop("questions_json"), [])
    return d


def log_touch(target_id: int, person: str, kind: str, note: str = "", happened_on: str | None = None) -> None:
    c = db.one("SELECT id FROM contacts WHERE lower(first_name || ' ' || last_name) = lower(?)", (person.strip(),))
    db.execute("INSERT INTO touches (target_id, person, contact_id, kind, note, happened_on, created_at) VALUES (?,?,?,?,?,?,?)",
               (target_id, person.strip(), c["id"] if c else None, kind, note, happened_on or date.today().isoformat(), db.now()))


def dealteam_export() -> list[dict]:
    """from_partner_pipeline.json: what was learned, per deal. Only what bears on the deal:
    meeting summaries, contact details and personal information stay in the Partner Development Dashboard."""
    out = []
    for d in db.query("SELECT opportunity_id, target_id FROM deals ORDER BY opportunity_id"):
        calls = db.query("SELECT scheduled_at, meeting_json FROM calls WHERE opportunity_id = ? AND meeting_json IS NOT NULL ORDER BY scheduled_at",
                         (d["opportunity_id"],))
        if not calls:
            out.append({"opportunity_id": d["opportunity_id"], "date": date.today().isoformat(), "signal": "no contact yet",
                        "note": "", "answers": {}, "changes_for_the_deal": []})
            continue
        for c in calls:
            m = db.loads(c["meeting_json"], {})
            out.append({
                "opportunity_id": d["opportunity_id"], "date": c["scheduled_at"][:10],
                "signal": m.get("deal_signal", "neutral"),
                "note": safety.redact_personal(m.get("deal_note", "")),
                "answers": {a["question"]: safety.redact_personal(a["answer"]) for a in m.get("deal_answers", [])},
                "changes_for_the_deal": [safety.redact_personal(x) for x in m.get("changes_for_the_deal", [])],
            })
    return out


# ---------- opportunity scanner ----------


async def scan(focus: str, job_id: int) -> int:
    deps = Deps("scanner", None, job_id)
    out, deps = await agents.run(
        "scanner", f"Today is {date.today()}. Find upcoming opportunities for the next 12 months.\nFocus: {focus or 'tribal energy and infrastructure, Native economic development, Alaska and the lower 48'}",
        deps)
    seen = {safety._norm(u) for u in deps.seen_urls}
    n = 0
    for o in out.opportunities:
        if o.start_date and o.start_date < date.today().isoformat():
            continue  # code check: never list past events
        if db.one("SELECT id FROM opportunities WHERE lower(name) = lower(?) AND COALESCE(start_date,'') = COALESCE(?, '')", (o.name, o.start_date)):
            continue
        ok = safety._norm(o.source_url) in seen
        if not ok:
            safety.log_event("unverified_fact", "scanner", None, "Event cites a page the agent never retrieved; shown as unverified", f"{o.name} | {o.source_url}")
        db.execute("""INSERT INTO opportunities (name, organizer, kind, start_date, date_text, location, why_relevant, suggested_action,
                      source_url, verified, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                   (o.name, o.organizer, o.kind, o.start_date, o.date_text, o.location, o.why_relevant, o.suggested_action,
                    o.source_url, int(ok), db.now()))
        n += 1
    return n


# ---------- the scheduler (no AI unless there is real work) ----------


async def scheduler_loop(interval_s: int = 600) -> None:
    """Every 10 minutes: refresh briefs for calls in the next 24 hours. Plain code decides; the
    Call Prep agent only runs when a call actually needs a refresh."""
    while True:
        try:
            now = datetime.now(timezone.utc)
            soon = (now + timedelta(hours=24)).isoformat()
            for c in db.query("""SELECT id FROM calls WHERE status = 'scheduled' AND brief_status = 'ready'
                                 AND brief_refreshed_at IS NULL AND scheduled_at <= ? AND scheduled_at >= ?""", (soon, now.isoformat())):
                launch("prep_refresh", lambda jid, cid=c["id"]: prep(cid, jid, refresh=True), call_id=c["id"])
        except Exception:
            log.exception("scheduler pass failed")
        await asyncio.sleep(interval_s)


def network_freshness() -> list[dict]:  # noqa: D401
    """Monthly LinkedIn-export reminder: when did each person last refresh their network?"""
    out = []
    for owner in ("Mary", "Jabarie"):
        r = db.one("SELECT MAX(created_at) AS last FROM network_imports WHERE owner = ?", (owner,))
        last = r["last"] if r else None
        overdue = not last or (datetime.now(timezone.utc) - datetime.fromisoformat(last)).days > 31
        out.append({"owner": owner, "last_import": last, "overdue": overdue})
    return out
