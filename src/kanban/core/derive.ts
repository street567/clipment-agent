// SPEC §5·§12 리스트 파생 (순수 함수). spec/fixtures/derive.json · team.json 으로 검증.
export type List = 'mine' | 'working' | 'waiting' | 'done'
export type BaseState = 'waiting' | 'working' | 'done' | 'failed' | 'turn'
export interface DEvent {
  id: string
  type: string
  created: string
  summary?: string
  ref?: string
  ask?: { kind?: string; options?: string[]; to?: string[] }
  title?: string
}
export interface DAction {
  id: string
  ref: string
  created: string
  kind?: string
}
export interface Derived {
  list: List
  base: BaseState
  open: DEvent[]
  lastReport?: string
  title?: string
}
/** manual 카드의 state op (§12): 이벤트와 한 줄로 세운다 */
export interface StateOp {
  id: string
  created: string
  state: 'waiting' | 'working' | 'mine' | 'done'
}

export const byCreated = (a: { created: string; id: string }, b: { created: string; id: string }) =>
  a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

type Item = { created: string; id: string; ev?: DEvent; state?: StateOp['state'] }

export function derive(eventsIn: DEvent[], actions: DAction[] = [], stateOps: StateOp[] = []): Derived {
  const real = [...eventsIn].sort(byCreated)
  // check 요청(§12): 첫 action 이 approve 면 그 시각에 done, reject 면 paused 가 있는 것으로 본다
  const firstAct = new Map<string, DAction>()
  for (const a of [...actions].sort(byCreated)) if (a.ref && !firstAct.has(a.ref)) firstAct.set(a.ref, a)
  const items: Item[] = real.map((ev) => ({ created: ev.created, id: ev.id, ev }))
  for (const e of real) {
    if (e.type !== 'needs_human' || e.ask?.kind !== 'check') continue
    const a = firstAct.get(e.id)
    if (a && (a.kind === 'approve' || a.kind === 'reject')) {
      items.push({ created: a.created, id: a.id, ev: { id: a.id, type: a.kind === 'approve' ? 'done' : 'paused', created: a.created } })
    }
  }
  for (const s of stateOps) items.push({ created: s.created, id: s.id, state: s.state })
  items.sort(byCreated)

  let base: BaseState = 'waiting'
  let lastReport: string | undefined
  let title: string | undefined
  for (const it of items) {
    if (it.state) {
      base = it.state === 'mine' ? 'turn' : it.state
      continue
    }
    const e = it.ev!
    if (e.type === 'created') base = 'waiting'
    else if (e.type === 'progress') {
      base = 'working'
      if (e.title) title = e.title
    } else if (e.type === 'paused') base = 'waiting'
    else if (e.type === 'done') base = 'done'
    else if (e.type === 'failed') base = 'failed'
    else if (e.type === 'report') lastReport = e.summary
  }
  const refs = new Set<string>()
  for (const e of real) if (e.type === 'resolved' && e.ref) refs.add(e.ref)
  for (const a of actions) if (a.ref) refs.add(a.ref)
  const open: DEvent[] = []
  items.forEach((it, i) => {
    const e = it.ev
    if (!e || e.type !== 'needs_human' || refs.has(e.id)) return
    const later = items.slice(i + 1)
    if (later.some((x) => x.state)) return // state op 이 뒤에 오면 닫힌 것
    const laterEv = later.filter((x) => x.ev).map((x) => x.ev!)
    if (laterEv.some((x) => x.type === 'done')) return
    if (e.ask?.kind === 'info' && laterEv.some((x) => x.type === 'progress' || x.type === 'paused' || x.type === 'failed')) return
    open.push(e)
  })
  let list: List
  if (open.length) list = 'mine'
  else if (base === 'failed' || base === 'turn') list = 'mine'
  else if (base === 'working') list = 'working'
  else if (base === 'done') list = 'done'
  else list = 'waiting'
  return { list, base, open, lastReport, title }
}
