// Small typed wrapper around the backend API.

export async function api<T = any>(path: string, opts: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = opts
  const res = await fetch(path, {
    ...rest,
    headers: json !== undefined ? { 'Content-Type': 'application/json', ...(rest.headers || {}) } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null }
  catch { throw new Error('The app server is running older code than this page. Stop it (Ctrl+C) and start it again with: python run.py') }
  if (!res.ok) throw new Error((data && (data.detail?.[0]?.msg || data.detail)) || `Request failed (${res.status})`)
  return data as T
}

export type Target = {
  id: number; name: string; state: string; region: string; project_focus: string; rationale: string
  rank_score: number | null; stage: string; interest_level: number | null; data: Record<string, string>
  next_call: { id: number; title: string; scheduled_at: string } | null; open_actions: number; drafts_waiting: number
}

export type JobStep = {
  agent: string; label: string; status: 'running' | 'done' | 'error'; message: string
  input_tokens?: number; cached_input_tokens?: number; output_tokens?: number; cost_usd?: number; seconds?: number
  tool_calls?: number; cached?: boolean
}
export type Job = { id: number; kind: string; status: 'running' | 'done' | 'error'; steps: JobStep[]; error: string | null }

export type Fact = {
  fact?: string; name?: string; role?: string; why_relevant?: string; as_of?: string
  kind?: string; date?: string | null; description?: string; person?: string; source_url: string
}
export type Profile = {
  summary: string; leadership: Fact[]; people_to_know: Fact[]; signals: Fact[]; priorities: Fact[]
  news_sources: string[]; confirm_with_introducer: string[]; open_questions: string[]
  why_now?: Fact[]; other_partners?: Fact[]
}

export type Deal = {
  opportunity_id: string; target_id: number; nation: string; site: string; state: string; project_type: string; size: string
  score: number | null; stage: string; one_line: string; what_the_tribe_would_receive: string; questions: string[]
  proposal_file: string; approved_to_share: number
}

export type WarmPath = {
  contact_id: number; contact_name: string; contact_org: string; owner: string; strength: string
  why_this_path: string; could_introduce_to: string; suggested_ask: string; contact_email?: string
}

export type Issue = { severity: 'block' | 'warn'; category: string; detail: string; suggested_fix: string }
export type Draft = {
  id: number; target_id: number; call_id: number | null; kind: string; recipient: string; recipient_email: string; recipient_email_source?: string
  subject: string; body: string; status: string; target_name?: string
  review: { approved?: boolean; issues?: Issue[]; summary?: string; revised?: boolean; code_recheck?: Issue[] }
}

export type Brief = {
  call_goal: string; context: string
  priorities?: { item: string; benefit: string }[]
  attendees: { name: string; role: string; background: string; connection: string }[]
  questions: { id: number; category: string; question: string; why_ask: string; priority: string }[]
  their_likely_questions: { question: string; suggested_answer: string }[]
  avoid_asking: string[]; confirm_with_contact: string[]; open_items: string[]
}

export type Meeting = {
  action_items: { action: string; owner: string; owner_detail: string; due_date: string | null; priority: string }[]
  next_meeting: string; answered_question_ids: number[]; unanswered_questions: string[]
  new_contacts: { name: string; role: string; org: string }[]; profile_updates: string[]; interest_level: number
  suspicious_text: string[]
  deal_signal?: string; deal_answers?: { question: string; answer: string }[]; deal_note?: string; changes_for_the_deal?: string[]
}

export type Call = {
  id: number; target_id: number; target_name?: string; title: string; scheduled_at: string
  attendees: { name: string; role: string; org: string }[]; agenda: string; consent_to_record: number
  brief: Brief | null; brief_status: string; brief_generated_at: string | null; brief_refreshed_at: string | null
  meeting: Meeting | null; status: string; summary_source?: string | null; opportunity_id?: string | null
}

export type Action = {
  id: number; target_id: number; call_id: number | null; action: string; owner: string; owner_detail?: string; due_date: string | null
  priority: string; status: string; source?: string; created_at: string; completed_at?: string | null; target_name?: string
}

export type Status = {
  has_key: boolean; key_name: string | null; model: string; pricing_is_placeholder: boolean
  network: { owner: string; last_import: string | null; overdue: boolean }[]
  tokens_today: number; daily_token_budget: number; cost_this_month: number; monthly_cost_budget: number; dataset: string; zoom_connected: boolean; outlook_connected?: boolean
}

export const STAGES = ['Identified', 'Researched', 'Paths found', 'Outreach drafted', 'Outreach approved', 'Call scheduled', 'Met', 'Follow-up']

export const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
export const fmtDay = (iso?: string | null) =>
  iso ? new Date(iso.length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''
export const fmtUsd = (n?: number | null) => (n == null ? '-' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)
export const fmtNum = (n?: number | null) => (n == null ? '-' : Math.round(n).toLocaleString())

export const AGENT_NAME: Record<string, string> = {
  scanner: 'scanner', research: 'research', connector: 'connector', outreach: 'outreach', reviewer: 'reviewer', prep: 'prep', tracker: 'tracker',
}
export const agentName = (k: string) => AGENT_NAME[k] || k

export type LinkedInStatus = { enabled: boolean; installed: boolean; open: boolean; signed_in: boolean; error: string }
