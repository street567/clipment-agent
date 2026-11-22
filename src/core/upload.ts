import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isPlaceholder } from './fsutil.ts'
import { assertWorkspaceWritable } from './contract.ts'
import { resolveProject, ValidationError, versionDir } from './paths.ts'
import { assertAuthor, assertUnlocked, listVersions } from './store.ts'
import type { UploadDesignation, VersionMeta } from './types.ts'

/**
 * 업로드용 영상 (SPEC §12): `<프로젝트>/.clipment/upload.json` 업로드용 버전 지정.
 * 작업 지침(§11)처럼 고쳐 쓰는 파일 — 폰·맥 모두 쓰고 마지막에 쓴 쪽이 이긴다. 쓰기는 원자적(tmp+rename).
 */
export const UPLOAD_FILE = 'upload.json'
export const uploadPath = (projectDir: string) => join(projectDir, '.clipment', UPLOAD_FILE)

/** 지정 읽기. 없음·깨짐·자리표시자(내려받는 중)면 null (기본 규칙 적용) */
export async function readUploadDesignation(projectDir: string): Promise<UploadDesignation | null> {
  const file = uploadPath(projectDir)
  if (isPlaceholder(file)) return null
  try {
    const j = JSON.parse(await readFile(file, 'utf8'))
    if (!Number.isInteger(j?.version) || j.version < 1) return null
    return {
      schema: 1, version: j.version, author: typeof j.author === 'string' ? j.author : 'user',
      ...(typeof j.authorName === 'string' ? { authorName: j.authorName } : {}),
      via: j.via === 'mac' ? 'mac' : 'app', updated: typeof j.updated === 'string' ? j.updated : '',
    }
  } catch { return null }
}

export interface UploadChoice { version: number; designated: boolean; hasOriginal: boolean; meta: VersionMeta }

/** 현재 업로드용 버전: ① 지정(실제 있는 버전) ② 원본 있는 최신 ③ 최신. 버전이 없으면 null. */
export function resolveUploadVersion(versions: VersionMeta[], d: UploadDesignation | null): UploadChoice | null {
  const mk = (m: VersionMeta, designated: boolean): UploadChoice => ({ version: m.version, designated, hasOriginal: !!m.original, meta: m })
  const byNum = (a: VersionMeta, b: VersionMeta) => b.version - a.version
  const sorted = [...versions].sort(byNum)
  const picked = d && sorted.find(v => v.version === d.version)
  if (picked) return mk(picked, true)
  const o = sorted.find(v => v.original)
  if (o) return mk(o, false)
  return sorted[0] ? mk(sorted[0], false) : null
}

export interface UploadInfo extends UploadChoice {
  designation: UploadDesignation | null
  /** 현재 업로드용보다 더 최신인 버전 번호 (없으면 null) */
  newer: number | null
}

export async function getUploadInfo(ref: string): Promise<UploadInfo | null> {
  const { dir } = resolveProject(ref)
  const [versions, designation] = await Promise.all([listVersions(ref), readUploadDesignation(dir)])
  const c = resolveUploadVersion(versions, designation)
  if (!c) return null
  const latest = Math.max(...versions.map(v => v.version))
  return { ...c, designation, newer: latest > c.version ? latest : null }
}

export async function writeUploadDesignation(projectDir: string, d: UploadDesignation): Promise<string> {
  const file = uploadPath(projectDir)
  await mkdir(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${basename(file)}.tmp`)
  await writeFile(tmp, JSON.stringify(d, null, 2) + '\n')
  try { await rename(tmp, file) } catch (e) { await rm(tmp, { force: true }); throw e }
  return file
}

export interface SetUploadOptions { author: string; authorName?: string; force?: boolean }

/** 업로드용 버전 지정. 잠긴 프로젝트는 force 없이 거부, 없는 버전도 거부. */
export async function setUploadVersion(ref: string, version: number, o: SetUploadOptions): Promise<UploadDesignation> {
  const { dir, workspace } = resolveProject(ref)
  await assertWorkspaceWritable(workspace.path)
  if (!o.force) await assertUnlocked(ref)
  assertAuthor(o.author)
  if (!Number.isInteger(version) || version < 1) throw new ValidationError(`잘못된 버전: ${version}`)
  if (!existsSync(join(versionDir(ref, version), 'meta.json'))) throw new ValidationError(`버전 ${version} 을(를) 찾을 수 없습니다`)
  const d: UploadDesignation = {
    schema: 1, version, author: o.author, via: 'mac', updated: new Date().toISOString(),
    ...(o.authorName?.trim() ? { authorName: o.authorName.trim().slice(0, 64) } : {}),
  }
  await writeUploadDesignation(dir, d)
  return d
}

/** 지정 해제 = 파일 삭제 (기본 규칙으로 돌아감). 지정이 없었으면 false. */
export async function clearUploadVersion(ref: string, o: { force?: boolean } = {}): Promise<boolean> {
  const { dir, workspace } = resolveProject(ref)
  await assertWorkspaceWritable(workspace.path)
  if (!o.force) await assertUnlocked(ref)
  const file = uploadPath(dir)
  if (!existsSync(file)) return false
  await rm(file, { force: true })
  return true
}
