// 불변 쓰기·배타적 만들기·now.json 교체 (SPEC §1). 내장 모듈만.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ID_RE } from './ids.ts'

export const ensureDir = (p: string) => mkdirSync(p, { recursive: true })

function tmpName(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
}

/** 같은 폴더 .tmp 에 쓰고 rename. 이미 있으면 덮어쓰지 않고 false. (hard link 로 배타적 게시 — 안 되는 파일시스템이면 존재 확인 후 rename) */
export function writeNew(path: string, obj: unknown): boolean {
  ensureDir(dirname(path))
  const tmp = tmpName(path)
  writeFileSync(tmp, JSON.stringify(obj, null, 1))
  try {
    try {
      linkSync(tmp, path)
      return true
    } catch (e: any) {
      if (e?.code === 'EEXIST') return false
      if (existsSync(path)) return false
      renameSync(tmp, path)
      return true
    }
  } finally {
    try {
      unlinkSync(tmp)
    } catch {}
  }
}

/** 고쳐 쓰는 파일(now.json, 로컬 상태) 교체 */
export function writeReplace(path: string, obj: unknown) {
  ensureDir(dirname(path))
  const tmp = tmpName(path)
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 1))
    renameSync(tmp, path)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {}
    throw e
  }
}

const downloadAsked = new Map<string, number>()
/** 자리표시자·dataless 는 내려받기를 요청하고 이번엔 건너뛴다 */
export function requestDownload(path: string) {
  if (process.platform !== 'darwin' || process.env.AGENT_KANBAN_NO_DOWNLOAD === '1') return
  const last = downloadAsked.get(path) ?? 0
  if (Date.now() - last < 60_000) return
  downloadAsked.set(path, Date.now())
  try {
    spawn('brctl', ['download', path], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  } catch {}
}

/** 깨졌거나 없거나 dataless 면 null */
export function readJson<T = any>(path: string): T | null {
  try {
    const st = statSync(path)
    if (st.size > 0 && st.blocks === 0) {
      requestDownload(path) // dataless
      return null
    }
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** 디렉터리의 <id>.json 이름들(확장자 제외). 점으로 시작하는 파일(.tmp, .x.icloud 자리표시자)은 건너뛰고 내려받기 요청 */
export function listIds(dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const n of names) {
    if (n.startsWith('.')) {
      const m = /^\.(.+\.json)\.icloud$/.exec(n)
      if (m) requestDownload(join(dir, m[1]))
      continue
    }
    if (!n.endsWith('.json')) continue
    const id = n.slice(0, -5)
    if (ID_RE.test(id)) out.push(id)
  }
  return out
}

export function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
  } catch {
    return []
  }
}

export function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

export const iso = (ms = Date.now()) => new Date(ms).toISOString()
