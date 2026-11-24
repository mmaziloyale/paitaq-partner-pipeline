"""Commitments and "Contact next", computed in plain code from what the agents and Mary
have recorded. No AI runs here, so the dashboard costs nothing to load.

Contact next ranks people by why they need attention now:
  100  we owe them something that is overdue
   90  we owe them something due within 7 days
   75  they owe us something that is overdue (a gentle nudge)
   70  newly elected / appointed leader (from the Research agent's signals)
   55  an upcoming council meeting or community event (a natural moment to reach out)
 40-70 no contact for 30+ days (grows with time)
   35  a leader we haven't met yet (with who could introduce us)
"""

from __future__ import annotations

from datetime import date, timedelta

import db

OURS = ("Mary", "Jabarie")


def _days(a: str | None, b: date) -> int | None:
    if not a:
        return None
    try:
        return (b - date.fromisoformat(a[:10])).days
    except ValueError:
        return None


def commitments(today: date) -> dict:
    rows = db.query("SELECT a.*, t.name AS target_name FROM action_items a LEFT JOIN targets t ON t.id = a.target_id")
    t = today.isoformat()

    def tally(items):
        open_ = [r for r in items if r["status"] == "open"]
        done = [r for r in items if r["status"] == "done"]
        kept = [r for r in done if not r["due_date"] or (r["completed_at"] or "")[:10] <= r["due_date"]]
        return {"open": len(open_), "overdue": sum(1 for r in open_ if r["due_date"] and r["due_date"] < t),
                "kept": len(kept), "late": len(done) - len(kept),
                "kept_rate": round(100 * len(kept) / len(done)) if done else None}

    ours = [r for r in rows if r["owner"] in OURS]
    theirs = [r for r in rows if r["owner"] not in OURS]
    by_nation = {}
    for r in rows:
        n = by_nation.setdefault(r["target_id"], {"target_id": r["target_id"], "name": r["target_name"], "ours": [], "theirs": []})
        n["ours" if r["owner"] in OURS else "theirs"].append(r)
    nations = [{"target_id": n["target_id"], "name": n["name"], "ours": tally(n["ours"]), "theirs": tally(n["theirs"])}
               for n in by_nation.values()]
    nations.sort(key=lambda n: (-(n["ours"]["overdue"] + n["theirs"]["overdue"]), n["name"] or ""))
    return {
        "ours": tally(ours), "theirs": tally(theirs), "by_nation": nations,
        "ours_open": sorted([r for r in ours if r["status"] == "open"], key=lambda r: r["due_date"] or "9999"),
        "theirs_open": sorted([r for r in theirs if r["status"] == "open"], key=lambda r: r["due_date"] or "9999"),
    }


def contact_next(today: date, limit: int = 15) -> list[dict]:
    t = today.isoformat()
    snoozed = {r["key"] for r in db.query("SELECT key FROM snoozes WHERE until > ?", (t,))}
    items: dict[str, dict] = {}

    def add(target, person, role, score, reason, action, last=None):
        key = f"{target['id']}:{person.strip().lower()}"
        if key in snoozed or not person.strip():
            return
        cur = items.get(key)
        if cur and cur["score"] >= score:
            cur["also"].append(reason)
            return
        items[key] = {"key": key, "target_id": target["id"], "nation": target["name"], "person": person.strip(), "role": role,
                      "score": score, "reason": reason, "suggested_action": action, "last_contact": last,
                      "also": cur["also"] + [cur["reason"]] if cur else []}

    for target in db.query("SELECT id, name, stage FROM targets"):
        tid = target["id"]
        last_touch = {r["p"]: r["last"] for r in db.query(
            "SELECT lower(person) AS p, MAX(happened_on) AS last FROM touches WHERE target_id = ? GROUP BY lower(person)", (tid,))}
        booked = db.one("SELECT scheduled_at FROM calls WHERE target_id = ? AND status = 'scheduled' AND scheduled_at >= ? ORDER BY scheduled_at LIMIT 1",
                        (tid, t))
        booked_soon = booked and _days(t, date.fromisoformat(booked["scheduled_at"][:10])) is not None and \
            (date.fromisoformat(booked["scheduled_at"][:10]) - today).days <= 14

        # People we've actually met (call attendees + contacts added from calls)
        known: dict[str, str] = {}
        for c in db.query("SELECT attendees_json FROM calls WHERE target_id = ?", (tid,)):
            for a in db.loads(c["attendees_json"], []):
                if a.get("name"):
                    known[a["name"].strip()] = a.get("role", "")
        for c in db.query("SELECT first_name || ' ' || last_name AS n, position FROM contacts WHERE source = 'meeting' AND (target_id = ? OR company = ?)",
                          (tid, target["name"])):
            known.setdefault(c["n"].strip(), c["position"] or "")
        first_known = next(iter(known), None)

        # Commitments
        for a in db.query("SELECT * FROM action_items WHERE target_id = ? AND status = 'open'", (tid,)):
            person = a["owner_detail"] if a["owner"] not in OURS and a["owner_detail"] else (first_known or "")
            if not person:
                continue
            due = a["due_date"]
            if a["owner"] in OURS and due:
                late = due < t
                soon = not late and due <= (today + timedelta(days=7)).isoformat()
                if late or soon:
                    add(target, person, known.get(person, ""), 100 if late else 90,
                        f"{'Overdue' if late else 'Due soon'}: {a['owner']} promised to {a['action'][0].lower() + a['action'][1:]} (due {due})",
                        "Deliver it, or let them know when it's coming", last_touch.get(person.lower()))
            elif a["owner"] not in OURS and due and due < t:
                add(target, person, known.get(person, ""), 75, f"They planned to {a['action'][0].lower() + a['action'][1:]} (due {due})",
                    "Gentle check-in; offer help", last_touch.get(person.lower()))

        # Gone quiet
        for person, role in known.items():
            last = last_touch.get(person.lower())
            gap = _days(last, today)
            if gap is not None and gap > 30 and not booked_soon:
                add(target, person, role, min(70, 40 + gap // 3), f"No contact in {gap} days", "Check in; share something useful", last)

        # From research: signals and leaders not yet met
        prof = db.one("SELECT profile_json, verified_json FROM profiles WHERE target_id = ?", (tid,))
        if not prof:
            continue
        p = db.loads(prof["profile_json"], {})
        wp = db.one("SELECT paths_json FROM warm_paths WHERE target_id = ?", (tid,))
        paths = db.loads(wp["paths_json"], {}).get("paths", []) if wp else []
        for sgl in p.get("signals", []):
            age = _days(sgl.get("date"), today)
            if sgl.get("kind") in ("leadership_change", "election") and sgl.get("person") and age is not None and 0 <= age <= 90:
                add(target, sgl["person"], "", 70, f"New leadership: {sgl['description']}", "Send congratulations; ask for a short introduction",
                    last_touch.get(sgl["person"].lower()))
            if sgl.get("kind") in ("council_meeting", "community_event") and age is not None and -21 <= age <= 0:
                leaders = p.get("leadership") or []
                who = sgl.get("person") or first_known or (leaders[0].get("name", "") if leaders else "")
                if who:
                    add(target, who, "", 55, f"Coming up {sgl['date']}: {sgl['description']}", "A natural moment to reach out",
                        last_touch.get(who.lower()))
        if not booked_soon:
            for person in p.get("leadership", [])[:4]:
                name = person.get("name", "")
                if name and name.lower() not in last_touch and name not in known:
                    intro = next((x for x in paths if name.split()[-1].lower() in (x.get("could_introduce_to") or "").lower()), paths[0] if paths else None)
                    add(target, name, person.get("role", ""), 35, "Leader we haven't met yet",
                        f"Ask {intro['contact_name']} ({intro['owner']}'s contact) for an introduction" if intro else "Find a warm path first (Connector)",
                        None)

    ranked = sorted(items.values(), key=lambda x: -x["score"])
    return ranked[:limit]
