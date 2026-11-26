// 칸반 설정/상태 (MCP 도구 kanban_setup·kanban_status 와 CLI `kanban setup|status` 가 같이 쓴다).
// 설정이 없는 세션에서도 동작해야 하므로 보드 세션·hook 상태에 의존하지 않는다.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { configPath, expandHome, loadConfig } from './config.ts'
import { writeReplace } from './core/fs.ts'
import { Store } from './core/store.ts'

export interface SetupResult {
  ok: boolean
  /** created | unchanged | replaced | refused | error */
  result: 'created' | 'unchanged' | 'replaced' | 'refused' | 'error'
  message: string
  configPath: string
  currentRoot?: string
  newRoot?: string
  backup?: string
}

export interface StatusResult {
  configured: boolean
  configPath: string
  configExists: boolean
  root?: string
  rootSource?: 'config' | 'env'
  rootReachable?: boolean
  board?: string
  hooks: string
  monitor: string
  message: string
}

const NOT_SET_UP = '칸반이 아직 설정되지 않았어요(not set up). kanban_setup(root: 보드 폴더) 또는 `kanban setup --root <폴더>` 로 설정하세요.'

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

function readRaw(path: string): { raw: any; broken: boolean } | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { raw, broken: false }
  } catch {}
  return { raw: null, broken: true }
}

function defaultConfig(root: string) {
  return {
    enabled: true,
    root,
    board: 'main',
    includePaths: [],
    excludePaths: [],
    includeHeadless: false,
    monitor: { intervalSec: 5, busyDelaySec: 30 },
    telegram: { enabled: false, chatId: '', tokenEnv: 'AGENT_KANBAN_TELEGRAM_TOKEN', apiBase: 'https://api.telegram.org' },
  }
}

/**
 * 보드 폴더를 설정한다. 폴더는 이미 있어야 한다(create=true 로 명시했을 때만 만든다 — 클라우드 폴더를 몰래 만들지 않음).
 * 다른 root 의 설정이 이미 있으면 바꾸지 않고 현재/새 root 를 알려 준다. confirmReplace=true 면 config.json.bak 으로 백업 후 교체.
 */
export function setupKanban(o: { root: string; confirmReplace?: boolean; create?: boolean }): SetupResult {
  const path = configPath()
  const rawRoot = typeof o.root === 'string' ? o.root.trim() : ''
  if (!rawRoot) return { ok: false, result: 'error', message: 'root(보드 폴더 경로)가 필요해요.', configPath: path }
  const root = resolve(expandHome(rawRoot))
  const base = { configPath: path, newRoot: root }
  if (!isDir(root)) {
    if (!o.create) return { ok: false, result: 'error', message: `폴더가 없어요: ${root}. 폴더를 먼저 만들거나(클라우드 폴더라면 동기화 앱에서) create=true 로 만들라고 명시하세요. 아무것도 바꾸지 않았어요.`, ...base }
    if (existsSync(root)) return { ok: false, result: 'error', message: `폴더가 아니에요: ${root}`, ...base }
    try { mkdirSync(root, { recursive: true }) } catch (e: any) {
      return { ok: false, result: 'error', message: `폴더를 만들지 못했어요: ${e?.code ?? e?.message ?? e}`, ...base }
    }
  }
  const cur = readRaw(path)
  const prepare = (board: string) => { new Store(root, board).init() }
  try {
    if (!cur) {
      mkdirSync(dirname(path), { recursive: true })
      writeReplace(path, defaultConfig(root))
      prepare('main')
      return { ok: true, result: 'created', message: `설정을 만들었어요: ${path} (root=${root}). hooks 는 다음 이벤트부터 바로 동작하고, 의견 전달 감시(monitor)는 새 세션부터 켜져요.`, ...base }
    }
    const curRoot = cur.raw && typeof cur.raw.root === 'string' ? resolve(expandHome(cur.raw.root)) : undefined
    if (!cur.broken && cur.raw.enabled === true && curRoot === root) {
      const board = typeof cur.raw.board === 'string' && /^[a-z0-9-]{1,32}$/.test(cur.raw.board) ? cur.raw.board : 'main'
      prepare(board)
      return { ok: true, result: 'unchanged', message: `이미 이 폴더로 설정돼 있어요: ${root}`, currentRoot: curRoot, ...base }
    }
    if (!o.confirmReplace) {
      const why = cur.broken ? '설정 파일이 깨져 있어요' : cur.raw.enabled !== true ? `설정은 있지만 꺼져 있어요(enabled 가 true 가 아님, root=${curRoot ?? '없음'})` : `이미 다른 폴더로 설정돼 있어요`
      return {
        ok: false, result: 'refused', ...base, ...(curRoot ? { currentRoot: curRoot } : {}),
        message: `${why}. 현재 root: ${curRoot ?? '(없음)'} / 새 root: ${root}. 아무것도 바꾸지 않았어요. 바꾸려면 사용자에게 확인한 뒤 confirmReplace=true 로 다시 호출하세요(기존 설정은 config.json.bak 으로 백업).`,
      }
    }
    const backup = `${path}.bak`
    copyFileSync(path, backup)
    const next = cur.broken ? defaultConfig(root) : { ...cur.raw, enabled: true, root }
    writeReplace(path, next)
    const board = typeof next.board === 'string' && /^[a-z0-9-]{1,32}$/.test(next.board) ? next.board : 'main'
    prepare(board)
    return { ok: true, result: 'replaced', message: `설정을 바꿨어요: ${path} (root ${curRoot ?? '없음'} → ${root}). 이전 설정은 ${backup} 에 백업했어요. 감시(monitor)는 새 세션부터 새 폴더를 봐요.`, currentRoot: curRoot, backup, ...base }
  } catch (e: any) {
    return { ok: false, result: 'error', message: `설정을 쓰지 못했어요: ${e?.code ?? e?.message ?? e}`, ...base }
  }
}

export function kanbanStatus(): StatusResult {
  const path = configPath()
  const cfg = loadConfig()
  const exists = existsSync(path)
  if (!cfg) {
    const cur = readRaw(path)
    const why = !exists ? '설정 파일 없음' : cur?.broken ? '설정 파일이 깨져 있음' : cur?.raw?.enabled !== true ? '설정의 enabled 가 true 가 아님' : 'root 가 없음'
    return {
      configured: false, configPath: path, configExists: exists,
      hooks: '꺼짐(아무것도 기록하지 않고 조용히 종료)', monitor: '꺼짐(아무것도 출력하지 않음)',
      message: `${NOT_SET_UP} (${why})`,
    }
  }
  const fromEnv = !!process.env.AGENT_KANBAN_ROOT
  const reachable = isDir(cfg.root)
  return {
    configured: true, configPath: path, configExists: true, root: cfg.root, rootSource: fromEnv ? 'env' : 'config',
    rootReachable: reachable, board: cfg.board,
    hooks: reachable ? '켜짐(이벤트마다 설정을 읽어 기록)' : '켜짐이지만 root 에 닿지 못해 기록이 실패할 수 있음',
    monitor: '세션 시작 때 설정을 읽어 켜짐(설정을 방금 바꿨다면 새 세션부터 반영)',
    message: reachable ? '설정됨' : `설정됐지만 root 폴더에 닿지 못해요: ${cfg.root} (클라우드 폴더가 아직 동기화 전이거나 지워졌을 수 있어요)`,
  }
}
