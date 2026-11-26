// 설정: ~/.config/agent-kanban/config.json (AGENT_KANBAN_CONFIG 로 교체). 내장 모듈만 사용(hook·monitor 가 node_modules 없이 돌아야 함).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export interface Config {
  enabled: boolean
  root: string
  board: string
  includePaths: string[]
  excludePaths: string[]
  includeHeadless: boolean
  allowAuthors?: string[]
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

/** 설정이 없거나 깨졌거나 enabled 가 true 가 아니거나 root 가 없으면 null (그러면 hook·monitor 는 아무것도 하지 않는다) */
export function loadConfig(): Config | null {
  let raw: any
  try {
    raw = JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return null
  const rootRaw = process.env.AGENT_KANBAN_ROOT || raw.root
  if (typeof rootRaw !== 'string' || !rootRaw) return null
  const root = resolve(expandHome(rootRaw))
  const board = typeof raw.board === 'string' && /^[a-z0-9-]{1,32}$/.test(raw.board) ? raw.board : 'main'
  const m = raw.monitor ?? {}
  const t = raw.telegram ?? {}
  return {
    enabled: true,
    root,
    board,
    includePaths: strs(raw.includePaths),
    excludePaths: strs(raw.excludePaths),
    includeHeadless: raw.includeHeadless === true,
    ...(Array.isArray(raw.allowAuthors) ? { allowAuthors: raw.allowAuthors.filter((x: unknown): x is string => typeof x === 'string') } : {}),
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

/** includePaths 가 있으면 그 밑만, excludePaths 밑은 제외 */
export function pathAllowed(cfg: Config, cwd: string | undefined): boolean {
  const c = cwd ? resolve(cwd) : ''
  if (cfg.includePaths.length && !(c && cfg.includePaths.some((d) => under(c, d)))) return false
  if (c && cfg.excludePaths.some((d) => under(c, d))) return false
  return true
}

export function envToken(cfg: Config): string | undefined {
  return process.env[cfg.telegram.tokenEnv] || undefined
}
