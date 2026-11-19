import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  readConfigWorkspaces, validWorkspaceName, ValidationError, workspaces, writeConfigWorkspaces, type Workspace,
} from './paths.ts'
import { readJson, writeJsonNew } from './fsutil.ts'
import { listWorkspaceProjects } from './store.ts'

export interface WorkspaceStatus extends Workspace { reachable: boolean; projects: number }

/** workspace.json 이 없으면 만든다 (있으면 절대 고치지 않음, SPEC §7) */
export async function ensureWorkspaceJson(path: string, name?: string): Promise<boolean> {
  const file = join(path, 'workspace.json')
  if (await readJson(file)) return false
  await mkdir(path, { recursive: true })
  await writeJsonNew(file, { schema: 1, name: name ?? (basename(path) || 'workspace'), created: new Date().toISOString() })
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
