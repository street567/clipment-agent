// 칸반 설정/상태 (MCP 도구 kanban_setup·kanban_status 와 CLI `kanban setup|status` 가 같이 쓴다).
// 설정이 없는 세션에서도 동작해야 하므로 보드 세션·hook 상태에 의존하지 않는다.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { configPath, expandHome, loadAllConfig, normalizeWorkspaces, routeWorkspace, type Workspace } from './config.ts'
import { writeReplace } from './core/fs.ts'
import { Store } from './core/store.ts'

export interface WorkspaceInfo {
  name?: string
  root: string
  board: string
  includePaths: string[]
}

export interface SetupResult {
  ok: boolean
  /** created | added | updated | unchanged | replaced | needsScope | refused | error */
  result: 'created' | 'added' | 'updated' | 'unchanged' | 'replaced' | 'needsScope' | 'refused' | 'error'
  message: string
  configPath: string
  currentRoot?: string
  newRoot?: string
  backup?: string
  /** 이 호출 뒤(바뀐 게 없으면 지금)의 전체 워크스페이스 목록 */
  workspaces?: WorkspaceInfo[]
  /** needsScope: 기존 워크스페이스 목록(name, root, includePaths) */
  existingWorkspaces?: WorkspaceInfo[]
}

export interface RemoveResult {
  ok: boolean
  /** removed | notFound | refused | error */
  result: 'removed' | 'notFound' | 'refused' | 'error'
  message: string
  configPath: string
  root?: string
  backup?: string
  /** 뺀 워크스페이스가 기본(includePaths 없음)이었는지. true 면 범위 밖 폴더의 세션은 이제 추적되지 않는다 */
  defaultRemoved?: boolean
  workspaces?: WorkspaceInfo[]
}

export interface WorkspaceStatus extends WorkspaceInfo {
  reachable: boolean
  hasKanbanJson: boolean
  excludePaths: string[]
  /** includePaths 가 없는 기본 워크스페이스인지 */
  isDefault: boolean
}

export interface StatusResult {
  configured: boolean
  configPath: string
  configExists: boolean
  /** 아래 root/board/rootReachable 은 현재 세션(cwd)이 가는 워크스페이스, 없으면 워크스페이스가 하나일 때 그것 */
  root?: string
  rootSource?: 'config' | 'env'
  rootReachable?: boolean
  board?: string
  workspaces?: WorkspaceStatus[]
  current?: { cwd: string; tracked: boolean; reason: string; workspace?: WorkspaceInfo }
  warnings?: string[]
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

const info = (w: Workspace): WorkspaceInfo => ({ ...(w.name ? { name: w.name } : {}), root: w.root, board: w.board, includePaths: w.includePaths })
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
const uniq = (a: string[]) => [...new Set(a)]

/** 파일에 쓰는 모양(이름·경로 외 옵션은 있을 때만) */
function toRaw(w: Workspace) {
  return {
    ...(w.name ? { name: w.name } : {}),
    root: w.root,
    board: w.board,
    includePaths: w.includePaths,
    ...(w.excludePaths.length ? { excludePaths: w.excludePaths } : {}),
  }
}

function defaultConfig(workspaces: Workspace[]) {
  return {
    enabled: true,
    workspaces: workspaces.map(toRaw),
    excludePaths: [],
    includeHeadless: false,
    monitor: { intervalSec: 5, busyDelaySec: 30 },
    telegram: { enabled: false, chatId: '', tokenEnv: 'AGENT_KANBAN_TELEGRAM_TOKEN', apiBase: 'https://api.telegram.org' },
  }
}

/** 기존 설정에 워크스페이스 목록을 반영한 새 설정(옛 최상위 root/board/includePaths 는 workspaces 로 옮기고 없앤다. 전역 옵션은 그대로) */
function withWorkspaces(raw: any, workspaces: Workspace[]) {
  const { root: _r, board: _b, includePaths: _i, workspaces: _w, ...rest } = raw
  return { ...rest, enabled: true, workspaces: workspaces.map(toRaw) }
}

function scopeWarnings(ws: Workspace[]): string[] {
  const out: string[] = []
  const defaults = ws.filter((w) => !w.includePaths.length)
  if (defaults.length > 1) out.push(`기본 워크스페이스(includePaths 없음)가 ${defaults.length}개예요: ${defaults.map((w) => w.root).join(', ')}. 어디에도 범위가 없는 폴더의 세션은 추적되지 않아요. 하나에 includePaths 를 주세요.`)
  const seen = new Map<string, string>()
  for (const w of ws) for (const d of w.includePaths) {
    const prev = seen.get(d)
    if (prev && prev !== w.root) out.push(`includePaths 가 겹쳐요(같은 경로): ${d} (${prev} / ${w.root}). 이 폴더의 세션은 추적되지 않아요.`)
    seen.set(d, w.root)
  }
  const flat = ws.flatMap((w) => w.includePaths.map((d) => ({ d, root: w.root })))
  for (const x of flat) for (const y of flat) {
    if (x.root !== y.root && x.d !== y.d && y.d.startsWith(x.d + '/')) out.push(`includePaths 가 포개져요: ${y.d} 는 ${x.d} 안에 있어요. 더 긴 경로(${y.root})가 우선해요.`)
  }
  return out
}

/**
 * 보드 폴더(워크스페이스)를 설정한다. 폴더는 이미 있어야 한다(create=true 로 명시했을 때만 만든다 — 클라우드 폴더를 몰래 만들지 않음).
 * - 설정 없음 → created / 이미 등록된 root → 이름·includePaths 가 주어지고 다르면 updated, 아니면 unchanged
 * - 새 root + includePaths → added / 새 root + includePaths 없음 + 기본 워크스페이스가 이미 있음 → 아무것도 바꾸지 않고 needsScope
 * - confirmReplace=true: (옛 의미) 기존 기본 워크스페이스 root 를 이 root 로 교체(replaced). 추가(added)가 우선이다.
 * 설정을 바꾸기 전에 config.json.bak 으로 백업한다.
 */
export function setupKanban(o: { root: string; name?: string; includePaths?: string[]; confirmReplace?: boolean; create?: boolean }): SetupResult {
  const path = configPath()
  const rawRoot = typeof o.root === 'string' ? o.root.trim() : ''
  if (!rawRoot) return { ok: false, result: 'error', message: 'root(보드 폴더 경로)가 필요해요.', configPath: path }
  const root = resolve(expandHome(rawRoot))
  const base = { configPath: path, newRoot: root }
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : undefined
  const scope = Array.isArray(o.includePaths) ? uniq(o.includePaths.filter((x) => typeof x === 'string' && x.trim()).map((x) => resolve(expandHome(x.trim())))) : []
  const cur = readRaw(path)
  const list: Workspace[] = cur && !cur.broken ? normalizeWorkspaces(cur.raw) : []
  const existing = list.find((w) => w.root === root)
  const enabled = !!cur && !cur.broken && cur.raw.enabled === true
  const ensureDir = (): SetupResult | null => {
    if (isDir(root)) return null
    if (!o.create) return { ok: false, result: 'error', message: `폴더가 없어요: ${root}. 폴더를 먼저 만들거나(클라우드 폴더라면 동기화 앱에서) create=true 로 만들라고 명시하세요. 아무것도 바꾸지 않았어요.`, ...base }
    if (existsSync(root)) return { ok: false, result: 'error', message: `폴더가 아니에요: ${root}`, ...base }
    try { mkdirSync(root, { recursive: true }) } catch (e: any) {
      return { ok: false, result: 'error', message: `폴더를 만들지 못했어요: ${e?.code ?? e?.message ?? e}`, ...base }
    }
    return null
  }
  try {
    // 새 root + 범위 없음 + 이미 기본 워크스페이스가 있음 → 건드리지 않고 사용자에게 물어보게 한다
    const defaultWs = list.filter((w) => !w.includePaths.length)
    if (cur && !cur.broken && enabled && !existing && !scope.length && defaultWs.length && !o.confirmReplace) {
      return {
        ok: false, result: 'needsScope', ...base, workspaces: list.map(info), existingWorkspaces: list.map(info),
        message: `이미 기본 보드(includePaths 없음: ${defaultWs.map((w) => w.root).join(', ')})가 있어서 새 보드(${root})를 추가하지 않았어요. 설정은 그대로예요. 사용자에게 어느 프로젝트 폴더들을 새 보드로 보낼지 물어보세요(includePaths 로 다시 호출). 또는 기존 기본 보드에 범위를 줄지 물어보세요(기존 root 로 includePaths 와 함께 호출). 범위를 추측하거나 기존 범위를 옮기지 마세요.`,
      }
    }
    const dirErr = ensureDir()
    if (dirErr) return dirErr
    const prepare = (w: Workspace) => { new Store(w.root, w.board).init() }
    const commit = (next: Workspace[], raw: any): string => {
      mkdirSync(dirname(path), { recursive: true })
      let backup = ''
      if (existsSync(path)) { backup = `${path}.bak`; copyFileSync(path, backup) }
      writeReplace(path, raw ?? withWorkspaces(cur?.raw ?? {}, next))
      return backup
    }
    const finish = (r: SetupResult['result'], next: Workspace[], message: string, backup: string, w: Workspace, extra: Partial<SetupResult> = {}): SetupResult => {
      prepare(w)
      const warn = scopeWarnings(next)
      return { ok: true, result: r, message: message + (warn.length ? ` 경고: ${warn.join(' ')}` : ''), ...base, ...(backup ? { backup } : {}), workspaces: next.map(info), ...extra }
    }
    if (!cur) {
      const w: Workspace = { ...(name ? { name } : {}), root, board: 'main', includePaths: scope, excludePaths: [] }
      mkdirSync(dirname(path), { recursive: true })
      writeReplace(path, defaultConfig([w]))
      return finish('created', [w], `설정을 만들었어요: ${path} (root=${root}${scope.length ? `, includePaths=${scope.join(', ')}` : ', 기본 워크스페이스'}). hooks 는 다음 이벤트부터 바로 동작하고, 의견 전달 감시(monitor)는 새 세션부터 켜져요.`, '', w)
    }
    if (cur.broken || !enabled) {
      if (!o.confirmReplace) {
        const why = cur.broken ? '설정 파일이 깨져 있어요' : `설정은 있지만 꺼져 있어요(enabled 가 true 가 아님, 워크스페이스=${list.map((w) => w.root).join(', ') || '없음'})`
        return {
          ok: false, result: 'refused', ...base, ...(list[0] ? { currentRoot: list[0].root } : {}), workspaces: list.map(info),
          message: `${why}. 새 root: ${root}. 아무것도 바꾸지 않았어요. 고치려면 사용자에게 확인한 뒤 confirmReplace=true 로 다시 호출하세요(기존 설정은 config.json.bak 으로 백업).`,
        }
      }
      const w: Workspace = { ...(name ? { name } : {}), root, board: 'main', includePaths: scope, excludePaths: [] }
      const backup = commit([w], cur.broken ? defaultConfig([w]) : withWorkspaces(cur.raw, [w]))
      return finish('replaced', [w], `설정을 바꿨어요: ${path} (root=${root}). 이전 설정은 ${backup} 에 백업했어요. 감시(monitor)는 새 세션부터 새 폴더를 봐요.`, backup, w, { currentRoot: list[0]?.root })
    }
    if (existing) {
      const nextName = name ?? existing.name
      const nextScope = scope.length ? scope : existing.includePaths
      if (nextName === existing.name && sameList(nextScope, existing.includePaths)) {
        prepare(existing)
        return { ok: true, result: 'unchanged', message: `이미 이 폴더로 설정돼 있어요: ${root}`, currentRoot: existing.root, ...base, workspaces: list.map(info) }
      }
      const upd: Workspace = { ...existing, ...(nextName ? { name: nextName } : {}), includePaths: nextScope }
      const next = list.map((w) => (w.root === root ? upd : w))
      const backup = commit(next, null)
      return finish('updated', next, `워크스페이스를 고쳤어요: ${root} (이름=${nextName ?? '없음'}, includePaths=${nextScope.join(', ') || '없음(기본)'}). 이전 설정은 ${backup} 에 백업했어요.`, backup, upd)
    }
    if (!scope.length && defaultWs.length && o.confirmReplace) {
      // 옛 의미: 기본 워크스페이스의 root 를 이 root 로 교체 (추가가 우선이니 정말 바꾸려는 때만)
      const old = defaultWs[0]
      if (defaultWs.length > 1) {
        return { ok: false, result: 'refused', ...base, workspaces: list.map(info), message: `기본 워크스페이스가 ${defaultWs.length}개라 어느 것을 바꿀지 알 수 없어요. kanban_remove 로 정리하거나 includePaths 를 주세요. 아무것도 바꾸지 않았어요.` }
      }
      const rep: Workspace = { ...old, ...(name ? { name } : {}), root }
      const next = list.map((w) => (w === old ? rep : w))
      const backup = commit(next, null)
      return finish('replaced', next, `설정을 바꿨어요: ${path} (root ${old.root} → ${root}). 이전 설정은 ${backup} 에 백업했어요. 감시(monitor)는 새 세션부터 새 폴더를 봐요.`, backup, rep, { currentRoot: old.root })
    }
    const w: Workspace = { ...(name ? { name } : {}), root, board: 'main', includePaths: scope, excludePaths: [] }
    const next = [...list, w]
    const backup = commit(next, null)
    return finish('added', next, `워크스페이스를 추가했어요: ${root}${scope.length ? ` (includePaths=${scope.join(', ')})` : ' (기본)'}. 이전 설정은 ${backup} 에 백업했어요. 감시(monitor)는 새 세션부터 반영돼요.`, backup, w)
  } catch (e: any) {
    return { ok: false, result: 'error', message: `설정을 쓰지 못했어요: ${e?.code ?? e?.message ?? e}`, ...base }
  }
}

/** 워크스페이스를 설정에서만 뺀다(폴더·보드는 지우지 않는다). confirm=true 필수, 백업 후 */
export function removeWorkspace(o: { root: string; confirm?: boolean }): RemoveResult {
  const path = configPath()
  const rawRoot = typeof o.root === 'string' ? o.root.trim() : ''
  if (!rawRoot) return { ok: false, result: 'error', message: 'root 가 필요해요.', configPath: path }
  const root = resolve(expandHome(rawRoot))
  const cur = readRaw(path)
  if (!cur || cur.broken) return { ok: false, result: 'error', message: cur ? '설정 파일이 깨져 있어 아무것도 바꾸지 않았어요.' : NOT_SET_UP, configPath: path, root }
  const list = normalizeWorkspaces(cur.raw)
  const target = list.find((w) => w.root === root)
  if (!target) return { ok: false, result: 'notFound', message: `등록된 워크스페이스가 아니에요: ${root}. 아무것도 바꾸지 않았어요.`, configPath: path, root, workspaces: list.map(info) }
  if (o.confirm !== true) {
    return { ok: false, result: 'refused', message: `${root} 를 설정에서 뺄까요? 폴더와 보드는 지워지지 않고 설정에서만 빠져요(config.json.bak 으로 백업). 사용자에게 확인받은 뒤 confirm=true 로 다시 호출하세요. 아무것도 바꾸지 않았어요.`, configPath: path, root, workspaces: list.map(info) }
  }
  try {
    const backup = `${path}.bak`
    copyFileSync(path, backup)
    const next = list.filter((w) => w.root !== root)
    writeReplace(path, withWorkspaces(cur.raw, next))
    const defaultRemoved = !target.includePaths.length
    const dr = defaultRemoved && next.length ? ' 기본 워크스페이스를 뺐으므로 남은 보드의 includePaths 밖 폴더 세션은 이제 추적되지 않아요(사용자에게 알려 주세요).' : ''
    const left = (next.length ? '' : ' 남은 워크스페이스가 없어 칸반은 꺼진 것과 같아요(다시 kanban_setup 으로 설정).') + dr
    return { ok: true, result: 'removed', message: `설정에서 뺐어요: ${root} (폴더는 그대로). 이전 설정은 ${backup} 에 백업했어요.${left}`, configPath: path, root, backup, defaultRemoved, workspaces: next.map(info) }
  } catch (e: any) {
    return { ok: false, result: 'error', message: `설정을 쓰지 못했어요: ${e?.code ?? e?.message ?? e}`, configPath: path, root }
  }
}

export function kanbanStatus(o: { cwd?: string; sessionRoot?: string } = {}): StatusResult {
  const path = configPath()
  const all = loadAllConfig()
  const exists = existsSync(path)
  if (!all) {
    const cur = readRaw(path)
    const why = !exists ? '설정 파일 없음' : cur?.broken ? '설정 파일이 깨져 있음' : cur?.raw?.enabled !== true ? '설정의 enabled 가 true 가 아님' : '워크스페이스(root)가 없음'
    return {
      configured: false, configPath: path, configExists: exists,
      hooks: '꺼짐(아무것도 기록하지 않고 조용히 종료)', monitor: '꺼짐(아무것도 출력하지 않음)',
      message: `${NOT_SET_UP} (${why})`,
    }
  }
  const cwd = resolve(o.cwd ?? (process.env.CLAUDE_PROJECT_DIR || process.cwd()))
  const fromEnv = !!process.env.AGENT_KANBAN_ROOT
  const workspaces: WorkspaceStatus[] = all.workspaces.map((w) => ({
    ...info(w), reachable: isDir(w.root), hasKanbanJson: existsSync(join(w.root, 'kanban.json')), excludePaths: w.excludePaths, isDefault: !w.includePaths.length,
  }))
  const route = routeWorkspace(all, cwd)
  const sessWs = o.sessionRoot ? all.workspaces.find((w) => w.root === o.sessionRoot) : undefined
  const cur = sessWs ?? route.workspace
  const warnings = scopeWarnings(all.workspaces)
  for (const w of workspaces) if (!w.reachable) warnings.push(`root 폴더에 닿지 못해요: ${w.root} (클라우드 폴더가 아직 동기화 전이거나 지워졌을 수 있어요)`)
  for (const w of workspaces) if (w.reachable && !w.hasKanbanJson) warnings.push(`kanban.json 이 아직 없어요: ${w.root} (첫 이벤트 때 만들어지거나 kanban setup 을 다시 실행)`)
  const shown = cur ? workspaces.find((w) => w.root === cur.root) : workspaces.length === 1 ? workspaces[0] : undefined
  const anyUnreachable = workspaces.some((w) => !w.reachable)
  return {
    configured: true, configPath: path, configExists: true,
    ...(shown ? { root: shown.root, rootReachable: shown.reachable, board: shown.board } : {}),
    rootSource: fromEnv ? 'env' : 'config',
    workspaces,
    current: cur
      ? { cwd, tracked: true, reason: sessWs ? `이 세션이 붙은 워크스페이스(${sessWs.name ?? sessWs.root})` : route.reason, workspace: info(cur) }
      : { cwd, tracked: false, reason: route.reason },
    warnings,
    hooks: anyUnreachable ? '켜짐이지만 닿지 못하는 root 가 있어 그 보드의 기록은 실패할 수 있음' : '켜짐(이벤트마다 설정을 읽어 기록)',
    monitor: '세션 시작 때 설정을 읽어 켜짐(설정을 방금 바꿨다면 새 세션부터 반영)',
    message: cur ? (warnings.length ? `설정됨(경고 ${warnings.length}건: kanban_status 의 warnings 확인)` : '설정됨') : `설정됨. 하지만 현재 폴더는 추적되지 않아요: ${route.reason}`,
  }
}
