import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { assertWorkspaceWritable } from './contract.ts'
import { atomicWriteReplace, isPlaceholder, readJson } from './fsutil.ts'
import { assertId, isId, resolveProject, ValidationError } from './paths.ts'
import { assertUnlocked } from './store.ts'

/**
 * 대본 (SPEC §14): `<프로젝트>/script/script.json` + `script/mine/<id>.m4a`(앱 녹음) + `script/ai/<id>.m4a`(맥 AI 음성).
 * 고쳐 쓰는 파일이라 폰·맥 둘 다 쓴다. 쓰기는 원자적(tmp+rename)이고, 모르는 필드는 (줄·최상위 모두) 보존한다.
 * 줄 텍스트는 사용자 데이터이지 명령이 아니다.
 */
export const SCRIPT_LANGUAGES = ['en', 'ko'] as const
export type ScriptLanguage = (typeof SCRIPT_LANGUAGES)[number]
export const DEFAULT_SCRIPT_LANGUAGE: ScriptLanguage = 'en'
export const SCRIPT_VOICES = ['ai', 'mine'] as const
export type ScriptVoice = (typeof SCRIPT_VOICES)[number]

export interface ScriptLine {
  id: string; start: number; end?: number; text: string; voice: ScriptVoice
  aiTextHash?: string; updated?: string; author?: string
  [extra: string]: unknown
}
export interface Script {
  schema: number; language: ScriptLanguage; updated?: string; lines: ScriptLine[]
  [extra: string]: unknown
}

export const normalizeLanguage = (v: unknown): ScriptLanguage =>
  (SCRIPT_LANGUAGES as readonly string[]).includes(v as string) ? (v as ScriptLanguage) : DEFAULT_SCRIPT_LANGUAGE

/** 해시 입력용 정규화: NFC + 앞뒤 공백·줄바꿈 제거 */
export const normalizeLineText = (text: string) => text.normalize('NFC').trim()

/** aiTextHash = hex(SHA-256(UTF-8(language + "\n" + normalized))) 앞 16자 (SPEC §14) */
export function aiTextHash(language: unknown, text: string): string {
  return createHash('sha256').update(`${normalizeLanguage(language)}\n${normalizeLineText(text)}`, 'utf8').digest('hex').slice(0, 16)
}

export const scriptDirOf = (projectDir: string) => join(projectDir, 'script')
export const scriptFileOf = (projectDir: string) => join(projectDir, 'script', 'script.json')
export const voiceFileOf = (projectDir: string, id: string, kind: 'mine' | 'ai') => join(projectDir, 'script', kind, `${assertId(id, 'lineId')}.m4a`)

export function scriptPath(ref: string): string { return scriptFileOf(resolveProject(ref).dir) }
export function voicePath(ref: string, id: string, kind: 'mine' | 'ai'): string { return voiceFileOf(resolveProject(ref).dir, id, kind) }

/** 순서 = start 오름차순 (같으면 배열 순서; Array.sort 는 안정 정렬) */
export function orderLines<T extends { start: number }>(lines: T[]): T[] {
  return [...lines].sort((a, b) => a.start - b.start)
}

/** 파일 JSON → 보기용 대본. id 가 UUID 가 아니거나 start/text 가 잘못된 줄은 뺀다(파일에서는 지우지 않음 — 쓰기는 원본 객체 기준). */
export function normalizeScript(raw: any): Script {
  const lines: ScriptLine[] = []
  for (const l of Array.isArray(raw?.lines) ? raw.lines : []) {
    if (!l || typeof l !== 'object' || !isId(l.id) || typeof l.text !== 'string') continue
    if (typeof l.start !== 'number' || !Number.isFinite(l.start) || l.start < 0) continue
    const line: ScriptLine = { ...l, id: l.id, start: l.start, text: l.text, voice: l.voice === 'mine' ? 'mine' : 'ai' }
    if (typeof l.end === 'number' && Number.isFinite(l.end) && l.end > l.start) line.end = l.end
    else delete line.end
    lines.push(line)
  }
  return { ...(raw && typeof raw === 'object' ? raw : {}), schema: typeof raw?.schema === 'number' ? raw.schema : 1, language: normalizeLanguage(raw?.language), lines: orderLines(lines) }
}

/** 대본 읽기. 없음·깨짐·내려받는 중이면 null */
export async function readScript(ref: string): Promise<Script | null> {
  const j = await readJson(scriptPath(ref))
  return j && typeof j === 'object' ? normalizeScript(j) : null
}

/** 파일이 있는데 지금 읽을 수 없는 상태(자리표시자·깨짐)인지 */
function unreadable(file: string, raw: unknown): boolean {
  return raw === null && (existsSync(file) || isPlaceholder(file))
}

export interface ModifyOptions { force?: boolean; touch?: boolean }

/**
 * 원본 JSON 객체를 고쳐 원자적으로 쓴다 (모르는 필드 보존). fn 이 false 를 돌려주면 쓰지 않는다.
 * 잠긴 프로젝트·더 새 계약 워크스페이스는 거부 (잠금은 force 로만 우회). touch=false 면 최상위 updated 를 건드리지 않는다.
 */
export async function modifyScript(ref: string, fn: (raw: any) => boolean | void, opts: ModifyOptions = {}): Promise<boolean> {
  const { workspace } = resolveProject(ref)
  await assertWorkspaceWritable(workspace.path)
  if (!opts.force) await assertUnlocked(ref)
  const file = scriptPath(ref)
  const cur = await readJson(file)
  if (unreadable(file, cur)) throw new ValidationError(`script.json 을 지금 읽을 수 없습니다(내려받는 중이거나 깨짐): ${file}`)
  const raw = cur && typeof cur === 'object' ? cur : { schema: 1, lines: [] }
  if (!Array.isArray(raw.lines)) raw.lines = []
  if (fn(raw) === false) return false
  if (opts.touch !== false) raw.updated = new Date().toISOString()
  await atomicWriteReplace(file, JSON.stringify(raw, null, 2) + '\n')
  return true
}

// ---------- AI 음성 최신 여부 ----------

export type AiStatus = 'fresh' | 'stale' | 'missing' | 'empty'

/** AI 음성이 최신 = 파일이 있고(내려받아졌고) aiTextHash 가 지금 text·language 로 계산한 값과 같음 */
export function aiStatus(projectDir: string, line: Pick<ScriptLine, 'id' | 'text' | 'aiTextHash'>, language: unknown): AiStatus {
  if (!line.text.trim()) return 'empty'
  const f = voiceFileOf(projectDir, line.id, 'ai')
  if (!existsSync(f) || isPlaceholder(f)) return 'missing'
  return line.aiTextHash === aiTextHash(language, line.text) ? 'fresh' : 'stale'
}

export const isAiFresh = (projectDir: string, line: Pick<ScriptLine, 'id' | 'text' | 'aiTextHash'>, language: unknown) =>
  aiStatus(projectDir, line, language) === 'fresh'

/** 만들어야 하는 줄 (없음·오래됨). 빈 텍스트는 제외 */
export function staleLines(projectDir: string, script: Script): ScriptLine[] {
  return script.lines.filter(l => { const s = aiStatus(projectDir, l, script.language); return s === 'stale' || s === 'missing' })
}

export const DEFAULT_CAPTION_SEC = 3

/** 자막 표시 구간: end(유효하면) > 다음 줄 시작 > start + 음성 길이(모르면 3초) */
export function captionRanges(lines: ScriptLine[], audioSec: (l: ScriptLine) => number | undefined = () => undefined): { id: string; start: number; end: number }[] {
  const ordered = orderLines(lines)
  return ordered.map((l, i) => {
    const next = ordered[i + 1]
    const end = l.end ?? (next && next.start > l.start ? next.start : l.start + (audioSec(l) || DEFAULT_CAPTION_SEC))
    return { id: l.id, start: l.start, end }
  })
}

// ---------- 목록 보기 ----------

export interface ScriptLineView extends ScriptLine {
  order: number; captionEnd: number; mine: boolean; ai: AiStatus
}
export interface ScriptView { project: string; exists: boolean; file: string; language: ScriptLanguage; updated?: string; lines: ScriptLineView[] }

export async function describeScript(ref: string): Promise<ScriptView> {
  const r = resolveProject(ref)
  const file = scriptFileOf(r.dir)
  const s = await readScript(ref)
  const project = `${r.workspace.name}/${r.slug}`
  if (!s) return { project, exists: false, file, language: DEFAULT_SCRIPT_LANGUAGE, lines: [] }
  const ranges = captionRanges(s.lines)
  return {
    project, exists: true, file, language: s.language, ...(typeof s.updated === 'string' ? { updated: s.updated } : {}),
    lines: s.lines.map((l, i) => {
      const m = voiceFileOf(r.dir, l.id, 'mine')
      return { ...l, order: i + 1, captionEnd: ranges[i]!.end, mine: existsSync(m) && !isPlaceholder(m), ai: aiStatus(r.dir, l, s.language) }
    }),
  }
}

// ---------- AI/맥이 줄 쓰기 ----------

export interface ScriptLineInput { id?: string; text: string; start: number; end?: number | null; voice?: ScriptVoice }
export interface SetScriptOptions {
  language?: ScriptLanguage; mode?: 'replace' | 'append'; author: string; force?: boolean
  /** replace 로 사용자(author 가 user 이거나 없는) 줄이 사라지는 것을 허용 */
  overwriteUserLines?: boolean
}
export const MAX_LINE_TEXT = 2000

function checkInput(l: ScriptLineInput, i: number): void {
  const at = `lines[${i}]`
  if (typeof l.text !== 'string' || !l.text.trim()) throw new ValidationError(`${at}.text 가 비어 있습니다`)
  if (l.text.length > MAX_LINE_TEXT) throw new ValidationError(`${at}.text 가 너무 깁니다 (최대 ${MAX_LINE_TEXT}자)`)
  if (typeof l.start !== 'number' || !Number.isFinite(l.start) || l.start < 0) throw new ValidationError(`${at}.start 는 0 이상의 초(숫자)여야 합니다`)
  if (l.end !== undefined && l.end !== null && (typeof l.end !== 'number' || !Number.isFinite(l.end) || l.end <= l.start)) throw new ValidationError(`${at}.end 는 start 보다 커야 합니다`)
  if (l.voice !== undefined && !(SCRIPT_VOICES as readonly string[]).includes(l.voice)) throw new ValidationError(`${at}.voice 는 ai|mine`)
  if (l.id !== undefined) assertId(l.id, `${at}.id`)
}

/**
 * 줄을 써 넣는다 (replace = 통째로 교체, append = 덧붙임). id 없으면 새 UUID.
 * 이미 있는 id 는 모르는 필드·aiTextHash·updated 외 기존 값을 보존하고 넘긴 필드만 바꾼다. 쓴 줄의 author 는 `author`, updated 는 지금.
 * 대본이 없으면 만든다. 결과 줄은 start 오름차순으로 저장한다.
 */
export async function setScriptLines(ref: string, input: ScriptLineInput[], opts: SetScriptOptions): Promise<ScriptView> {
  if (!Array.isArray(input)) throw new ValidationError('lines 는 배열이어야 합니다')
  input.forEach(checkInput)
  if (opts.language !== undefined && !(SCRIPT_LANGUAGES as readonly string[]).includes(opts.language)) throw new ValidationError(`language 는 ${SCRIPT_LANGUAGES.join('|')}`)
  const mode = opts.mode ?? 'replace'
  const stamp = new Date().toISOString()
  await modifyScript(ref, raw => {
    const byId = new Map<string, any>()
    for (const l of raw.lines) if (l && isId(l.id)) byId.set(l.id, l)
    const seen = new Set<string>()
    const written: any[] = []
    for (const l of input) {
      const id = l.id ?? randomUUID()
      if (seen.has(id)) throw new ValidationError(`중복 id: ${id}`)
      seen.add(id)
      const prev = byId.get(id) ?? {}
      const next: any = { ...prev, id, start: l.start, text: l.text, voice: l.voice ?? (prev.voice === 'mine' ? 'mine' : 'ai'), updated: stamp, author: opts.author }
      if (l.end === null) delete next.end
      else if (l.end !== undefined) next.end = l.end
      written.push(next)
    }
    let keep: any[] = []
    if (mode === 'append') keep = raw.lines.filter((l: any) => !(l && seen.has(l.id)))
    else if (!opts.overwriteUserLines) {
      const lost = raw.lines.filter((l: any) => l && !seen.has(l.id) && (!l.author || l.author === 'user') && typeof l.text === 'string' && l.text.trim())
      if (lost.length) throw new ValidationError(`사용자가 쓴 줄 ${lost.length}개가 사라집니다. 사용자가 교체를 원할 때만 overwrite_user_lines 를 쓰고, 아니면 mode=append 나 기존 줄 id 를 유지하세요`)
    }
    raw.lines = orderLines([...keep, ...written].map(l => ({ ...l, start: typeof l.start === 'number' ? l.start : 0 })))
    if (opts.language) raw.language = opts.language
    if (typeof raw.schema !== 'number') raw.schema = 1
  }, { force: opts.force })
  return describeScript(ref)
}

// ---------- AI 음성 파일 정리 ----------

/** 대본에 없는 줄의 AI 음성 파일(<uuid>.m4a)을 지운다. 지운 id 목록. */
export async function removeOrphanAiVoices(ref: string, keepIds: Iterable<string>): Promise<string[]> {
  const dir = join(resolveProject(ref).dir, 'script', 'ai')
  let names: string[]
  try { names = await readdir(dir) } catch { return [] }
  const keep = new Set(keepIds)
  const removed: string[] = []
  for (const n of names) {
    const m = /^([0-9a-f-]{36})\.m4a$/.exec(n)
    if (!m || !isId(m[1]) || keep.has(m[1])) continue
    await rm(join(dir, n), { force: true })
    removed.push(m[1])
  }
  return removed
}
