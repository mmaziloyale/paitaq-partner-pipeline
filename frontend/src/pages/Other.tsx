import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { agentName, api, type LinkedInStatus, fmtDate, fmtDay, fmtNum, fmtUsd, type Action, type Draft, type Status } from '../api'
import { Badge, DraftCard, Empty, ErrorNote, JobProgress, useJob } from '../components'

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

// ---------- Follow-ups dashboard (computed in code from the action items: no AI, no cost) ----------

type Dash = {
  today: string
  kpis: { open: number; overdue: number; due_this_week: number; waiting_on_them: number; done_30d: number; on_time_rate: number | null; no_due_date: number }
  owners: { owner: string; open: number; overdue: number }[]
  nations: { target_id: number; name: string; interest_level: number | null; stage: string; open: number; overdue: number; waiting_on_them: number; done: number; next_due: string | null; last_call: string | null; next_call: string | null }[]
  aging: { bucket: string; count: number }[]
  upcoming: (Action & { target_name: string })[]
  overdue: (Action & { target_name: string })[]
  drafts_waiting: number
  commitments: {
    ours: Tally; theirs: Tally
    by_nation: { target_id: number; name: string; ours: Tally; theirs: Tally }[]
    ours_open: (Action & { target_name: string })[]; theirs_open: (Action & { target_name: string })[]
  }
  contact_next: NextContact[]
}
type Tally = { open: number; overdue: number; kept: number; late: number; kept_rate: number | null }
type NextContact = {
  key: string; target_id: number; nation: string; person: string; role: string; score: number
  reason: string; also: string[]; suggested_action: string; last_contact: string | null
}

function ContactNextRow({ c, onDone }: { c: NextContact; onDone: () => void }) {
  const [logging, setLogging] = useState(false)
  const [kind, setKind] = useState('email')
  const [note, setNote] = useState('')
  const urgent = c.score >= 90
  const log = async () => {
    await api('/api/touches', { method: 'POST', json: { target_id: c.target_id, person: c.person, kind, note } })
    setLogging(false); onDone()
  }
  return (
    <li className={urgent ? 'urgent' : ''}>
      <div className="who">
        <b>{c.person}</b>{c.role && <span className="muted small"> · {c.role}</span>}
        <div className="small"><Link to={`/targets/${c.target_id}`}>{c.nation}</Link>{c.last_contact ? <span className="muted"> · last contact {fmtDay(c.last_contact)}</span> : <span className="muted"> · not contacted yet</span>}</div>
      </div>
      <div className="why">
        <div>{urgent && '⚠ '}{c.reason}</div>
        {c.also.length > 0 && <div className="muted small">Also: {c.also.join(' · ')}</div>}
        <div className="small suggest">→ {c.suggested_action}</div>
        {logging && (
          <div className="row gap wrap log">
            <select value={kind} onChange={e => setKind(e.target.value)}>{['email', 'call', 'intro', 'event', 'other'].map(k => <option key={k}>{k}</option>)}</select>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Optional note" />
            <button className="primary" onClick={log}>Save</button><button className="ghost" onClick={() => setLogging(false)}>Cancel</button>
          </div>
        )}
      </div>
      {!logging && <div className="row gap">
        <button onClick={() => setLogging(true)}>Log contact</button>
        <button className="ghost" onClick={async () => { await api('/api/snooze', { method: 'POST', json: { key: c.key, days: 14 } }); onDone() }}>Snooze 2 wks</button>
      </div>}
    </li>
  )
}

function TallyBox({ title, t }: { title: string; t: Tally }) {
  return (
    <div className="tally">
      <div className="eyebrow">{title}</div>
      <div className="row gap wrap">
        <span><b>{t.open}</b> open</span>
        <span className={t.overdue ? 'bad-text' : ''}><b>{t.overdue}</b> {t.overdue ? '⚠ ' : ''}overdue</span>
        <span><b>{t.kept}</b> kept</span>
        <span><b>{t.late}</b> late</span>
        <span className="muted">{t.kept_rate != null ? `${t.kept_rate}% kept on time` : 'none completed yet'}</span>
      </div>
    </div>
  )
}

function HBars({ rows, max }: { rows: { label: string; value: number; overdue?: number; title: string }[]; max: number }) {
  return (
    <div className="hbars">
      {rows.map(r => {
        const ok = r.value - (r.overdue ?? 0)
        return (
          <div key={r.label} className="hbar-row" title={r.title}>
            <span className="hbar-label">{r.label}</span>
            <span className="hbar-track">
              {ok > 0 && <span className="hbar-fill" style={{ width: `${(100 * ok) / Math.max(max, 1)}%` }} />}
              {!!r.overdue && <span className="hbar-fill overdue" style={{ width: `${(100 * r.overdue) / Math.max(max, 1)}%` }} />}
            </span>
            <span className="hbar-value">{r.value}{r.overdue ? <span className="muted small"> ({r.overdue} overdue)</span> : ''}</span>
          </div>
        )
      })}
    </div>
  )
}

export function FollowUps() {
  const [d, setD] = useState<Dash | null>(null)
  const [actions, setActions] = useState<Action[]>([])
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [owner, setOwner] = useState('All')
  const [nation, setNation] = useState('All')
  const [targets, setTargets] = useState<{ id: number; name: string }[]>([])
  const [form, setForm] = useState({ target_id: 0, action: '', owner: 'Mary', due_date: '' })
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(() => {
    api<Dash>('/api/dashboard').then(setD).catch(e => setErr(e.message))
    api<Action[]>('/api/actions').then(setActions)
    api<Draft[]>('/api/drafts?status=needs_review').then(setDrafts)
  }, [])
  useEffect(() => { load(); api<{ id: number; name: string }[]>('/api/targets').then(setTargets) }, [load])
  const toggle = async (a: Action) => { await api(`/api/actions/${a.id}`, { method: 'PATCH', json: { status: 'done' } }); load() }
  const add = async () => {
    setErr(null)
    try { await api('/api/actions', { method: 'POST', json: { ...form, due_date: form.due_date || null } }); setForm({ ...form, action: '', due_date: '' }); load() }
    catch (e) { setErr((e as Error).message) }
  }
  if (!d) return err ? <ErrorNote error={err} /> : <Empty>Loading...</Empty>
  const k = d.kpis
  const shown = actions.filter(a => (owner === 'All' || a.owner === owner) && (nation === 'All' || String(a.target_id) === nation))
  const ownerMax = Math.max(...d.owners.map(o => o.open), 1)
  const agingMax = Math.max(...d.aging.map(a => a.count), 1)
  // "Waiting on you" strip, same pattern as the Pipeline page
  const soon = new Date(new Date(d.today + 'T12:00:00').getTime() + 7 * 864e5).toISOString().slice(0, 10)
  const owed = d.commitments.ours_open.filter(a => a.due_date && a.due_date <= soon).sort((a, b) => a.due_date!.localeCompare(b.due_date!))
  const draftsBy = Object.entries(drafts.reduce<Record<string, number>>((m, x) => { const n = x.target_name || 'Other'; m[n] = (m[n] || 0) + 1; return m }, {}))
  const waiting = owed.length + d.drafts_waiting + d.contact_next.length
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const days = (iso: string) => Math.round((new Date(iso + 'T12:00:00').getTime() - new Date(d.today + 'T12:00:00').getTime()) / 864e5)

  return (
    <div>
      <section className="hero compact">
        <div className="hero-text">
          <h1 className="display">Follow-ups</h1>
          <p className="lede">{plural(k.open, 'open follow-up')} · {k.overdue ? `⚠ ${k.overdue} overdue` : 'none overdue'} · {k.due_this_week} due this week · {k.waiting_on_them} waiting on the tribe · {k.done_30d} done in 30 days</p>
        </div>
        <div className="hero-actions">
          <details className="menu">
            <summary className="button quiet">Deal Team ▾</summary>
            <div className="menu-list">
              <a className="menu-item" href="/api/dealteam/export" title="from_partner_pipeline.json: what we learned, deal-relevant facts only">Export to Deal Team</a>
            </div>
          </details>
        </div>
      </section>
      <ErrorNote error={err} />
      {waiting > 0 && (
        <section className="waiting" aria-label="Waiting on you">
          <header><span className="w-title">Waiting on you · {waiting}</span><span className="muted small">Nothing goes out until you approve it</span></header>
          {owed.length > 0 && (
            <div className="w-row">
              <span><b>{plural(owed.length, 'promise')} {owed.some(a => a.due_date! < d.today) ? 'overdue or due soon' : 'due soon'}</b><span className="muted"> · {owed.map(a => `${a.target_name}: ${a.action} (${fmtDay(a.due_date)})`).join(' · ')}</span></span>
              <button className="button quiet" onClick={() => jump('timeline')}>See dates</button>
            </div>
          )}
          {d.drafts_waiting > 0 && (
            <div className="w-row">
              <span><b>{plural(d.drafts_waiting, 'draft')} to approve</b><span className="muted"> · {draftsBy.map(([n, c]) => `${n} ${c}`).join(' · ')}</span></span>
              <button className="button quiet" onClick={() => jump('drafts')}>Review drafts</button>
            </div>
          )}
          {d.contact_next.length > 0 && (
            <div className="w-row">
              <span><b>{plural(d.contact_next.length, 'person', 'people')} to contact</b><span className="muted"> · {d.contact_next.slice(0, 4).map(c => c.person).join(' · ')}{d.contact_next.length > 4 ? ' · ...' : ''}</span></span>
              <button className="button quiet" onClick={() => jump('contact-next')}>Open list</button>
            </div>
          )}
        </section>
      )}

      <div className="card" id="contact-next">
        <div className="row between wrap"><h3>Contact next</h3><span className="muted small">Ranked by urgency: promises due, leadership changes, upcoming events, relationships going quiet, leaders not yet met.</span></div>
        {d.contact_next.length === 0 ? <p className="muted">No one needs a nudge right now.</p> : (
          <ul className="contact-next">{d.contact_next.map(c => <ContactNextRow key={c.key} c={c} onDone={load} />)}</ul>
        )}
      </div>

      <div className="card">
        <h3>Commitments</h3>
        <div className="grid2 tight">
          <TallyBox title="What we promised them" t={d.commitments.ours} />
          <TallyBox title="What they promised us" t={d.commitments.theirs} />
        </div>
        {d.commitments.by_nation.length > 0 && (
          <table>
            <thead><tr><th>Nation</th><th>Ours: open</th><th>Ours: overdue</th><th>Ours: kept on time</th><th>Theirs: open</th><th>Theirs: overdue</th></tr></thead>
            <tbody>{d.commitments.by_nation.map(n => (
              <tr key={n.target_id}><td><Link to={`/targets/${n.target_id}`}>{n.name}</Link></td>
                <td>{n.ours.open}</td><td>{n.ours.overdue ? <Badge tone="bad">⚠ {n.ours.overdue}</Badge> : 0}</td>
                <td>{n.ours.kept_rate != null ? `${n.ours.kept_rate}%` : '-'}</td>
                <td>{n.theirs.open}</td><td>{n.theirs.overdue ? <Badge tone="warn">{n.theirs.overdue}</Badge> : 0}</td></tr>))}</tbody>
          </table>
        )}
        <p className="muted small">Keeping our word on small things is how trust gets built. "Kept" means done on or before the date we gave.</p>
      </div>

      <div className="grid2">
        <div className="card">
          <h3>Open follow-ups by owner</h3>
          <div className="legend"><span><i className="sw" /> on track</span><span><i className="sw overdue" /> overdue</span></div>
          <HBars max={ownerMax} rows={d.owners.map(o => ({ label: o.owner, value: o.open, overdue: o.overdue, title: `${o.owner}: ${o.open} open, ${o.overdue} overdue` }))} />
        </div>
        <div className="card">
          <h3>How long items have been open</h3>
          <HBars max={agingMax} rows={d.aging.map(a => ({ label: a.bucket, value: a.count, title: `${a.count} open items created ${a.bucket} ago` }))} />
          <p className="muted small">Items open 30+ days usually mean a relationship has stalled.</p>
        </div>
      </div>

      <div className="card">
        <h3>By nation</h3>
        <table>
          <thead><tr><th>Nation</th><th>Stage</th><th>Interest</th><th>Open</th><th>Overdue</th><th>Waiting on them</th><th>Next due</th><th>Last call</th><th>Next call</th></tr></thead>
          <tbody>{d.nations.map(n => (
            <tr key={n.target_id}>
              <td><Link to={`/targets/${n.target_id}`}>{n.name}</Link></td><td>{n.stage}</td><td>{n.interest_level ? `${n.interest_level}/5` : '-'}</td>
              <td>{n.open}</td><td>{n.overdue ? <Badge tone="bad">⚠ {n.overdue}</Badge> : 0}</td><td>{n.waiting_on_them}</td>
              <td>{n.next_due ? fmtDay(n.next_due) : '-'}</td><td>{n.last_call ? fmtDay(n.last_call) : '-'}</td>
              <td>{n.next_call ? fmtDay(n.next_call) : <span className="muted">none booked</span>}</td>
            </tr>))}</tbody>
        </table>
        {d.nations.length === 0 && <Empty>No follow-ups yet. After a call, capture follow-ups from Zoom's summary on the call page.</Empty>}
      </div>

      <div className="grid2">
        <div className="card" id="timeline">
          <h3>Next 3 weeks</h3>
          {d.overdue.length + d.upcoming.length === 0 ? <p className="muted">Nothing due.</p> : (
            <ul className="timeline">{[...d.overdue, ...d.upcoming.filter(u => !d.overdue.some(o => o.id === u.id))].map(a => {
              const n = days(a.due_date!)
              return (
                <li key={a.id} className={n < 0 ? 'late' : ''}>
                  <span className="when">{n < 0 ? `⚠ ${-n}d late` : n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n}d`}<small>{fmtDay(a.due_date)}</small></span>
                  <span><b>{a.action}</b><br /><span className="muted small">{a.owner_detail || a.owner} · <Link to={`/targets/${a.target_id}`}>{a.target_name}</Link></span></span>
                </li>)
            })}</ul>
          )}
        </div>
        <div className="card">
          <div className="row between wrap gap"><h3>All open follow-ups</h3>
            <div className="row gap filters">
              <select value={owner} onChange={e => setOwner(e.target.value)}>{['All', 'Mary', 'Jabarie', 'Tribe', 'Other'].map(o => <option key={o}>{o}</option>)}</select>
              <select value={nation} onChange={e => setNation(e.target.value)}><option value="All">All nations</option>{d.nations.map(n => <option key={n.target_id} value={n.target_id}>{n.name}</option>)}</select>
            </div></div>
          <ul className="checks">{shown.map(a => (
            <li key={a.id}>
              <input type="checkbox" onChange={() => toggle(a)} title="Mark done" />
              <span>{a.action}</span> <Badge tone={a.owner === 'Tribe' ? 'accent' : 'neutral'}>{a.owner_detail || a.owner}</Badge>
              {a.due_date && <Badge tone={a.due_date < d.today ? 'bad' : 'neutral'}>{a.due_date < d.today ? '⚠ overdue ' : 'due '}{fmtDay(a.due_date)}</Badge>}
              <Link className="small" to={`/targets/${a.target_id}`}>{a.target_name}</Link>
              {a.source === 'zoom' && <span className="muted small">from Zoom</span>}
            </li>))}</ul>
          {shown.length === 0 && <p className="muted">Nothing open for this filter.</p>}
          <details><summary>Add a follow-up by hand</summary>
            <div className="form-grid" style={{ marginTop: 10 }}>
              <label>Nation<select value={form.target_id} onChange={e => setForm({ ...form, target_id: Number(e.target.value) })}><option value={0}>Choose...</option>{targets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
              <label>Owner<select value={form.owner} onChange={e => setForm({ ...form, owner: e.target.value })}>{['Mary', 'Jabarie', 'Tribe', 'Other'].map(o => <option key={o}>{o}</option>)}</select></label>
              <label className="span2">What<input value={form.action} onChange={e => setForm({ ...form, action: e.target.value })} /></label>
              <label>Due<input type="date" value={form.due_date} onChange={e => setForm({ ...form, due_date: e.target.value })} /></label>
              <div className="row"><button className="primary" disabled={!form.target_id || form.action.length < 3} onClick={add}>Add</button></div>
            </div>
          </details>
        </div>
      </div>

      <h2 id="drafts">Emails to approve ({drafts.length})</h2>
      {drafts.length === 0 ? <p className="muted">Nothing waiting.</p> : drafts.map(dr => <DraftCard key={dr.id} draft={dr} onChange={load} />)}
    </div>
  )
}

// ---------- Gatherings: the scanner's separate, on-demand events calendar ----------

type Opp = { id: number; name: string; organizer: string; kind: string; start_date: string | null; date_text: string; location: string; why_relevant: string; suggested_action: string; source_url: string; verified: number; status: string }

export function Gatherings() {
  const [opps, setOpps] = useState<Opp[] | null>(null)
  const [focus, setFocus] = useState('')
  const [jobId, setJobId] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(() => api<Opp[]>('/api/opportunities').then(setOpps), [])
  useEffect(() => { load() }, [load])
  const job = useJob(jobId, () => load())
  const scan = async () => {
    setErr(null)
    try { const r = await api<{ job_id: number }>('/api/opportunities/scan', { method: 'POST', json: { focus } }); setJobId(r.job_id) }
    catch (e) { setErr((e as Error).message) }
  }
  const setStatus = async (o: Opp, status: string) => { await api(`/api/opportunities/${o.id}`, { method: 'PATCH', json: { status } }); load() }
  const groups = new Map<string, Opp[]>()
  for (const o of opps ?? []) {
    const key = o.start_date ? new Date(o.start_date + 'T12:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : 'Date to confirm'
    groups.set(key, [...(groups.get(key) ?? []), o])
  }
  return (
    <div>
      <div className="page-head"><div><h1>Gatherings</h1><p className="lede">Conferences, council meetings and community events where we can see a nation's people in person. The scanner runs separately from the pipeline, whenever you ask.</p></div></div>
      <div className="card row gap">
        <input value={focus} onChange={e => setFocus(e.target.value)} placeholder="Optional focus, e.g. 'Alaska Native energy', 'tribal utility summits', 'DOE tribal grant deadlines'" />
        <button className="primary" disabled={job?.status === 'running'} onClick={scan}>Scan for gatherings</button>
      </div>
      <ErrorNote error={err} />
      <JobProgress job={job} title="scanner is finding gatherings" />
      {!opps ? <Empty>Loading...</Empty> : opps.length === 0 ? <Empty>No gatherings yet. Run a scan.</Empty> : [...groups.entries()].map(([month, items]) => (
        <section key={month}><h2>{month}</h2>
          <div className="grid2">{items.map(o => (
            <div key={o.id} className={`card opp ${o.status}`}>
              <div className="row between"><b>{o.name}</b><Badge tone="accent">{o.suggested_action}</Badge></div>
              <div className="muted small">{[o.date_text || fmtDay(o.start_date), o.location, o.organizer].filter(Boolean).join(' · ')}</div>
              <p>{o.why_relevant}</p>
              <div className="row between">
                <span className="source">{o.source_url && <a href={o.source_url} target="_blank" rel="noreferrer">source</a>} {!o.verified && <Badge tone="warn">unverified</Badge>}</span>
                <div className="row gap">
                  {o.status !== 'planned' ? <button onClick={() => setStatus(o, 'planned')}>Add to plan</button> : <Badge tone="good">In our plan</Badge>}
                  <button className="ghost" onClick={() => setStatus(o, 'dismissed')}>Dismiss</button>
                </div>
              </div>
            </div>))}</div>
        </section>
      ))}
    </div>
  )
}

// ---------- Network ----------

type Contact = { id: number; first_name: string; last_name: string; company: string; position: string; owner: string; relationship: string; strength: string; source: string }

export function Network() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<Status | null>(null)
  const [owner, setOwner] = useState('Mary')
  const [msg, setMsg] = useState<string | null>(null)
  const [li, setLi] = useState<LinkedInStatus | null>(null)
  const [liBusy, setLiBusy] = useState(false)
  const [liErr, setLiErr] = useState<string | null>(null)
  const load = useCallback(() => { api<Contact[]>(`/api/contacts?q=${encodeURIComponent(q)}`).then(setContacts); api<Status>('/api/status').then(setStatus); api<LinkedInStatus>('/api/linkedin').then(setLi) }, [q])
  const liAction = async (what: 'open' | 'close') => {
    setLiBusy(true); setLiErr(null)
    try { setLi(await api<LinkedInStatus>(`/api/linkedin/${what}`, { method: 'POST' })) } catch (e) { setLiErr((e as Error).message) } finally { setLiBusy(false) }
  }
  useEffect(() => { load() }, [load])
  const upload = async (f: File) => {
    const fd = new FormData(); fd.append('file', f); fd.append('owner', owner)
    const r = await api<{ imported: number }>('/api/contacts/import', { method: 'POST', body: fd }); setMsg(`Imported ${r.imported} contacts for ${owner}.`); load()
  }
  const sample = contacts.some(c => c.relationship.startsWith('FICTIONAL'))
  return (
    <div>
      <div className="page-head"><div><h1>Network</h1><p className="lede">Mary's and Jabarie's contacts: what the connector agent searches for warm paths.</p></div></div>
      {sample && <div className="banner info">This is <b>fictional sample data</b> for the demo. Import your real LinkedIn export below to replace it.</div>}
      <div className="grid2">
        <div className="card">
          <h3>Monthly refresh</h3>
          {status?.network.map(n => <p key={n.owner}><b>{n.owner}</b>: {n.last_import ? `last refreshed ${fmtDay(n.last_import)}` : 'never imported'} {n.overdue ? <Badge tone="warn">due</Badge> : <Badge tone="good">up to date</Badge>}</p>)}
          <details><summary>How to export from LinkedIn (2 minutes)</summary>
            <ol><li>LinkedIn → Me → Settings &amp; Privacy → Data privacy → Download my data.</li><li>Choose the <b>larger data archive</b> (it includes connections), click Request archive.</li><li>Download the file from LinkedIn's email and upload <code>Connections.csv</code> here.</li></ol>
            <p className="muted small">LinkedIn's export no longer includes connections' current company or title, so warm paths match mostly on names. The optional LinkedIn window below fills that gap.</p></details>
        </div>
        <div className="card stack">
          <h3>Import contacts</h3>
          <label>Whose network<select value={owner} onChange={e => setOwner(e.target.value)}><option>Mary</option><option>Jabarie</option></select></label>
          <label className="button">Upload Connections.csv<input type="file" accept=".csv" hidden onChange={e => e.target.files?.[0] && upload(e.target.files[0])} /></label>
          {msg && <div className="banner info">{msg}</div>}
        </div>
      </div>
      <div className="card stack">
        <div className="row between"><h3>LinkedIn window <span className="muted small">(optional)</span></h3>
          {li && (li.signed_in ? <Badge tone="good">signed in</Badge> : li.open ? <Badge tone="warn">open, not signed in</Badge> : <Badge>{li.enabled ? 'closed' : 'off'}</Badge>)}</div>
        <p className="muted small">The app's own browser window with its own profile, separate from your everyday Chrome. You sign in yourself; the app never sees your password. While it's signed in, the connector agent can search your 1st-degree connections (at most 3 searches per run, read-only: it never messages or connects).</p>
        {li && !li.enabled && <p className="small">Turned off. To use it: add <code>LINKEDIN_BROWSER=1</code> to <code>.env</code>, run <code>pip install -r requirements-linkedin.txt</code> and <code>python -m playwright install chromium</code>, then restart.</p>}
        {li && li.enabled && !li.installed && <p className="small">Playwright isn't installed yet: run <code>pip install -r requirements-linkedin.txt</code> and <code>python -m playwright install chromium</code>, then restart.</p>}
        {li && li.enabled && li.installed && <div className="row gap">
          <button className="primary" disabled={liBusy} onClick={() => liAction('open')}>{li.open ? 'Show LinkedIn window' : 'Open LinkedIn window'}</button>
          {li.open && <button className="ghost" disabled={liBusy} onClick={() => liAction('close')}>Close it</button>}
          <button className="ghost" disabled={liBusy} onClick={load}>Check sign-in</button>
        </div>}
        {liErr && <div className="banner bad">{liErr}</div>}
      </div>
      <div className="card">
        <div className="row between"><h3>Contacts ({contacts.length})</h3><input className="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, organization, title" /></div>
        <table><thead><tr><th>Name</th><th>Organization</th><th>Title</th><th>Whose</th><th>Strength</th><th>How we know them</th></tr></thead>
          <tbody>{contacts.map(c => <tr key={c.id}><td>{c.first_name} {c.last_name} {c.source === 'meeting' && <Badge tone="accent">from a call</Badge>}</td><td>{c.company}</td><td>{c.position}</td><td>{c.owner}</td><td>{c.strength}</td><td className="small">{c.relationship}</td></tr>)}</tbody></table>
      </div>
    </div>
  )
}

// ---------- Usage & Safety ----------

type Usage = {
  by_agent: { agent: string; runs: number; input_tokens: number; cached_input_tokens: number; output_tokens: number; cost_usd: number; avg_ms: number; failures: number }[]
  by_job: { id: number; kind: string; status: string; created_at: string; target_name: string | null; input_tokens: number; cached_input_tokens: number; output_tokens: number; cost_usd: number; agent_runs: number }[]
  totals: { runs: number; input_tokens: number; cached_input_tokens: number; output_tokens: number; cost_usd: number }
  pricing: { input_per_m: number; cached_input_per_m: number; output_per_m: number; note: string }; model: string
}
type SafetyEvent = { id: number; kind: string; agent: string; target_name: string | null; detail: string; evidence: string; created_at: string }
type SelfTest = { injection: { text: string; caught: boolean; expected: boolean }[]; outgoing: { text: string; flagged: boolean; expected: boolean }[] }

export function UsageSafety() {
  const [u, setU] = useState<Usage | null>(null)
  const [s, setS] = useState<{ events: SafetyEvent[]; counts: { kind: string; n: number }[] } | null>(null)
  const [test, setTest] = useState<SelfTest | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [users, setUsers] = useState(100)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    api<Usage>('/api/usage').then(setU).catch(e => setErr(e.message))
    api('/api/safety').then(setS)
    api<Status>('/api/status').then(setStatus)
  }, [])
  const avg = (kind: string) => {
    const rows = u?.by_job.filter(j => j.kind === kind && j.status === 'done' && j.cost_usd > 0) ?? []  // finished runs only
    return rows.length ? rows.reduce((a, j) => a + j.cost_usd, 0) / rows.length : null
  }
  const perPipeline = avg('pipeline'), perPrep = avg('prep'), perMeeting = avg('meeting')
  // A user's month (assumption shown on screen): 4 new targets, 6 call preps, 6 meetings, 1 scan
  const perUserMonth = perPipeline != null ? 4 * perPipeline + 6 * (perPrep ?? 0) * 1.5 + 6 * (perMeeting ?? 0) + (avg('scan') ?? 0) : null
  return (
    <div>
      <div className="page-head"><div><h1>Usage &amp; Safety</h1><p className="lede">Measured from every agent run in this app: tokens, cost, and what the guards caught.</p></div>
        <a className="button" href="/api/usage.csv">Download run log (CSV)</a></div>
      <ErrorNote error={err} />
      {status?.pricing_is_placeholder && <div className="banner warn">Costs use <b>placeholder prices</b> from <code>pricing.json</code>. Put in the real prices for {status.model} before quoting dollar figures.</div>}
      {u && (
        <>
          <div className="kpis">
            <div className="kpi"><span>Agent runs</span><b>{fmtNum(u.totals.runs)}</b></div>
            <div className="kpi"><span>Input tokens</span><b>{fmtNum(u.totals.input_tokens)}</b><small>{u.totals.input_tokens ? Math.round(100 * u.totals.cached_input_tokens / u.totals.input_tokens) : 0}% cached</small></div>
            <div className="kpi"><span>Output tokens</span><b>{fmtNum(u.totals.output_tokens)}</b></div>
            <div className="kpi"><span>Total cost</span><b>{fmtUsd(u.totals.cost_usd)}</b></div>
            <div className="kpi"><span>Today's budget</span><b>{status ? Math.round(100 * status.tokens_today / status.daily_token_budget) : 0}%</b><small>{fmtNum(status?.tokens_today)} of {fmtNum(status?.daily_token_budget)}</small></div>
          </div>
          <div className="grid2">
            <div className="card"><h3>By agent</h3>
              <table><thead><tr><th>Agent</th><th>Runs</th><th>Avg in</th><th>Avg out</th><th>Avg time</th><th>Avg cost</th></tr></thead>
                <tbody>{u.by_agent.map(a => <tr key={a.agent}><td>{agentName(a.agent)}{a.failures ? <Badge tone="bad">{a.failures} failed</Badge> : null}</td><td>{a.runs}</td>
                  <td>{fmtNum(a.input_tokens / a.runs)}</td><td>{fmtNum(a.output_tokens / a.runs)}</td><td>{(a.avg_ms / 1000).toFixed(1)}s</td><td>{fmtUsd(a.cost_usd / a.runs)}</td></tr>)}</tbody></table>
            </div>
            <div className="card"><h3>Cost at scale</h3>
              <p className="muted small">Measured averages over finished runs: full pipeline {fmtUsd(perPipeline)}, call prep {fmtUsd(perPrep)}, meeting {fmtUsd(perMeeting)}. Assumed month per user: 4 new nations, 6 calls (prep + 24h refresh), 6 meetings, 1 scan.</p>
              <p>Per user per month: <b>{fmtUsd(perUserMonth)}</b></p>
              <label>Users<input type="range" min={1} max={10000} step={1} value={users} onChange={e => setUsers(Number(e.target.value))} /></label>
              <p className="big">{fmtNum(users)} users → <b>{perUserMonth != null ? fmtUsd(users * perUserMonth) : '-'}</b> / month</p>
            </div>
          </div>
          <div className="card"><h3>Recent runs</h3>
            <table><thead><tr><th>When</th><th>Task</th><th>Target</th><th>Agents</th><th>Input</th><th>Cached</th><th>Output</th><th>Cost</th></tr></thead>
              <tbody>{u.by_job.map(j => <tr key={j.id}><td>{fmtDate(j.created_at)}</td><td>{j.kind}</td><td>{j.target_name ?? '-'}</td><td>{j.agent_runs}</td><td>{fmtNum(j.input_tokens)}</td><td>{fmtNum(j.cached_input_tokens)}</td><td>{fmtNum(j.output_tokens)}</td><td>{fmtUsd(j.cost_usd)}</td></tr>)}</tbody></table>
            {u.by_job.length === 0 && <Empty>No runs yet.</Empty>}
          </div>
        </>
      )}
      <h2>Safety</h2>
      <div className="grid2">
        <div className="card">
          <h3>Guard self-test</h3>
          <p className="muted small">Runs known attack strings through the code-level guards (instant, no AI, no cost).</p>
          <button onClick={() => api<SelfTest>('/api/safety/selftest', { method: 'POST' }).then(setTest)}>Run self-test</button>
          {test && <ul className="selftest">
            {test.injection.map((t, i) => <li key={i}>{t.caught === t.expected ? '✅' : '❌'} {t.expected ? 'Attack' : 'Normal text'} {t.caught ? 'blocked' : 'allowed'}: <span className="muted">“{t.text}”</span></li>)}
            {test.outgoing.map((t, i) => <li key={'o' + i}>{t.flagged === t.expected ? '✅' : '❌'} Outgoing {t.flagged ? 'flagged' : 'allowed'}: <span className="muted">“{t.text}”</span></li>)}
          </ul>}
        </div>
        <div className="card"><h3>What the guards caught</h3>
          {s?.counts.length ? <div className="row gap wrap">{s.counts.map(c => <Badge key={c.kind} tone="accent">{c.kind.replace(/_/g, ' ')}: {c.n}</Badge>)}</div> : <p className="muted">Nothing yet.</p>}
          <ul className="small">
            <li><b>injection blocked</b>: instruction-like text removed from web pages, Zoom summaries and invites before the AI saw it</li>
            <li><b>unverified fact</b>: a fact cited a page the agent never opened</li>
            <li><b>invented contact</b>: a warm path named someone not in the network (dropped)</li>
            <li><b>compliance</b>: fundraising or return language in a message to a tribe</li>
            <li><b>consent</b>: a Zoom AI summary was refused because participant consent wasn't confirmed</li>
            <li><b>budget / run capped</b>: spending limits stopped an agent</li>
          </ul>
        </div>
      </div>
      <div className="card"><h3>Safety log</h3>
        <table><thead><tr><th>When</th><th>Guard</th><th>Agent</th><th>Target</th><th>What happened</th><th>Evidence</th></tr></thead>
          <tbody>{s?.events.map(e => <tr key={e.id}><td>{fmtDate(e.created_at)}</td><td><Badge>{e.kind.replace(/_/g, ' ')}</Badge></td><td>{agentName(e.agent)}</td><td>{e.target_name ?? '-'}</td><td>{e.detail}</td><td className="small mono">{e.evidence}</td></tr>)}</tbody></table>
        {!s?.events.length && <Empty>No events yet.</Empty>}
      </div>
    </div>
  )
}
