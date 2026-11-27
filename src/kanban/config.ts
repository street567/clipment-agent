// 설정: ~/.config/agent-kanban/config.json (AGENT_KANBAN_CONFIG 로 교체). 내장 모듈만 사용(hook·monitor 가 node_modules 없이 돌아야 함).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { sanitizeLabel } from './core/lane.ts'

/** 한 보드 폴더(워크스페이스). includePaths 가 없으면 "기본" 워크스페이스 */
export interface Workspace {
  name?: string
  root: string
  board: string
  includePaths: string[]
  excludePaths: string[]
}

/** 설정 파일 전체(전역 옵션 + 워크스페이스 목록). 세션 라우팅 전 단계 */
export interface AllConfig {
  enabled: true
  workspaces: Workspace[]
  /** 전역 excludePaths (워크스페이스별 excludePaths 는 각 워크스페이스에) */
  excludePaths: string[]
  includeHeadless: boolean
  allowAuthors?: string[]
  /** 이 컴퓨터의 표시 이름(SPEC 1.2). 없으면 ComputerName/hostname */
  machineName?: string
  /** tmux 세션 이름 앞에서 뗄 접두어(기본 없음) */
  laneStripPrefixes: string[]
  monitor: { intervalSec: number; busyDelaySec: number }
  telegram: { enabled: boolean; chatId: string; tokenEnv: string; apiBase: string }
}

/** 한 세션이 속한 워크스페이스로 좁힌 설정. root/board/includePaths 는 그 워크스페이스 것, excludePaths 는 전역+워크스페이스 합 */
export interface Config {
  enabled: boolean
  root: string
  board: string
  workspaceName?: string
  includePaths: string[]
  excludePaths: string[]
  includeHeadless: boolean
  allowAuthors?: string[]
  machineName?: string
  laneStripPrefixes: string[]
  monitor: { intervalSec: number; busyDelaySec: number }
  telegram: { enabled: boolean; chatId: string; tokenEnv: string; apiBase: string }
}

export const DEFAULT_ROOT = join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/Agent Kanban')

export function configPath(): string {
  return process.env.AGENT_KANBAN_CONFIG || join(homedir(), '.config/agent-kanban/config.json')
}

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

const num = (v: unknown, d: number, min: number) => (typeof v === 'number' && isFinite(v) ? Math.max(min, v) : d)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0).map((x) => resolve(expandHome(x))) : [])

const BOARD_RE = /^[a-z0-9-]{1,32}$/

/** 설정 파일의 workspaces + 옛 최상위 root 를 워크스페이스 목록으로 정규화(경로 해석·중복 제거). setup 도 같이 쓴다 */
export function normalizeWorkspaces(raw: any): Workspace[] {
  const out: Workspace[] = []
  const add = (w: any, legacy: boolean) => {
    if (!w || typeof w !== 'object' || typeof w.root !== 'string' || !w.root) return
    const root = resolve(expandHome(w.root))
    if (out.some((x) => x.root === root)) return
    out.push({
      ...(typeof w.name === 'string' && w.name ? { name: w.name } : {}),
      root,
      board: typeof w.board === 'string' && BOARD_RE.test(w.board) ? w.board : 'main',
      includePaths: strs(w.includePaths),
      // 옛 최상위 excludePaths 는 전역으로 읽는다(워크스페이스에 넣지 않음)
      excludePaths: legacy ? [] : strs(w.excludePaths),
    })
  }
  if (Array.isArray(raw?.workspaces)) for (const w of raw.workspaces) add(w, false)
  if (typeof raw?.root === 'string' && raw.root) add({ root: raw.root, board: raw.board, includePaths: raw.includePaths }, true)
  return out
}

/** 설정이 없거나 깨졌거나 enabled 가 true 가 아니거나 워크스페이스가 하나도 없으면 null (그러면 hook·monitor 는 아무것도 하지 않는다) */
export function loadAllConfig(): AllConfig | null {
  let raw: any
  try {
    raw = JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return null
  let workspaces = normalizeWorkspaces(raw)
  const envRoot = process.env.AGENT_KANBAN_ROOT
  if (envRoot) {
    // 환경변수: "워크스페이스 하나, 이 root" (옛 최상위 board/includePaths 는 그대로 적용)
    const legacy = normalizeWorkspaces({ root: envRoot, board: raw.board, includePaths: raw.includePaths })
    workspaces = legacy
  }
  if (!workspaces.length) return null
  const m = raw.monitor ?? {}
  const t = raw.telegram ?? {}
  return {
    enabled: true,
    workspaces,
    excludePaths: strs(raw.excludePaths),
    includeHeadless: raw.includeHeadless === true,
    ...(Array.isArray(raw.allowAuthors) ? { allowAuthors: raw.allowAuthors.filter((x: unknown): x is string => typeof x === 'string') } : {}),
    ...(sanitizeLabel(raw.machineName) ? { machineName: sanitizeLabel(raw.machineName) } : {}),
    laneStripPrefixes: Array.isArray(raw.laneStripPrefixes) ? raw.laneStripPrefixes.filter((x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 40) : [],
    monitor: { intervalSec: num(m.intervalSec, 5, 0.1), busyDelaySec: num(m.busyDelaySec, 30, 0) },
    telegram: {
      enabled: t.enabled === true,
      chatId: typeof t.chatId === 'string' || typeof t.chatId === 'number' ? String(t.chatId) : '',
      tokenEnv: typeof t.tokenEnv === 'string' && t.tokenEnv ? t.tokenEnv : 'AGENT_KANBAN_TELEGRAM_TOKEN',
      apiBase: typeof t.apiBase === 'string' && t.apiBase ? t.apiBase.replace(/\/+$/, '') : 'https://api.telegram.org',
    },
  }
}

const under = (cwd: string, dir: string) => cwd === dir || cwd.startsWith(dir.endsWith(sep) ? dir : dir + sep)

export interface Route {
  workspace?: Workspace
  /** 라우팅 이유(또는 추적하지 않는 이유) */
  reason: string
  ambiguous?: boolean
}

/**
 * cwd → 워크스페이스. 전역/워크스페이스 excludePaths 밑이면 제외.
 * includePaths 가 cwd 를 포함하는 워크스페이스 중 가장 긴 접두사가 이긴다. 없으면 includePaths 없는 "기본" 워크스페이스가 정확히 하나일 때 그것.
 * 그 외(기본이 둘 이상, 같은 길이로 겹침, 해당 없음)는 추적하지 않는다.
 */
export function routeWorkspace(all: Pick<AllConfig, 'workspaces' | 'excludePaths'>, cwd: string | undefined): Route {
  const c = cwd ? resolve(cwd) : ''
  if (c && all.excludePaths.some((d) => under(c, d))) return { reason: '전역 excludePaths 밑이라 제외' }
  const alive = all.workspaces.filter((w) => !(c && w.excludePaths.some((d) => under(c, d))))
  const scoped: { w: Workspace; len: number }[] = []
  if (c) {
    for (const w of alive) {
      const hits = w.includePaths.filter((d) => under(c, d))
      if (hits.length) scoped.push({ w, len: Math.max(...hits.map((d) => d.length)) })
    }
  }
  if (scoped.length) {
    const best = Math.max(...scoped.map((s) => s.len))
    const top = scoped.filter((s) => s.len === best)
    if (top.length === 1) return { workspace: top[0].w, reason: `includePaths 로 매칭(${top[0].w.name ?? top[0].w.root})` }
    return { reason: `같은 범위(includePaths)가 여러 워크스페이스에 있어 추적하지 않음: ${top.map((s) => s.w.root).join(', ')}`, ambiguous: true }
  }
  const defaults = alive.filter((w) => !w.includePaths.length)
  if (defaults.length === 1) return { workspace: defaults[0], reason: `기본 워크스페이스(${defaults[0].name ?? defaults[0].root})` }
  if (defaults.length > 1) return { reason: `기본 워크스페이스(includePaths 없음)가 ${defaults.length}개라 어디로 보낼지 알 수 없어 추적하지 않음: ${defaults.map((w) => w.root).join(', ')}`, ambiguous: true }
  return { reason: '이 폴더를 포함하는 워크스페이스(includePaths)가 없고 기본 워크스페이스도 없어 추적하지 않음' }
}

export function configFor(all: AllConfig, w: Workspace): Config {
  return {
    enabled: true,
    root: w.root,
    board: w.board,
    ...(w.name ? { workspaceName: w.name } : {}),
    includePaths: w.includePaths,
    excludePaths: [...all.excludePaths, ...w.excludePaths],
    includeHeadless: all.includeHeadless,
    ...(all.allowAuthors ? { allowAuthors: all.allowAuthors } : {}),
    ...(all.machineName ? { machineName: all.machineName } : {}),
    laneStripPrefixes: all.laneStripPrefixes,
    monitor: all.monitor,
    telegram: all.telegram,
  }
}

/** 세션 cwd 의 워크스페이스로 좁힌 설정. 추적하지 않는 세션이면 null.
 *  cwd 를 생략하면(CLI) 현재 폴더로 라우팅하고, 안 되면 첫 워크스페이스로 대신한다(보드 명령이 동작하도록). */
export function loadConfig(cwd?: string, opts: { workspaceRoot?: string } = {}): Config | null {
  const all = loadAllConfig()
  if (!all) return null
  if (opts.workspaceRoot) {
    const w = all.workspaces.find((x) => x.root === opts.workspaceRoot)
    if (w) return configFor(all, w)
  }
  const r = routeWorkspace(all, cwd ?? process.cwd())
  if (r.workspace) return configFor(all, r.workspace)
  if (cwd === undefined) return configFor(all, all.workspaces[0])
  return null
}

/** includePaths/excludePaths 로 이 세션 폴더가 허용되는지(라우팅이 끝난 설정 기준) */
export function pathAllowed(cfg: Config, cwd: string | undefined): boolean {
  const c = cwd ? resolve(cwd) : ''
  if (cfg.includePaths.length && !(c && cfg.includePaths.some((d) => under(c, d)))) return false
  if (c && cfg.excludePaths.some((d) => under(c, d))) return false
  return true
}

export function envToken(cfg: Config): string | undefined {
  return process.env[cfg.telegram.tokenEnv] || undefined
}
