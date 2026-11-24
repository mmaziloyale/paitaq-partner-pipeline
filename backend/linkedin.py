"""Optional LinkedIn window: the app's OWN browser, separate from your everyday Chrome.

Off by default. Turn it on with LINKEDIN_BROWSER=1 in .env and install the extra package:

    pip install -r requirements-linkedin.txt
    python -m playwright install chromium        # skip if LINKEDIN_BROWSER_CHANNEL=chrome

What it does
- "Open LinkedIn window" (Network page) starts a browser with its own profile folder
  (data/linkedin-browser/, never committed). You sign in yourself; the app never sees or
  stores your password. The sign-in stays saved in that folder for next time.
- While it is open and signed in, the connector agent gets one extra tool:
  search your 1st-degree LinkedIn connections by keyword (e.g. "Navajo energy").
  People it finds are added to the Network (source "linkedin_browser") so the
  "never invent a contact" check still works.

What it never does
- Send messages, connection requests, likes or anything else. It only reads search results.
- Run more than MAX_LOOKUPS searches per agent run, or faster than one every few seconds.
  LinkedIn restricts automated use, so keep this light; the monthly Connections.csv export
  remains the main way to load a network.

All Playwright calls run on one dedicated thread (Playwright's sync API is tied to the
thread that started it), so the FastAPI server and the agents can call it from anywhere.
"""

from __future__ import annotations

import concurrent.futures
import os
import random
import time
import urllib.parse

import config
import db

MAX_LOOKUPS = 3              # per agent run
MIN_SECONDS_BETWEEN = 4.0    # pacing between LinkedIn page loads
PROFILE_DIR = config.DATA / "linkedin-browser"
SOURCE = "linkedin_browser"

_pool = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="linkedin")
_state: dict = {"pw": None, "ctx": None, "page": None, "last_load": 0.0, "error": ""}


def enabled() -> bool:
    return os.getenv("LINKEDIN_BROWSER", "").strip().lower() in ("1", "true", "yes", "on")


def installed() -> bool:
    try:
        import playwright  # noqa: F401
        return True
    except ImportError:
        return False


def _on_thread(fn, *args, timeout: float = 90):
    return _pool.submit(fn, *args).result(timeout=timeout)


# ---------- everything below the line runs on the linkedin thread ----------

def _is_open() -> bool:
    ctx = _state["ctx"]
    if ctx is None:
        return False
    try:
        _ = ctx.pages  # raises if the browser was closed by the user
        return True
    except Exception:
        _state.update(ctx=None, page=None)
        return False


def _signed_in() -> bool:
    if not _is_open():
        return False
    try:
        return any(c["name"] == "li_at" for c in _state["ctx"].cookies("https://www.linkedin.com"))
    except Exception:
        return False


def _page():
    ctx = _state["ctx"]
    pages = [p for p in ctx.pages if not p.is_closed()]
    if pages:
        return pages[0]
    return ctx.new_page()


def _open() -> None:
    if _is_open():
        _page().bring_to_front()
        return
    from playwright.sync_api import sync_playwright
    if _state["pw"] is None:
        _state["pw"] = sync_playwright().start()
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    kwargs = dict(user_data_dir=str(PROFILE_DIR), headless=False, viewport=None)
    channel = os.getenv("LINKEDIN_BROWSER_CHANNEL", "").strip()  # "chrome" = use installed Chrome, own profile
    try:
        ctx = _state["pw"].chromium.launch_persistent_context(**kwargs, **({"channel": channel} if channel else {}))
    except Exception:
        if not channel:
            raise
        ctx = _state["pw"].chromium.launch_persistent_context(**kwargs)  # fall back to Playwright's Chromium
    _state["ctx"] = ctx
    try:  # the window is open either way; a slow or failed first page load isn't fatal
        _page().goto("https://www.linkedin.com/feed/" if _signed_in() else "https://www.linkedin.com/login",
                     wait_until="domcontentloaded", timeout=30_000)
    except Exception as e:  # noqa: BLE001
        _state["error"] = f"Opened the window, but LinkedIn didn't load: {e}"[:300]


def _close() -> None:
    if _state["ctx"] is not None:
        try:
            _state["ctx"].close()
        except Exception:
            pass
    _state.update(ctx=None, page=None, error="")


def _status() -> dict:
    is_open = _is_open()
    return {"enabled": enabled(), "installed": installed(), "open": is_open,
            "signed_in": _signed_in() if is_open else False, "error": _state["error"]}


EXTRACT_JS = r"""
() => {
  const out = [], seen = new Set();
  for (const a of document.querySelectorAll('main a[href*="/in/"]')) {
    const url = a.href.split('?')[0];
    if (seen.has(url)) continue;
    const card = a.closest('li') || a.closest('div[data-chameleon-result-urn]') || a.parentElement;
    const lines = (card?.innerText || '').split('\n').map(s => s.trim())
      .filter(s => s && !/^(Connect|Message|Follow|View .*profile|•|1st|2nd|3rd\+?|Status is .*)$/i.test(s));
    if (!lines.length) continue;
    seen.add(url);
    out.push({ name: lines[0], headline: lines[1] || '', location: lines[2] || '', url });
    if (out.length >= 10) break;
  }
  return out;
}
"""


def _search(words: str) -> list[dict]:
    if not _signed_in():
        raise RuntimeError("The LinkedIn window isn't open and signed in.")
    wait = MIN_SECONDS_BETWEEN - (time.time() - _state["last_load"])
    if wait > 0:
        time.sleep(wait + random.uniform(0.5, 1.5))
    q = urllib.parse.quote(words)
    page = _page()
    page.goto(f"https://www.linkedin.com/search/results/people/?keywords={q}&network=%5B%22F%22%5D",
              wait_until="domcontentloaded")
    _state["last_load"] = time.time()
    page.wait_for_timeout(2500)
    if "/login" in page.url or "/authwall" in page.url or "/checkpoint" in page.url:
        raise RuntimeError("LinkedIn asked to sign in again. Sign in in the LinkedIn window, then rerun.")
    return page.evaluate(EXTRACT_JS)


# ---------- public API (safe to call from any thread) ----------

def status() -> dict:
    if not (enabled() and installed()):
        return {"enabled": enabled(), "installed": installed(), "open": False, "signed_in": False, "error": ""}
    try:
        return _on_thread(_status, timeout=10)
    except Exception as e:  # noqa: BLE001
        return {"enabled": True, "installed": True, "open": False, "signed_in": False, "error": str(e)}


def open_window() -> dict:
    if not enabled():
        raise RuntimeError("Turned off. Add LINKEDIN_BROWSER=1 to .env and restart.")
    if not installed():
        raise RuntimeError("Playwright isn't installed. Run: pip install -r requirements-linkedin.txt "
                           "&& python -m playwright install chromium")
    try:
        _state["error"] = ""
        _on_thread(_open)
    except Exception as e:  # noqa: BLE001
        _state["error"] = str(e)
        raise RuntimeError(f"Couldn't start the LinkedIn window: {e}") from e
    return status()


def close_window() -> dict:
    if enabled() and installed():
        _on_thread(_close, timeout=20)
    return status()


def ready() -> bool:
    """True when the connector agent may use LinkedIn this run."""
    return enabled() and installed() and status()["signed_in"]


def _split_name(name: str) -> tuple[str, str]:
    parts = name.split()
    return (parts[0], " ".join(parts[1:])) if parts else ("", "")


def search_connections(words: str, owner: str | None = None) -> list[dict]:
    """Search 1st-degree connections; save each person to contacts; return rows with contact ids."""
    owner = owner or os.getenv("LINKEDIN_OWNER", "Mary")
    people = _on_thread(_search, words)
    rows = []
    for p in people:
        first, last = _split_name(p["name"])
        if not first:
            continue
        existing = db.one("SELECT id FROM contacts WHERE url = ? AND url != ''", (p["url"],)) or \
            db.one("SELECT id FROM contacts WHERE first_name = ? AND last_name = ? AND owner = ?", (first, last, owner))
        if existing:
            db.execute("UPDATE contacts SET position = CASE WHEN position = '' THEN ? ELSE position END, "
                       "url = CASE WHEN url = '' THEN ? ELSE url END WHERE id = ?", (p["headline"], p["url"], existing["id"]))
            cid = existing["id"]
        else:
            cid = db.execute(
                """INSERT INTO contacts (first_name, last_name, company, position, url, owner, relationship, source, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (first, last, "", p["headline"], p["url"], owner,
                 f"1st-degree LinkedIn connection of {owner}" + (f" ({p['location']})" if p["location"] else ""), SOURCE, db.now()))
        rows.append({"contact_id": cid, "name": p["name"], "headline": p["headline"], "location": p["location"], "owner": owner})
    return rows
