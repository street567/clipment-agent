import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export const DEFAULT_ROOT = join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/ClipReview')

export function rootDir(): string {
  const env = process.env.CLIPREV_ROOT
  return resolve(env && env.trim() ? env : DEFAULT_ROOT)
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class ValidationError extends Error {}

export function isSlug(s: unknown): s is string {
  return typeof s === 'string' && s.length >= 1 && s.length <= 64 && SLUG_RE.test(s)
}
export function isId(s: unknown): s is string {
  return typeof s === 'string' && UUID_RE.test(s)
}
export function isVersionNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 999
}

export function assertSlug(s: unknown): string {
  if (!isSlug(s)) throw new ValidationError(`잘못된 프로젝트 slug: ${JSON.stringify(s)} (소문자·숫자·하이픈만)`)
  return s
}
export function assertId(s: unknown, what = 'id'): string {
  if (!isId(s)) throw new ValidationError(`잘못된 ${what}: ${JSON.stringify(s)} (소문자 UUID 필요)`)
  return s
}
export function assertVersionNum(n: unknown): number {
  if (!isVersionNum(n)) throw new ValidationError(`잘못된 버전 번호: ${JSON.stringify(n)} (1~999 정수)`)
  return n
}

export function versionLabel(n: number): string {
  return 'v' + String(assertVersionNum(n)).padStart(3, '0')
}

/** root 밖으로 나가는 경로를 최종 방어선에서 차단 */
export function safeJoin(base: string, ...parts: string[]): string {
  const full = resolve(base, ...parts)
  const b = resolve(base)
  if (full !== b && !full.startsWith(b + sep)) throw new ValidationError(`경로 이탈 차단: ${full}`)
  return full
}

export function projectDir(slug: string): string {
  return safeJoin(rootDir(), assertSlug(slug))
}
export function versionDir(slug: string, version: number): string {
  return safeJoin(projectDir(slug), 'versions', versionLabel(version))
}
export function commentsDir(slug: string) { return safeJoin(projectDir(slug), 'comments') }
export function repliesDir(slug: string, commentId: string) {
  return safeJoin(projectDir(slug), 'replies', assertId(commentId, 'commentId'))
}
export function requestsDir(slug: string) { return safeJoin(projectDir(slug), 'requests') }
export function progressDir(slug: string, requestId: string) {
  return safeJoin(projectDir(slug), 'progress', assertId(requestId, 'requestId'))
}
