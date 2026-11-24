import { useEffect, useRef, useState } from 'react'
import nationList from '../nations.json'
import { Link } from 'react-router-dom'
import { api, fmtDate, type Target } from '../api'
import { Empty, ErrorNote, Interest } from '../components'

const LANES = [
  { title: 'Research', agents: ['Research'], hint: 'Leaders, people to know, what is happening', stages: ['Identified', 'Researched'] },
  { title: 'Outreach', agents: ['Connector', 'Outreach', 'Reviewer'], hint: 'Warm paths from your network, drafted and checked', stages: ['Paths found', 'Outreach drafted', 'Outreach approved'] },
  { title: 'Call', agents: ['Prep'], hint: 'Booked calls; the brief is written when the call is booked', stages: ['Call scheduled'] },
  { title: 'Follow-up', agents: ['Tracker'], hint: "Zoom's summary turned into commitments", stages: ['Met', 'Follow-up'] },
]

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// One line per card: who acts next (you, or an agent).
function nextStep(t: Target): { who: string; what: string } {
  if (t.drafts_waiting > 0) return { who: 'You', what: `approve ${plural(t.drafts_waiting, 'draft')}` }
  switch (t.stage) {
    case 'Identified': return { who: 'Research agent', what: 'builds the profile' }
    case 'Researched': return { who: 'Connector', what: 'finds warm paths' }
    case 'Paths found': return { who: 'Outreach + Reviewer', what: 'draft and check' }
    case 'Outreach drafted': return { who: 'Reviewer', what: 'checks the drafts' }
    case 'Outreach approved': return { who: 'You', what: 'send and book the call' }
    case 'Call scheduled': return { who: 'You', what: 'review the brief' }
    default: return t.open_actions > 0 ? { who: 'You', what: plural(t.open_actions, 'open action') } : { who: 'Tracker', what: 'waits for the Zoom summary' }
  }
}

type Nation = { name: string; state: string; recognition: string }
const NATIONS = nationList as Nation[]

// Searchable dropdown: opens on click, filters as you type, arrow keys + Enter to pick. Any typed name is still allowed.
function NationPicker({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close)
  }, [])
  const q = value.trim().toLowerCase()
  const exact = NATIONS.some(n => n.name.toLowerCase() === q)
  const matches = (q && !exact ? NATIONS.filter(n => n.name.toLowerCase().includes(q)) : NATIONS).slice(0, 80)
  useEffect(() => { listRef.current?.children[hi]?.scrollIntoView({ block: 'nearest' }) }, [hi])
  const choose = (n: Nation) => { onChange(n.name); setOpen(false) }
  return (
    <div className="combo" ref={box}>
      <input value={value} placeholder="Start typing, or pick from the list" autoComplete="off" role="combobox" aria-expanded={open}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
        onChange={e => { onChange(e.target.value); setOpen(true); setHi(0) }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi(h => Math.min(h + 1, matches.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)) }
          else if (e.key === 'Enter' && open && matches[hi]) { e.preventDefault(); choose(matches[hi]) }
          else if (e.key === 'Escape' || e.key === 'Tab') setOpen(false)
        }} />
      <button type="button" className="combo-toggle" tabIndex={-1} aria-label="Show nations" onClick={() => setOpen(o => !o)}>▾</button>
      {open && (
        <ul className="combo-list" ref={listRef} role="listbox">
          {matches.length === 0 && <li className="muted">Not on the list: it will be added as typed.</li>}
          {matches.map((n, i) => (
            <li key={n.name} role="option" aria-selected={i === hi} className={i === hi ? 'on' : ''}
              onMouseEnter={() => setHi(i)} onMouseDown={e => { e.preventDefault(); choose(n) }}>
              <span>{n.name}</span><span className="muted small">{n.state}{n.recognition === 'state' ? ' · state-recognized' : ''}</span>
            </li>))}
          {matches.length === 80 && <li className="muted small">Keep typing to narrow the list...</li>}
        </ul>
      )}
    </div>
  )
}
const STATES: [string, string][] = [['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['DC','District of Columbia'],['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],['ME','Maine'],['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],['OK','Oklahoma'],['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],['SD','South Dakota'],['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],['VA','Virginia'],['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming']]

export default function Pipeline() {
  const [targets, setTargets] = useState<Target[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', state: '', project_focus: '', rationale: '' })
  const pickNation = (name: string) => {
    const hit = NATIONS.find(n => n.name.toLowerCase() === name.trim().toLowerCase())
    setForm(f => ({ ...f, name, state: hit?.state || f.state }))
  }

  const load = () => api<Target[]>('/api/targets').then(setTargets).catch(e => setErr(e.message))
  useEffect(() => { load() }, [])

  const add = async () => {
    try { await api('/api/targets', { method: 'POST', json: form }); setAdding(false); setForm({ name: '', state: '', project_focus: '', rationale: '' }); load() }
    catch (e) { setErr((e as Error).message) }
  }
  const importCsv = async (f: File) => {
    const fd = new FormData(); fd.append('file', f)
    try { const r = await api<{ imported: number }>('/api/targets/import', { method: 'POST', body: fd }); alertMsg(`Imported ${r.imported} targets`); load() }
    catch (e) { setErr((e as Error).message) }
  }
  const [msg, setMsg] = useState<string | null>(null)
  const alertMsg = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 3000) }

  const all = targets ?? []
  const drafts = all.filter(t => t.drafts_waiting > 0)
  const draftTotal = drafts.reduce((n, t) => n + t.drafts_waiting, 0)
  const calls = all.filter(t => t.next_call).sort((a, b) => a.next_call!.scheduled_at.localeCompare(b.next_call!.scheduled_at))
  const actions = all.filter(t => t.open_actions > 0)
  const actionTotal = actions.reduce((n, t) => n + t.open_actions, 0)
  const waiting = draftTotal + calls.length + actionTotal

  return (
    <div>
      <section className="hero compact">
        <div className="hero-text">
          <h1 className="display">Building relationships to drive deal flow.</h1>
          {targets && <p className="lede">{plural(all.length, 'nation')} in the pipeline · {plural(calls.length, 'call')} booked · {plural(actionTotal, 'open commitment')}</p>}
        </div>
        <div className="hero-actions">
          <button className="primary" onClick={() => setAdding(a => !a)}>+ Add a nation</button>
          <details className="menu">
            <summary className="button quiet">Deal Team ▾</summary>
            <div className="menu-list">
              <label className="menu-item" title="to_partner_pipeline.json from the Deal Team, or a CSV list">Import Deal Team file<input type="file" accept=".json,.csv" hidden onChange={e => e.target.files?.[0] && importCsv(e.target.files[0])} /></label>
              <a className="menu-item" href="/api/dealteam/export" title="from_partner_pipeline.json: what we learned, deal-relevant facts only">Export to Deal Team</a>
            </div>
          </details>
        </div>
      </section>
      <ErrorNote error={err} />
      {msg && <div className="banner info">{msg}</div>}
      {adding && (
        <div className="card form-grid">
          <label>Tribal nation<NationPicker value={form.name} onChange={pickNation} /></label>
          <label>State<select value={form.state} onChange={e => setForm({ ...form, state: e.target.value })}>
            <option value="">Choose a state...</option>
            {form.state && !STATES.some(([c]) => c === form.state) && <option value={form.state}>{form.state}</option>}
            {STATES.map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}</select></label>
          <label>Project focus<input value={form.project_focus} onChange={e => setForm({ ...form, project_focus: e.target.value })} placeholder="Solar + storage" /></label>
          <label>Why Paitaq is looking at them<input value={form.rationale} onChange={e => setForm({ ...form, rationale: e.target.value })} /></label>
          <div className="row gap"><button className="primary" disabled={form.name.length < 2} onClick={add}>Add</button><button onClick={() => setAdding(false)}>Cancel</button></div>
        </div>
      )}
      {targets && waiting > 0 && (
        <section className="waiting" aria-label="Waiting on you">
          <header><span className="w-title">Waiting on you · {waiting}</span><span className="muted small">Nothing goes out until you approve it</span></header>
          {draftTotal > 0 && (
            <div className="w-row">
              <span><b>{plural(draftTotal, 'draft')} to approve</b><span className="muted"> · {drafts.map(t => `${t.name} ${t.drafts_waiting}`).join(' · ')}</span></span>
              <Link className="button quiet" to={`/targets/${drafts[0].id}`}>Review drafts</Link>
            </div>
          )}
          {calls.map(t => (
            <div className="w-row" key={t.id}>
              <span><b>{t.name} call brief</b><span className="muted"> · {fmtDate(t.next_call!.scheduled_at)}</span></span>
              <Link className="button quiet" to={`/calls/${t.next_call!.id}`}>Open brief</Link>
            </div>
          ))}
          {actionTotal > 0 && (
            <div className="w-row">
              <span><b>{plural(actionTotal, 'follow-up action')}</b><span className="muted"> · {actions.map(t => `${t.name} ${t.open_actions}`).join(' · ')}</span></span>
              <Link className="button quiet" to="/followups">Open follow-ups</Link>
            </div>
          )}
        </section>
      )}
      {!targets ? <Empty>Loading...</Empty> : targets.length === 0 ? <Empty>No nations yet. Import the Deal Team's to_partner_pipeline.json or add one.</Empty> : (
        <div className="board">
          {LANES.map(lane => {
            const items = targets.filter(t => lane.stages.includes(t.stage))
            return (
              <section key={lane.title} className="lane">
                <header>
                  <h3>{lane.title}<span className="count">{items.length}</span></h3>
                  <div className="agents">{lane.agents.map(a => <span key={a} className="agent-chip">{a}</span>)}</div>
                  <p>{lane.hint}</p>
                </header>
                {items.map(t => {
                  const n = nextStep(t)
                  return (
                    <Link to={`/targets/${t.id}`} key={t.id} className="tcard">
                      <div className="row between"><b>{t.name}</b><Interest level={t.interest_level} /></div>
                      <div className="muted small">{[t.state, t.project_focus, t.rank_score != null ? `Fit ${t.rank_score}` : ''].filter(Boolean).join(' · ')}</div>
                      {t.next_call && <div className="next-call"><span className="dot" aria-hidden />{t.next_call.title} · {fmtDate(t.next_call.scheduled_at)}</div>}
                      <div className={`next ${n.who === 'You' ? 'you' : ''}`}>Next: <b>{n.who}</b> {n.what}</div>
                    </Link>
                  )
                })}
                {items.length === 0 && <div className="lane-empty">{lane.title === 'Research' ? 'Add a nation and the research agent builds its profile' : 'Nothing at this stage'}</div>}
              </section>
            )
          })}
        </div>
      )}
      {targets && targets.length > 0 && <p className="muted small scanner-note">The scanner runs separately and feeds <Link to="/gatherings">Gatherings</Link>.</p>}
    </div>
  )
}
