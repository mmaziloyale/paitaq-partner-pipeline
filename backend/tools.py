"""What the agents can do in the world: search the web, read a page, search the network.
No API keys needed (web search reads the free DuckDuckGo and Bing results pages).

Everything that comes back from outside is screened by safety.screen_untrusted first.
Search results are cached for 7 days so repeat runs cost no search time.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

import httpx
from bs4 import BeautifulSoup

import db

SEARCH_CACHE_DAYS = 7
PAGE_CHARS = 6000  # how much of a page an agent reads (cost control)


BROWSER = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
           "Accept-Language": "en-US,en;q=0.9"}


def _ddg_html(q: str, n: int) -> list[dict]:
    r = httpx.get("https://html.duckduckgo.com/html/", params={"q": q}, headers=BROWSER, timeout=15, follow_redirects=True)
    soup, out = BeautifulSoup(r.text, "html.parser"), []
    for res in soup.select("div.result"):
        a = res.select_one("a.result__a")
        if not a or not a.get("href", "").startswith("http"):
            continue
        snip = res.select_one(".result__snippet")
        out.append({"title": a.get_text(" ", strip=True), "url": a["href"], "snippet": snip.get_text(" ", strip=True) if snip else ""})
    return out[:n]


def _ddg_lite(q: str, n: int) -> list[dict]:
    r = httpx.get("https://lite.duckduckgo.com/lite/", params={"q": q}, headers=BROWSER, timeout=15, follow_redirects=True)
    soup = BeautifulSoup(r.text, "html.parser")
    links = [a for a in soup.select("a.result-link") if a.get("href", "").startswith("http")]
    snips = [td.get_text(" ", strip=True) for td in soup.select("td.result-snippet")]
    return [{"title": a.get_text(" ", strip=True), "url": a["href"], "snippet": snips[i] if i < len(snips) else ""} for i, a in enumerate(links)][:n]


def _bing(q: str, n: int) -> list[dict]:
    import base64
    from urllib.parse import parse_qs, urlparse
    r = httpx.get("https://www.bing.com/search", params={"q": q}, headers=BROWSER, timeout=15, follow_redirects=True)
    out = []
    for li in BeautifulSoup(r.text, "html.parser").select("li.b_algo"):
        a = li.select_one("h2 a")
        if not a:
            continue
        url = a.get("href", "")
        u = parse_qs(urlparse(url).query).get("u", [""])[0]
        if u.startswith("a1"):  # Bing wraps results in a redirect; the real URL is base64 inside it
            try:
                url = base64.urlsafe_b64decode(u[2:] + "=" * (-len(u[2:]) % 4)).decode()
            except Exception:
                pass
        p = li.select_one(".b_caption p") or li.select_one("p")
        if url.startswith("http"):
            out.append({"title": a.get_text(" ", strip=True), "url": url, "snippet": p.get_text(" ", strip=True) if p else ""})
    return out[:n]


SEARCHERS = [("duckduckgo", _ddg_html), ("duckduckgo-lite", _ddg_lite), ("bing", _bing)]  # tried in order


def web_search(query: str, max_results: int = 6) -> list[dict]:
    """Return [{title, url, snippet}] from the web (cached 7 days). Tries several free search
    pages in turn, so one being slow or blocked doesn't stop research."""
    q = query.strip()
    cached = db.one("SELECT results_json, created_at FROM search_cache WHERE query = ?", (q.lower(),))
    if cached:
        age = datetime.now(timezone.utc) - datetime.fromisoformat(cached["created_at"])
        if age < timedelta(days=SEARCH_CACHE_DAYS):
            return json.loads(cached["results_json"])
    results, errors = [], []
    for name, fn in SEARCHERS:
        try:
            results = fn(q, max_results)
        except Exception as e:
            errors.append(f"{name}: {type(e).__name__}")
            continue
        if results:
            break
        errors.append(f"{name}: no results")
    if not results:
        return [{"title": "Search failed", "url": "", "snippet": f"Web search is unavailable right now ({'; '.join(errors)}). Say what you could not check."}]
    db.execute("INSERT OR REPLACE INTO search_cache (query, results_json, created_at) VALUES (?,?,?)",
               (q.lower(), json.dumps(results), db.now()))
    return results


def fetch_page(url: str) -> str:
    """Return readable text from a web page (first PAGE_CHARS characters)."""
    if not re.match(r"^https?://", url or ""):
        return "Not a web address."
    try:
        r = httpx.get(url, timeout=15, follow_redirects=True,
                      headers=BROWSER)
        r.raise_for_status()
    except Exception as e:
        return f"Could not open the page ({type(e).__name__})."
    if "html" not in r.headers.get("content-type", "html"):
        return "That link is not a web page (it may be a PDF or file)."
    soup = BeautifulSoup(r.text, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "noscript", "svg", "form"]):
        tag.decompose()
    # Hidden text is a classic place to plant instructions for AI readers: drop it.
    for tag in soup.select('[style*="display:none"], [style*="display: none"], [hidden], [aria-hidden="true"]'):
        tag.decompose()
    text = re.sub(r"\n\s*\n+", "\n", soup.get_text("\n")).strip()
    return text[:PAGE_CHARS]


def search_contacts(words: str, limit: int = 15) -> list[dict]:
    """Contacts whose name, company, position or relationship notes match any of the words."""
    terms = [w for w in re.findall(r"[A-Za-z0-9'&-]{3,}", words or "") if w.lower() not in {"the", "and", "tribe", "nation", "tribal"}]
    if not terms:
        terms = [words.strip()]
    clauses, params = [], []
    for t in terms[:8]:
        like = f"%{t}%"
        clauses.append("(company LIKE ? OR position LIKE ? OR relationship LIKE ? OR first_name || ' ' || last_name LIKE ?)")
        params += [like, like, like, like]
    rows = db.query(f"SELECT * FROM contacts WHERE {' OR '.join(clauses)} LIMIT 200", tuple(params))

    def score(c: dict) -> int:
        blob = " ".join(str(c.get(k, "")) for k in ("company", "position", "relationship", "first_name", "last_name")).lower()
        return sum(blob.count(t.lower()) for t in terms) + {"strong": 3, "medium": 1}.get(c.get("strength", ""), 0)

    rows.sort(key=score, reverse=True)
    return [{"contact_id": c["id"], "name": f"{c['first_name']} {c['last_name']}".strip(), "company": c["company"],
             "position": c["position"], "owner": c["owner"], "relationship": c["relationship"], "strength": c["strength"]}
            for c in rows[:limit]]
