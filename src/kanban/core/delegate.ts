// SPEC §14 LLM 에게 맡기기: 이 세션이 맡을 수 있는 카드 찾기. board_list · board_inbox · SessionStart · monitor 에서만 쓴다(hook 은 매 도구 호출마다 쓰지 않음).
import { dropTaken } from './board.ts'
import type { SessionState } from './localstate.ts'
import { sanitizeBody } from './deliver.ts'
import type { DAction, DEvent } from './derive.ts'
import type { CardRec, Store } from './store.ts'
import { actorLine, boardState, cardView, currentHolder, delegatedToSession, mergeOps, recalled as recalledView, validCardKey, type Board, type CardView, type OpRec } from './team.ts'

export interface Session {
  name?: string
  agent?: string
}
export interface Available {
  card: CardRec
  view: CardView
}

/** 한 카드가 이 세션이 맡을 수 있는 상태인가: manual · 맡긴 것 · 아직 아무도 안 맡음 · done/archived 아님 */
export function evalAvailable(card: CardRec, ops: OpRec[], events: DEvent[], actions: DAction[], takes: { n: number; sessionId: string }[], board: Board, session: Session, allow?: string[]): CardView | null {
  if (card.kind !== 'manual') return null
  const view = cardView({ card, session: null, ops, events, actions, board })
  if (currentHolder(takes, view) || view.archived || view.base === 'done') return null
  return delegatedToSession(card, view, board, session, allow) ? view : null
}

/** 보드 전체를 훑어 맡을 수 있는 카드를 모은다 (비싼 일: 카드 수만큼 읽는다) */
export function scanAvailable(store: Store, board: Board, session: Session, allow?: string[]): Available[] {
  const out: Available[] = []
  for (const id of store.cardIds()) {
    const card = store.readCard(id)
    if (!card || card.kind !== 'manual') continue
    const ops = store.cardOps(id)
    if (!ops.some((o) => Object.keys(o.set).some((k) => k.startsWith('assignee.')))) continue // 담당이 없으면 맡긴 것이 아님
    const v = evalAvailable(card, ops, store.events(id), store.actions(id), store.takes(id), board, session, allow)
    if (v) out.push({ card: { ...card, id }, view: v })
  }
  return out.sort((a, b) => (a.card.created < b.card.created ? -1 : a.card.created > b.card.created ? 1 : a.card.id < b.card.id ? -1 : 1))
}

export function loadBoard(store: Store): Board {
  return boardState(store.boardOps())
}

/** 에이전트에게 보여 주는 카드 설명(제목·설명·체크리스트). 사람이 쓴 글이라 sanitizeBody 로 정리한다 */
export function describeCard(card: CardRec, v: CardView, board: Board): string {
  const lines = [`카드 「${sanitizeBody(v.title, 120)}」 card_id=${card.id}`]
  if (v.detail) lines.push(`설명: ${sanitizeBody(v.detail, 1500)}`)
  if (v.checks.length) lines.push('체크리스트:\n' + v.checks.map((c) => `  ${c.done ? '[x]' : '[ ]'} ${sanitizeBody(c.text, 200)}`).join('\n'))
  if (v.due) lines.push(`기한: ${v.due}`)
  if (v.labels.length) lines.push(`카테고리: ${v.labels.map((id) => sanitizeBody(board.labels.get(id)?.name ?? id, 20)).join(', ')}`)
  lines.push(actorLine(board, v.assignees).replace('담당', '담당(전체)'))
  if (card.by?.name) lines.push(`만든 사람: ${sanitizeBody(card.by.name, 40)}`)
  return lines.join('\n')
}

/** 지금 맡은 세션(§14): 가장 큰 n 의 take 인데 released.<n> 이 없을 때. 카드 ops 만 읽는다 */
export function holderOf(store: Store, cardId: string): { n: number; sessionId: string } | null {
  const takes = store.takes(cardId)
  if (!takes.length) return null
  const last = takes[takes.length - 1]
  const m = mergeOps(store.cardOps(cardId), validCardKey)
  return m.values.get(`released.${last.n}`) === true ? null : last
}

/** 맡은 카드가 아직 이 세션 것인가·회수됐는가 (쓰기 전에 확인: Stop·submit·take 때만 부른다) */
export function checkMine(store: Store, board: Board, sessionId: string, cardId: string): { mine: boolean; recalled: boolean; n?: number } {
  const card = store.readCard(cardId)
  if (!card) return { mine: false, recalled: true }
  const ops = store.cardOps(cardId)
  const view = cardView({ card, session: null, ops, events: [], actions: [], board })
  const takes = store.takes(cardId)
  const h = currentHolder(takes, view)
  return { mine: !!h && h.sessionId === sessionId, recalled: recalledView(view, board), ...(h ? { n: h.n } : {}) }
}

/** 맡은 카드 중 풀렸거나 남에게 넘어갔거나 회수된 것을 로컬 표시에 반영한다(board_list·board_inbox 에서) */
export function refreshTaken(store: Store, board: Board, st: SessionState) {
  for (const id of [...(st.taken ?? [])]) {
    const c = checkMine(store, board, st.sessionId, id)
    if (!c.mine || c.recalled) dropTaken(st, id)
  }
}
