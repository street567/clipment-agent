import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

export const DEFAULT_ROOT = join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/ClipReview')

// ---------- 워크스페이스 (SPEC §7) ----------

export interface Workspace { name: string; path: string; allowAuthors?: string[] }

export function configPath(): string {
  const env = process.env.CLIPREV_CONFIG
  return resolve(env && env.trim() ? env : join(homedir(), '.config/cliprev/workspaces.json'))
}

const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

export function validWorkspaceName(n: unknown): n is string {
  return typeof n === 'string' && n.trim() === n && n.length >= 1 && n.length <= 64 && !/[\/\\\0]/.test(n) && !n.startsWith('.')
}

/** 설정 파일 원본 읽기 (없으면 빈 목록). 잘못된 JSON 이면 오류. */
export function readConfigWorkspaces(): Workspace[] {
  const file = configPath()
  if (!existsSync(file)) return []
  let j: any
  try { j = JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
    throw new ValidationError(`설정 파일을 읽을 수 없습니다: ${file} (${e instanceof Error ? e.message : e})`)
  }
  const out: Workspace[] = []
  for (const w of Array.isArray(j?.workspaces) ? j.workspaces : []) {
    if (!w || !validWorkspaceName(w.name) || typeof w.path !== 'string' || !w.path.trim()) continue
    const ws: Workspace = { name: w.name, path: resolve(expandHome(w.path.trim())) }
    if (Array.isArray(w.allowAuthors)) {
      const a = w.allowAuthors.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim()).map((x: string) => x.trim())
      if (a.length) ws.allowAuthors = a
    }
    out.push(ws)
  }
  return out
}

export function writeConfigWorkspaces(list: Workspace[]): void {
  const file = configPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ workspaces: list }, null, 2) + '\n')
}

/** 우선순위: CLIPREV_ROOT(단일, 기존 호환) > 설정 파일 > 기본 iCloud 경로 */
export function workspaces(): Workspace[] {
  const env = process.env.CLIPREV_ROOT
  if (env && env.trim()) { const path = resolve(env); return [{ name: basename(path) || 'root', path }] }
  const cfg = readConfigWorkspaces()
  if (cfg.length) return cfg
  return [{ name: basename(DEFAULT_ROOT), path: DEFAULT_ROOT }]
}

/** 첫 번째 워크스페이스 경로 (기존 호환) */
export function rootDir(): string { return workspaces()[0]!.path }

export interface ProjectRef { workspace: Workspace; slug: string; dir: string }

function wsByName(name: string): Workspace {
  const list = workspaces()
  const w = list.find(x => x.name === name)
  if (!w) throw new ValidationError(`알 수 없는 워크스페이스: ${name} (등록됨: ${list.map(x => x.name).join(', ')})`)
  return w
}

/** `<워크스페이스>/<프로젝트>` 또는 유일한 `<프로젝트>` 를 해석. 프로젝트 존재 여부는 검사하지 않는 한 경우도 있음(아래 참고). */
export function resolveProject(ref: string, opts: { allowMissing?: boolean } = {}): ProjectRef {
  if (typeof ref !== 'string') throw new ValidationError(`잘못된 프로젝트: ${JSON.stringify(ref)}`)
  const i = ref.indexOf('/')
  if (i >= 0) {
    const w = wsByName(ref.slice(0, i))
    const slug = assertSlug(ref.slice(i + 1))
    return { workspace: w, slug, dir: safeJoin(w.path, slug) }
  }
  const slug = assertSlug(ref)
  const list = workspaces()
  const withProject = list.filter(w => existsSync(join(w.path, slug, 'project.json')))
  const cands = withProject.length ? withProject : list.filter(w => existsSync(join(w.path, slug)))
  if (cands.length === 1) return { workspace: cands[0]!, slug, dir: safeJoin(cands[0]!.path, slug) }
  if (cands.length > 1)
    throw new ValidationError(`프로젝트 이름이 모호합니다: ${slug} — ${cands.map(w => `${w.name}/${slug}`).join(', ')} 중 하나로 지정하세요`)
  if (list.length === 1 || opts.allowMissing) {
    if (list.length > 1) throw new ValidationError(`프로젝트 없음: ${slug} — 워크스페이스를 지정하세요 (${list.map(w => `${w.name}/${slug}`).join(', ')})`)
    return { workspace: list[0]!, slug, dir: safeJoin(list[0]!.path, slug) }
  }
  throw new ValidationError(`프로젝트 없음: ${slug} (워크스페이스: ${list.map(w => w.name).join(', ')})`)
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

export function projectDir(ref: string): string {
  return resolveProject(ref).dir
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
export function locksDir(ref: string) { return safeJoin(projectDir(ref), 'locks') }
