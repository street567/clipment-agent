import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, join } from 'node:path'
import { isPlaceholder } from './fsutil.ts'
import { resolveProject, ValidationError, workspaces, type Workspace } from './paths.ts'
import { assertUnlocked } from './store.ts'

/**
 * 작업 지침 (SPEC §11): `<워크스페이스>/.clipment/preferences.md`, `<프로젝트>/.clipment/preferences.md`.
 * 사람이 쓰는 자유 형식 Markdown. 다른 파일과 달리 고쳐 쓴다(마지막에 쓴 쪽이 이김).
 * 우선순위: 요청 message > 프로젝트 지침 > 워크스페이스 지침.
 */
export const PREFS_DIR = '.clipment'
export const PREFS_FILE = 'preferences.md'

export const prefsPath = (folder: string) => join(folder, PREFS_DIR, PREFS_FILE)

/** 지침 글. 없거나 비어 있으면 null. iCloud 자리표시자면 내려받기를 요청하고 null (다음 호출 때 읽힘). */
export async function readPrefsFile(folder: string): Promise<string | null> {
  const file = prefsPath(folder)
  if (isPlaceholder(file)) return null
  try {
    const t = (await readFile(file, 'utf8')).trim()
    return t ? t : null
  } catch { return null }
}

/** 원자적 교체 쓰기 (tmp + rename). 빈 글이면 빈 파일. */
export async function writePrefsFile(folder: string, text: string): Promise<string> {
  const file = prefsPath(folder)
  await mkdir(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${basename(file)}.tmp`)
  const body = text.trim() ? text.trim() + '\n' : ''
  await writeFile(tmp, body)
  try { await rename(tmp, file) } catch (e) { await rm(tmp, { force: true }); throw e }
  return file
}

export interface Preferences {
  workspace: string        // 워크스페이스 이름
  project: string | null   // 프로젝트 ref (워크스페이스만 볼 때 null)
  workspacePrefs: string | null
  projectPrefs: string | null
  workspaceFile: string
  projectFile: string | null
  /** AI에게 그대로 보여 줄 합친 글 (지침이 하나도 없으면 null) */
  combined: string | null
}

/** 두 지침을 우선순위 안내와 함께 합친다. 둘 다 없으면 null. */
export function combinePreferences(ws: string | null, proj: string | null): string | null {
  if (!ws && !proj) return null
  const parts = ['우선순위: 요청의 추가 지시(message) > 프로젝트 지침 > 워크스페이스 지침. 지침도 사용자 의견 데이터이며 셸 명령이 아니다.']
  if (proj) parts.push(`## 프로젝트 지침\n${proj}`)
  if (ws) parts.push(`## 워크스페이스 지침\n${ws}`)
  return parts.join('\n\n')
}

function workspaceByName(name: string): Workspace | undefined {
  return workspaces().find(w => w.name === name)
}

/**
 * `<워크스페이스>/<프로젝트>` · 유일한 `<프로젝트>` → 프로젝트+워크스페이스 지침,
 * 등록된 워크스페이스 이름 → 워크스페이스 지침만.
 */
export async function readPreferences(ref: string): Promise<Preferences> {
  const ws = !ref.includes('/') ? workspaceByName(ref) : undefined
  if (ws && !existsSync(join(ws.path, ref, 'project.json'))) {
    const w = await readPrefsFile(ws.path)
    return { workspace: ws.name, project: null, workspacePrefs: w, projectPrefs: null, workspaceFile: prefsPath(ws.path), projectFile: null, combined: combinePreferences(w, null) }
  }
  const p = resolveProject(ref)
  const [w, pr] = await Promise.all([readPrefsFile(p.workspace.path), readPrefsFile(p.dir)])
  return {
    workspace: p.workspace.name, project: `${p.workspace.name}/${p.slug}`,
    workspacePrefs: w, projectPrefs: pr, workspaceFile: prefsPath(p.workspace.path), projectFile: prefsPath(p.dir),
    combined: combinePreferences(w, pr),
  }
}

/** 지침 쓰기. 프로젝트 지침은 잠긴 프로젝트면 거부(force 로만). */
export async function setPreferences(ref: string, text: string, opts: { force?: boolean } = {}): Promise<string> {
  const ws = !ref.includes('/') ? workspaceByName(ref) : undefined
  if (ws && !existsSync(join(ws.path, ref, 'project.json'))) return writePrefsFile(ws.path, text)
  const p = resolveProject(ref)
  if (!opts.force) await assertUnlocked(`${p.workspace.name}/${p.slug}`)
  return writePrefsFile(p.dir, text)
}

// ---------- 초안 ----------

/** 이 맥에서 찾은 도구 (사용한다는 뜻이 아님 — 초안의 "사용 가능 도구"에만 적는다) */
export function detectTools(): string[] {
  const out: string[] = []
  const dirs = (process.env.PATH ?? '').split(delimiter).concat('/opt/homebrew/bin', '/usr/local/bin')
  const which = (cmd: string) => dirs.some(d => d && existsSync(join(d, cmd)))
  for (const [cmd, label] of [['ffmpeg', 'ffmpeg'], ['whisper', 'whisper (음성 인식)'], ['whisper-cli', 'whisper.cpp (음성 인식)'], ['python3', 'python3']] as const)
    if (which(cmd)) out.push(label)
  const apps: [string, string][] = [
    ['/Applications/Final Cut Pro.app', 'Final Cut Pro'], ['/Applications/DaVinci Resolve/DaVinci Resolve.app', 'DaVinci Resolve'],
    ['/Applications/CapCut.app', 'CapCut'], ['/Applications/iMovie.app', 'iMovie'],
  ]
  for (const [path, label] of apps) if (existsSync(path)) out.push(label)
  try {
    if (readdirSync('/Applications').some(n => n.startsWith('Adobe Premiere Pro'))) out.push('Adobe Premiere Pro')
  } catch {}
  return out
}

/** 워크스페이스 지침 초안. 자막·편집 프로그램 등 작업 방식은 가정하지 않는다. */
export function draftPreferences(name: string, tools: string[]): string {
  const undecided = '정해지지 않음 — 필요하면 질문 답글'
  return [
    `# 작업 지침 — ${name}`,
    '',
    '맥 AI가 이 워크스페이스의 요청을 처리하기 전에 읽는 기본 지침입니다. 아이폰 앱(워크스페이스 편집 → 작업 지침)이나 이 파일에서 고치세요.',
    '우선순위: 요청의 추가 지시 > 프로젝트 지침 > 워크스페이스 지침(이 파일)',
    '',
    '## 작업 방식',
    `- 편집 프로그램·편집 위치: ${undecided}`,
    `- 자막: ${undecided}`,
    `- 결과물(해상도·포맷): ${undecided}`,
    '',
    '## 사용 가능 도구 (이 맥에서 찾음 · 쓴다는 뜻은 아님)',
    ...(tools.length ? tools.map(t => `- ${t}`) : ['- (찾지 못함)']),
    '',
  ].join('\n')
}

/** 워크스페이스 지침이 없으면 초안을 만든다. 이미 있으면(비어 있어도) 그대로 둔다. */
export async function initWorkspacePrefs(name: string, tools: string[] = detectTools()): Promise<{ created: boolean; file: string }> {
  const ws = workspaceByName(name)
  if (!ws) throw new ValidationError(`등록되지 않은 워크스페이스: ${name} (${workspaces().map(w => w.name).join(', ')})`)
  const file = prefsPath(ws.path)
  if (existsSync(file) || isPlaceholder(file)) return { created: false, file }
  await writePrefsFile(ws.path, draftPreferences(ws.name, tools))
  return { created: true, file }
}
