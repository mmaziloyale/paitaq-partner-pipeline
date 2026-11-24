"""Settings, API key loading and the model used by every agent.

Keys are read from .env in the repo folder first, then from the folder above it
(the teaching staff keep one shared .env there). The repo's own .env overrides any
key already exported in the shell (so a stale key in ~/.zshrc can't win); the folder
above only fills in what is still missing.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

os.environ.setdefault("PYDANTIC_AI_NO_BANNER", "1")

from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parent
ROOT = BACKEND.parent
DATA = ROOT / "data"
PROMPTS = BACKEND / "prompts"

load_dotenv(ROOT / ".env", override=True)
load_dotenv(ROOT.parent / ".env")

# If this folder's .env uses your own OpenAI key (and no Portkey key), use OpenAI directly:
# drop any Portkey key or Portkey base URL picked up from the shell or the folder above.
from dotenv import dotenv_values

_own = dotenv_values(ROOT / ".env") if (ROOT / ".env").exists() else {}
if _own.get("OPENAI_API_KEY") and not _own.get("PORTKEY_API_KEY"):
    os.environ.pop("PORTKEY_API_KEY", None)
    if "portkey" in (os.environ.get("OPENAI_BASE_URL") or "") and not _own.get("OPENAI_BASE_URL"):
        os.environ.pop("OPENAI_BASE_URL", None)

PORTKEY_BASE_URL = "https://api.portkey.ai/v1"
DEFAULT_MODEL = "gpt-6-luna"  # the only model allowed on the course Portkey key

# Where the app keeps its working database. Created automatically on first run.
DB_PATH = Path(os.getenv("PAITAQ_DB", DATA / "paitaq.db"))

# Which target list to load on first run: the small sample in the repo, or the full
# Paitaq mapping export if you have it (see README, "Using the full dataset").
TARGETS_CSV = Path(os.getenv("PAITAQ_TARGETS_CSV", DATA / "sample" / "targets.csv"))
# The Deal Team's hand-off file (Jabarie's separate project). Used for the target list when present.
DEALTEAM_JSON = Path(os.getenv("PAITAQ_DEALTEAM_JSON", DATA / "sample" / "to_partner_pipeline.json"))
CONTACTS_CSV = Path(os.getenv("PAITAQ_CONTACTS_CSV", DATA / "sample" / "contacts.csv"))

# ---- Spending guards (see safety.py) ----
DAILY_TOKEN_BUDGET = int(os.getenv("DAILY_TOKEN_BUDGET", "1500000"))  # all agents, all users, per day
MONTHLY_COST_BUDGET_USD = float(os.getenv("MONTHLY_COST_BUDGET_USD", "25"))

# How long a research profile stays fresh before the Research agent re-runs.
PROFILE_FRESH_DAYS = int(os.getenv("PROFILE_FRESH_DAYS", "30"))


class NotReady(RuntimeError):
    """The API key or model setting is missing."""


def model_name() -> str:
    return (os.getenv("MODEL_NAME") or DEFAULT_MODEL).strip()


def api_key() -> str | None:
    # PORTKEY_API_KEY (course key) first; OPENAI_API_KEY if you use your own key.
    return os.getenv("PORTKEY_API_KEY") or os.getenv("OPENAI_API_KEY")


def key_status() -> dict:
    return {
        "has_key": bool(api_key()),
        "key_name": "PORTKEY_API_KEY" if os.getenv("PORTKEY_API_KEY") else ("OPENAI_API_KEY" if os.getenv("OPENAI_API_KEY") else None),
        "model": model_name(),
    }


def build_model():
    """The chat model every agent uses (OpenAI-compatible, through Portkey by default)."""
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    if os.getenv("PAITAQ_TEST_MODEL") == "1":  # offline tests: no key, no network
        from pydantic_ai.models.test import TestModel
        return TestModel()
    if os.getenv("PORTKEY_API_KEY"):
        base_url = (os.getenv("OPENAI_BASE_URL") or PORTKEY_BASE_URL).rstrip("/")
        return OpenAIChatModel(model_name(), provider=OpenAIProvider(base_url=base_url, api_key=os.environ["PORTKEY_API_KEY"]))
    if os.getenv("OPENAI_API_KEY"):
        return OpenAIChatModel(model_name(), provider=OpenAIProvider(api_key=os.environ["OPENAI_API_KEY"]))
    raise NotReady("No API key found. Put PORTKEY_API_KEY in .env (in this folder or the folder above it). See .env.example.")


def pricing() -> dict:
    """Dollar prices per 1M tokens, from pricing.json (edit to match your Portkey dashboard)."""
    path = ROOT / "pricing.json"
    data = json.loads(path.read_text()) if path.exists() else {}
    m = data.get(model_name()) or data.get("default") or {}
    return {
        "input_per_m": float(m.get("input_per_m", 0)),
        "cached_input_per_m": float(m.get("cached_input_per_m", 0)),
        "output_per_m": float(m.get("output_per_m", 0)),
        "note": data.get("note", ""),
    }
