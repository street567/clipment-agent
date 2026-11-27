// 보드 쓰기 연산: 카드 만들기·이벤트·now.json·텔레그램 알림 큐. hook·mcp·monitor 가 같이 쓴다.
// 반드시 withSession 락 안에서 호출한다(로컬 상태와 클라우드 쓰기를 같이 바꾼다).
import type { Config } from '../config.ts'
import { iso } from './fs.ts'
import { derive } from './derive.ts'
import { laneTitle } from './lane.ts'
import { cardId as mkCardId, newId, type CardKind } from './ids.ts'
import { clean } from './redact.ts'
import type { CardStatus, SessionState } from './localstate.ts'
import type { EventRec, Store } from './store.ts'
import { actorLine, boardState, cardView } from './team.ts'

export interface Notice {
  text: string
}
export interface Ctx {
  cfg: Config
  store: Store
  st: SessionState
  notices: Notice[] // 락을 풀고 나서 보낼 텔레그램 알림
  via?: 'self' // `kanban agent` 로 스스로 남기는 이벤트(SPEC §15)
}

export const NOW_MIN_INTERVAL_MS = 5000

export function newCtx(cfg: Config, store: Store, st: SessionState): Ctx {
  return { cfg, store, st, notices: [] }
}

/** 카드가 없으면 만든다(card.json 배타 생성 + created 이벤트). 카드 id 반환 */
export function ensureCard(ctx: Ctx, kind: CardKind, key: string, title: string, opts?: { detail?: string }): string {
  const { st, store } = ctx
  const id = mkCardId(kind, st.sessionId, key)
  if (st.cards[id]) return id
  const t = clean(title, 120) || clean(st.name, 120) || '(제목 없음)'
  const made = store.writeCard({ id, sessionId: st.sessionId, kind, title: t, ...(opts?.detail ? { detail: clean(opts.detail, 200) } : {}), created: iso() })
  st.cards[id] = { kind, status: 'waiting', title: t, shownTitle: t, lastMs: 0 }
  if (made) emit(ctx, id, 'created')
  return id
}

const STATUS_BY_TYPE: Record<string, CardStatus | undefined> = { created: 'waiting', progress: 'working', paused: 'paused', done: 'done', failed: 'failed' }

/** 이벤트 하나를 쓰고 로컬 상태를 갱신한다. created 는 카드마다 단조 증가(같은 ms 에도 순서 보장) */
export function emit(
  ctx: Ctx,
  cardId: string,
  type: EventRec['type'],
  f: { summary?: string; tool?: string; title?: string; ref?: string; from?: string; ask?: { kind: string; options?: string[]; to?: string[] } } = {},
): EventRec {
  const { st, store } = ctx
  const c = st.cards[cardId]
  const ms = Math.max(Date.now(), (c?.lastMs ?? 0) + 1)
  const ev: EventRec = {
    schema: 1,
    id: newId(),
    cardId,
    sessionId: st.sessionId,
    type,
    ...(f.summary !== undefined ? { summary: clean(f.summary, type === 'report' ? 4000 : 4000) } : {}),
    ...(f.tool ? { tool: clean(f.tool, 80) } : {}),
    ...(f.title ? { title: clean(f.title, 120) } : {}),
    ...(f.ref ? { ref: f.ref } : {}),
    ...(f.from ? { from: f.from } : {}),
    ...(f.ask ? { ask: f.ask } : {}),
    ...(ctx.via ? { via: ctx.via } : {}),
    created: iso(ms),
  }
  store.writeEvent(ev)
  if (c) {
    c.lastMs = ms
    const s = STATUS_BY_TYPE[type]
    if (s) c.status = s
    if (type === 'progress' && ev.title) c.shownTitle = ev.title
  }
  return ev
}

/** 카드를 "일하는 중"으로. 이미 일하는 중이고 제목도 그대로면 아무것도 쓰지 않는다. */
export function touchWorking(ctx: Ctx, cardId: string, force = false): boolean {
  const c = ctx.st.cards[cardId]
  if (!c) return false
  const titleChanged = c.title !== c.shownTitle
  if (c.status === 'working' && !titleChanged && !force) return false
  emit(ctx, cardId, 'progress', titleChanged ? { title: c.title } : {})
  return true
}

export function setTitle(ctx: Ctx, cardId: string, title: string) {
  const c = ctx.st.cards[cardId]
  if (c?.lane) return // 레인 카드 제목은 "컴퓨터 · 레인" 으로 고정(지금 하는 일은 now.json summary)
  if (c && title) c.title = clean(title, 120) || c.title
}

export function sessionCardId(ctx: Ctx): string {
  return ensureSessionCard(ctx, ctx.st.name)
}

/** 세션 카드. 레인(채널)이 있으면 레인 카드(세션이 바뀌어도 같은 카드, SPEC 1.2 §16), 없거나 밀려났으면 세션별 카드 */
export function ensureSessionCard(ctx: Ctx, title: string): string {
  const l = ctx.st.lane
  if (l && !l.superseded) return ctx.st.cards[l.cardId] ? l.cardId : attachLaneCard(ctx)
  return ensureCard(ctx, 'session', '', title)
}

/** 레인 카드를 만들거나(첫 세션) 이어받는다(다음 세션: 이벤트 기록은 그대로, "replaced" 이벤트 추가). 락(withSession) 안에서만 */
function attachLaneCard(ctx: Ctx): string {
  const { st, store } = ctx
  const l = st.lane!
  const id = l.cardId
  const title = clean(laneTitle(st.machine ?? 'computer', l.name), 120)
  const made = store.writeCard({ id, sessionId: st.sessionId, kind: 'session', title, created: iso(), agentKey: l.agentKey, lane: l.name, ...(st.machine ? { machine: st.machine } : {}) })
  if (made) {
    st.cards[id] = { kind: 'session', status: 'waiting', title, shownTitle: title, lastMs: 0, lane: true }
    emit(ctx, id, 'created')
    l.pendingFrom = undefined
    return id
  }
  const events = store.events(id)
  const d = derive(events, store.actions(id))
  const last = events.length ? Date.parse(events[events.length - 1].created) : 0
  const card = store.readCard(id)
  st.cards[id] = { kind: 'session', status: d.base === 'working' ? 'working' : d.base === 'done' ? 'done' : d.base === 'failed' ? 'failed' : 'waiting', title, shownTitle: d.title ?? card?.title ?? title, lastMs: isFinite(last) ? last : 0, lane: true }
  const from = l.pendingFrom ?? [...events].reverse().find((e) => e.type !== 'replaced')?.sessionId
  l.pendingFrom = undefined
  if (from && from !== st.sessionId) {
    emit(ctx, id, 'replaced', { summary: '새 세션으로 이어짐', from })
    if (st.cards[id].status === 'working') emit(ctx, id, 'paused') // 이전 세션이 일하다 끊긴 채 남은 "AI 작업 중"을 거둔다
  }
  return id
}

/** 맡은 카드 중 지금 쓸 수 있는 것(가장 나중에 맡은 순): 끝나지 않았고 확인 요청 중이 아닌 것 */
export function takenCardId(st: SessionState): string | undefined {
  const list = st.taken ?? []
  for (let i = list.length - 1; i >= 0; i--) {
    const c = st.cards[list[i]]
    if (c && c.kind === 'manual' && c.taken && c.status !== 'done' && !c.submitted && !c.recalled) return list[i]
  }
  return undefined
}

/** 지금 하는 일 카드: in_progress 로 정해진 task, 없으면 맡은 카드, 없으면 세션 카드 */
export function currentCardId(ctx: Ctx): string {
  const { st } = ctx
  if (st.currentTaskId) {
    const id = st.tasks[st.currentTaskId]
    if (id && st.cards[id] && st.cards[id].status !== 'done') return id
  }
  return takenCardId(st) ?? sessionCardId(ctx)
}

/** 맡은 카드가 풀렸거나 남에게 넘어갔을 때: 이 세션의 로컬 표시를 지운다(클라우드에는 쓰지 않음) */
export function dropTaken(st: SessionState, id: string, recalled = true) {
  const c = st.cards[id]
  if (c) {
    c.taken = false
    c.recalled = recalled
    c.submitted = false
    if (c.status === 'working') c.status = 'paused'
  }
  st.taken = (st.taken ?? []).filter((x) => x !== id)
}

/** 이 세션이 쓸 manual 카드를 로컬 상태에 올린다(맡았거나 board_card 로 만든 것) */
export function registerManual(ctx: Ctx, id: string, title: string, taken: boolean) {
  const { st } = ctx
  const c = st.cards[id] ?? (st.cards[id] = { kind: 'manual', status: 'waiting', title, shownTitle: title, lastMs: 0 })
  if (taken) {
    c.taken = true
    c.recalled = false
    st.taken = [...(st.taken ?? []).filter((x) => x !== id), id]
  }
}

/** needs_human 이벤트를 쓰고 텔레그램 알림을 큐에 넣는다 */
export function needsHuman(ctx: Ctx, cardId: string, summary: string, ask: { kind: string; options?: string[]; to?: string[] }, toolUseId?: string): EventRec {
  const ev = emit(ctx, cardId, 'needs_human', { summary, ask })
  if (ask.kind === 'info') ctx.st.openInfos.push({ cardId, eventId: ev.id, ...(toolUseId ? { toolUseId } : {}) })
  queueNotice(ctx, cardId, ask.kind === 'info' ? '확인 필요' : '사람 차례', summary)
  return ev
}

export function queueNotice(ctx: Ctx, cardId: string, label: string, text: string) {
  if (!ctx.cfg.telegram.enabled) return
  const title = ctx.st.cards[cardId]?.title ?? ctx.st.name
  ctx.notices.push({ text: `[${clean(ctx.st.name, 40)}] ${label}\n${title}\n${clean(text, 600)}\n${actorsText(ctx, cardId)}` })
}

/** 사람 차례 알림에 붙이는 "담당: 민수, 지연"(미정이면 "담당: 미정"). 알림을 켰을 때만 읽는다 */
function actorsText(ctx: Ctx, cardId: string): string {
  try {
    const { store, st } = ctx
    const card = store.readCard(cardId)
    if (!card) return '담당: 미정'
    const board = boardState(store.boardOps())
    const session = card.sessionId ? store.readSession(card.sessionId) ?? { name: st.name, agent: st.agent } : null
    const v = cardView({ card, session, ops: store.cardOps(cardId), events: store.events(cardId), actions: store.actions(cardId), board })
    return actorLine(board, v.actors)
  } catch {
    return '담당: 미정'
  }
}

export interface NowFields {
  state: 'working' | 'idle' | 'ended'
  cardId?: string
  summary?: string
  tool?: string
}

/** now.json 갱신: 상태·카드가 바뀌면 즉시, 아니면 최소 5초 간격. 쓰면 true */
export function setNow(ctx: Ctx, f: NowFields, force = false): boolean {
  const { st, store } = ctx
  const prev = st.now
  const t = Date.now()
  const changed = !prev || prev.state !== f.state || prev.cardId !== f.cardId
  if (!changed && !force && t - prev.writtenMs < NOW_MIN_INTERVAL_MS) return false
  const summary = f.summary !== undefined ? clean(f.summary, 200) : undefined
  const ts = iso(t)
  st.now = { state: f.state, cardId: f.cardId, summary, tool: f.tool, ts, writtenMs: t, aliveMs: t }
  store.writeNow(st.sessionId, {
    schema: 1,
    sessionId: st.sessionId,
    state: f.state,
    ...(f.cardId ? { cardId: f.cardId } : {}),
    ...(summary ? { summary } : {}),
    ...(f.tool ? { tool: clean(f.tool, 80) } : {}),
    ts,
    aliveAt: ts,
  })
  return true
}

/** 감시 스크립트가 5분마다: aliveAt 만 갱신 */
export function bumpAlive(ctx: Ctx) {
  const { st, store } = ctx
  const n = st.now
  if (!n || n.state === 'ended') return false
  const t = Date.now()
  n.aliveMs = t
  store.writeNow(st.sessionId, {
    schema: 1,
    sessionId: st.sessionId,
    state: n.state,
    ...(n.cardId ? { cardId: n.cardId } : {}),
    ...(n.summary ? { summary: n.summary } : {}),
    ...(n.tool ? { tool: n.tool } : {}),
    ts: n.ts,
    aliveAt: iso(t),
  })
  return true
}

/** 전달된 처리(action)로 닫을 것을 닫는다. ask 카드는 끝난 것으로 한다(에이전트가 직접 완료하는 도구는 없음).
 *  맡은 manual 카드는 check 요청의 처리만 본다: 승인이면 더 쓰지 않고, 그 밖(거절 등)이면 다시 일할 수 있게 한다(다음에 progress). */
export function closeAnswered(ctx: Ctx, delivered: { kind: string; cardId: string; actionKind?: string; askKind?: string }[]) {
  for (const d of delivered) {
    const c = ctx.st.cards[d.cardId]
    if (d.kind !== 'action' || !c) continue
    if (c.kind === 'ask' && c.status !== 'done') emit(ctx, d.cardId, 'done')
    else if (c.kind === 'manual' && c.taken && c.submitted && d.askKind === 'check') {
      c.submitted = false
      if (d.actionKind === 'approve') c.status = 'done'
      else c.status = 'paused'
    }
  }
}
