// 반영 요청 · 주인 없는 카드 이어받기 (SPEC 1.3 §17). 내장 모듈만 사용(monitor·hook 이 node_modules 없이 돌아야 함).
//  - 살아 있는 세션 = now.json 이 ended 가 아니고 aliveAt 이 2분 안
//  - 요청은 .taken.json 을 배타 생성한 세션 하나가 맡는다. 우선순위: (a) 카드 주인(세션·레인) > (b) 같은 컴퓨터·같은 프로젝트 폴더 이름 > (c) 아무 세션
//  - 의견 전달은 항상 receipt 의 배타 생성이 정한다 → 어떤 경로로도 두 번 전달되지 않는다.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../config.ts'
import { closeAnswered, type Ctx } from './board.ts'
import { claim, pendingFor, renderRequest, type Pending } from './deliver.ts'
import { iso, listDirs, mtimeMs, readJson } from './fs.ts'
import { readMarkers, removeMarker, writeAdopt, writeMarker, type ReqMarker } from './inbound.ts'
import { isId, SESSION_RE } from './ids.ts'
import { laneOwner } from './lane.ts'
import type { SessionState } from './localstate.ts'
import type { RequestRec, SessionRec, Store } from './store.ts'

/** "살아 있다"의 기준: aliveAt(없으면 ts)이 이 안이어야 한다 (감시가 1분마다 aliveAt 을 갱신) */
export const LIVE_MS = Number(process.env.AGENT_KANBAN_LIVE_MS) || 2 * 60_000
/** 주인 세션이 이 시간 넘게 신호가 없으면(또는 ended) 주인 없는 카드로 본다 */
export const ORPHAN_STALE_MS = Number(process.env.AGENT_KANBAN_ORPHAN_MS) || 5 * 60_000
/** 주인 없는 상태가 이만큼 이어져야 이어받는다(세션 재시작 틈에 가로채지 않게) */
export const ORPHAN_GRACE_MS = process.env.AGENT_KANBAN_ORPHAN_GRACE_MS !== undefined ? Number(process.env.AGENT_KANBAN_ORPHAN_GRACE_MS) : 60_000
export const ORPHAN_SCAN_MS = process.env.AGENT_KANBAN_ORPHAN_SCAN_MS !== undefined ? Number(process.env.AGENT_KANBAN_ORPHAN_SCAN_MS) : 30_000
/** 이보다 오래된 반영 요청은 새로 맡지 않는다 */
export const REQUEST_MAX_AGE_MS = 24 * 3600_000
/** 더 잘 맞는 세션이 아닌 쪽이 맡기 전에 기다리는 감시 틱 수 */
export const WAIT_TICKS = 2
const DELIVER_BUDGET = 7000

// ── 세션 목록 (now.json + session.json)
export type Liveness = 'live' | 'recent'
export interface SessInfo {
  id: string
  name?: string
  machine?: string
  lane?: string
  agentKey?: string
  created: string
  liveness: Liveness // 끝나거나 신호가 오래된 세션은 목록에 없다
}

const aliveMs = (n: any): number => {
  const t = Math.max(Date.parse(n?.aliveAt ?? '') || 0, Date.parse(n?.ts ?? '') || 0)
  return t
}

export class SessionIndex {
  private meta = new Map<string, SessionRec>()
  constructor(private store: Store) {}
  /** 지금 살아 있거나(live, LIVE_MS) 최근까지 살아 있던(recent, ORPHAN_STALE_MS) 세션들. now.json 이 1시간 넘게 안 바뀐 세션은 읽지 않는다 */
  refresh(nowMs = Date.now()): SessInfo[] {
    const out: SessInfo[] = []
    const base = join(this.store.boardDir, 'sessions')
    for (const id of listDirs(base)) {
      if (!SESSION_RE.test(id)) continue
      const np = join(base, id, 'now.json')
      const mt = mtimeMs(np)
      if (mt === null || nowMs - mt > 3600_000) continue
      const n = readJson<any>(np)
      if (!n || n.state === 'ended' || n.replacedBy) continue
      const age = nowMs - aliveMs(n)
      const liveness: Liveness | null = age <= LIVE_MS ? 'live' : age <= ORPHAN_STALE_MS ? 'recent' : null
      if (!liveness) continue
      let s = this.meta.get(id)
      if (!s) {
        const r = this.store.readSession(id)
        if (r) this.meta.set(id, (s = r))
      }
      out.push({ id, name: s?.name, machine: s?.machine, lane: s?.lane, agentKey: s?.agentKey, created: s?.created ?? '', liveness })
    }
    return out
  }
}

/**
 * 같은 레인(agentKey)에 살아 있는 세션이 둘이면 "지금 세션" 하나만 남긴다: 이 컴퓨터의 레인 소유자 기록, 없으면 가장 늦게 시작한 세션.
 * 살아 있는(live) 세션만 돌려준다.
 */
export function currentSessions(infos: SessInfo[], owner: (key: string) => string | undefined = laneOwner): SessInfo[] {
  const live = infos.filter((i) => i.liveness === 'live')
  const keep: SessInfo[] = []
  const groups = new Map<string, SessInfo[]>()
  for (const i of live) {
    if (!i.agentKey) keep.push(i)
    else groups.set(i.agentKey, [...(groups.get(i.agentKey) ?? []), i])
  }
  for (const [key, g] of groups) {
    if (g.length === 1) keep.push(g[0])
    else {
      const o = owner(key)
      const cur = g.find((x) => x.id === o) ?? [...g].sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : a.id < b.id ? 1 : -1))[0]
      keep.push(cur)
    }
  }
  return keep
}

// ── 카드 주인 · 순위
export interface CardInfo {
  id: string
  title: string
  kind: string
  sessionId?: string
  agentKey?: string
  name?: string // 카드를 만든 세션의 session.json name(작업 폴더 이름)
  machine?: string
}

export function cardInfo(store: Store, id: string): CardInfo | null {
  const c = store.readCard(id)
  if (!c) return null
  const s = c.sessionId ? store.readSession(c.sessionId) : null
  return { id, title: c.title, kind: c.kind, sessionId: c.sessionId, agentKey: c.agentKey, name: s?.name, machine: c.machine ?? s?.machine }
}

/** 한 세션이 이 카드들에 대해 가지는 순위: 1=카드 주인(세션 또는 레인), 2=같은 컴퓨터·같은 프로젝트 폴더 이름, 3=그 밖의 세션. 여러 카드면 가장 좋은 것 */
export function rankOf(c: SessInfo, cards: CardInfo[]): 1 | 2 | 3 {
  let best: 1 | 2 | 3 = 3
  for (const k of cards) {
    if ((k.sessionId && k.sessionId === c.id) || (k.agentKey && k.agentKey === c.agentKey)) return 1
    if (k.name && c.name === k.name && (!k.machine || c.machine === k.machine)) best = 2
  }
  return best
}

/** 카드 주인의 상태: 'live'(신호 2분 안) | 'recent'(5분 안) | 'dead'(끝났거나 5분 넘게 신호 없음) */
export function ownerStatus(k: CardInfo, infos: SessInfo[]): 'live' | 'recent' | 'dead' {
  const mine = infos.filter((i) => (k.agentKey && i.agentKey === k.agentKey) || (!k.agentKey && k.sessionId && i.id === k.sessionId))
  if (mine.some((i) => i.liveness === 'live')) return 'live'
  if (mine.length) return 'recent'
  return 'dead'
}

export type Decision = 'claim' | 'wait' | 'no'

/**
 * 요청을 지금 맡을 차례인가 (순수 함수).
 *  - to 가 있으면 그 레인(agentKey)의 지금 세션만, 기다림 없이 맡는다.
 *  - 없으면 살아 있는 세션 중 순위가 가장 좋은 세션들만 후보이고, 그중 session id 가 가장 작은 하나가 먼저(기다림 없음, 순위 1·2일 때)
 *    맡는다. 순위 3 이거나 먼저 맡을 세션이 아니면 WAIT_TICKS 틱을 기다렸다가 맡는다. 겹쳐도 .taken.json 배타 생성이 하나만 이기게 한다.
 */
export function decideClaim(req: Pick<RequestRec, 'to'>, cands: SessInfo[], cards: CardInfo[], me: string, ticks: number): Decision {
  const mine = cands.find((c) => c.id === me)
  if (!mine) return 'no'
  if (req.to) return mine.agentKey === req.to ? 'claim' : 'no'
  const ranked = cands.map((c) => ({ c, r: rankOf(c, cards) }))
  const best = Math.min(...ranked.map((x) => x.r))
  const my = ranked.find((x) => x.c.id === me)!.r
  if (my !== best) return 'no'
  const first = ranked.filter((x) => x.r === best).map((x) => x.c.id).sort()[0]
  if (best < 3 && first === me) return 'claim'
  return ticks >= WAIT_TICKS ? 'claim' : 'wait'
}

// ── 대상 카드 · 미전달 의견
const titleOf = (store: Store, id: string) => () => store.readCard(id)?.title ?? ''
export const pendingOf = (store: Store, cardId: string, allow?: string[]): Pending[] => pendingFor(store, cardId, titleOf(store, cardId), allow)

/** 보드 전체에서 미전달 사람 의견이 있는 카드 id (요청의 cardIds 가 비었을 때) */
export function cardsWithPending(store: Store, allow?: string[]): string[] {
  return store.cardIds().filter((id) => pendingOf(store, id, allow).length > 0)
}

function requestCards(store: Store, req: RequestRec, allow?: string[]): string[] {
  return req.cardIds?.length ? [...new Set(req.cardIds)] : cardsWithPending(store, allow)
}

/** done 파일에 쓸 handled/skipped: delivered 의 카드 = handled, 나머지는 이유와 함께 skipped */
export function doneBody(store: Store, cardIds: string[], delivered: string[]) {
  const handled = cardIds.filter((c) => delivered.includes(c))
  const skipped = cardIds
    .filter((c) => !delivered.includes(c))
    .map((cardId) => {
      let reason = '반영할 의견 없음'
      if (!store.readCard(cardId)) reason = '카드를 찾지 못함'
      else if (store.comments(cardId).some((x) => x.author === 'user') || store.actions(cardId).length) reason = '이미 전달됨(다른 경로로 전달돼 이 요청에서는 건드리지 않음)'
      return { cardId, reason }
    })
  return { handled, skipped }
}

export function finishRequest(store: Store, sid: string, id: string, cardIds: string[], delivered: string[], over?: { handled?: string[]; skipped?: { cardId: string; reason: string }[] }): boolean {
  const body = over?.handled || over?.skipped ? { handled: over.handled ?? [], skipped: over.skipped ?? [] } : doneBody(store, cardIds, delivered)
  const wrote = store.writeRequestDone({ schema: 1, id, sessionId: sid, handled: body.handled, skipped: body.skipped, created: iso() })
  removeMarker(sid, id)
  return wrote
}

// ── 맡은 요청의 전달 (Stop hook · board_inbox, 세션 락 안에서)
/** 이 세션이 맡은 열린 요청들의 미전달 의견을 receipt 를 만들며 한 덩어리로 전달한다. 글이 없으면 undefined */
export function deliverRequests(ctx: Ctx, via: 'stop' | 'inbox'): { text?: string; won: Pending[] } {
  const { store, st, cfg } = ctx
  const blocks: string[] = []
  const wonAll: Pending[] = []
  for (const m of readMarkers(st.sessionId)) {
    if (store.hasDone(m.id)) {
      removeMarker(st.sessionId, m.id)
      continue
    }
    const taken = store.readTaken(m.id)
    if (taken && taken.sessionId !== st.sessionId) {
      removeMarker(st.sessionId, m.id)
      continue
    }
    const req = store.readRequest(m.id)
    const items = m.cardIds.flatMap((c) => pendingOf(store, c, cfg.allowAuthors))
    if (!items.length) continue
    const picked: Pending[] = []
    let used = 0
    for (const it of items) {
      const len = it.text.length + it.cardTitle.length + 200
      if (picked.length && used + len > DELIVER_BUDGET) break
      picked.push(it)
      used += len
    }
    const won = claim(store, st, picked, via)
    if (!won.length) continue
    closeAnswered(ctx, won)
    wonAll.push(...won)
    const delivered = [...new Set([...m.delivered, ...won.map((w) => w.cardId)])]
    writeMarker(st.sessionId, { ...m, delivered })
    blocks.push(renderRequest({ id: m.id, author: req?.authorName, items: won, remaining: items.length - won.length, again: m.delivered.length > 0 }))
  }
  return blocks.length ? { text: blocks.join('\n\n'), won: wonAll } : { won: wonAll }
}

/** 맡은 요청 중 미전달 의견이 모두 없어졌으면(= 모든 의견에 receipt) done 을 쓴다. 끝낸 요청 id 들 */
export function autoDone(store: Store, sid: string, allow?: string[]): string[] {
  const done: string[] = []
  for (const m of readMarkers(sid)) {
    if (store.hasDone(m.id)) {
      removeMarker(sid, m.id)
      continue
    }
    const taken = store.readTaken(m.id)
    if (taken && taken.sessionId !== sid) {
      removeMarker(sid, m.id)
      continue
    }
    if (m.cardIds.some((c) => pendingOf(store, c, allow).length > 0)) continue
    finishRequest(store, sid, m.id, m.cardIds, m.delivered)
    done.push(m.id)
  }
  return done
}

/** 이 세션의 열린 요청·이어받은 카드의 id (board_reply 가 이 카드들에 답할 수 있게) */
export function delegatedCards(sid: string): Set<string> {
  const s = new Set<string>()
  for (const m of readMarkers(sid)) for (const c of m.cardIds) s.add(c)
  return s
}

// ── 감시: 요청 맡기 · 주인 없는 카드 이어받기
interface Pend {
  req: RequestRec
  first: number
  ticks: number
  cards?: CardInfo[]
}

export interface WatchCtx {
  cfg: Config
  store: Store
  sid: string
  st: SessionState
  idle: boolean
  nowMs: number
}

export class InboundWatcher {
  private idx: SessionIndex
  private reqMt: number | null | undefined
  private settled = new Set<string>()
  private pend = new Map<string, Pend>()
  private unreadable = new Map<string, number>()
  private orphanLast = Date.now() // 첫 훑기는 한 주기 뒤(감시 시작 직후 카드를 훑지 않는다)
  private cardMeta = new Map<string, { info: CardInfo | null; key: string; items: number }>()
  private orphanSince = new Map<string, number>()
  adopted: string[] = []
  constructor(private store: Store, private busyDelayMs: number) {
    this.idx = new SessionIndex(store)
  }

  /** 새 세션으로 바뀌면 상태를 비운다 */
  reset() {
    this.pend.clear()
    this.settled.clear()
    this.unreadable.clear()
    this.reqMt = undefined
    this.orphanSince.clear()
    this.adopted = []
  }

  private ingest(id: string, nowMs: number, allow?: string[]) {
    const req = this.store.readRequest(id)
    if (!req) {
      const n = (this.unreadable.get(id) ?? 0) + 1
      if (n > 30) {
        this.unreadable.delete(id)
        this.settled.add(id)
      } else this.unreadable.set(id, n)
      return
    }
    this.unreadable.delete(id)
    const age = nowMs - Date.parse(req.created)
    if (!isFinite(age) || age > REQUEST_MAX_AGE_MS || this.store.hasTaken(id) || this.store.hasDone(id)) {
      this.settled.add(id)
      return
    }
    if (allow && !(req.authorName && allow.includes(req.authorName))) {
      this.settled.add(id) // 허용 목록에 없는 작성자의 요청은 맡지 않는다(§8 과 같은 규칙)
      return
    }
    this.pend.set(id, { req, first: nowMs, ticks: 0 })
  }

  /** 이번 틱에 이 세션이 새로 맡은 요청 id 들 (글 전달은 board_inbox/Stop 이 한다) */
  tickRequests(o: WatchCtx): string[] {
    const { store, sid, st, cfg, nowMs } = o
    const mt = mtimeMs(store.requestsDir)
    if (mt === null) return []
    if (mt !== this.reqMt || this.unreadable.size) {
      this.reqMt = mt
      for (const id of store.requestIds()) if (!this.settled.has(id) && !this.pend.has(id)) this.ingest(id, nowMs, cfg.allowAuthors)
    }
    if (!this.pend.size) return []
    let cands: SessInfo[] | null = null
    const claimed: string[] = []
    for (const [id, e] of [...this.pend]) {
      if (store.hasTaken(id) || store.hasDone(id)) {
        this.pend.delete(id)
        this.settled.add(id)
        continue
      }
      e.ticks++
      cands ??= currentSessions(this.idx.refresh(nowMs))
      if (!e.req.to && !e.cards) {
        const ids = requestCards(store, e.req, cfg.allowAuthors)
        e.cards = ids.map((c) => cardInfo(store, c)).filter((c): c is CardInfo => !!c)
      }
      const d = decideClaim(e.req, cands, e.cards ?? [], sid, e.ticks)
      if (d !== 'claim') continue
      if (!o.idle && nowMs - e.first < this.busyDelayMs) continue // 일하는 중이면 busyDelaySec 지난 뒤에
      this.pend.delete(id)
      this.settled.add(id)
      const won = store.claimRequest({ schema: 1, id, sessionId: sid, ...(st.lane?.agentKey ? { agentKey: st.lane.agentKey } : {}), ...(st.machine ? { machine: st.machine } : {}), ...(st.lane?.name ? { lane: st.lane.name } : {}), created: iso(nowMs) })
      if (!won) continue
      const cardIds = requestCards(store, e.req, cfg.allowAuthors)
      const has = cardIds.some((c) => pendingOf(store, c, cfg.allowAuthors).length > 0)
      if (!has) {
        finishRequest(store, sid, id, cardIds, []) // 반영할 의견이 없으면 맡자마자 끝
        continue
      }
      writeMarker(sid, { v: 1, id, cardIds, delivered: [], created: iso(nowMs) } satisfies ReqMarker)
      claimed.push(id)
    }
    return claimed
  }

  /** 주인 없는 카드를 이어받을 세션이 이 세션이면 그 카드 id 들. 훑기 주기가 안 됐으면 null(바뀐 것 없음) */
  tickOrphans(o: WatchCtx): string[] | null {
    const { store, sid, cfg, nowMs } = o
    if (!cfg.adoptOrphans) {
      if (this.adopted.length) {
        this.adopted = []
        writeAdopt(sid, [])
        return []
      }
      return null
    }
    if (nowMs - this.orphanLast < ORPHAN_SCAN_MS) return null
    this.orphanLast = nowMs
    const infos = this.idx.refresh(nowMs)
    const cands = currentSessions(infos)
    const mine: string[] = []
    const seen = new Set<string>()
    if (cands.some((c) => c.id === sid)) {
      for (const id of store.cardIds()) {
        let meta = this.cardMeta.get(id)
        if (!meta) this.cardMeta.set(id, (meta = { info: cardInfo(store, id), key: '', items: 0 }))
        else if (!meta.info) meta.info = cardInfo(store, id)
        const info = meta.info
        if (!info || info.kind === 'manual') continue // 맡긴 카드는 §14 의 흐름
        const dir = store.cardDir(id)
        const key = ['comments', 'actions', 'receipts'].map((d) => mtimeMs(join(dir, d))).join('|')
        if (key !== meta.key) {
          meta.key = key
          meta.items = pendingOf(store, id, cfg.allowAuthors).length
        }
        if (!meta.items || ownerStatus(info, infos) !== 'dead') continue
        seen.add(id)
        const since = this.orphanSince.get(id) ?? nowMs
        this.orphanSince.set(id, since)
        if (nowMs - since < ORPHAN_GRACE_MS) continue
        const ranked = cands.map((c) => ({ c, r: rankOf(c, [info]) }))
        const best = Math.min(...ranked.map((x) => x.r))
        const first = ranked.filter((x) => x.r === best).map((x) => x.c.id).sort()[0]
        if (first === sid) mine.push(id)
      }
    }
    for (const id of [...this.orphanSince.keys()]) if (!seen.has(id)) this.orphanSince.delete(id)
    const same = mine.length === this.adopted.length && mine.every((x, i) => x === this.adopted[i])
    if (same) return null
    this.adopted = mine
    writeAdopt(sid, mine)
    return mine
  }
}

/** 요청 상태 조회용(앱·CLI 와 같은 규칙): requests/<id>.json 한 건의 상태 */
export function requestState(store: Store, id: string): 'open' | 'taken' | 'done' {
  if (existsSync(join(store.requestsDir, `${id}.done.json`))) return 'done'
  return store.hasTaken(id) ? 'taken' : 'open'
}

export const isReqId = isId
