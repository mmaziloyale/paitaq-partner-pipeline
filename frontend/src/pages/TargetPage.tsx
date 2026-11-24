import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { agentName, api, fmtDate, fmtDay, fmtNum, fmtUsd, STAGES, type Action, type Call, type Deal, type Draft, type Fact, type Profile, type Target, type WarmPath } from '../api'
import { Badge, DraftCard, Empty, ErrorNote, Interest, JobProgress, Source, useJob } from '../components'
import { ScheduleCall } from './Calls'

type Detail = {
  target: Target; profile: Profile | null; verified: Record<string, boolean[]> | null; profile_updated: string | null
  warm_paths: { paths: WarmPath[]; gaps: string } | null; deals: Deal[]; drafts: Draft[]; calls: Call[]; actions: Action[]
  notes: { id: number; source: string; text: string; created_at: string }[]
  runs: { id: number; agent: string; input_tokens: number; cached_input_tokens: number; output_tokens: number; cost_usd: number; duration_ms: number; ok: number; error: string | null; created_at: string }[]
  job: { id: number } | null
  edge?: { nearby: { id: number; name: string; state: string; stage: string }[]; gatherings: { id: number; name: string; date_text: string; location: string; status: string }[] }
}

const TABS = ['Profile', 'Warm paths', 'Outreach', 'Calls', 'Actions & notes', 'Agent runs'] as const

export default function TargetPage() {
  const { id } = useParams()
  const [d, setD] = useState<Detail | null>(null)
  const [tab, setTab] = useState<(typeof TABS)[number]>('Profile')
  const [jobId, setJobId] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(() => api<Detail>(`/api/targets/${id}`).then(x => { setD(x); if (x.job) setJobId(x.job.id) }).catch(e => setErr(e.message)), [id])
  useEffect(() => { load() }, [load])
  const job = useJob(jobId, () => load())

  const run = async (step: string, force = false) => {
    setErr(null)
    try { const r = await api<{ job_id: number }>(`/api/targets/${id}/run/${step}?force=${force}`, { method: 'POST' }); setJobId(r.job_id) }
    catch (e) { setErr((e as Error).message) }
  }
  if (!d) return err ? <ErrorNote error={err} /> : <Empty>Loading...</Empty>
  const t = d.target
  const busy = job?.status === 'running'
  const stageIdx = STAGES.indexOf(t.stage)

  return (
    <div>
      <Link to="/" className="back">← Pipeline</Link>
      <div className="page-head">
        <div>
          <h1>{t.name} <Interest level={t.interest_level} /></h1>
          <p className="lede">{[t.state, t.region, t.project_focus].filter(Boolean).join(' · ')}</p>
          {t.rationale && <p className="muted">Why we're looking: {t.rationale}</p>}
        </div>
        <div className="stack right">
          <button className="primary big" disabled={busy} onClick={() => run('pipeline')}>{busy ? 'Agents working...' : 'Run full pipeline'}</button>
          <span className="muted small">research → connector → outreach → reviewer</span>
        </div>
      </div>
      <Progress d={d} stageIdx={stageIdx} busy={busy} onTab={setTab} onRun={() => run('pipeline')} />
      <ErrorNote error={err} />
      <JobProgress job={job} />
      <Snapshot d={d} onTab={setTab} onResearch={() => run('research')} busy={busy} />
      {Object.keys(t.data).length > 0 && (
        <details className="card data"><summary>Paitaq mapping data ({Object.keys(t.data).length} fields)</summary>
          <dl>{Object.entries(t.data).map(([k, v]) => <div key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd>{v}</dd></div>)}</dl>
        </details>
      )}
      <div className="tabs">{TABS.map(x => <button key={x} className={x === tab ? 'on' : ''} onClick={() => setTab(x)}>{x}{x === 'Outreach' && d.drafts.filter(dr => dr.status === 'needs_review').length ? ' •' : ''}</button>)}</div>

      {tab === 'Profile' && <ProfileView d={d} onRefresh={() => run('research')} busy={busy} />}
      {tab === 'Warm paths' && (
        <div>
          <div className="row between"><p className="muted">Warm intros from Mary's and Jabarie's network. Every contact is checked against the database.</p>
            <button disabled={busy} onClick={() => run('connect')}>Find paths again</button></div>
          {!d.warm_paths ? <Empty>No paths yet. Run the pipeline.</Empty> : (
            <>
              {d.warm_paths.paths.length === 0 && <Empty>No warm paths in the network for this nation.</Empty>}
              <div className="grid2">
                {d.warm_paths.paths.map((p, i) => (
                  <div key={i} className="card path">
                    <div className="row between"><b>{i + 1}. {p.contact_name}</b><Badge tone={p.strength === 'strong' ? 'good' : p.strength === 'medium' ? 'accent' : 'neutral'}>{p.strength}</Badge></div>
                    <div className="muted small">{p.contact_org} · {p.owner}'s contact</div>
                    <Bullets text={p.why_this_path} />
                    <dl className="kv"><dt>Introduces to</dt><dd>{p.could_introduce_to}</dd><dt>The ask</dt><dd>{p.suggested_ask}</dd></dl>
                  </div>
                ))}
              </div>
              {d.warm_paths.gaps && <div className="card note"><h3>Gaps in the network</h3><Bullets text={d.warm_paths.gaps} /></div>}
            </>
          )}
        </div>
      )}
      {tab === 'Outreach' && (
        <div>
          <div className="row between"><p className="muted">Drafted by Outreach, checked by Reviewer and code. Nothing is sent: you approve, then send from your own email.</p>
            <button disabled={busy} onClick={() => run('outreach')}>Draft again</button></div>
          {d.drafts.length === 0 ? <Empty>No drafts yet.</Empty> : d.drafts.map(dr => <DraftCard key={dr.id} draft={dr} onChange={load} />)}
        </div>
      )}
      {tab === 'Calls' && <CallsTab d={d} />}
      {tab === 'Actions & notes' && <ActionsTab d={d} reload={load} />}
      {tab === 'Agent runs' && (
        <div className="card">
          <table>
            <thead><tr><th>When</th><th>Agent</th><th>Input</th><th>Cached</th><th>Output</th><th>Time</th><th>Cost</th><th /></tr></thead>
            <tbody>{d.runs.map(r => (
              <tr key={r.id}><td>{fmtDate(r.created_at)}</td><td>{agentName(r.agent)}</td><td>{fmtNum(r.input_tokens)}</td><td>{fmtNum(r.cached_input_tokens)}</td><td>{fmtNum(r.output_tokens)}</td>
                <td>{(r.duration_ms / 1000).toFixed(1)}s</td><td>{fmtUsd(r.cost_usd)}</td><td>{r.ok ? '' : <Badge tone="bad" >{r.error?.slice(0, 60)}</Badge>}</td></tr>
            ))}</tbody>
          </table>
          {d.runs.length === 0 && <Empty>No agent runs yet.</Empty>}
        </div>
      )}
    </div>
  )
}

// ---------- progress: the board's four columns as a stepper, plus what to do next ----------

const PHASES = [
  { title: 'Research', stages: ['Identified', 'Researched'] },
  { title: 'Outreach', stages: ['Paths found', 'Outreach drafted', 'Outreach approved'] },
  { title: 'Call', stages: ['Call scheduled'] },
  { title: 'Follow-up', stages: ['Met', 'Follow-up'] },
]

function Progress({ d, stageIdx, busy, onTab, onRun }: { d: Detail; stageIdx: number; busy: boolean; onTab: (t: (typeof TABS)[number]) => void; onRun: () => void }) {
  const stage = STAGES[Math.max(stageIdx, 0)]
  const cur = PHASES.findIndex(ph => ph.stages.includes(stage))
  const toReview = d.drafts.filter(x => x.status === 'needs_review').length
  const nextCall = [...d.calls].filter(c => c.status === 'scheduled').sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))[0]
  const go = (label: string, fn: () => void) => <button className="linkish" disabled={busy} onClick={fn}>{label} →</button>
  const step: Record<string, [string, React.ReactNode]> = {
    'Identified': ['Not researched yet', go('Run full pipeline', onRun)],
    'Researched': ['Profile ready; no warm paths yet', go('Find warm paths', () => onTab('Warm paths'))],
    'Paths found': ['Warm paths found; no drafts yet', go('Draft outreach', () => onTab('Outreach'))],
    'Outreach drafted': [toReview ? `Drafts ready, waiting for your approval` : 'Drafts written', go(toReview ? `Review ${toReview} draft${toReview > 1 ? 's' : ''}` : 'Open drafts', () => onTab('Outreach'))],
    'Outreach approved': ['Outreach approved: send it from your own email', go('Schedule a call', () => onTab('Calls'))],
    'Call scheduled': [nextCall ? `Call booked for ${fmtDate(nextCall.scheduled_at)}` : 'Call booked', nextCall ? <Link to={`/calls/${nextCall.id}`} className="linkish">Open the brief →</Link> : null],
    'Met': ['Met; follow-ups captured', <Link to="/followups" className="linkish">Open follow-ups →</Link>],
    'Follow-up': ['Following up on commitments', <Link to="/followups" className="linkish">Open follow-ups →</Link>],
  }
  const [detail, action] = step[stage] ?? ['', null]
  return (
    <div className="progress" aria-label="Progress with this nation">
      <ol className="stepper">{PHASES.map((ph, i) => (
        <li key={ph.title} className={i < cur ? 'done' : i === cur ? 'now' : ''}>
          <span className="dot">{i < cur ? '✓' : ''}</span><span className="name">{ph.title}</span>
        </li>))}</ol>
      <p className="progress-next">{detail}{action && <> · <b>Next:</b> {action}</>}</p>
    </div>
  )
}

// ---------- top of the page: value, what to cover, at a glance ----------

const splitList = (t: string) => (t || '').replace(/^SAMPLE:\s*/i, '').split(/\s*(?:[;,]|\band\b)\s+(?![^()]*\))/i).map(x => x.trim().replace(/\.$/, '')).filter(x => x.length > 2)
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1)
const short = (t: string, n = 20) => { const w = t.replace(/^(As of (the )?sources? retrieved,?|According to [^,]+,)\s*/i, '').split(/\s+/); return w.length > n ? w.slice(0, n).join(' ') + '…' : w.join(' ') }

function Snapshot({ d, onTab, onResearch, busy }: { d: Detail; onTab: (t: (typeof TABS)[number]) => void; onResearch: () => void; busy: boolean }) {
  const t = d.target, p = d.profile
  const deals = [...d.deals].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const top = deals[0]
  const forNation = top ? splitList(top.what_the_tribe_would_receive).map(cap) : []
  const paths = d.warm_paths?.paths ?? []
  const best = paths.find(x => x.strength === 'strong') ?? paths[0]
  const forPaitaq = [
    ...deals.map(x => [x.project_type, x.size && x.size !== 'SAMPLE' ? x.size : '', x.score != null ? `fit ${x.score}` : ''].filter(Boolean).join(' · ')),
  ]
  const v = d.verified || {}
  const sourced = (items: Fact[] | undefined, key: string) => (items ?? []).map((f, i) => ({ f, ok: v[key]?.[i] !== false }))
  const whyNow = sourced(p?.why_now, 'why_now'), partners = sourced(p?.other_partners, 'other_partners')
  const edge = d.edge ?? { nearby: [], gatherings: [] }
  const met = d.calls.filter(c => c.status === 'met').length
  const matches = (p?.priorities ?? []).slice(0, 2).map(f => short(f.fact || f.description || '', 14))

  const lastMet = [...d.calls].filter(c => c.meeting).sort((a, b) => b.scheduled_at.localeCompare(a.scheduled_at))[0]
  const nextCall = [...d.calls].filter(c => c.status === 'scheduled').sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))[0]
  const seen = new Set<string>()
  const topics: { text: string; tag: string }[] = []
  const add = (text: string, tag: string) => { const k = text.toLowerCase().slice(0, 60); if (text && !seen.has(k)) { seen.add(k); topics.push({ text, tag }) } }
  lastMet?.meeting?.unanswered_questions.forEach(q => add(q, 'carried over'))
  nextCall?.brief?.questions.filter(q => q.priority === 'must_ask').forEach(q => add(q.question, 'must ask'))
  deals.forEach(x => x.questions.forEach(q => add(q, 'Deal Team')))
  p?.confirm_with_introducer?.slice(0, 2).forEach(q => add(q, 'confirm first'))
  const glance = toBullets(p?.summary ?? '').slice(0, 4)

  return (
    <section className="snapshot">
      {nextCall && <Link to={`/calls/${nextCall.id}`} className="next-up">Next call: <b>{nextCall.title}</b> · {fmtDate(nextCall.scheduled_at)} →</Link>}
      <div className="card edge">
        <div className="eyebrow">Why Paitaq, why now</div>
        <div className="value-cols">
          <div><h4>Our edge</h4><ul>
            {forPaitaq.map((x, i) => <li key={'d' + i}>Deal Team fit: {x}{i === 0 && top && <> {top.approved_to_share ? <Badge tone="good">proposal approved to share</Badge> : <Badge tone="warn">don't share the proposal yet</Badge>}</>}</li>)}
            {best ? <li>{paths.length} warm path{paths.length > 1 ? 's' : ''}; best: <b>{best.contact_name}</b> ({best.strength}, {best.owner}'s contact) → {short(best.could_introduce_to, 10)}</li>
              : <li className="muted">No warm path yet. <button className="ghost small" onClick={() => onTab('Warm paths')}>Find paths</button></li>}
            {met > 0 && <li>Met {met}×; their interest so far {t.interest_level ?? '?'}/5</li>}
            {edge.gatherings.map(g => <li key={g.id}>See them at <Link to="/gatherings">{g.name}</Link> <span className="muted small">{g.date_text}</span> {g.status === 'planned' && <Badge tone="good">planned</Badge>}</li>)}
            {edge.nearby.length > 0 && <li>Regional cluster: {edge.nearby.map((o, i) => <span key={o.id}>{i > 0 && ', '}<Link to={`/targets/${o.id}`}>{o.name}</Link></span>)} also in the pipeline</li>}
          </ul></div>
          <div><h4>Why now</h4>{whyNow.length ? <ul>{whyNow.map(({ f, ok }, i) => <li key={i}>{f.fact} <Source url={f.source_url} verified={ok} /></li>)}</ul>
            : <p className="muted small">{p && !p.why_now ? <>Not looked for yet: the current profile predates this section. <button className="linkish" disabled={busy} onClick={onResearch}>Research again now →</button> <span className="small">(about 1 min)</span></> : 'Nothing timely found.'}</p>}
            <h4 className="mt">Already working with</h4>{partners.length ? <ul>{partners.map(({ f, ok }, i) => <li key={i}>{f.fact} <Source url={f.source_url} verified={ok} /></li>)}</ul>
            : <p className="muted small">{p && !p.other_partners ? 'Filled in by the same research run.' : 'No announced partners found.'}</p>}</div>
        </div>
      </div>
      <div className="card value">
        <div className="eyebrow">Benefits to the Nation</div>
        {top ? (
          <ul className="benefits">{forNation.map((x, i) => <li key={i}>{x}</li>)}
            {matches.length > 0 && <li>Fits what they've said matters: {matches.join('; ')}</li>}</ul>
        ) : <p className="muted">No Deal Team deal for this nation yet. {t.rationale && <>Why we're looking: {t.rationale}</>}</p>}
      </div>
      <div className="grid2 compact">
        <div className="card"><h3>Key questions &amp; topics</h3>
          {topics.length ? <ul>{topics.slice(0, 6).map((x, i) => <li key={i}>{x.text} <Badge tone={x.tag === 'carried over' ? 'warn' : x.tag === 'must ask' ? 'accent' : 'neutral'}>{x.tag}</Badge></li>)}</ul>
            : <p className="muted small">None yet. Import a Deal Team file or book a call.</p>}
        </div>
        <div className="card"><h3>At a glance</h3>
          {glance.length ? <ul>{glance.map((x, i) => <li key={i} title={x}>{short(x)}</li>)}</ul> : <p className="muted small">No research yet.</p>}
          <button className="ghost small" onClick={() => onTab('Profile')}>Full profile ↓</button>
        </div>
      </div>
      {deals.length > 0 && (
        <details className="card deals"><summary>Deal Team details ({deals.length})</summary>
          {deals.map(x => (
            <div key={x.opportunity_id} className="deal">
              <div className="row gap wrap"><b>{x.project_type}</b><Badge>{x.opportunity_id}</Badge>{x.site && <span className="muted small">{x.site}</span>}</div>
              <p className="small">{x.one_line}</p>
            </div>))}
        </details>
      )}
    </section>
  )
}

// Long agent text → short bullets. Splits on lines ("- ...") or sentences, so older saved text reads as bullets too.
function toBullets(text: string): string[] {
  if (!text) return []
  const lines = text.split(/\n+/).map(l => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean)
  const parts = lines.length > 1 ? lines : text.split(/(?<=[.!?;])\s+(?=[A-Z\u201C"(])/)
  return parts.map(x => x.trim().replace(/[.;]$/, '')).filter(Boolean)
}
function Bullets({ text, className }: { text: string; className?: string }) {
  const items = toBullets(text)
  if (items.length <= 1) return <p className={className}>{items[0] ?? text}</p>
  return <ul className={`bullets ${className ?? ''}`}>{items.map((b, i) => <li key={i}>{b}</li>)}</ul>
}

const SIGNAL_LABEL: Record<string, string> = {
  leadership_change: 'Leadership change', election: 'Election', council_meeting: 'Council meeting',
  community_event: 'Community event', public_statement: 'Public statement', other: 'Signal',
}

function FactList({ title, items, flags }: { title: string; items: Fact[]; flags?: boolean[] }) {
  if (!items?.length) return null
  return (
    <div className="card">
      <h3>{title}</h3>
      <ul className="facts">{items.map((f, i) => (
        <li key={i}>
          {f.description != null ? (
            <><Badge tone={f.kind === 'leadership_change' || f.kind === 'election' ? 'accent' : 'neutral'}>{SIGNAL_LABEL[f.kind || 'other'] || f.kind}</Badge>{' '}
              {f.date && <b>{fmtDay(f.date)}: </b>}{toBullets(f.description)[0]}</>
          ) : f.fact ?? (
            <><b>{f.name}</b>{f.role && <> · {f.role}</>}{f.why_relevant && <span className="muted"> · {f.why_relevant}</span>}{f.as_of && <span className="muted small"> (as of {f.as_of})</span>}</>
          )}{' '}
          <Source url={f.source_url} verified={flags ? flags[i] !== false : true} />
        </li>
      ))}</ul>
    </div>
  )
}

function ProfileView({ d, onRefresh, busy }: { d: Detail; onRefresh: () => void; busy: boolean }) {
  const p = d.profile, v = d.verified || {}
  if (!p) return <Empty>No research yet. Click <b>Run full pipeline</b>.</Empty>
  const unverified = Object.values(v).flat().filter(x => !x).length
  const pairs = (p.signals || []).map((x, i) => ({ x, ok: v.signals?.[i] !== false })).sort((a, b) => (b.x.date || '').localeCompare(a.x.date || ''))
  return (
    <div>
      <div className="row between">
        <p className="muted">From the nation's own news and official pages · {fmtDay(d.profile_updated)} · reused for 30 days {unverified > 0 && <Badge tone="warn">{unverified} item{unverified > 1 ? 's' : ''} unverified</Badge>}</p>
        <button disabled={busy} onClick={onRefresh}>Research again</button>
      </div>
      <div className="grid2">
        <FactList title="Leadership" items={p.leadership} flags={v.leadership} />
        <FactList title="People to know" items={p.people_to_know} flags={v.people_to_know} />
        <FactList title="Signals: what's happening" items={pairs.map(q => q.x)} flags={pairs.map(q => q.ok)} />
        <FactList title="What they say they care about" items={p.priorities} flags={v.priorities} />
        {p.confirm_with_introducer?.length > 0 && <div className="card note"><h3>Confirm with your introducer</h3><ul>{p.confirm_with_introducer.map((q, i) => <li key={i}>{q}</li>)}</ul></div>}
        {p.open_questions?.length > 0 && <div className="card"><h3>Couldn't confirm</h3><ul>{p.open_questions.map((q, i) => <li key={i}>{q}</li>)}</ul></div>}
        {p.news_sources?.length > 0 && <div className="card"><h3>The nation's own sources</h3><ul className="small">{p.news_sources.map((u, i) => <li key={i}><Source url={u} /></li>)}</ul></div>}
      </div>
      {d.notes.length > 0 && <div className="card"><h3>Learned on calls</h3><ul>{d.notes.filter(n => n.source.startsWith('call')).map(n => <li key={n.id}>{n.text} <span className="muted small">({fmtDay(n.created_at)})</span></li>)}</ul></div>}
    </div>
  )
}

function CallsTab({ d }: { d: Detail }) {
  const nav = useNavigate()
  return (
    <div>
      <ScheduleCall targetId={d.target.id} onScheduled={(cid) => nav(`/calls/${cid}`)} />
      {d.calls.length === 0 ? <Empty>No calls yet.</Empty> : (
        <div className="list">{d.calls.map(c => (
          <Link key={c.id} to={`/calls/${c.id}`} className="card row between link">
            <div><b>{c.title}</b><div className="muted small">{fmtDate(c.scheduled_at)} · {c.attendees.map(a => a.name).join(', ')}</div></div>
            <div className="row gap">{c.status === 'met' ? <Badge tone="good">Met</Badge> : <Badge>Scheduled</Badge>}
              {c.brief_status === 'ready' ? <Badge tone="accent">Brief ready</Badge> : <Badge tone="warn">Brief {c.brief_status}</Badge>}</div>
          </Link>
        ))}</div>
      )}
    </div>
  )
}

function ActionsTab({ d, reload }: { d: Detail; reload: () => void }) {
  const [note, setNote] = useState('')
  const toggle = async (a: Action) => { await api(`/api/actions/${a.id}`, { method: 'PATCH', json: { status: a.status === 'open' ? 'done' : 'open' } }); reload() }
  const addNote = async () => { await api(`/api/targets/${d.target.id}/notes`, { method: 'POST', json: { text: note } }); setNote(''); reload() }
  return (
    <div className="grid2">
      <div className="card">
        <h3>Action items</h3>
        {d.actions.length === 0 ? <p className="muted">None yet. The tracker agent adds them from Zoom's summary after each call.</p> : (
          <ul className="checks">{d.actions.map(a => (
            <li key={a.id} className={a.status}>
              <input type="checkbox" checked={a.status === 'done'} onChange={() => toggle(a)} />
              <span>{a.action}</span> <Badge>{a.owner}</Badge> {a.due_date && <span className="muted small">due {fmtDay(a.due_date)}</span>}
            </li>
          ))}</ul>
        )}
      </div>
      <div className="card">
        <h3>Notes</h3>
        <div className="row gap"><input value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note the agents will see next time" /><button disabled={!note.trim()} onClick={addNote}>Add</button></div>
        <ul>{d.notes.map(n => <li key={n.id}>{n.text} <span className="muted small">({n.source}, {fmtDay(n.created_at)})</span></li>)}</ul>
      </div>
    </div>
  )
}
