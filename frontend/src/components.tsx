import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { api, fmtNum, fmtUsd, type Draft, type Job, type Status } from './api'
import { PaitaqLogo } from './brand'

// ---------- layout ----------

export function Layout() {
  const [status, setStatus] = useState<Status | null>(null)
  useEffect(() => { api<Status>('/api/status').then(setStatus).catch(() => {}) }, [])
  const overdue = status?.network.filter(n => n.overdue) ?? []
  const { pathname } = useLocation()
  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="brand" aria-label="Paitaq Partner Development Dashboard, home">
          <PaitaqLogo height={38} />
          <span className="brand-divider" aria-hidden />
          <span className="brand-product">Partner Development Dashboard</span>
        </NavLink>
        <nav>
          <NavLink to="/" end>Pipeline</NavLink>
          <NavLink to="/network">Network</NavLink>
          <NavLink to="/calendar" className={({ isActive }) => (isActive || pathname.startsWith('/calls') ? 'active' : '')}>Calendar</NavLink>
          <NavLink to="/followups">Follow-ups</NavLink>
          <NavLink to="/gatherings">Gatherings</NavLink>
          <NavLink to="/usage">Usage &amp; Safety</NavLink>
        </nav>
      </header>
      {status && !status.has_key && (
        <div className="banner warn">No API key found, so the agents can't run. Add <code>PORTKEY_API_KEY</code> to <code>.env</code> (see README), then restart.</div>
      )}
      {overdue.length > 0 && (
        <div className="banner info">
          Monthly reminder: refresh the LinkedIn export for {overdue.map(o => o.owner).join(' and ')} so the Connector sees new connections.{' '}
          <NavLink to="/network">Go to Network →</NavLink>
        </div>
      )}
      <main><Outlet /></main>
      <footer className="foot">
        <b>Paitaq Capital</b> · Capital for sovereign nations · Nothing is sent without a person's approval
        {status && <span> · Today: {fmtNum(status.tokens_today)} / {fmtNum(status.daily_token_budget)} tokens · {status.model}</span>}
      </footer>
    </div>
  )
}

// ---------- small pieces ----------

export function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'accent' }) {
  return <span className={`badge ${tone}`}>{children}</span>
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? <div className="banner bad">{error}</div> : null
}

export function Interest({ level }: { level: number | null }) {
  if (!level) return null
  return <span className="interest" title={`Interest level ${level} of 5 (from the last call)`}>{[1, 2, 3, 4, 5].map(i => <i key={i} className={i <= level ? 'on' : ''} />)}</span>
}

export function Source({ url, verified = true }: { url: string; verified?: boolean }) {
  let host = url
  try { host = new URL(url).hostname.replace(/^www\./, '') } catch { /* keep raw */ }
  return (
    <span className="source">
      {url ? <a href={url} target="_blank" rel="noreferrer">{host}</a> : 'no source'}
      {!verified && <Badge tone="warn">unverified</Badge>}
    </span>
  )
}

// ---------- job progress (polls the backend while agents work) ----------

export function useJob(jobId: number | null, onDone?: (j: Job) => void) {
  const [job, setJob] = useState<Job | null>(null)
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    if (!jobId) return
    let stop = false
    const tick = async () => {
      try {
        const j = await api<Job>(`/api/jobs/${jobId}`)
        if (stop) return
        setJob(j)
        if (j.status === 'running') setTimeout(tick, 1500)
        else done.current?.(j)
      } catch { if (!stop) setTimeout(tick, 3000) }
    }
    tick()
    return () => { stop = true }
  }, [jobId])
  return job
}

export function JobProgress({ job, title }: { job: Job | null; title?: string }) {
  if (!job) return null
  const tokens = job.steps.reduce((s, x) => s + (x.input_tokens || 0) + (x.output_tokens || 0), 0)
  const cost = job.steps.reduce((s, x) => s + (x.cost_usd || 0), 0)
  return (
    <div className={`job ${job.status}`}>
      <div className="job-head">
        <b>{title || 'Agents at work'}</b>
        <span>{job.status === 'running' ? <><span className="spinner" /> running</> : job.status === 'done' ? 'Finished' : 'Stopped with an error'}</span>
        <span className="muted">{fmtNum(tokens)} tokens · {fmtUsd(cost)}</span>
      </div>
      <ol className="steps">
        {job.steps.map((s, i) => (
          <li key={i} className={s.status}>
            <span className="dot" />
            <b>{s.label}</b>
            <span className="msg">{s.status === 'running' ? <><span className="spinner" /> {s.message}</> : s.message}</span>
            {s.status === 'done' && !s.cached && (
              <span className="meta">
                {fmtNum(s.input_tokens)} in{s.cached_input_tokens ? ` (${fmtNum(s.cached_input_tokens)} cached)` : ''} · {fmtNum(s.output_tokens)} out · {s.tool_calls ?? 0} tool calls · {s.seconds}s · {fmtUsd(s.cost_usd)}
              </span>
            )}
          </li>
        ))}
      </ol>
      {job.error && <div className="banner bad">{job.error}</div>}
    </div>
  )
}

// ---------- a draft with its review, editing and the approval gate ----------

const KIND_LABEL: Record<string, string> = { intro_request: 'Intro request (to warm contact)', outreach: 'Outreach (to the nation)', follow_up: 'Follow-up email' }

export function DraftCard({ draft, onChange }: { draft: Draft; onChange: () => void }) {
  const [edit, setEdit] = useState(false)
  const [subject, setSubject] = useState(draft.subject)
  const [body, setBody] = useState(draft.body)
  const [email, setEmail] = useState(draft.recipient_email || '')
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [finding, setFinding] = useState(false)
  const [lookupNote, setLookupNote] = useState<string | null>(null)
  const src = draft.recipient_email_source || ''
  const findEmail = async () => {
    setFinding(true); setLookupNote(null); setErr(null)
    try {
      const r = await api<{ email: string; source: string }>(`/api/drafts/${draft.id}/find-email`, { method: 'POST' })
      if (r.email) { setEmail(r.email); onChange() } else setLookupNote('No published email found. Add one with Edit.')
    } catch (e) { setErr((e as Error).message) } finally { setFinding(false) }
  }
  const issues = [...(draft.review.issues || []), ...(draft.review.code_recheck || [])]
  const blocks = issues.filter(i => i.severity === 'block')

  const save = async (status?: string) => {
    setErr(null)
    try {
      await api(`/api/drafts/${draft.id}`, { method: 'PATCH', json: { subject, body, recipient_email: email, status } })
      setEdit(false)
      onChange()
    } catch (e) { setErr((e as Error).message) }
  }
  const mailto = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`

  return (
    <div className={`card draft ${draft.status}`}>
      <div className="draft-head">
        <div>
          <div className="eyebrow">{KIND_LABEL[draft.kind] || draft.kind}{draft.target_name ? ` · ${draft.target_name}` : ''}</div>
          <div className="to">To: {draft.recipient}</div>
          <div className="to small">
            {email
              ? <>Email: <a href={`mailto:${email}`}>{email}</a>{' '}
                  <span className="muted">
                    {src === 'contacts' ? '· from your contacts'
                      : src === 'you' ? '· added by you'
                      : src ? <>· found on <a href={src} target="_blank" rel="noreferrer">{(() => { try { return new URL(src).hostname.replace(/^www\./, '') } catch { return 'the web' } })()}</a>; verify before sending</>
                      : ''}
                  </span></>
              : <span className="muted">No email on file.{' '}
                  <button className="ghost small" disabled={finding} onClick={findEmail}>{finding ? 'Looking...' : 'Find email'}</button>{' '}
                  <button className="ghost small" onClick={() => setEdit(true)}>Add by hand</button>
                  {lookupNote && <> {lookupNote}</>}</span>}
          </div>
        </div>
        <div className="row gap">
          {draft.status === 'needs_review' && (blocks.length ? <Badge tone="bad">Reviewer: needs changes</Badge> : <Badge tone="good">Reviewer: OK</Badge>)}
          {draft.review.revised && <Badge tone="accent">Revised once by agents</Badge>}
          {draft.status === 'approved' && <Badge tone="good">Approved by you</Badge>}
          {draft.status === 'sent' && <Badge>Marked sent</Badge>}
        </div>
      </div>
      {edit ? (
        <div className="stack">
          <label>Recipient email<input value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.org" /></label>
          <label>Subject<input value={subject} onChange={e => setSubject(e.target.value)} /></label>
          <label>Body<textarea rows={12} value={body} onChange={e => setBody(e.target.value)} /></label>
        </div>
      ) : (
        <>
          <div className="subject">{draft.subject}</div>
          <pre className="body">{draft.body}</pre>
        </>
      )}
      {issues.length > 0 && (
        <details className="review" open={blocks.length > 0}>
          <summary>Reviewer notes ({issues.length}){draft.review.summary ? `: ${draft.review.summary}` : ''}</summary>
          <ul>{issues.map((i, k) => <li key={k}><Badge tone={i.severity === 'block' ? 'bad' : 'warn'}>{i.category.replace(/_/g, ' ')}</Badge> {i.detail} <span className="muted">→ {i.suggested_fix}</span></li>)}</ul>
        </details>
      )}
      <ErrorNote error={err} />
      <div className="row gap wrap actions">
        {edit ? (
          <>
            <button className="primary" onClick={() => save()}>Save changes</button>
            <button onClick={() => setEdit(false)}>Cancel</button>
          </>
        ) : (
          <>
            {draft.status === 'needs_review' && <button className="primary" onClick={() => save('approved')}>Approve</button>}
            <button onClick={() => setEdit(true)}>Edit</button>
            <button onClick={() => { navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? 'Copied' : 'Copy'}</button>
            {draft.status === 'approved' && <a className="button" href={mailto}>Open in email</a>}
            {draft.status === 'approved' && <button onClick={() => save('sent')}>Mark as sent</button>}
            {draft.status !== 'discarded' && draft.status !== 'sent' && <button className="ghost" onClick={() => save('discarded')}>Discard</button>}
          </>
        )}
      </div>
    </div>
  )
}
