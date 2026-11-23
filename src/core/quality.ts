import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isPlaceholder, readJson } from './fsutil.ts'
import { assertWorkspaceWritable } from './contract.ts'
import { resolveProject, ValidationError, workspaces, type Workspace } from './paths.ts'
import { assertAuthor, assertUnlocked } from './store.ts'
import { QUALITIES, DEFAULT_QUALITY, parseQuality, type Quality, type QualityDesignation } from './types.ts'

/**
 * 작업용 화질 (SPEC §13): 프로젝트 `.clipment/quality.json` (고쳐 쓰는 파일, 마지막에 쓴 쪽이 이김) +
 * 워크스페이스 `workspace.json` 의 `previewQuality`.
 * 게시 때 순서: 명시 인자 > 프로젝트 > 워크스페이스 > 720p.
 */
export const QUALITY_FILE = 'quality.json'
export const qualityPath = (projectDir: string) => join(projectDir, '.clipment', QUALITY_FILE)

/** 프로젝트 지정 읽기. 없음·깨짐·모르는 값·자리표시자면 null */
export async function readQualityDesignation(projectDir: string): Promise<QualityDesignation | null> {
  const file = qualityPath(projectDir)
  if (isPlaceholder(file)) return null
  try {
    const j = JSON.parse(await readFile(file, 'utf8'))
    const quality = parseQuality(j?.quality)
    if (!quality) return null
    return {
      schema: 1, quality, author: typeof j.author === 'string' ? j.author : 'user',
      ...(typeof j.authorName === 'string' ? { authorName: j.authorName } : {}),
      via: j.via === 'mac' ? 'mac' : 'app', updated: typeof j.updated === 'string' ? j.updated : '',
    }
  } catch { return null }
}

export async function readWorkspaceQuality(wsPath: string): Promise<Quality | null> {
  const j = await readJson(join(wsPath, 'workspace.json'))
  return parseQuality(j?.previewQuality)
}

export type QualitySource = 'explicit' | 'project' | 'workspace' | 'default'
export interface EffectiveQuality {
  quality: Quality; source: QualitySource
  project: QualityDesignation | null; workspace: Quality | null
}

/** 순수 결정 함수 (테스트용) */
export function pickQuality(explicit: Quality | null | undefined, project: Quality | null, workspace: Quality | null): { quality: Quality; source: QualitySource } {
  if (explicit) return { quality: explicit, source: 'explicit' }
  if (project) return { quality: project, source: 'project' }
  if (workspace) return { quality: workspace, source: 'workspace' }
  return { quality: DEFAULT_QUALITY, source: 'default' }
}

export async function getEffectiveQuality(ref: string, explicit?: Quality | null): Promise<EffectiveQuality> {
  const { dir, workspace } = resolveProject(ref)
  const [project, ws] = await Promise.all([readQualityDesignation(dir), readWorkspaceQuality(workspace.path)])
  return { ...pickQuality(explicit, project?.quality ?? null, ws), project, workspace: ws }
}

export function assertQuality(v: unknown): Quality {
  const q = parseQuality(v)
  if (!q) throw new ValidationError(`잘못된 화질: ${JSON.stringify(v)} (${QUALITIES.join('|')})`)
  return q
}

async function atomicWrite(file: string, text: string) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${basename(file)}.tmp`)
  await writeFile(tmp, text)
  try { await rename(tmp, file) } catch (e) { await rm(tmp, { force: true }); throw e }
}

export async function writeQualityDesignation(projectDir: string, d: QualityDesignation): Promise<string> {
  const file = qualityPath(projectDir)
  await atomicWrite(file, JSON.stringify(d, null, 2) + '\n')
  return file
}

export interface SetQualityOptions { author: string; authorName?: string; force?: boolean }

/** 프로젝트 화질 지정. 잠긴 프로젝트는 force 없이 거부. */
export async function setProjectQuality(ref: string, quality: Quality, o: SetQualityOptions): Promise<QualityDesignation> {
  const { dir, workspace } = resolveProject(ref)
  await assertWorkspaceWritable(workspace.path)
  if (!o.force) await assertUnlocked(ref)
  assertAuthor(o.author)
  assertQuality(quality)
  const d: QualityDesignation = {
    schema: 1, quality, author: o.author, via: 'mac', updated: new Date().toISOString(),
    ...(o.authorName?.trim() ? { authorName: o.authorName.trim().slice(0, 64) } : {}),
  }
  await writeQualityDesignation(dir, d)
  return d
}

/** 프로젝트 지정 해제 = 파일 삭제 (워크스페이스 기본을 따름). 지정이 없었으면 false. */
export async function clearProjectQuality(ref: string, o: { force?: boolean } = {}): Promise<boolean> {
  const { dir, workspace } = resolveProject(ref)
  await assertWorkspaceWritable(workspace.path)
  if (!o.force) await assertUnlocked(ref)
  const file = qualityPath(dir)
  if (!existsSync(file)) return false
  await rm(file, { force: true })
  return true
}

export function findWorkspace(name: string): Workspace {
  const list = workspaces()
  const w = list.find(x => x.name === name)
  if (!w) throw new ValidationError(`알 수 없는 워크스페이스: ${name} (등록됨: ${list.map(x => x.name).join(', ')})`)
  return w
}

/** workspace.json 의 previewQuality 쓰기(null = 필드 제거). 다른 필드는 보존한다. */
export async function setWorkspaceQuality(wsName: string, quality: Quality | null): Promise<Quality | null> {
  const w = findWorkspace(wsName)
  await assertWorkspaceWritable(w.path)
  const file = join(w.path, 'workspace.json')
  const cur = (await readJson(file)) ?? { schema: 1, name: w.name }
  const next = { ...cur }
  if (quality) next.previewQuality = assertQuality(quality)
  else delete next.previewQuality
  await atomicWrite(file, JSON.stringify(next, null, 2) + '\n')
  return quality
}

export interface WorkspaceQualityInfo { workspace: string; quality: Quality; source: 'workspace' | 'default'; set: Quality | null }

export async function getWorkspaceQualityInfo(wsName: string): Promise<WorkspaceQualityInfo> {
  const w = findWorkspace(wsName)
  const set = await readWorkspaceQuality(w.path)
  return { workspace: w.name, quality: set ?? DEFAULT_QUALITY, source: set ? 'workspace' : 'default', set }
}

export const QUALITY_SOURCE_LABEL: Record<QualitySource, string> = {
  explicit: '명시 인자', project: '프로젝트 지정', workspace: '워크스페이스 기본', default: '기본값',
}
