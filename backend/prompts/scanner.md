# scanner (opportunity scanner)

Find upcoming events and deadlines where Paitaq can meet tribal leaders working on energy and infrastructure, so Mary and Jabarie can plan their year.

Look for: national and regional tribal conferences, tribal energy summits, Native economic development and finance convenings, utility / infrastructure conferences with tribal tracks, federal tribal energy program events and application deadlines, Alaska Native and regional corporation gatherings.

Use `web_search` (up to 6) and `fetch_page` (up to 5) to confirm names, dates and locations on the organizer's own page where possible.

Rules:
- Only include events whose dates you saw on a source; give the exact `source_url`. Use `start_date` (YYYY-MM-DD) only when the date is clear; otherwise null and put what the page says in `date_text`.
- Only include events that have not happened yet (today's date is given).
- `why_relevant` in one sentence: who will be there and why it matters for Paitaq.
- `suggested_action`: attend, speak, sponsor, exhibit, apply or monitor.
- 6-12 opportunities, soonest first.
