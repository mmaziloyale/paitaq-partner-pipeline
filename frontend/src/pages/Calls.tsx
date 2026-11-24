import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, fmtDate, fmtDay, type Action, type Call, type Deal, type Draft, type Job, type Target } from '../api'
import { Badge, DraftCard, Empty, ErrorNote, JobProgress, useJob } from '../components'

// ---------- schedule form: scheduling starts the prep agent (call prep) right away ----------

export function ScheduleCall({ targetId, onScheduled }: { targetId?: number; onScheduled: (callId: number) => void }) {
  const [open, setOpen] = useState(false)
  const [targets, setTargets] = useState<Target[]>([])
  const [tid, setTid] = useState<number | undefined>(targetId)
  const [title, setTitle] = useState('Introductory call')
  const [when, setWhen] = useState(() => { const d = new Date(Date.now() + 3 * 864e5); d.setHours(13, 0, 0, 0); return toLocalInput(d) })
  const [people, setPeople] = useState([{ name: '', role: '', org: '' }])
  const [agenda, setAgenda] = useState('')
  const [consent, setConsent] = useState(false)
  const [deals, setDeals] = useState<Deal[]>([])
  const [oid, setOid] = useState('')
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { if (!targetId && open) api<Target[]>('/api/targets').then(setTargets) }, [targetId, open])
  useEffect(() => {
    setOid('')
    if (open && tid) api<{ deals: Deal[] }>(`/api/targets/${tid}`).then(x => { setDeals(x.deals); if (x.deals.length === 1) setOid(x.deals[0].opportunity_id) })
  }, [tid, open])

  const submit = async () => {
    setErr(null)
    try {
      const r = await api<{ id: number }>('/api/calls', { method: 'POST', json: {
        target_id: tid, title, scheduled_at: new Date(when).toISOString(), agenda, consent_to_record: consent, opportunity_id: oid || null,
        attendees: people.filter(p => p.name.trim()),
      } })
      onScheduled(r.id)
    } catch (e) { setErr((e as Error).message) }
  }
  if (!open) return <button className="primary" onClick={() => setOpen(true)}>+ Schedule a call</button>
  return (
    <div className="card form-grid">
      <h3 className="span2">Schedule a call <span className="muted small">(the prep agent starts the brief as soon as you save)</span></h3>
      {!targetId && (
        <label>Tribal nation<select value={tid ?? ''} onChange={e => setTid(Number(e.target.value))}>
          <option value="">Choose...</option>{targets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      )}
      <label>Title<input value={title} onChange={e => setTitle(e.target.value)} /></label>
      {deals.length > 0 && (
        <label>Deal to discuss (from the Deal Team)<select value={oid} onChange={e => setOid(e.target.value)}>
          <option value="">None: relationship call</option>
          {deals.map(d => <option key={d.opportunity_id} value={d.opportunity_id}>{d.project_type} · {d.opportunity_id}</option>)}</select></label>
      )}
      <label>When<input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} /></label>
      <div className="span2">
        <div className="label">Attendees from their side</div>
        {people.map((p, i) => (
          <div key={i} className="row gap attendee">
            <input placeholder="Name" value={p.name} onChange={e => setPeople(people.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
            <input placeholder="Role" value={p.role} onChange={e => setPeople(people.map((x, j) => j === i ? { ...x, role: e.target.value } : x))} />
            <input placeholder="Organization" value={p.org} onChange={e => setPeople(people.map((x, j) => j === i ? { ...x, org: e.target.value } : x))} />
          </div>
        ))}
        <button className="ghost" onClick={() => setPeople([...people, { name: '', role: '', org: '' }])}>+ attendee</button>
      </div>
      <label className="span2">Agenda / invite notes<textarea rows={3} value={agenda} onChange={e => setAgenda(e.target.value)} /></label>
      <label className="check span2"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /> Everyone has agreed to the call being recorded and transcribed</label>
      <ErrorNote error={err} />
      <div className="row gap span2"><button className="primary" disabled={!tid || title.length < 2} onClick={submit}>Save &amp; prep me</button><button onClick={() => setOpen(false)}>Cancel</button></div>
    </div>
  )
}

function toLocalInput(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

const sentences = (t: string) => (t || '').split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/).map(x => x.trim()).filter(Boolean)
const firstSentence = (t: string) => sentences(t)[0] ?? ''

// ---------- calendar: booked calls + Outlook (read-only) ----------

type CalEvent = { source: 'paitaq' | 'outlook'; title: string; start: string; end: string | null; all_day: boolean
  call_id?: number; target_id?: number; target_name?: string; status?: string; location?: string }
type CalData = { outlook_configured: boolean; outlook_error: string | null; events: CalEvent[] }
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const hm = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(' ', '').toLowerCase()

export function CalendarView() {
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1) })
  const [data, setData] = useState<CalData | null>(null)
  const [showOutlook, setShowOutlook] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const weeks = Math.ceil((month.getDay() + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7)
  const gridStart = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay())
  const days = Array.from({ length: weeks * 7 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i))
  useEffect(() => {
    const end = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + weeks * 7)
    setErr(null)
    api<CalData>(`/api/calendar?start=${encodeURIComponent(gridStart.toISOString())}&end=${encodeURIComponent(end.toISOString())}`).then(setData).catch(e => setErr(e.message))
  }, [month]) // eslint-disable-line react-hooks/exhaustive-deps
  const byDay = new Map<string, CalEvent[]>()
  for (const e of data?.events ?? []) {
    if (e.source === 'outlook' && !showOutlook) continue
    const k = e.all_day ? e.start.slice(0, 10) : ymd(new Date(e.start))
    byDay.set(k, [...(byDay.get(k) ?? []), e])
  }
  for (const list of byDay.values()) list.sort((a, b) => (a.all_day ? -1 : 0) - (b.all_day ? -1 : 0) || a.start.localeCompare(b.start))
  const today = ymd(new Date())
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1))
  return (
    <div>
      <div className="cal-head">
        <div className="row gap"><button className="ghost" onClick={() => shift(-1)}>‹</button>
          <h2 className="cal-title">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
          <button className="ghost" onClick={() => shift(1)}>›</button>
          <button className="ghost" onClick={() => { const d = new Date(); setMonth(new Date(d.getFullYear(), d.getMonth(), 1)) }}>Today</button></div>
        <div className="legend"><span><i className="sw paitaq" />Paitaq calls</span>
          {data?.outlook_configured
            ? <label className="check"><input type="checkbox" checked={showOutlook} onChange={e => setShowOutlook(e.target.checked)} /><i className="sw outlook" />Outlook</label>
            : <span className="muted">Outlook not connected (add OUTLOOK_ICS_URL to .env)</span>}</div>
      </div>
      <ErrorNote error={err || data?.outlook_error || null} />
      <div className="cal">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => <div key={d} className="dow">{d}</div>)}
        {days.map(d => {
          const k = ymd(d)
          return (
            <div key={k} className={`day${d.getMonth() !== month.getMonth() ? ' other' : ''}${k === today ? ' today' : ''}`}>
              <span className="num">{d.getDate()}</span>
              {(byDay.get(k) ?? []).map((e, i) => {
                const label = <>{!e.all_day && <span className="t">{hm(e.start)}</span>}{e.title}</>
                const tip = `${e.title}${e.all_day ? '' : ' · ' + fmtDate(e.start)}${e.location ? ' · ' + e.location : ''}`
                if (e.source === 'paitaq') return <Link key={i} to={`/calls/${e.call_id}`} className={`ev paitaq${e.status === 'met' ? ' met' : ''}`} title={tip}>{label}</Link>
                if (e.target_id) return <Link key={i} to={`/targets/${e.target_id}`} className="ev outlook linked" title={`${tip} · ${e.target_name}`}>{label}</Link>
                return <span key={i} className="ev outlook" title={tip}>{label}</span>
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------- calls list ----------

export function CallsList() {
  const [calls, setCalls] = useState<Call[] | null>(null)
  const nav = useNavigate()
  useEffect(() => { api<Call[]>('/api/calls').then(setCalls) }, [])
  const upcoming = calls?.filter(c => c.status === 'scheduled') ?? []
  const past = calls?.filter(c => c.status !== 'scheduled') ?? []
  return (
    <div>
      <div className="page-head"><div><h1>Calendar</h1><p className="lede">The prep agent writes the brief when a call is booked and refreshes it 24 hours before.</p></div></div>
      <ScheduleCall onScheduled={(id) => nav(`/calls/${id}`)} />
      <CalendarView />
      {!calls ? <Empty>Loading...</Empty> : (
        <>
          <h2>Upcoming</h2>
          {upcoming.length === 0 ? <Empty>No calls scheduled.</Empty> : upcoming.map(c => <CallRow key={c.id} c={c} />)}
          <h2>Past</h2>
          {past.length === 0 ? <Empty>No calls processed yet.</Empty> : past.map(c => <CallRow key={c.id} c={c} />)}
        </>
      )}
    </div>
  )
}

function CallRow({ c }: { c: Call }) {
  return (
    <Link to={`/calls/${c.id}`} className="card row between link">
      <div><b>{c.target_name}: {c.title}</b><div className="muted small">{fmtDate(c.scheduled_at)} · {c.attendees.map(a => a.name).join(', ') || 'no attendees listed'}</div></div>
      <div className="row gap">
        {c.status === 'met' ? <Badge tone="good">Notes processed</Badge> : <Badge>Scheduled</Badge>}
        {c.brief_status === 'ready' ? <Badge tone="accent">Brief ready{c.brief_refreshed_at ? ' · refreshed' : ''}</Badge> : <Badge tone="warn">Brief {c.brief_status}</Badge>}
      </div>
    </Link>
  )
}

// ---------- one call: brief, then meeting notes ----------

type CallDetail = Call & { deal: Deal | null; source_text: string | null; follow_ups: Draft[]; actions: Action[]; job: Job | null }

export function CallPage() {
  const { id } = useParams()
  const [c, setC] = useState<CallDetail | null>(null)
  const [jobId, setJobId] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(() => api<CallDetail>(`/api/calls/${id}`).then(x => { setC(x); if (x.job?.status === 'running') setJobId(x.job.id) }).catch(e => setErr(e.message)), [id])
  useEffect(() => { load() }, [load])
  const job = useJob(jobId, () => load())

  if (!c) return err ? <ErrorNote error={err} /> : <Empty>Loading...</Empty>
  const b = c.brief, m = c.meeting
  const answered = new Set(m?.answered_question_ids ?? [])
  const rerun = async (refresh: boolean) => {
    try { const r = await api<{ job_id: number }>(`/api/calls/${id}/prep?refresh=${refresh}`, { method: 'POST' }); setJobId(r.job_id) }
    catch (e) { setErr((e as Error).message) }
  }

  return (
    <div>
      <Link to={`/targets/${c.target_id}`} className="back">← {c.target_name}</Link>
      <div className="page-head">
        <div><h1>{c.title}</h1><p className="lede">{c.target_name} · {fmtDate(c.scheduled_at)}</p>
          <p className="muted">{c.attendees.map(a => `${a.name}${a.role ? ` (${a.role})` : ''}`).join(' · ')}</p></div>
        <div className="row gap">
          {c.status === 'scheduled' && <button disabled={job?.status === 'running'} onClick={() => rerun(true)}>Refresh brief now</button>}
          <button onClick={() => { window.location.href = `/api/calls/${c.id}/ics` }} title="Downloads an .ics file; open it to add the call to Outlook">Add to Outlook</button>
          <button onClick={() => window.print()}>Print brief</button>
        </div>
      </div>
      <ErrorNote error={err} />
      <JobProgress job={job} title={job?.kind === 'meeting' ? 'tracker is capturing follow-ups' : 'prep is preparing your brief'} />

      {c.deal && (
        <div className="card deals">
          <div className="row gap wrap"><b>Deal from the Deal Team:</b> {c.deal.project_type} <Badge>{c.deal.opportunity_id}</Badge>
            {c.deal.approved_to_share ? <Badge tone="good">proposal approved to share</Badge> : <Badge tone="warn">don't share the proposal yet</Badge>}</div>
          <p className="small">{c.deal.one_line} <span className="muted">What the tribe would receive: {c.deal.what_the_tribe_would_receive}</span></p>
        </div>
      )}
      {b ? (
        <section className="brief">
          <div className="card priorities">
            <div className="eyebrow">Priorities for Paitaq</div>
            {(b.priorities?.length ?? 0) > 0 ? (
              <ol className="prio">{b.priorities!.map((p, i) => <li key={i}><b>{p.item}</b>{p.benefit && <span className="muted"> · {p.benefit}</span>}</li>)}</ol>
            ) : (
              <p className="muted small">This brief was written before priorities were added.{' '}
                {c.status === 'scheduled' && <button className="ghost" disabled={job?.status === 'running'} onClick={() => rerun(true)}>Refresh to add them</button>}</p>
            )}
            <p className="goal-line"><span className="label-inline">Call goal</span>{b.call_goal}</p>
          </div>
          <div className="grid2 compact">
            <div className="card"><h3>Questions to ask</h3>
              <ol className="questions">{b.questions.map(q => (
                <li key={q.id} className={answered.has(q.id) ? 'answered' : ''} title={q.why_ask}>
                  {q.question}{' '}
                  {q.priority === 'must_ask' && <Badge tone="accent">must ask</Badge>}
                  {q.category === 'carried_over' && <Badge tone="warn">carried over</Badge>}
                  {q.category === 'deal_team' && <Badge tone="accent">Deal Team</Badge>}
                  {m && (answered.has(q.id) ? <Badge tone="good">answered</Badge> : <Badge tone="warn">open</Badge>)}
                </li>))}</ol>
            </div>
            {b.their_likely_questions.length > 0 && <div className="card"><h3>They'll probably ask</h3>
              <ul>{b.their_likely_questions.map((q, i) => <li key={i}><b>{q.question}</b> <span className="muted">{q.suggested_answer}</span></li>)}</ul></div>}
            {b.attendees.length > 0 && <div className="card"><h3>Who's on the call</h3>
              <ul>{b.attendees.map((a, i) => <li key={i}><b>{a.name}</b>{a.role && `, ${a.role}`}{a.connection && <span className="muted"> · via {a.connection}</span>}
                {a.background && <div className="muted small">{firstSentence(a.background)}</div>}</li>)}</ul></div>}
            <div className="card"><h3>Background</h3><ul>{sentences(b.context).map((x, i) => <li key={i}>{x}</li>)}</ul></div>
            {b.confirm_with_contact.length > 0 && <div className="card note"><h3>Confirm with your introducer</h3><ul>{b.confirm_with_contact.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
            {(b.avoid_asking.length > 0 || b.open_items.length > 0) && <div className="card"><h3>Skip / open items</h3><ul>{b.avoid_asking.map((x, i) => <li key={i}>Skip: {x}</li>)}{b.open_items.map((x, i) => <li key={'o' + i}>Open: {x}</li>)}</ul></div>}
          </div>
          <p className="muted small">Brief written {fmtDate(c.brief_generated_at)}{c.brief_refreshed_at && `, refreshed ${fmtDate(c.brief_refreshed_at)}`}. Hover a question to see why it matters.</p>
        </section>
      ) : <Empty>{c.brief_status === 'error' ? <>Prep failed. <button onClick={() => rerun(false)}>Try again</button></> : 'The brief is being written...'}</Empty>}

      <h2>After the call</h2>
      {m ? <MeetingView c={c} reload={load} /> : <MeetingUpload c={c} onStarted={setJobId} />}
    </div>
  )
}

type ZoomMeeting = { uuid: string; id: number; topic: string; start_time: string }

function MeetingUpload({ c, onStarted }: { c: CallDetail; onStarted: (id: number) => void }) {
  const [kind, setKind] = useState<'zoom_paste' | 'zoom_api' | 'notes'>('zoom_paste')
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [consent, setConsent] = useState(!!c.consent_to_record)
  const [zoomList, setZoomList] = useState<{ configured: boolean; meetings: ZoomMeeting[] } | null>(null)
  const [zoomUuid, setZoomUuid] = useState('')
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { api<{ configured: boolean; meetings: ZoomMeeting[] }>('/api/zoom/meetings').then(setZoomList).catch(() => setZoomList({ configured: false, meetings: [] })) }, [])
  const submit = async () => {
    setErr(null)
    const fd = new FormData()
    fd.append('kind', kind); fd.append('consent', String(consent)); fd.append('text', text); fd.append('zoom_uuid', zoomUuid)
    if (file && kind === 'zoom_paste') fd.append('file', file)
    try { const r = await api<{ job_id: number }>(`/api/calls/${c.id}/meeting`, { method: 'POST', body: fd }); onStarted(r.job_id) }
    catch (e) { setErr((e as Error).message) }
  }
  const ready = kind === 'zoom_api' ? !!zoomUuid : !!(text.trim() || file)
  return (
    <div className="card stack">
      <p className="muted small">Zoom AI Companion already writes the meeting summary. The tracker agent reads it and pulls out the action items, owners, due dates and open questions. It doesn't write another summary.</p>
      <div className="row gap wrap">
        <label className="check"><input type="radio" checked={kind === 'zoom_paste'} onChange={() => setKind('zoom_paste')} /> Paste / upload Zoom's summary</label>
        <label className="check"><input type="radio" checked={kind === 'zoom_api'} disabled={!zoomList?.configured} onChange={() => setKind('zoom_api')} /> Pull from Zoom {!zoomList?.configured && <span className="muted small">(not connected)</span>}</label>
        <label className="check"><input type="radio" checked={kind === 'notes'} onChange={() => setKind('notes')} /> My own notes (no Zoom summary)</label>
      </div>
      {kind === 'zoom_api' && (
        <label>Zoom meeting<select value={zoomUuid} onChange={e => setZoomUuid(e.target.value)}>
          <option value="">Choose a recent meeting...</option>
          {zoomList?.meetings.map(m => <option key={m.uuid} value={m.uuid}>{m.topic} · {fmtDate(m.start_time)}</option>)}
        </select></label>
      )}
      {kind === 'zoom_paste' && <label>Summary file (.txt), e.g. saved from Zoom's recap email<input type="file" accept=".txt,.md,.vtt" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>}
      {kind !== 'zoom_api' && <label>{kind === 'zoom_paste' ? '...or paste the summary (Quick recap, Next steps, Summary)' : 'Notes'}<textarea rows={8} value={text} onChange={e => setText(e.target.value)} /></label>}
      {kind !== 'notes' && <label className="check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /> Everyone on the call knew Zoom AI Companion was on</label>}
      <ErrorNote error={err} />
      <div><button className="primary" disabled={!ready} onClick={submit}>Capture follow-ups</button>
        <span className="muted small"> Action items go to the Follow-ups dashboard; a reviewed thank-you email is drafted for your approval.</span></div>
    </div>
  )
}

function MeetingView({ c, reload }: { c: CallDetail; reload: () => void }) {
  const m = c.meeting!
  const [redo, setRedo] = useState(false)
  if (redo) return <MeetingUpload c={c} onStarted={() => { setRedo(false); reload() }} />
  return (
    <div>
      {m.suspicious_text.length > 0 && <div className="banner warn">The summary contained text aimed at the AI. It was removed and <b>not followed</b>: “{m.suspicious_text[0]}”</div>}
      <div className="grid2">
        <div className="stack">
          <div className="card"><h3>Follow-ups captured <span className="muted small">interest {m.interest_level}/5</span></h3>
            <ul className="checks">{c.actions.map(a => (
              <li key={a.id} className={a.status}><input type="checkbox" checked={a.status === 'done'}
                onChange={async () => { await api(`/api/actions/${a.id}`, { method: 'PATCH', json: { status: a.status === 'open' ? 'done' : 'open' } }); reload() }} />
                <span>{a.action}</span> <Badge tone={a.owner === 'Tribe' ? 'accent' : 'neutral'}>{a.owner_detail || a.owner}</Badge> {a.due_date && <span className="muted small">due {fmtDay(a.due_date)}</span>}</li>))}</ul>
            {c.actions.length === 0 && <p className="muted">No follow-ups found in the summary.</p>}
            {m.next_meeting && <p><b>Next meeting:</b> {m.next_meeting}</p>}
            <Link to="/followups" className="small">Open the Follow-ups dashboard →</Link>
          </div>
          {c.deal && (
            <div className="card deals"><h3>Going to the Deal Team <Badge tone={m.deal_signal === 'positive' ? 'good' : m.deal_signal === 'negative' ? 'bad' : 'neutral'}>{m.deal_signal || 'neutral'}</Badge></h3>
              {m.deal_note && <p>{m.deal_note}</p>}
              {(m.deal_answers || []).map((a, i) => <div key={i} className="qa"><b>{a.question}</b><p>{a.answer}</p></div>)}
              {(m.changes_for_the_deal || []).length > 0 && <><h4>Changes for the deal</h4><ul>{m.changes_for_the_deal!.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
              <p className="muted small">Only deal-relevant facts go to the Deal Team. Zoom's summary, contact details and personal information stay here.</p>
            </div>
          )}
          {m.unanswered_questions.length > 0 && <div className="card note"><h3>Carried to the next call</h3><ul>{m.unanswered_questions.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
          {(m.new_contacts.length > 0 || m.profile_updates.length > 0) && <div className="card"><h3>Added to the profile &amp; network</h3><ul>
            {m.new_contacts.map((x, i) => <li key={i}>New contact: <b>{x.name}</b> {x.role && `(${x.role})`}</li>)}
            {m.profile_updates.map((x, i) => <li key={'p' + i}>{x}</li>)}</ul></div>}
        </div>
        <div className="card">
          <div className="row between"><h3>{c.summary_source === 'notes' ? 'Your notes' : "Zoom's summary"}</h3><button className="ghost" onClick={() => setRedo(true)}>Replace</button></div>
          <pre className="body source-text">{c.source_text}</pre>
        </div>
      </div>
      <h3>Follow-up email</h3>
      {c.follow_ups.map(d => <DraftCard key={d.id} draft={d} onChange={reload} />)}
    </div>
  )
}
