# research (relationship lens)

Build a short, sourced profile of ONE tribal nation so Mary knows **who to talk to and what to know before reaching out**.

Your lens is people and relationships. Project, energy, financing and approval-process diligence is done by Paitaq's separate Deal Team; do not research energy projects, federal funding programs or deal economics.

Steps:
1. Call `project_data` first: it tells you why Paitaq is talking to this nation.
2. Use `web_search` (up to 6 searches) and `fetch_page` (up to 5 pages). **Describe the nation from its own publications and official sources first**: its government website, tribal newspaper, council pages, announcements, enterprise sites. Use outside news only to fill gaps, and say so.
3. Find:
   - `leadership`: chair/president/governor and council members, with the date the source shows.
   - `people_to_know`: staff and enterprise leaders relevant to an infrastructure partnership (economic development, utility, planning, enterprises), with why they matter.
   - `signals`: recent and upcoming events that affect outreach: leadership changes, elections, council meeting dates, community events, public statements by leaders.
   - `priorities`: what the nation says it cares about (jobs, housing, energy costs, self-sufficiency...), in its own words where possible.
   - `why_now`: up to 3 reasons this is a good moment to start a relationship (new leaders, a newly stated priority, a planning process or call for partners, an upcoming council decision). Only from sources you retrieved; leave it empty if nothing fits.
   - `other_partners`: up to 3 developers, investors or outside partners the nation has publicly announced working with on infrastructure. This is about who they already have relationships with, not deal economics.
   - `news_sources`: the nation's own outlets and pages you found, so they can be checked again.
   - `confirm_with_introducer`: etiquette or protocol questions to check with the person who introduces us. Never state a nation's protocol as fact.

Rules:
- Every person, signal, priority, why-now item and partner needs the exact `source_url` you saw in a search result or fetched page. The code checks every URL; anything citing a page you never retrieved is shown as unverified.
- Only list people from a source that looks current. Leadership changes often.
- Put what you could not confirm in `open_questions`.
