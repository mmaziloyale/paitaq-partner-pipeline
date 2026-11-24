"""Optional: pull Zoom AI Companion meeting summaries straight from Zoom.

Off unless these are in .env (a Zoom "Server-to-Server OAuth" app with the scopes
meeting:read:list_meetings and meeting:read:summary):

    ZOOM_ACCOUNT_ID=...
    ZOOM_CLIENT_ID=...
    ZOOM_CLIENT_SECRET=...
    ZOOM_USER=me            # or the Zoom user's email

Without them, paste or upload the summary from Zoom's recap email instead (same result).
Note: written against Zoom's documented REST API; test with your own Zoom account.
"""

from __future__ import annotations

import base64
import os
import time
from urllib.parse import quote

import httpx

_token: dict = {}


def configured() -> bool:
    return all(os.getenv(k) for k in ("ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET"))


def _access_token() -> str:
    if _token.get("value") and _token["expires"] > time.time() + 60:
        return _token["value"]
    auth = base64.b64encode(f"{os.environ['ZOOM_CLIENT_ID']}:{os.environ['ZOOM_CLIENT_SECRET']}".encode()).decode()
    r = httpx.post("https://zoom.us/oauth/token", params={"grant_type": "account_credentials", "account_id": os.environ["ZOOM_ACCOUNT_ID"]},
                   headers={"Authorization": f"Basic {auth}"}, timeout=20)
    r.raise_for_status()
    data = r.json()
    _token.update(value=data["access_token"], expires=time.time() + int(data.get("expires_in", 3600)))
    return _token["value"]


def _get(path: str, **params) -> dict:
    r = httpx.get(f"https://api.zoom.us/v2{path}", params=params, headers={"Authorization": f"Bearer {_access_token()}"}, timeout=20)
    r.raise_for_status()
    return r.json()


def recent_meetings(limit: int = 30) -> list[dict]:
    user = os.getenv("ZOOM_USER", "me")
    data = _get(f"/users/{quote(user)}/meetings", type="previous_meetings", page_size=limit)
    return [{"uuid": m.get("uuid"), "id": m.get("id"), "topic": m.get("topic", ""), "start_time": m.get("start_time", "")}
            for m in data.get("meetings", [])]


def meeting_summary(meeting_uuid: str) -> str:
    """Zoom's own AI Companion summary, as plain text (overview, details, next steps)."""
    uid = quote(quote(meeting_uuid, safe=""), safe="") if meeting_uuid.startswith("/") or "//" in meeting_uuid else quote(meeting_uuid, safe="")
    s = _get(f"/meetings/{uid}/meeting_summary")
    lines = [s.get("summary_title") or s.get("meeting_topic") or "Meeting summary", ""]
    if s.get("summary_overview"):
        lines += ["Quick recap", s["summary_overview"], ""]
    for d in s.get("summary_details", []) or []:
        lines += [d.get("label", ""), d.get("summary", ""), ""]
    if s.get("next_steps"):
        lines += ["Next steps"] + [f"- {n}" for n in s["next_steps"]]
    return "\n".join(lines).strip()
