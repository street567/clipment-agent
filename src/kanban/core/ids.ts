import { createHash, randomUUID } from 'node:crypto'

export const ID_RE = /^[0-9a-f-]{8,64}$/
export const SESSION_RE = /^[A-Za-z0-9-]{8,64}$/
export const BOARD_RE = /^[a-z0-9-]{1,32}$/
export type CardKind = 'session' | 'task' | 'ask'

export const isId = (s: unknown): s is string => typeof s === 'string' && ID_RE.test(s)
export const isSessionId = (s: unknown): s is string => typeof s === 'string' && SESSION_RE.test(s)

/** SPEC §2: sha256("<kind>|<sessionId>|<key>") 앞 32 hex 를 UUID 모양으로 */
export function cardId(kind: CardKind, sessionId: string, key = ''): string {
  const h = createHash('sha256').update(`${kind}|${sessionId}|${key}`).digest('hex').slice(0, 32)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

export const newId = (): string => randomUUID()

/** 파일 이름으로 쓰기 전 검증 (경로 탈출 방지) */
export function assertId(s: unknown, what = 'id'): string {
  if (!isId(s)) throw new Error(`${what} 형식이 올바르지 않습니다`)
  return s
}
export function assertSessionId(s: unknown): string {
  if (!isSessionId(s)) throw new Error('세션 id 형식이 올바르지 않습니다')
  return s
}
