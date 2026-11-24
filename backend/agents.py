"""The seven agents: scanner, research, connector, outreach, reviewer, prep, tracker. Each one has: a prompt (prompts/<name>.md), the tools it may use,
a structured output (models.py) and hard limits on model calls and tokens.

The agents never talk to each other directly. pipeline.py (plain code) decides who runs
next and passes each agent only what it needs. That keeps runs predictable and cheap.

    scanner    web_search, fetch_page                          -> Opportunities
    research   web_search, fetch_page, project data            -> TribeProfile
    connector  search_contacts (+ search_linkedin_connections  -> WarmPaths
               only when the optional LinkedIn window is on)
    outreach   (none: works from what it is given)             -> OutreachDrafts
    reviewer   (none)                                          -> Review
    prep       (none)                                          -> CallBrief
    tracker    (none: reads Zoom's own summary)                -> FollowUpExtract
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from functools import lru_cache

from pydantic_ai import Agent, NativeOutput, RunContext
from pydantic_ai.usage import UsageLimits

import config
import db
import linkedin
import safety
import tools
from models import CallBrief, FollowUpExtract, Opportunities, OutreachDrafts, Review, TribeProfile, WarmPaths


@dataclass
class Deps:
    agent: str
    target_id: int | None = None
    job_id: int | None = None
    seen_urls: set[str] = field(default_factory=set)
    searches: int = 0
    pages: int = 0
    linkedin: int = 0


# Per-run caps: a loop or a bug can't burn more than this in one agent run.
# The tool caps sit well above the soft limits in the tools (MAX_SEARCHES etc.) because
# gpt-6-luna can ask for 10-20 tool calls in one burst; extra calls past the soft limit just
# get "finish now" and cost almost nothing. The token caps are what bound the cost.
LIMITS = {
    "scanner": UsageLimits(request_limit=14, tool_calls_limit=40, total_tokens_limit=160_000),
    "research": UsageLimits(request_limit=14, tool_calls_limit=40, total_tokens_limit=160_000),
    "connector": UsageLimits(request_limit=9, tool_calls_limit=30, total_tokens_limit=60_000),
    "outreach": UsageLimits(request_limit=3, total_tokens_limit=40_000),
    "reviewer": UsageLimits(request_limit=3, total_tokens_limit=30_000),
    "prep": UsageLimits(request_limit=3, total_tokens_limit=60_000),
    "tracker": UsageLimits(request_limit=3, total_tokens_limit=50_000),
}
MAX_SEARCHES = 6
MAX_PAGES = 5
MAX_CONTACT_SEARCHES = 5  # connector: the tool says "finish now" before the hard cap is hit

LABELS = {
    "scanner": "scanner", "research": "research", "connector": "connector", "outreach": "outreach",
    "reviewer": "reviewer", "prep": "prep", "tracker": "tracker",
}


def prompt(name: str) -> str:
    shared = (config.PROMPTS / "paitaq.md").read_text(encoding="utf-8")
    own = (config.PROMPTS / f"{name}.md").read_text(encoding="utf-8")
    return shared + "\n\n" + own  # static text first, so the provider can cache it


# ---------- web tools (Research + Scanner) ----------


def _add_web_tools(agent: Agent) -> None:
    @agent.tool
    def web_search(ctx: RunContext[Deps], query: str) -> str:
        """Search the web. Returns titles, URLs and snippets. Use specific queries
        (e.g. "Navajo Tribal Utility Authority solar project 2026")."""
        if ctx.deps.searches >= MAX_SEARCHES:
            return f"Search limit reached ({MAX_SEARCHES} per run). Finish with what you have."
        ctx.deps.searches += 1
        results = tools.web_search(query)
        lines = []
        for r in results:
            if r["url"]:
                ctx.deps.seen_urls.add(r["url"])
            lines.append(f"- {r['title']}\n  URL: {r['url']}\n  {r['snippet']}")
        return safety.screen_untrusted("\n".join(lines) or "No results.", f"web search: {query}", ctx.deps.agent, ctx.deps.target_id)

    @agent.tool
    def fetch_page(ctx: RunContext[Deps], url: str) -> str:
        """Read the text of one web page (first part only). Use on the most promising search results."""
        if ctx.deps.pages >= MAX_PAGES:
            return f"Page limit reached ({MAX_PAGES} per run). Finish with what you have."
        ctx.deps.pages += 1
        text = tools.fetch_page(url)
        ctx.deps.seen_urls.add(url)
        return safety.screen_untrusted(text, url, ctx.deps.agent, ctx.deps.target_id)


# gpt-6-luna on Portkey's chat endpoint refuses function tools while it is reasoning, so the
# agents that call tools (scanner, research, connector) run with reasoning off. The others keep the
# model's default reasoning. Override with TOOL_REASONING_EFFORT in .env if the model changes.
TOOL_AGENTS = {"scanner", "research", "connector"}


def _settings(name: str):
    if config.os.getenv("PAITAQ_TEST_MODEL") == "1" or name not in TOOL_AGENTS:
        return None
    from pydantic_ai.models.openai import OpenAIChatModelSettings
    settings = OpenAIChatModelSettings(openai_reasoning_effort=config.os.getenv("TOOL_REASONING_EFFORT", "none"))
    # One tool call per turn. Without this the model fired tool calls in big bursts (connector: 10 at
    # once on the Navajo Nation; research: 19 on the Blackfeet Nation) and blew through the hard caps
    # before the "finish now" soft limits in the tools could work.
    settings["parallel_tool_calls"] = False
    return settings


def _new(name: str, output) -> Agent:
    # NativeOutput = JSON-schema answers (worked with Portkey in HW3/HW4). The offline test model
    # doesn't support it, so tests use PydanticAI's default tool-based output instead.
    wrapped = output if config.os.getenv("PAITAQ_TEST_MODEL") == "1" else NativeOutput(output)
    return Agent(config.build_model(), deps_type=Deps, output_type=wrapped,
                 instructions=prompt(name), retries=2, name=name, model_settings=_settings(name))


@lru_cache(maxsize=None)
def get(name: str) -> Agent:
    if name == "research":
        a = _new("research", TribeProfile)
        _add_web_tools(a)

        @a.tool
        def project_data(ctx: RunContext[Deps]) -> str:
            """Paitaq's own mapping / ranking data for this target (grid, pipelines, hydro, scores)."""
            t = db.one("SELECT * FROM targets WHERE id = ?", (ctx.deps.target_id,))
            if not t:
                return "No project data."
            extra = db.loads(t["data_json"], {})
            rows = [f"{k}: {v}" for k, v in extra.items()]
            return "\n".join([f"name: {t['name']}", f"state: {t['state']}", f"project_focus: {t['project_focus']}",
                              f"why targeted: {t['rationale']}", f"rank score: {t['rank_score']}", *rows])
        return a
    if name == "scanner":
        a = _new("scanner", Opportunities)
        _add_web_tools(a)
        return a
    if name == "connector":
        a = _new("connector", WarmPaths)

        @a.tool
        def search_contacts(ctx: RunContext[Deps], words: str) -> str:
            """Search Mary's and Jabarie's network by organization, title, place or name.
            Try several searches: the tribe's name, its utility or enterprise names, the state,
            and roles like 'energy', 'tribal council', 'economic development'."""
            if ctx.deps.searches >= MAX_CONTACT_SEARCHES:
                return f"Search limit reached ({MAX_CONTACT_SEARCHES} per run). Finish now with the contacts you have."
            ctx.deps.searches += 1
            rows = tools.search_contacts(words)
            if not rows:
                return "No contacts matched."
            lines = [f"[id {r['contact_id']}] {r['name']} | {r['position']} at {r['company']} | owner: {r['owner']}"
                     f" | strength: {r['strength'] or 'unknown'} | how we know them: {r['relationship'] or 'not noted'}" for r in rows]
            return safety.screen_untrusted("\n".join(lines), "contacts database", "connector", ctx.deps.target_id)

        async def _linkedin_ready(ctx: RunContext[Deps], tool_def):
            # Hidden from the model unless the optional LinkedIn window is on and signed in.
            return tool_def if await asyncio.to_thread(linkedin.ready) else None

        @a.tool(prepare=_linkedin_ready)
        def search_linkedin_connections(ctx: RunContext[Deps], words: str) -> str:
            """Search your 1st-degree LinkedIn connections by keyword (the nation's name, its enterprises,
            a place, or a role like 'tribal energy'). Read-only. Use only after search_contacts finds too little.
            People found are added to the network, so you can use their contact_id."""
            if ctx.deps.linkedin >= linkedin.MAX_LOOKUPS:
                return f"LinkedIn limit reached ({linkedin.MAX_LOOKUPS} per run). Finish now with the contacts you have."
            ctx.deps.linkedin += 1
            try:
                rows = linkedin.search_connections(words)
            except Exception as e:  # noqa: BLE001
                return f"LinkedIn search unavailable: {e}"
            if not rows:
                return "No 1st-degree connections matched."
            lines = [f"[id {r['contact_id']}] {r['name']} | {r['headline']} | {r['location']} | owner: {r['owner']}"
                     f" | how we know them: 1st-degree LinkedIn connection (strength unknown)" for r in rows]
            return safety.screen_untrusted("\n".join(lines), "LinkedIn search", "connector", ctx.deps.target_id)
        return a
    outputs = {"outreach": OutreachDrafts, "reviewer": Review, "prep": CallBrief, "tracker": FollowUpExtract}
    return _new(name, outputs[name])


# ---------- running an agent: budget check, limits, token + cost log ----------


def cost_of(input_tokens: int, cached: int, output_tokens: int) -> float:
    p = config.pricing()
    fresh = max(input_tokens - cached, 0)
    return (fresh * p["input_per_m"] + cached * p["cached_input_per_m"] + output_tokens * p["output_per_m"]) / 1_000_000


def job_step(job_id: int | None, agent: str, status: str, message: str, **extra) -> None:
    if not job_id:
        return
    job = db.one("SELECT steps_json FROM jobs WHERE id = ?", (job_id,))
    steps = db.loads(job["steps_json"], []) if job else []
    for s in steps:
        if s["agent"] == agent and s["status"] == "running":
            s.update(status=status, message=message, **extra)
            break
    else:
        steps.append({"agent": agent, "label": LABELS.get(agent, agent), "status": status, "message": message, **extra})
    db.execute("UPDATE jobs SET steps_json = ? WHERE id = ?", (db.dumps(steps), job_id))


async def run(name: str, user_prompt: str, deps: Deps):
    """Run one agent and record what it used. Returns (output, deps)."""
    safety.check_budget(name, deps.target_id)
    job_step(deps.job_id, name, "running", "Working...")
    started = time.time()
    try:
        result = await get(name).run(user_prompt, deps=deps, usage_limits=LIMITS[name])
    except Exception as e:
        ms = int((time.time() - started) * 1000)
        db.execute("""INSERT INTO agent_runs (job_id, agent, target_id, model, input_tokens, cached_input_tokens, output_tokens,
                      requests, tool_calls, cost_usd, duration_ms, ok, error, created_at) VALUES (?,?,?,?,0,0,0,0,0,0,?,0,?,?)""",
                   (deps.job_id, name, deps.target_id, config.model_name(), ms, f"{type(e).__name__}: {e}"[:500], db.now()))
        if "UsageLimitExceeded" in type(e).__name__:
            safety.log_event("run_capped", name, deps.target_id, "Agent hit its per-run limit and was stopped", str(e)[:300])
        job_step(deps.job_id, name, "error", f"{type(e).__name__}: {e}"[:300])
        raise
    u = result.usage() if callable(result.usage) else result.usage
    cached = getattr(u, "cache_read_tokens", 0) or 0
    cost = cost_of(u.input_tokens or 0, cached, u.output_tokens or 0)
    ms = int((time.time() - started) * 1000)
    db.execute("""INSERT INTO agent_runs (job_id, agent, target_id, model, input_tokens, cached_input_tokens, output_tokens,
                  requests, tool_calls, cost_usd, duration_ms, ok, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)""",
               (deps.job_id, name, deps.target_id, config.model_name(), u.input_tokens or 0, cached, u.output_tokens or 0,
                u.requests or 0, u.tool_calls or 0, cost, ms, db.now()))
    job_step(deps.job_id, name, "done", "Done", input_tokens=u.input_tokens or 0, cached_input_tokens=cached,
             output_tokens=u.output_tokens or 0, cost_usd=round(cost, 5), seconds=round(ms / 1000, 1),
             tool_calls=u.tool_calls or 0)
    return result.output, deps
