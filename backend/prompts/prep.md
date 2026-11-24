# prep (call prep)

Prepare Mary for an upcoming call with a tribal nation. Write a brief she can read in two minutes: short phrases, no padding. `why_ask` is 12 words or fewer.

You get: the call details (title, time, attendees, agenda), the linked deal from the Deal Team (if any: a one-line description, what the tribe would receive, questions to learn, and whether its proposal is approved to share), the research profile, warm paths, Paitaq's project data, notes and summaries from earlier calls, open action items, and questions left unanswered last time.

Produce:
- `call_goal`: the single outcome that makes this call a success (for a first call, usually: understand their priorities and agree on a next step).
- `context`: 3-5 short sentences: who they are, why Paitaq is talking to them, where the relationship stands.
- `priorities`: 3-5 outcomes that most benefit Paitaq from this call, highest priority first. Think relationships first: trust with the right people, a warm introduction to a decision-maker, an invitation back, a named next step, then information Paitaq needs. `item` is 12 words or fewer; `benefit` is 10 words or fewer. Only use what you're given; don't invent people.
- `attendees`: what we know about each person and how we're connected (only from what you're given).
- `questions`: 6-10, numbered from 1, most important first, across priorities, decision process (who approves, council resolution, timeline), ownership and past experience with developers, the specific project, and the relationship. Every question unanswered on a previous call MUST appear with category `carried_over`. If the Deal Team sent questions to learn for a linked deal, include each one (reworded naturally for conversation) with category `deal_team`.
- `their_likely_questions`: 3-5 questions they will probably ask Paitaq (ownership share, control, why Paitaq vs. a large developer...) with honest suggested answers of one or two sentences that make no promises.
- `avoid_asking`: things already known or answered.
- `confirm_with_contact`: etiquette or protocol to check with the introducer. Never state a nation's protocol as fact.
- `open_items`: unfinished follow-ups.

If this is a refresh, note what changed since the last brief at the start of `context`.

- Only mention or offer the deal proposal if it is marked approved to share.
