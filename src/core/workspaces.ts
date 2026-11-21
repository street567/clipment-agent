import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import {
  addConfigRoot, expandHome, readConfigRoots, readConfigWorkspaces, validWorkspaceName, ValidationError, workspaces, writeConfigWorkspaces, type Workspace,
} from './paths.ts'
import { readJson, writeJsonNew } from './fsutil.ts'
import { listWorkspaceProjects } from './store.ts'
import { CONTRACT_STAMP } from './contract.ts'

export interface WorkspaceStatus extends Workspace { reachable: boolean; projects: number }

/** workspace.json 이 없으면 만든다 (있으면 절대 고치지 않음, SPEC §7) */
export async function ensureWorkspaceJson(path: string, name?: string): Promise<boolean> {
  const file = join(path, 'workspace.json')
  if (await readJson(file)) return false
  await mkdir(path, { recursive: true })
  await writeJsonNew(file, { schema: 1, contract: CONTRACT_STAMP, name: name ?? (basename(path) || 'workspace'), created: new Date().toISOString() })
  return true
}

export async function workspaceStatuses(): Promise<WorkspaceStatus[]> {
  const out: WorkspaceStatus[] = []
  for (const w of workspaces()) {
    const reachable = existsSync(w.path)
    const ps = reachable ? await listWorkspaceProjects(w) : []
    out.push({ ...w, reachable, projects: ps.length })
  }
  return out
}

export async function addWorkspace(path: string, opts: { name?: string; allowAuthors?: string[] } = {}): Promise<Workspace> {
  const abs = resolve(path.startsWith('~/') ? join(process.env.HOME ?? '', path.slice(2)) : path)
  if (existsSync(join(abs, 'project.json')))
    throw new ValidationError('프로젝트 폴더가 아니라 워크스페이스 폴더를 지정하세요 (이 폴더에는 project.json 이 있습니다)')
  const name = opts.name ?? (basename(abs) || 'workspace')
  if (!validWorkspaceName(name)) throw new ValidationError(`잘못된 워크스페이스 이름: ${JSON.stringify(name)} ('/' 불가, '.' 로 시작 불가)`)
  const list = readConfigWorkspaces()
  if (list.some(w => w.name === name)) throw new ValidationError(`이미 있는 워크스페이스 이름: ${name}`)
  if (list.some(w => w.path === abs)) throw new ValidationError(`이미 등록된 경로: ${abs}`)
  await ensureWorkspaceJson(abs)
  const ws: Workspace = { name, path: abs }
  const allow = (opts.allowAuthors ?? []).map(s => s.trim()).filter(Boolean)
  if (allow.length) ws.allowAuthors = allow
  writeConfigWorkspaces([...list, ws])
  await reindexRootsFor(abs)
  return ws
}

/** 설정에서만 제거한다. 파일은 지우지 않는다. */
export function removeWorkspace(name: string): Workspace {
  const list = readConfigWorkspaces()
  const w = list.find(x => x.name === name)
  if (!w) throw new ValidationError(`등록되지 않은 워크스페이스: ${name} (${list.map(x => x.name).join(', ') || '없음'})`)
  writeConfigWorkspaces(list.filter(x => x !== w))
  return w
}

// ---------- 클라우드 드라이브 자동 감지 (Google Drive / Dropbox / OneDrive) ----------

export type CloudProvider = 'google' | 'dropbox' | 'onedrive'

export function cloudStorageDir(): string {
  const env = process.env.CLIPREV_CLOUDSTORAGE_DIR
  return resolve(env && env.trim() ? env : join(homedir(), 'Library/CloudStorage'))
}

export interface CloudCandidate { account: string; root: string }

/** ~/Library/CloudStorage 아래 해당 서비스의 (계정, 드라이브 루트) 후보들 */
export function detectCloud(provider: CloudProvider): CloudCandidate[] {
  const base = cloudStorageDir()
  let names: string[] = []
  try { names = readdirSync(base).sort() } catch { return [] }
  const out: CloudCandidate[] = []
  for (const n of names) {
    if (provider === 'google') {
      if (!n.startsWith('GoogleDrive-')) continue
      const root = ['My Drive', '내 드라이브'].map(d => join(base, n, d)).find(p => existsSync(p))
      if (root) out.push({ account: n.slice('GoogleDrive-'.length), root })
    } else if (provider === 'dropbox' ? n.startsWith('Dropbox') : n.startsWith('OneDrive')) {
      out.push({ account: n, root: join(base, n) })
    }
  }
  return out
}

export const PROVIDER_LABEL: Record<CloudProvider, string> = { google: '구글 드라이브', dropbox: 'Dropbox', onedrive: 'OneDrive' }

/** 감지한 드라이브 안의 워크스페이스 폴더 경로를 정한다. create 가 없으면 폴더를 만들지 않고 안내만(오류). */
export function resolveCloudWorkspace(provider: CloudProvider, o: { account?: string; sub?: string; create?: boolean }): string {
  const label = PROVIDER_LABEL[provider]
  let cands = detectCloud(provider)
  if (!cands.length) throw new ValidationError(`${label} 폴더를 찾지 못했습니다 (${cloudStorageDir()}). 데스크톱 앱을 설치·로그인했는지 확인하세요.`)
  if (o.account) cands = cands.filter(c => c.account.toLowerCase().includes(o.account!.toLowerCase()))
  if (!cands.length) throw new ValidationError(`--account '${o.account}' 와 맞는 ${label} 계정이 없습니다`)
  if (cands.length > 1)
    throw new ValidationError(`${label} 계정이 여러 개입니다. --account <이메일 일부> 로 고르세요:\n${cands.map(c => `  ${c.account}`).join('\n')}`)
  const sub = o.sub ?? 'ClipReview'
  if (!sub || sub.includes('..') || sub.startsWith('/')) throw new ValidationError(`잘못된 --sub: ${sub}`)
  const target = join(cands[0]!.root, sub)
  if (!existsSync(target)) {
    if (!o.create) throw new ValidationError(`폴더가 없습니다: ${target}\n만들려면 --create 를 붙이거나 직접 만드세요: mkdir -p ${JSON.stringify(target)}`)
    mkdirSync(target, { recursive: true })
  }
  return target
}

// ---------- 루트 인덱스 (SPEC §9) ----------

export interface IndexWorkspace { path: string; name: string; projects: number }
export interface RootIndex { schema: 1; contract?: string; updated: string; workspaces: IndexWorkspace[] }

export const DEFAULT_INDEX_DEPTH = 4
const SKIP_DIRS = new Set(['node_modules'])

/** 파일 존재(온라인 전용 자리표시자 `.name.icloud` 포함). 내용은 읽지 않는다. */
function hasFile(dir: string, name: string): boolean {
  return existsSync(join(dir, name)) || existsSync(join(dir, `.${name}.icloud`))
}

async function childDirs(dir: string): Promise<string[]> {
  try {
    const ents = await readdir(dir, { withFileTypes: true })
    return ents.filter(e => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)).map(e => e.name).sort()
  } catch { return [] }
}

export interface ScanOptions { depth?: number; fix?: boolean }

/** 루트 아래를 훑어 워크스페이스를 찾는다. fix 면 workspace.json 이 없는 워크스페이스에 만든다. */
export async function scanRoot(root: string, opts: ScanOptions = {}): Promise<{ workspaces: IndexWorkspace[]; created: string[] }> {
  const depth = opts.depth ?? DEFAULT_INDEX_DEPTH
  const base = resolve(root)
  const found: IndexWorkspace[] = []
  const created: string[] = []

  async function visit(dir: string, level: number): Promise<void> {
    if (level > 0 && hasFile(dir, 'project.json')) return // 프로젝트 폴더 안은 들어가지 않음
    const kids = await childDirs(dir)
    const projectKids = kids.filter(k => hasFile(join(dir, k), 'project.json'))
    const hasWsJson = hasFile(dir, 'workspace.json')
    if (hasWsJson || projectKids.length > 0) {
      const rel = level === 0 ? '.' : relative(base, dir).split(sep).join('/')
      let name = basename(dir) || 'workspace'
      if (hasWsJson) {
        const j = await readJson(join(dir, 'workspace.json'))
        if (j && typeof j.name === 'string' && j.name.trim()) name = j.name
      } else if (opts.fix && await ensureWorkspaceJson(dir)) created.push(rel)
      found.push({ path: rel, name, projects: projectKids.length })
    }
    if (level >= depth) return
    for (const k of kids) {
      if (projectKids.includes(k)) continue // 워크스페이스의 프로젝트 하위는 건너뜀
      await visit(join(dir, k), level + 1)
    }
  }
  await visit(base, 0)
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { workspaces: found, created }
}

export function indexPath(root: string): string { return join(resolve(root), '.clipment', 'index.json') }

/** tmp + rename 으로 원자적으로 덮어쓴다 (맥만 쓰는 파일이라 덮어써도 충돌 없음) */
export async function writeRootIndex(root: string, index: RootIndex): Promise<string> {
  const file = indexPath(root)
  await mkdir(dirname(file), { recursive: true })
  const tmp = join(dirname(file), '.index.json.tmp')
  await writeFile(tmp, JSON.stringify(index, null, 2) + '\n')
  try { await rename(tmp, file) } catch (e) { await rm(tmp, { force: true }); throw e }
  return file
}

export interface IndexResult { root: string; file: string; index: RootIndex; created: string[]; registered: boolean }

/** 스캔 → 인덱스 쓰기 → 루트 등록(idempotent) */
export async function indexRoot(root: string, opts: ScanOptions & { register?: boolean } = {}): Promise<IndexResult> {
  const abs = resolve(expandHome(root))
  if (!existsSync(abs)) throw new ValidationError(`루트 폴더가 없습니다: ${abs}`)
  const { workspaces: ws, created } = await scanRoot(abs, opts)
  const index: RootIndex = { schema: 1, contract: CONTRACT_STAMP, updated: new Date().toISOString(), workspaces: ws }
  const file = await writeRootIndex(abs, index)
  const registered = opts.register === false ? false : addConfigRoot(abs)
  return { root: abs, file, index, created, registered }
}

/** path 가 등록된 루트 아래면 그 루트의 인덱스를 조용히 갱신한다. 실패는 무시. */
export async function reindexRootsFor(path: string): Promise<string[]> {
  const abs = resolve(path)
  const done: string[] = []
  for (const r of readConfigRoots()) {
    if (abs !== r.path && !abs.startsWith(r.path + sep)) continue
    try { await indexRoot(r.path, { register: false }); done.push(r.path) } catch {}
  }
  return done
}

export interface RootStatus { path: string; reachable: boolean; indexUpdated: string | null; workspaces: number | null }

export async function rootStatuses(): Promise<RootStatus[]> {
  const out: RootStatus[] = []
  for (const r of readConfigRoots()) {
    const j = await readJson(indexPath(r.path))
    out.push({
      path: r.path, reachable: existsSync(r.path),
      indexUpdated: typeof j?.updated === 'string' ? j.updated : null,
      workspaces: Array.isArray(j?.workspaces) ? j.workspaces.length : null,
    })
  }
  return out
}
