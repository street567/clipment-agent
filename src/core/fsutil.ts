import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** iCloud 자리표시자 내려받기 요청. 테스트에서 교체 가능. */
export type Downloader = (path: string) => void
let downloader: Downloader = path => {
  try {
    const p = spawn('brctl', ['download', path], { stdio: 'ignore', detached: true })
    p.on('error', () => {})
    p.unref()
  } catch {}
}
export function setDownloader(d: Downloader | null) {
  downloader = d ?? (() => {})
}

/** `.name.icloud` -> `name` (아니면 null) */
export function placeholderTarget(entry: string): string | null {
  if (entry.startsWith('.') && entry.endsWith('.icloud') && entry.length > '..icloud'.length) {
    return entry.slice(1, -'.icloud'.length)
  }
  return null
}

/** 같은 폴더에 .name.tmp 로 쓰고 rename. 이미 있으면 덮어쓰지 않고 실패(불변 규칙). */
export async function atomicWriteNew(path: string, data: string | Uint8Array): Promise<void> {
  if (existsSync(path)) throw new Error(`이미 존재(불변 파일): ${path}`)
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.tmp`)
  await writeFile(tmp, data, { flag: 'w' })
  try {
    await rename(tmp, path)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}

export async function writeJsonNew(path: string, obj: unknown): Promise<void> {
  await atomicWriteNew(path, JSON.stringify(obj, null, 2) + '\n')
}

/**
 * 폴더의 *.json 파일 이름(확장자 제거)을 나열.
 * 점으로 시작하는 임시파일은 무시, iCloud 자리표시자는 내려받기 요청 후 건너뜀.
 */
export async function listJsonStems(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const stems: string[] = []
  for (const e of entries) {
    const target = placeholderTarget(e)
    if (target) {
      downloader(join(dir, target))
      continue
    }
    if (e.startsWith('.')) continue
    if (e.endsWith('.json')) stems.push(e.slice(0, -'.json'.length))
  }
  return stems
}

export async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const ents = await readdir(dir, { withFileTypes: true })
    const out: string[] = []
    for (const e of ents) {
      const t = placeholderTarget(e.name)
      if (t) { downloader(join(dir, t)); continue }
      if (e.name.startsWith('.')) continue
      if (e.isDirectory()) out.push(e.name)
    }
    return out
  } catch {
    return []
  }
}

/** JSON 읽기. 없거나 깨졌거나(동기화 중) 자리표시자면 null (자리표시자는 내려받기 요청). */
export async function readJson(path: string): Promise<any | null> {
  const ph = join(dirname(path), `.${basename(path)}.icloud`)
  if (existsSync(ph)) {
    downloader(path)
    return null
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 구글 드라이브 "스트리밍" 등 온라인 전용 파일은 읽을 때 내려받아진다. 끝까지 읽어 로컬에 실체화한다.
 * (미러링 모드·iCloud 에서는 사실상 일반 읽기)
 */
export async function materialize(path: string): Promise<void> {
  const { createReadStream } = await import('node:fs')
  await new Promise<void>((res, rej) => {
    const s = createReadStream(path)
    s.on('data', () => {}); s.on('end', () => res()); s.on('error', rej)
  })
}

/** 파일이 아직 내려받아지지 않았으면 true (요청도 보냄) */
export function isPlaceholder(path: string): boolean {
  const ph = join(dirname(path), `.${basename(path)}.icloud`)
  if (existsSync(ph)) {
    downloader(path)
    return true
  }
  return false
}
