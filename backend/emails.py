"""Finds a recipient's email for a draft. Plain code, not an agent, so it cannot invent one.

Order: (1) our own contacts table; (2) a published work email on a public page, accepted
only when the address literally appears on the page, the person's name is on the same page,
and the address matches the name. People-search and data-broker sites are never used.
Every result carries its source, and the app shows it so Mary verifies before sending.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

import db
import tools

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
SKIP_DOMAINS = ("linkedin.", "facebook.", "instagram.", "twitter.", "x.com", "zoominfo.", "rocketreach.",
                "contactout.", "apollo.io", "lusha.", "signalhire.", "hunter.io", "spokeo.", "whitepages.",
                "beenverified.", "truepeoplesearch.", "fastpeoplesearch.", "peoplefinders.", "radaris.",
                "clustrmaps.", "intelius.", "leadiq.", "seamless.ai", "crunchbase.")
TITLES = {"mr", "mrs", "ms", "dr", "hon", "honorable", "chairman", "chairwoman", "chair", "president", "vice",
          "councilman", "councilwoman", "council", "member", "director", "chief", "the", "and", "of", "jr", "sr"}
MAX_PAGES = 4


def name_tokens(name: str) -> list[str]:
    words = re.findall(r"[A-Za-z][A-Za-z'\-]+", name or "")
    return [w.lower().replace("'", "") for w in words if w.lower() not in TITLES and len(w) > 1]


def _page(url: str) -> tuple[str, set[str]]:
    """Whole page text (not truncated) plus every email in text and mailto links."""
    try:
        r = httpx.get(url, timeout=12, follow_redirects=True, headers=tools.BROWSER)
        r.raise_for_status()
    except Exception:
        return "", set()
    if "html" not in r.headers.get("content-type", "html"):
        return "", set()
    soup = BeautifulSoup(r.text, "html.parser")
    found = {a["href"][7:].split("?")[0] for a in soup.select('a[href^="mailto:"]') if a.get("href")}
    for tag in soup(["script", "style", "noscript", "svg"]):
        tag.decompose()
    text = soup.get_text(" ")
    found |= set(EMAIL_RE.findall(text))
    return text, {e.strip().strip(".").lower() for e in found if EMAIL_RE.fullmatch(e.strip().strip("."))}


def _matches(email: str, tokens: list[str]) -> bool:
    local = re.sub(r"[^a-z]", "", email.split("@")[0].lower())
    if len(tokens) < 2:
        return False
    first, last = tokens[0], tokens[-1]
    return (last in local and (first in local or local.startswith(first[0]) or local.endswith(first[0]))) or \
           (first in local and local.endswith(last[0])) or local == first + last


def from_contacts(name: str) -> str:
    t = name_tokens(name)
    if len(t) < 2:
        return ""
    for c in db.query("SELECT first_name, last_name, email FROM contacts WHERE email != '' AND email IS NOT NULL"):
        if name_tokens(f"{c['first_name']} {c['last_name']}") == [t[0], t[-1]] or \
           (c["first_name"] or "").lower() == t[0] and (c["last_name"] or "").lower().endswith(t[-1]):
            return c["email"].strip()
    return ""


def from_web(name: str, org: str, hint_urls: list[str] | None = None) -> tuple[str, str]:
    """(email, source_url) or ("", "")."""
    tokens = name_tokens(name)
    if len(tokens) < 2:
        return "", ""
    urls = [u for u in (hint_urls or []) if u]
    for q in (f'"{tokens[0].title()} {tokens[-1].title()}" {org} email', f"{name} {org} contact"):
        urls += [r.get("url", "") for r in tools.web_search(q, 6)]
    seen, tried = set(), 0
    for u in urls:
        host = urlparse(u).netloc.lower()
        if not u.startswith("http") or u in seen or any(s in host for s in SKIP_DOMAINS):
            continue
        seen.add(u)
        tried += 1
        if tried > MAX_PAGES:
            break
        text, found = _page(u)
        low = text.lower()
        if not (tokens[0] in low and tokens[-1] in low):
            continue  # the person must be named on the same page
        for e in sorted(found):
            if _matches(e, tokens):
                return e, u
    return "", ""


def candidates_for(draft: dict, target_id: int | None) -> list[tuple[str, str, list[str]]]:
    """People named in the draft's recipient line: (name, org, hint source urls)."""
    who = (draft.get("recipient") or "").lower()
    out: list[tuple[str, str, list[str]]] = []
    if target_id:
        t = db.one("SELECT name FROM targets WHERE id = ?", (target_id,))
        nation = t["name"] if t else ""
        p = db.one("SELECT profile_json FROM profiles WHERE target_id = ?", (target_id,))
        prof = db.loads(p["profile_json"], {}) if p else {}
        for person in (prof.get("leadership") or []) + (prof.get("people_to_know") or []):
            nm = person.get("name") or ""
            if nm and nm.lower() in who:
                out.append((nm, nation, [person.get("source_url", "")]))
        wp = db.one("SELECT paths_json FROM warm_paths WHERE target_id = ?", (target_id,))
        for path in (db.loads(wp["paths_json"], {}).get("paths", []) if wp else []):
            nm = path.get("contact_name") or ""
            if nm and nm.lower() in who:
                c = db.one("SELECT email FROM contacts WHERE id = ?", (path.get("contact_id"),))
                if c and (c["email"] or "").strip():
                    out.insert(0, (nm, "__contact__:" + c["email"].strip(), []))
                else:
                    out.append((nm, path.get("contact_org") or "", []))
    if not out:  # fall back to a plain "First Last" at the start of the recipient line
        m = re.match(r"\s*([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+){1,2})", draft.get("recipient") or "")
        if m:
            org = ""
            if target_id:
                t = db.one("SELECT name FROM targets WHERE id = ?", (target_id,))
                org = t["name"] if t else ""
            out.append((m.group(1), org, []))
    return out


def resolve(draft: dict, target_id: int | None, use_web: bool = True) -> tuple[str, str]:
    """(email, source). source is 'contacts' or the page URL it was found on."""
    for name, org, hints in candidates_for(draft, target_id):
        if org.startswith("__contact__:"):
            return org.split(":", 1)[1], "contacts"
        e = from_contacts(name)
        if e:
            return e, "contacts"
        if use_web:
            e, src = from_web(name, org, hints)
            if e:
                return e, src
    return "", ""
