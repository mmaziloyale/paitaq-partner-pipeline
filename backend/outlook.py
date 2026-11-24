"""Optional: show Mary's Outlook calendar next to the calls booked in the app, and
export any booked call as an .ics file that opens straight into Outlook.

Read-only by design: the app never writes to Outlook and never sends invites.

To turn it on, publish the Outlook calendar and put its ICS link in .env:

    OUTLOOK_ICS_URL=https://outlook.office365.com/owa/calendar/.../calendar.ics
    OUTLOOK_TZ=America/New_York      # optional: used when an event has no usable time zone

(Outlook on the web: Settings > Calendar > Shared calendars > Publish a calendar >
pick the calendar and "Can view all details" (or "Can view titles and locations") >
Publish > copy the ICS link. Some company Microsoft 365 accounts turn publishing off.)

Without it, the calendar view shows only the calls booked in the app.
No extra library is needed. If python-dateutil is installed, recurring meetings are
expanded; otherwise only the first occurrence of a recurring series is shown.
"""

from __future__ import annotations

import os
import time
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import httpx

try:  # optional, for recurring meetings
    from dateutil.rrule import rrulestr
except Exception:  # pragma: no cover
    rrulestr = None

_cache: dict = {}
CACHE_SECONDS = 300

# Outlook writes Windows time-zone names; map the common ones to IANA names.
WINDOWS_TZ = {
    "Eastern Standard Time": "America/New_York", "US Eastern Standard Time": "America/Indiana/Indianapolis",
    "Central Standard Time": "America/Chicago", "Mountain Standard Time": "America/Denver",
    "US Mountain Standard Time": "America/Phoenix", "Pacific Standard Time": "America/Los_Angeles",
    "Alaskan Standard Time": "America/Anchorage", "Aleutian Standard Time": "America/Adak",
    "Hawaiian Standard Time": "Pacific/Honolulu", "Atlantic Standard Time": "America/Halifax",
    "GMT Standard Time": "Europe/London", "Greenwich Standard Time": "Atlantic/Reykjavik",
    "W. Europe Standard Time": "Europe/Berlin", "Romance Standard Time": "Europe/Paris",
    "Central European Standard Time": "Europe/Warsaw", "UTC": "UTC", "Coordinated Universal Time": "UTC",
}


def configured() -> bool:
    return bool(os.getenv("OUTLOOK_ICS_URL", "").strip())


def _default_tz() -> ZoneInfo:
    try:
        return ZoneInfo(os.getenv("OUTLOOK_TZ", "America/New_York"))
    except Exception:
        return ZoneInfo("America/New_York")


def _tz(name: str | None) -> ZoneInfo:
    if not name:
        return _default_tz()
    name = name.strip('"')
    for candidate in (WINDOWS_TZ.get(name), name):
        if candidate:
            try:
                return ZoneInfo(candidate)
            except Exception:
                pass
    return _default_tz()


def _unescape(v: str) -> str:
    return v.replace("\\n", " ").replace("\\N", " ").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\").strip()


def _lines(text: str) -> list[str]:
    out: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and out:
            out[-1] += raw[1:]
        elif raw:
            out.append(raw)
    return out


def _split(line: str) -> tuple[str, dict, str]:
    head, _, value = line.partition(":")
    name, *params = head.split(";")
    p = {}
    for x in params:
        k, _, v = x.partition("=")
        p[k.upper()] = v
    return name.upper(), p, value


def _dt(value: str, params: dict) -> tuple[datetime, bool]:
    """Returns (aware datetime, all_day)."""
    value = value.strip()
    if params.get("VALUE") == "DATE" or len(value) == 8:
        d = datetime.strptime(value[:8], "%Y%m%d")
        return d.replace(tzinfo=_default_tz()), True
    if value.endswith("Z"):
        return datetime.strptime(value[:15], "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc), False
    return datetime.strptime(value[:15], "%Y%m%dT%H%M%S").replace(tzinfo=_tz(params.get("TZID"))), False


def parse_ics(text: str) -> list[dict]:
    """Raw VEVENTs: uid, title, location, start, end, all_day, rrule, exdates, recurrence_id."""
    events, cur, depth = [], None, 0
    for line in _lines(text):
        name, params, value = _split(line)
        if name == "BEGIN" and value.upper() == "VEVENT":
            cur, depth = {"exdates": []}, 0
        elif name == "BEGIN" and cur is not None:
            depth += 1  # e.g. VALARM inside the event
        elif name == "END" and cur is not None:
            if depth:
                depth -= 1
            elif value.upper() == "VEVENT":
                if "start" in cur and cur.get("status") != "CANCELLED":
                    events.append(cur)
                cur = None
        elif cur is not None and not depth:
            try:
                if name == "UID":
                    cur["uid"] = value
                elif name == "SUMMARY":
                    cur["title"] = _unescape(value)
                elif name == "LOCATION":
                    cur["location"] = _unescape(value)
                elif name == "STATUS":
                    cur["status"] = value.upper()
                elif name == "DTSTART":
                    cur["start"], cur["all_day"] = _dt(value, params)
                elif name == "DTEND":
                    cur["end"], _ = _dt(value, params)
                elif name == "RRULE":
                    cur["rrule"] = value
                elif name == "EXDATE":
                    cur["exdates"] += [_dt(v, params)[0] for v in value.split(",") if v]
                elif name == "RECURRENCE-ID":
                    cur["recurrence_id"], _ = _dt(value, params)
            except ValueError:
                continue
    return events


def _expand(events: list[dict], start: datetime, end: datetime) -> list[dict]:
    overrides = {(e.get("uid"), e["recurrence_id"]) for e in events if e.get("recurrence_id")}
    out = []
    for e in events:
        dur = (e.get("end") or e["start"] + (timedelta(days=1) if e.get("all_day") else timedelta(hours=1))) - e["start"]
        starts = [e["start"]]
        if e.get("rrule") and not e.get("recurrence_id") and rrulestr is not None:
            try:
                rule = rrulestr(e["rrule"], dtstart=e["start"])
                ex = set(e["exdates"])
                starts = [s for s in rule.between(start - dur, end, inc=True)
                          if s not in ex and (e.get("uid"), s) not in overrides]
            except Exception:
                pass
        for s in starts:
            if s < end and s + dur > start:
                out.append({"source": "outlook", "title": e.get("title") or "(busy)", "location": e.get("location", ""),
                            "start": s.isoformat(), "end": (s + dur).isoformat(), "all_day": bool(e.get("all_day"))})
    return out


def events(start: datetime, end: datetime) -> list[dict]:
    """Outlook events overlapping [start, end). Cached for five minutes."""
    url = os.getenv("OUTLOOK_ICS_URL", "").strip()
    if not url:
        return []
    if url.startswith("webcal://"):
        url = "https://" + url[len("webcal://"):]
    if _cache.get("url") != url or _cache.get("at", 0) < time.time() - CACHE_SECONDS:
        r = httpx.get(url, timeout=20, follow_redirects=True)
        r.raise_for_status()
        _cache.update(url=url, at=time.time(), events=parse_ics(r.text))
    return sorted(_expand(_cache["events"], start, end), key=lambda e: e["start"])


# ---------- export one booked call as .ics (opens in Outlook; nothing is sent) ----------


def _esc(v: str) -> str:
    return (v or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def _fold(line: str) -> str:
    out, b = [], line.encode()
    while len(b) > 74:
        cut = 74
        while (b[cut] & 0xC0) == 0x80:  # don't split a UTF-8 character
            cut -= 1
        out.append(b[:cut].decode())
        b = b[cut:]
    out.append(b.decode())
    return "\r\n ".join(out)


def call_ics(call: dict, minutes: int = 45) -> str:
    start = datetime.fromisoformat(call["scheduled_at"]).astimezone(timezone.utc)
    end = start + timedelta(minutes=minutes)
    fmt = "%Y%m%dT%H%M%SZ"
    who = ", ".join(a.get("name", "") + (f" ({a['role']})" if a.get("role") else "") for a in call.get("attendees", []) if a.get("name"))
    goal = (call.get("brief") or {}).get("call_goal", "")
    desc = "\n".join(x for x in [f"Call goal: {goal}" if goal else "", f"Attendees: {who}" if who else "", call.get("agenda", ""),
                                  f"Brief: http://localhost:8000/calls/{call['id']}"] if x)
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Paitaq Capital//Partner Development Dashboard//EN", "METHOD:PUBLISH",
             "BEGIN:VEVENT", f"UID:paitaq-call-{call['id']}@paitaq.local", f"DTSTAMP:{datetime.now(timezone.utc).strftime(fmt)}",
             f"DTSTART:{start.strftime(fmt)}", f"DTEND:{end.strftime(fmt)}",
             f"SUMMARY:{_esc(call.get('target_name', ''))}: {_esc(call.get('title', ''))}", f"DESCRIPTION:{_esc(desc)}",
             "END:VEVENT", "END:VCALENDAR"]
    return "\r\n".join(_fold(x) for x in lines) + "\r\n"
