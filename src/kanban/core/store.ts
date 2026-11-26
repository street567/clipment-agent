// 클라우드 폴더(SPEC §2) 읽고 쓰기
import { join } from 'node:path'
import { byCreated, type DAction, type DEvent } from './derive.ts'
import { ensureDir, iso, listDirs, listIds, readJson, writeNew, writeReplace } from './fs.ts'
import { readdirSync } from 'node:fs'
import { assertId, assertSessionId, BOARD_RE, ID_RE, newId, SESSION_RE, type CardKind } from './ids.ts'
import { clean } from './redact.ts'
import { validBoardKey, validCardKey, type By, type OpRec } from './team.ts'

export interface EventRec extends DEvent {
  schema: 1
  cardId: string
  sessionId: string
  tool?: string
  via?: 'self'
}
export interface CommentRec {
  id: string
  cardId: string
  author: 'user' | 'agent'
  authorName?: string
  text: string
  replyTo?: string | null
  created: string
}
export interface ActionRec {
  id: string
  cardId: string
  ref: string
  kind: 'approve' | 'reject' | 'choose' | 'done'
  choice?: string | null
  text?: string
  authorName?: string
  authorMember?: string
  created: string
}
export interface CardRec {
  id: string
  sessionId?: string // manual 카드는 없을 수 있다(사람이 앱에서 만든 것)
  kind: CardKind | 'manual'
  title: string
  detail?: string
  created: string
  by?: By
}
export interface TakeRec {
  schema: 1
  cardId: string
  sessionId: string
  created: string
  n?: number
}
export interface SessionRec {
  id: string
  name?: string
  agent?: string
}

export class Store {
  constructor(public root: string, public board: string) {
    if (!BOARD_RE.test(board)) throw new Error('보드 이름이 올바르지 않습니다')
  }
  get boardDir() {
    return join(this.root, 'boards', this.board)
  }
  cardDir(id: string) {
    return join(this.boardDir, 'cards', assertId(id, 'card id'))
  }
  sessionDir(sid: string) {
    return join(this.boardDir, 'sessions', assertSessionId(sid))
  }
  init() {
    ensureDir(this.root)
    writeNew(join(this.root, 'kanban.json'), { schema: 1, contract: '1.1', name: '에이전트 칸반', created: iso() })
    ensureDir(this.boardDir)
    writeNew(join(this.boardDir, 'board.json'), { schema: 1, id: this.board, title: this.board === 'main' ? '내 보드' : this.board, created: iso() })
  }
  ensureSession(sid: string, name: string, agent?: string) {
    writeNew(join(this.sessionDir(sid), 'session.json'), { schema: 1, id: sid, name: clean(name, 60) || sid, ...(agent ? { agent } : {}), created: iso() })
  }
  readSession(sid: string): SessionRec | null {
    return readJson<SessionRec>(join(this.sessionDir(sid), 'session.json'))
  }
  /** 보드에 나온 세션들 (agent 목록 등). 세션 폴더 수만큼 읽는다 — 감시·board_* 에서만 부른다 */
  sessions(): SessionRec[] {
    const out: SessionRec[] = []
    for (const id of listDirs(join(this.boardDir, 'sessions'))) {
      if (!SESSION_RE.test(id)) continue
      const s = this.readSession(id)
      if (s) out.push({ ...s, id })
    }
    return out
  }
  /** card.json 을 배타적으로 만든다. 새로 만들었으면 true */
  writeCard(c: CardRec): boolean {
    return writeNew(join(this.cardDir(c.id), 'card.json'), {
      schema: 1,
      ...c,
      title: clean(c.title, 120) || '(제목 없음)',
      ...(c.detail !== undefined ? { detail: clean(c.detail, c.kind === 'manual' ? 4000 : 200) } : {}),
    })
  }
  writeEvent(e: EventRec) {
    writeNew(join(this.cardDir(e.cardId), 'events', `${assertId(e.id)}.json`), e)
  }
  writeNow(sid: string, now: unknown) {
    writeReplace(join(this.sessionDir(sid), 'now.json'), now)
  }
  readNow(sid: string): any | null {
    return readJson(join(this.sessionDir(sid), 'now.json'))
  }
  static cardReads = 0 // card.json 읽은 횟수(테스트용)
  readCard(id: string): CardRec | null {
    Store.cardReads++
    return readJson<CardRec>(join(this.cardDir(id), 'card.json'))
  }
  private readAll<T extends { id: string; created: string }>(cardId: string, sub: string): T[] {
    const dir = join(this.cardDir(cardId), sub)
    const out: T[] = []
    for (const id of listIds(dir)) {
      const r = readJson<T>(join(dir, `${id}.json`))
      if (r && typeof r === 'object' && typeof r.created === 'string') out.push({ ...r, id })
    }
    return out.sort(byCreated)
  }
  events(cardId: string) {
    return this.readAll<EventRec>(cardId, 'events')
  }
  actions(cardId: string) {
    return this.readAll<ActionRec>(cardId, 'actions')
  }
  comments(cardId: string) {
    return this.readAll<CommentRec>(cardId, 'comments')
  }
  receiptIds(cardId: string): Set<string> {
    return new Set(listIds(join(this.cardDir(cardId), 'receipts')))
  }
  /** receipt 를 배타적으로 만든 쪽만 true */
  claimReceipt(cardId: string, sessionId: string, itemId: string, via: 'stop' | 'inbox'): boolean {
    return writeNew(join(this.cardDir(cardId), 'receipts', `${assertId(itemId)}.json`), { schema: 1, id: itemId, cardId, sessionId, via, created: iso() })
  }
  addComment(c: CommentRec) {
    writeNew(join(this.cardDir(c.cardId), 'comments', `${assertId(c.id)}.json`), { schema: 1, ...c })
  }
  static cardScans = 0 // 보드 전체 훑기 횟수(테스트용: hook 은 매 도구 호출마다 훑지 않는다)
  cardIds(): string[] {
    Store.cardScans++
    return listDirs(join(this.boardDir, 'cards')).filter((d) => ID_RE.test(d))
  }
  asDerive(cardId: string): { events: EventRec[]; actions: DAction[] } {
    return { events: this.events(cardId), actions: this.actions(cardId) }
  }

  // ── 1.1: ops (§11) · take (§14)
  private readOps(dir: string): OpRec[] {
    const out: OpRec[] = []
    for (const id of listIds(dir)) {
      const r = readJson<OpRec>(join(dir, `${id}.json`))
      if (r && typeof r === 'object' && typeof r.created === 'string' && r.set && typeof r.set === 'object') out.push({ ...r, id })
    }
    return out.sort(byCreated)
  }
  cardOps(cardId: string): OpRec[] {
    return this.readOps(join(this.cardDir(cardId), 'ops'))
  }
  boardOps(): OpRec[] {
    return this.readOps(join(this.boardDir, 'ops'))
  }
  /** 읽은 ops 의 가장 늦은 created 보다 최소 1ms 뒤 */
  private nextCreated(ops: OpRec[]): string {
    let max = 0
    for (const o of ops) {
      const t = Date.parse(o.created)
      if (isFinite(t) && t > max) max = t
    }
    return iso(Math.max(Date.now(), max + 1))
  }
  private cleanSet(set: Record<string, unknown>, valid: (k: string, v: unknown) => boolean): Record<string, unknown> {
    const keys = Object.keys(set).filter((k) => valid(k, set[k]))
    if (keys.length < 1 || keys.length > 200) throw new Error('쓸 수 있는 변경이 없습니다')
    const out: Record<string, unknown> = {}
    for (const k of keys) out[k] = set[k]
    return out
  }
  private cleanBy(by: By): By {
    return { author: by.author, ...(by.name ? { name: clean(by.name, 40) } : {}), ...(by.member && /^[a-z0-9-]{1,64}$/.test(by.member) ? { member: by.member } : {}) }
  }
  writeCardOp(cardId: string, set: Record<string, unknown>, by: By): OpRec {
    const dir = join(this.cardDir(cardId), 'ops')
    const op: OpRec = { id: newId(), cardId, by: this.cleanBy(by), set: this.cleanSet(set, validCardKey), created: this.nextCreated(this.readOps(dir)) }
    writeNew(join(dir, `${op.id}.json`), { schema: 1, ...op })
    return op
  }
  writeBoardOp(set: Record<string, unknown>, by: By): OpRec {
    const dir = join(this.boardDir, 'ops')
    const op: OpRec = { id: newId(), by: this.cleanBy(by), set: this.cleanSet(set, validBoardKey), created: this.nextCreated(this.readOps(dir)) }
    writeNew(join(dir, `${op.id}.json`), { schema: 1, ...op })
    return op
  }
  /** takes/<n>.json 들 (n 오름차순) */
  takes(cardId: string): (TakeRec & { n: number })[] {
    const dir = join(this.cardDir(cardId), 'takes')
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {}
    const out: (TakeRec & { n: number })[] = []
    for (const nm of names) {
      const m = /^([1-9][0-9]{0,8})\.json$/.exec(nm)
      if (!m) continue
      const t = readJson<TakeRec>(join(dir, nm))
      if (t && typeof t.sessionId === 'string') out.push({ ...t, n: Number(m[1]) })
    }
    return out.sort((a, b) => a.n - b.n)
  }
  /** takes/<n>.json 을 배타 생성한 세션이면 n, 졌거나 아직 안 풀린 맡은 세션이 있으면 null */
  writeTake(cardId: string, sessionId: string, holder: { n: number } | null, takes: { n: number }[] = this.takes(cardId)): number | null {
    if (holder) return null
    const n = Math.max(0, ...takes.map((t) => t.n)) + 1
    return writeNew(join(this.cardDir(cardId), 'takes', `${n}.json`), { schema: 1, cardId, sessionId: assertSessionId(sessionId), created: iso() }) ? n : null
  }
}
