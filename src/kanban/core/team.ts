// SPEC §11~14 담당·카테고리·리스트·순서 (순수 함수). spec/fixtures/team.json 으로 검증.
import { byCreated, derive, type BaseState, type DAction, type DEvent, type List, type StateOp } from './derive.ts'

export interface By {
  author: 'user' | 'agent'
  name?: string
  member?: string
}
export interface OpRec {
  id: string
  created: string
  by?: By
  set: Record<string, unknown>
  cardId?: string
}
export interface Member {
  id: string
  name: string
  kind: 'human' | 'llm'
  agent?: string
  project?: string
  color?: number
  rank?: number
}
export interface LabelDef {
  id: string
  name: string
  color: number
  rank: number
  assignees?: string[]
}
export interface ListDef {
  id: string
  title: string
  base: List
  rank: number
}
export interface Board {
  members: Map<string, Member>
  labels: Map<string, LabelDef>
  lists: Map<string, ListDef>
  ranks: Map<string, number>
  defaultHuman?: string
}
export interface Check {
  id: string
  text: string
  done: boolean
  rank: number
  assignee?: string
}
export type Nature = 'human' | 'llm' | 'both' | 'none'

const KEY_ID = /^[a-z0-9-]{1,64}$/
export const isKeyId = (s: unknown): s is string => typeof s === 'string' && KEY_ID.test(s)
const AGENT_RE = /^[a-z0-9-]{1,20}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const LISTS: List[] = ['mine', 'working', 'waiting', 'done']
const STATES = ['waiting', 'working', 'mine', 'done']
const cps = (s: string) => Array.from(s).length
const isStr = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && cps(v) >= min && cps(v) <= max
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

// ── 열쇠별 검증 (null 은 항상 "지움")
export function validCardKey(key: string, v: unknown): boolean {
  if (v === null) return /^(title|detail|due|list|state|archived)$/.test(key) || /^(assignee|label|check)\.[a-z0-9-]{1,64}$/.test(key) || /^released\.[1-9][0-9]{0,8}$/.test(key)
  if (key.startsWith('released.')) return /^released\.[1-9][0-9]{0,8}$/.test(key) && v === true
  if (key === 'title') return isStr(v, 1, 120)
  if (key === 'detail') return isStr(v, 0, 4000)
  if (key === 'due') return typeof v === 'string' && DATE_RE.test(v)
  if (key === 'list') return isKeyId(v)
  if (key === 'state') return typeof v === 'string' && STATES.includes(v)
  if (key === 'archived') return v === true
  if (key.startsWith('assignee.') || key.startsWith('label.')) return keyShapeOk(key) && v === true
  if (key.startsWith('check.')) {
    if (!keyShapeOk(key) || !isObj(v)) return false
    return isStr(v.text, 1, 200) && typeof v.done === 'boolean' && isNum(v.rank) && (v.assignee === undefined || isKeyId(v.assignee))
  }
  return false
}
function keyShapeOk(key: string): boolean {
  const i = key.indexOf('.')
  return i < 0 ? true : isKeyId(key.slice(i + 1))
}
export function validBoardKey(key: string, v: unknown): boolean {
  if (key === 'defaultHuman') return v === null || isKeyId(v)
  if (key.startsWith('rank.')) return /^[A-Za-z0-9-]{1,64}$/.test(key.slice(5)) && (v === null || isNum(v))
  if (!keyShapeOk(key)) return false
  if (key.startsWith('member.')) {
    if (v === null) return true
    if (!isObj(v) || !isStr(v.name, 1, 20) || (v.kind !== 'human' && v.kind !== 'llm')) return false
    if (v.agent !== undefined && !(typeof v.agent === 'string' && AGENT_RE.test(v.agent))) return false
    if (v.project !== undefined && !isStr(v.project, 0, 60)) return false
    if (v.color !== undefined && !(Number.isInteger(v.color) && v.color >= 0 && v.color <= 9)) return false
    if (v.rank !== undefined && !isNum(v.rank)) return false
    return true
  }
  if (key.startsWith('label.')) {
    if (v === null) return true
    if (!isObj(v) || !isStr(v.name, 1, 20) || !(Number.isInteger(v.color) && v.color >= 0 && v.color <= 9) || !isNum(v.rank)) return false
    if (v.assignees !== undefined && !(Array.isArray(v.assignees) && v.assignees.length <= 8 && v.assignees.every(isKeyId))) return false
    return true
  }
  if (key.startsWith('list.')) {
    if (v === null) return true
    return isObj(v) && isStr(v.title, 1, 20) && LISTS.includes(v.base) && isNum(v.rank)
  }
  return false
}

export interface Merged {
  /** 열쇠 → 마지막 값(null = 지움). 값이 틀린 열쇠는 앞의 값 유지 */
  values: Map<string, unknown>
  /** 열쇠 → 그 값을 쓴 op 의 by */
  by: Map<string, By | undefined>
}

/** §11 합치기: created 순(같으면 id), 열쇠마다 마지막 값. 모양이 틀린 열쇠만 무시 */
export function mergeOps(ops: OpRec[], valid: (key: string, v: unknown) => boolean): Merged {
  const values = new Map<string, unknown>()
  const by = new Map<string, By | undefined>()
  for (const op of [...ops].sort(byCreated)) {
    if (!isObj(op.set)) continue
    const keys = Object.keys(op.set)
    if (keys.length < 1 || keys.length > 200) continue
    for (const k of keys) {
      if (!valid(k, op.set[k])) continue
      values.set(k, op.set[k])
      by.set(k, op.by)
    }
  }
  return { values, by }
}

// ── 멤버·보드
const DEFAULT_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }
export const agentName = (agent: string) => DEFAULT_NAMES[agent] ?? agent
export const llmMemberId = (agent: string) => `llm-${agent}`

/** §11 보드 ops → 보드 설정 */
export function boardState(ops: OpRec[]): Board {
  const m = mergeOps(ops, validBoardKey)
  const b: Board = { members: new Map(), labels: new Map(), lists: new Map(), ranks: new Map() }
  for (let i = 0; i < LISTS.length; i++) {
    const id = LISTS[i]
    b.lists.set(id, { id, title: ({ mine: '사람 차례', working: '진행 중', waiting: '대기', done: '완료' } as const)[id], base: id, rank: i })
  }
  for (const [k, v] of m.values) {
    const i = k.indexOf('.')
    const kind = i < 0 ? k : k.slice(0, i)
    const id = i < 0 ? '' : k.slice(i + 1)
    if (kind === 'defaultHuman') {
      if (typeof v === 'string') b.defaultHuman = v
    } else if (kind === 'member' && v) {
      const x = v as any
      b.members.set(id, { id, name: x.name, kind: x.kind, ...(x.agent !== undefined ? { agent: x.agent } : {}), ...(x.project ? { project: x.project } : {}), ...(x.color !== undefined ? { color: x.color } : {}), ...(x.rank !== undefined ? { rank: x.rank } : {}) })
    } else if (kind === 'label' && v) {
      const x = v as any
      b.labels.set(id, { id, name: x.name, color: x.color, rank: x.rank, ...(x.assignees ? { assignees: x.assignees } : {}) })
    } else if (kind === 'list' && v) {
      const x = v as any
      const def = b.lists.get(id)
      // 기본 리스트는 이름·rank 만 바꿀 수 있고 base 는 못 바꾼다
      b.lists.set(id, { id, title: x.title, base: def && LISTS.includes(id as List) ? def.base : x.base, rank: x.rank })
    } else if (kind === 'rank' && typeof v === 'number') b.ranks.set(id, v)
  }
  return b
}

/** 멤버 하나. 기본 LLM 멤버(llm-<agent>)는 보드에 나오는 agent 마다 자동이라 id 모양으로 만들어 준다 */
export function getMember(b: Board, id: string): Member | undefined {
  const m = b.members.get(id)
  if (m) return m
  const r = /^llm-([a-z0-9-]{1,20})$/.exec(id)
  if (r) return { id, name: agentName(r[1]), kind: 'llm', agent: r[1] }
  return undefined
}

/** 보드 멤버 전체(기본 LLM 멤버는 agents 에 있는 것만 더한다), 정렬: 사람 먼저·rank·id */
export function allMembers(b: Board, agents: string[] = []): Member[] {
  const out = new Map(b.members)
  for (const a of agents) if (AGENT_RE.test(a) && !out.has(llmMemberId(a))) out.set(llmMemberId(a), getMember(b, llmMemberId(a))!)
  return [...out.values()].sort(cmpMember)
}
const cmpMember = (a: Member, b: Member) => (a.kind === b.kind ? 0 : a.kind === 'human' ? -1 : 1) || (a.rank ?? 1e9) - (b.rank ?? 1e9) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** §12 세션 → LLM 멤버 */
export function memberForSession(b: Board, session: { name?: string; agent?: string } | null | undefined): Member {
  const agent = session?.agent && AGENT_RE.test(session.agent) ? session.agent : 'claude'
  const name = session?.name
  if (name) {
    const hit = [...b.members.values()].filter((m) => m.kind === 'llm' && m.agent === agent && m.project === name).sort(cmpMember)[0]
    if (hit) return hit
  }
  return getMember(b, llmMemberId(agent))!
}

/** 이름(대소문자 무시) 또는 id 로 멤버 찾기. 같은 이름이 여럿이면 정렬 첫째 */
export function findMember(b: Board, key: string, agents: string[] = []): Member | undefined {
  const k = key.trim()
  const all = allMembers(b, agents)
  return all.find((m) => m.id === k) ?? all.find((m) => m.name.toLowerCase() === k.toLowerCase()) ?? getMember(b, k)
}
export function findLabel(b: Board, key: string): LabelDef | undefined {
  const k = key.trim()
  const all = [...b.labels.values()].sort((x, y) => x.rank - y.rank || (x.id < y.id ? -1 : 1))
  return all.find((l) => l.id === k) ?? all.find((l) => l.name.toLowerCase() === k.toLowerCase())
}

// ── 카드
export interface CardInfo {
  id: string
  kind: string
  created: string
  title: string
  detail?: string
  sessionId?: string
  by?: By
}
export interface CardInput {
  card: CardInfo
  session?: { name?: string; agent?: string } | null
  ops: OpRec[]
  events: DEvent[]
  actions: (DAction & { authorMember?: string })[]
  board: Board
}
export interface CardView {
  base: BaseState
  list: List
  listId: string
  open: DEvent[]
  lastReport?: string
  title: string
  detail?: string
  due: string | null
  archived: boolean
  labels: string[]
  checks: Check[]
  assignees: string[]
  actors: string[]
  nature: Nature
  rank: number
  merged: Merged
}

const sortIds = (b: Board, ids: string[]): string[] =>
  [...new Set(ids)].sort((x, y) => {
    const a = getMember(b, x)
    const c = getMember(b, y)
    if (a && c) return cmpMember(a, c)
    if (a) return -1
    if (c) return 1
    return x < y ? -1 : x > y ? 1 : 0
  })

export function stateOpsOf(ops: OpRec[]): StateOp[] {
  const out: StateOp[] = []
  for (const op of ops) {
    if (!isObj(op.set) || Object.keys(op.set).length < 1 || Object.keys(op.set).length > 200) continue
    const v = op.set.state
    if (typeof v === 'string' && STATES.includes(v)) out.push({ id: op.id, created: op.created, state: v as StateOp['state'] })
  }
  return out
}

export function cardView(inp: CardInput): CardView {
  const { card, board: b } = inp
  const manual = card.kind === 'manual'
  const merged = mergeOps(inp.ops, validCardKey)
  const mv = (k: string) => merged.values.get(k)
  const d = derive(inp.events, inp.actions, manual ? stateOpsOf(inp.ops) : [])

  // 리스트 (§13)
  let listId: string = d.list
  const lv = mv('list')
  if (typeof lv === 'string') {
    const def = b.lists.get(lv)
    if (def && def.base === d.list) listId = def.id
  }

  // 담당 (§12)
  const assigned: string[] = []
  const labels: string[] = []
  const checks: Check[] = []
  for (const [k, v] of merged.values) {
    if (k.startsWith('assignee.') && v === true) assigned.push(k.slice(9))
    else if (k.startsWith('label.') && v === true) labels.push(k.slice(6))
    else if (k.startsWith('check.') && v) checks.push({ id: k.slice(6), ...(v as any) })
  }
  if (!manual && !assigned.some((id) => getMember(b, id)?.kind === 'llm')) assigned.push(memberForSession(b, inp.session).id)
  const assignees = sortIds(b, assigned)
  const humansOf = (ids: string[]) => sortIds(b, ids.filter((id) => getMember(b, id)?.kind === 'human'))
  const defaultHuman = b.defaultHuman && getMember(b, b.defaultHuman)?.kind === 'human' ? [b.defaultHuman] : []

  let actors: string[]
  let humanTurn = false
  if (d.open.length) {
    humanTurn = true
    const to = Array.isArray(d.open[0].ask?.to) ? d.open[0].ask!.to!.filter((x): x is string => typeof x === 'string') : []
    actors = humansOf(to)
    if (!actors.length) actors = humansOf(assignees)
    if (!actors.length) actors = defaultHuman
  } else if (d.list === 'mine') {
    humanTurn = true
    actors = humansOf(assignees)
    if (!actors.length) actors = defaultHuman
  } else actors = assignees

  const known = actors.map((id) => getMember(b, id)).filter((m): m is Member => !!m)
  const hasH = known.some((m) => m.kind === 'human')
  const hasL = known.some((m) => m.kind === 'llm')
  const nature: Nature = hasH && hasL ? 'both' : hasH ? 'human' : hasL ? 'llm' : humanTurn ? 'human' : 'none'

  const title = manual ? (typeof mv('title') === 'string' ? (mv('title') as string) : card.title) : d.title ?? card.title
  const detail = manual ? (typeof mv('detail') === 'string' ? (mv('detail') as string) : card.detail) : card.detail
  const due = typeof mv('due') === 'string' ? (mv('due') as string) : null
  const rank = b.ranks.get(card.id) ?? -(Date.parse(card.created) / 1000)

  return {
    base: d.base,
    list: d.list,
    listId,
    open: d.open,
    lastReport: d.lastReport,
    title,
    detail,
    due,
    archived: mv('archived') === true,
    labels: labels.filter((id) => b.labels.has(id)).sort((x, y) => b.labels.get(x)!.rank - b.labels.get(y)!.rank || (x < y ? -1 : 1)),
    checks: checks.sort((x, y) => x.rank - y.rank || (x.id < y.id ? -1 : 1)),
    assignees,
    actors,
    nature,
    rank,
    merged,
  }
}

// ── §14 맡기기
/** 사람이 맡긴 LLM 담당 멤버 id 들. manual 카드, 카드와 그 assignee op 가 모두 by.author=user(=agent 가 만든 것은 제외),
 *  allowAuthors 가 있으면 카드 by.name 과 assignee op 의 by.name 이 모두 목록에 있어야 한다 */
export function delegatedMembers(card: CardInfo, v: CardView, b: Board, allow?: string[]): string[] {
  if (card.kind !== 'manual' || card.by?.author !== 'user') return []
  const ok = (n?: string) => !allow || (!!n && allow.includes(n))
  if (!ok(card.by.name)) return []
  const out: string[] = []
  for (const [k, val] of v.merged.values) {
    if (!k.startsWith('assignee.') || val !== true) continue
    const id = k.slice(9)
    if (getMember(b, id)?.kind !== 'llm') continue
    const by = v.merged.by.get(k)
    if (by?.author !== 'user' || !ok(by.name)) continue
    out.push(id)
  }
  return out
}

/** 이 세션이 맡을 수 있는 카드인가 (이미 맡은 것·done·archived 는 호출하는 쪽이 거른다):
 *  카드의 LLM 담당이 memberForSession 이거나, project 없는 같은 agent 의 멤버(공용 llm-<agent> 포함) */
export function delegatedToSession(card: CardInfo, v: CardView, b: Board, session: { name?: string; agent?: string }, allow?: string[]): boolean {
  const mine = memberForSession(b, session)
  const agent = mine.agent
  return delegatedMembers(card, v, b, allow).some((id) => {
    if (id === mine.id) return true
    const m = getMember(b, id)
    return !!m && m.kind === 'llm' && !m.project && m.agent === agent
  })
}

/** 감시 스크립트가 신호를 내도 되는 카드인가: 담당이 이 세션의 멤버이고 그 멤버에 project 가 있을 때만 (공용은 신호 없음) */
export function signalsCard(card: CardInfo, v: CardView, b: Board, session: { name?: string; agent?: string }, allow?: string[]): boolean {
  const mine = memberForSession(b, session)
  return !!mine.project && delegatedMembers(card, v, b, allow).includes(mine.id)
}

/** §14 지금 맡은 세션: 가장 큰 n 의 take 인데 카드 ops 에 released.<n> 이 없을 때 */
export function currentHolder(takes: { n: number; sessionId: string }[], v: CardView): { n: number; sessionId: string } | null {
  if (!takes.length) return null
  const t = takes.reduce((a, b) => (b.n > a.n ? b : a))
  return v.merged.values.get(`released.${t.n}`) === true ? null : t
}

/** 맡은 카드가 회수됐나: 보관됐거나 LLM 담당이 하나도 안 남았을 때 */
export function recalled(v: CardView, b: Board): boolean {
  if (v.archived) return true
  for (const [k, val] of v.merged.values) if (k.startsWith('assignee.') && val === true && getMember(b, k.slice(9))?.kind === 'llm') return false
  return true
}

// ── 표시 이름
export const memberName = (b: Board, id: string): string => getMember(b, id)?.name ?? '지운 멤버'
export function actorLine(b: Board, actors: string[]): string {
  const names = actors.map((id) => getMember(b, id)).filter((m): m is Member => !!m).map((m) => m.name)
  return names.length ? `담당: ${names.join(', ')}` : '담당: 미정'
}
