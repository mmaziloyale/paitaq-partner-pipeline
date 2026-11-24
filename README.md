# Paitaq Partner Development Dashboard

**A team of AI agents that manages Paitaq Capital's relationships with tribal nations, from first research to follow-through.**

MGT 409 (AI Foundations for Managers) final project · Mary Hiratsuka Mazilo

Paitaq Capital is a Native infrastructure investment platform with tribal ownership built into every deal. Its first fund depends on trusted partnerships with dozens of tribal nations at once, and a two-person founding team can't research, introduce, prepare, meet and follow up with all of them by hand. This app runs that relationship cycle:

| Agent | What it does | Tools |
|---|---|---|
| **scanner** (separate, on demand) | Runs on its own from the Gatherings tab: finds conferences, council meetings and community events where we can see a nation's people in person | web search, read page |
| **research** (relationship lens) | Relationship lens: who leads the nation, people to know, signals (leadership changes, elections, council meetings, events) and stated priorities, from the nation's own news and official pages | web search, read page, Deal Team hand-off |
| **connector** (finds warm paths) | Finds warm introduction paths through Mary's and Jabarie's networks | search contacts |
| **outreach** (drafts outreach) | Drafts the intro request (to the warm contact) and the note to the nation | (works from what it's given) |
| **reviewer** (reviews drafts) | Checks every outgoing message: unsupported claims, fundraising/securities language, overpromises, sovereignty, tone | (works from what it's given) |
| **prep** (call prep) | Writes a brief **the moment a call is scheduled** (goal, attendees, prioritized questions, their likely questions, open items); refreshes it 24 hours before | (works from what it's given) |
| **tracker** (follow-up tracker) | Reads the meeting summary **Zoom AI Companion already wrote** (it does not write its own) and pulls out the follow-ups: action items with owner and due date, who we're waiting on, open questions, new contacts, profile updates; drafts a thank-you email. Unanswered questions carry into the next call's prep | Zoom (optional) |

### Separate from the Paitaq Deal Team
Jabarie Campbell's **Deal Team** is a separate project that works on the deals: thesis, sourcing, screening, pricing, structure, returns, and the advance/hold/pass decision. It contacts no one. The Partner Development Dashboard works on the **people and relationships** and never prices, structures or scores a deal. Both read the nation's own news, for different questions: the Deal Team for deal signals, the Partner Development Dashboard for relationship signals. The two connect through two files only, and each runs on its own:

- **In:** `to_partner_pipeline.json` (deals to pursue, ranked; questions to learn in meetings; whether the proposal is approved to share). Import it on the Pipeline page.
- **Out:** `from_partner_pipeline.json` (per deal: signal, answers to its questions, changes for the deal). Export it from the Pipeline or Follow-ups page. Zoom summaries, contact details and personal information never leave the Partner Development Dashboard; emails and phone numbers are stripped in code.
- A proposal can't be mentioned in outreach unless the Deal Team set `approved_to_share: true` (checked in code at approval time).

Plain-code pieces (no AI): **dashboard** (`dashboard.py`, the Follow-ups page: contact next, commitments), **scheduler** (calendar checks, 24-hour brief refresh, monthly LinkedIn reminder) and **safety.py** (the guardrail checks). Plain code (`backend/pipeline.py`) orchestrates the agents. They never call each other directly, which keeps runs predictable and cheap.

## Run it (about 3 minutes)

Needs **Python 3.10+**. The website is already built, so Node is **not** needed.

```bash
git clone <this repo>
cd paitaq-pipeline
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python run.py
```

Your browser opens **http://localhost:8000**.

### API key
The app looks for a `.env` file **in this folder first, then in the folder above it**. It needs `PORTKEY_API_KEY` (model `gpt-6-luna` through Portkey). To set your own:

```bash
cp .env.example .env     # then put your key in .env
```

`OPENAI_API_KEY` also works if you'd rather use your own OpenAI key (set `MODEL_NAME` to a model your key can use).

## Try it (5-minute tour)

1. **Pipeline** → click **Moapa Band of Paiutes** → **Run full pipeline**. Watch research → connector → outreach → reviewer work, with tokens and cost per step.
2. Open the **Outreach** tab: review the drafts and the Reviewer's notes. **Approve**, then **Open in email**. Nothing is ever sent by the app.
3. **Calls** tab → **Schedule a call**. The prep brief starts writing as soon as you save.
4. On the call page, under **After the call**, upload `data/sample/zoom_summaries/sample_zoom_summary_moapa.txt` (tick the consent box) → **Capture follow-ups**. Zoom's summary is shown as written; next to it are the follow-ups pulled out of it, a reviewed thank-you email, and new contacts added to the Network. The summary contains a planted prompt-injection line; see it caught on **Usage & Safety**.
5. **Follow-ups** → the dashboard: **Contact next** (a ranked list of tribal leaders and contacts, each with the reason: a promise due or overdue, a new leader, an upcoming council meeting, a relationship gone quiet, a leader not yet met plus who could introduce you; log a contact or snooze), **Commitments** (what we promised them vs. what they promised us, kept / late / open by nation), open / overdue / due this week, items by owner, how long items have been open, status by nation, the next three weeks, and emails waiting for approval. All of it is computed in code (no AI cost).
6. **Gatherings** → **Scan for gatherings** builds the events calendar (separate from the main pipeline).
7. **Usage & Safety** → measured tokens and cost per agent and per run, cost at 100 / 10,000 users, the safety log, and a **guard self-test**.

## Data

| File | What it is |
|---|---|
| `data/sample/to_partner_pipeline.json` | The Deal Team hand-off: 17 opportunities across 15 nations (data center campuses and transmission stakes), loaded on first run. |
| `data/sample/targets.csv` | Fallback CSV target list, used only if no Deal Team file is present. |
| `data/sample/contacts.csv` | **Fictional** contacts for the demo. Replace with your own LinkedIn export on the **Network** page. |
| `data/sample/zoom_summaries/` | A **fictional** Zoom AI Companion-style summary for testing the tracker agent. |
| `data/paitaq.db` | The app's working database, created on first run. Delete it to start fresh. |

### Using the real Deal Team file
Import `to_partner_pipeline.json` on the Pipeline page (re-importing updates existing deals), or point the app at it on first run:
```
PAITAQ_DEALTEAM_JSON=data/full/to_partner_pipeline.json
```
then delete `data/paitaq.db` and restart.

### Zoom summaries
By default you paste or upload the summary from Zoom's recap email (no extra keys, so the teaching staff can run it). To pull summaries straight from Zoom, create a Zoom **Server-to-Server OAuth** app with the scopes `meeting:read:list_meetings` and `meeting:read:summary`, and add `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` (and optionally `ZOOM_USER`) to `.env`. A **Pull from Zoom** option then appears on each call page. This path is optional and was written against Zoom's documented API; test it with your own account.

**Outlook calendar (optional, read-only).** The Calendar tab has a month calendar of every booked call. To show your Outlook meetings on it too, publish your calendar in Outlook on the web (Settings → Calendar → Shared calendars → Publish a calendar → Publish), copy the **ICS** link, and add `OUTLOOK_ICS_URL=...` to `.env` (optionally `OUTLOOK_TZ=America/New_York`). Outlook meetings whose titles name a nation in the pipeline link to that nation. `pip install python-dateutil` to expand recurring meetings. Each call page also has **Add to Outlook**, which downloads an `.ics` file for the call. The app never writes to Outlook or sends invites.

### LinkedIn contacts
Each person exports their own connections (LinkedIn → Settings & Privacy → Data privacy → Download my data → **larger data archive**) and uploads `Connections.csv` on the **Network** page. A monthly reminder banner appears when an export is over a month old. Since late 2026 LinkedIn's export no longer includes connections' current company or title, so warm paths from the export match mostly on names.

### Optional: the LinkedIn window
Off by default; the app runs fully without it. When it's on, the app opens **its own browser window with its own profile** (`data/linkedin-browser/`, never committed), separate from your everyday Chrome. You sign in to LinkedIn yourself in that window; the app never sees or stores your password. While it's signed in, the connector agent gets one extra, read-only tool: search your 1st-degree connections by keyword (at most 3 searches per run, a few seconds apart). People it finds are added to the Network, so the "never invent a contact" check still applies. It never sends messages or connection requests. LinkedIn restricts automated use, so keep it light; the export above stays the main way to load a network.

```bash
pip install -r requirements-linkedin.txt
python -m playwright install chromium   # or set LINKEDIN_BROWSER_CHANNEL=chrome to use your installed Chrome
echo "LINKEDIN_BROWSER=1" >> .env
python run.py
```
Then **Network → Open LinkedIn window**, sign in, and run a pipeline.

## Safety, in code (not just in the prompt)

- **Prompt injection**: text from web pages, search results, calendar invites, contact notes and Zoom summaries is scanned; instruction-like lines are removed before the model sees them, logged, and the rest is wrapped as `<untrusted>` data. Hidden HTML is stripped from pages.
- **Deal Team boundary**: only deal-relevant facts are exported (emails/phones stripped); proposals can't be referenced unless approved to share.
- **Made-up facts**: every profile fact must cite a URL the agent actually retrieved in that run; others are labeled *unverified*.
- **Made-up contacts**: warm paths must reference a real contact id; others are dropped.
- **LinkedIn window (optional)**: read-only, its own browser profile, you sign in yourself, at most 3 searches per run with pauses between them; off unless `LINKEDIN_BROWSER=1`.
- **Fundraising / securities language** in messages to tribes is flagged by code as well as by the Reviewer, and blocks approval.
- **Human approval**: drafts are never sent by the app.
- **Consent**: Zoom AI summaries are refused unless you confirm everyone knew AI Companion was on (your own notes are always fine).
- **Spending**: per-agent caps on model calls, tool calls and tokens; max searches/pages per run; a daily token budget and a monthly dollar budget for the whole app; one pipeline job per target at a time.

## Tests

```bash
python tests/test_offline.py
```
These run without an API key or internet: the guards, plus the whole pipeline end to end with PydanticAI's `TestModel` standing in for the LLM.

## Costs

Every agent run records input, cached-input and output tokens, time, and cost (**Usage & Safety** page, or `/api/usage.csv`). Dollar prices come from `pricing.json` (OpenAI's list prices for gpt-6-luna: $0.10 input, $0.01 cached input, $0.50 output per 1M tokens, checked Nov 21, 2026).

## Layout

```
backend/
  main.py        API + serves the website
  pipeline.py    orchestrator: who runs when, what each agent sees, the scheduler
  agents.py      the seven agents: tools, structured outputs, limits, token/cost logging
  models.py      structured outputs (Pydantic)
  tools.py       web search, page reader, contact search
  dashboard.py   Contact next + Commitments (plain code)
  zoom.py        optional: pull Zoom AI Companion summaries
  linkedin.py    optional: the app's own LinkedIn window (separate browser profile)
  safety.py      injection screening, source/contact verification, compliance scan, budgets
  db.py          SQLite storage + CSV import (LinkedIn format supported)
  prompts/       one prompt per agent + shared Paitaq context
frontend/        React + Vite + TypeScript (built files in frontend/dist)
data/sample/     test dataset
tests/           offline tests
```

To change the website: `cd frontend && npm install && npm run dev` (proxies to the backend on :8000), then `npm run build`.

**Nation list.** The Add form's Tribal nation dropdown uses `frontend/src/nations.json` (built into the site): 629 tribal governments (590 federally recognized, 39 state-recognized) from the NCAI tribal government directory, via the open-source `tgd` package. The State field fills in from each nation's headquarters address; nations that span several states list only one, so adjust as needed. Any name not on the list can still be typed in.
