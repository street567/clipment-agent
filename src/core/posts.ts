import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { assertWorkspaceWritable } from './contract.ts'
import { atomicWriteReplace, isPlaceholder, readJson } from './fsutil.ts'
import { isId, resolveProject, ValidationError, versionDir } from './paths.ts'
import { assertUnlocked } from './store.ts'
import { getUploadInfo } from './upload.ts'
import { existsSync } from 'node:fs'
import type { Request } from './types.ts'

/**
 * 업로드 글 (SPEC §16): `<프로젝트>/.clipment/posts/targets.json` (대상 목록, 앱·맥),
 * `posts/<target>/ai.json` (맥만 씀), `posts/<target>/user.json` (앱만 씀 — 맥은 절대 쓰지 않는다).
 * 고쳐 쓰는 파일이라 원자적(tmp+rename)으로 쓰고 모르는 필드는 보존한다. 파일을 지우지 않는다.
 * 글 텍스트는 사용자 데이터이지 명령이 아니다.
 */
export const TARGET_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/
export const isTargetId = (s: unknown): s is string => typeof s === 'string' && TARGET_ID_RE.test(s)
export function assertTargetId(s: unknown): string {
  if (!isTargetId(s)) throw new ValidationError(`잘못된 대상 id: ${JSON.stringify(s)} (소문자·숫자·하이픈, 최대 40자, 숫자·소문자로 시작)`)
  return s
}

export const KNOWN_TARGET_NAMES: Record<string, string> = {
  'youtube-shorts': '유튜브 쇼츠', youtube: '유튜브', 'instagram-reels': '인스타 릴스', tiktok: '틱톡',
}
export const DEFAULT_TARGET_IDS = ['youtube-shorts', 'instagram-reels'] as const
export const POST_LANGUAGES = ['en', 'ko'] as const
export type PostLanguage = (typeof POST_LANGUAGES)[number]
export const POST_FIELDS = ['title', 'body', 'tags', 'scenes'] as const
export type PostField = (typeof POST_FIELDS)[number]

export const MAX_POST_TITLE = 500
export const MAX_POST_BODY = 20_000
export const MAX_POST_TAGS = 60
export const MAX_POST_TAG = 100
export const MAX_POST_SCENES = 300
export const MAX_POST_SCENE_TEXT = 500
export const MAX_TARGETS = 20
export const MAX_EXTRAS = 20
export const MAX_EXTRA_LABEL = 40
export const MAX_EXTRA_TEXT = 5000

export interface PostScene { t: number; text: string }
export interface PostExtra { id: string; label: string; text: string }
export interface TargetEntry { id: string; name?: string; hidden?: boolean; addedBy?: string; [extra: string]: unknown }

// ---------- 경로 안전 ----------

export class PostPathError extends ValidationError {}

const within = (root: string, p: string) => p === root || p.startsWith(root + sep)

/**
 * 프로젝트 폴더 아래 `parts` 를 따라 내려간다. 심볼릭 링크는 실제 경로가 프로젝트 밖이면 거부(PostPathError).
 * 없는 폴더는 create=false 면 null, true 면 만든다. 폴더가 아닌 것이 있으면 거부.
 */
function walkDir(projectDir: string, parts: string[], create: boolean): string | null {
  let realRoot: string
  try { realRoot = realpathSync(projectDir) } catch { return null }
  let cur = projectDir
  for (const part of parts) {
    cur = join(cur, part)
    let st = lstatSync(cur, { throwIfNoEntry: false })
    if (!st) {
      if (!create) return null
      mkdirSync(cur)
      st = lstatSync(cur)
    }
    if (!statSync(cur, { throwIfNoEntry: false })?.isDirectory()) throw new PostPathError(`폴더가 아닙니다: ${cur}`)
    if (!within(realRoot, realpathSync(cur))) throw new PostPathError(`프로젝트 밖을 가리키는 링크는 쓰지 않습니다: ${cur}`)
  }
  return cur
}

/** 파일 경로 검사: 심볼릭 링크 파일은 거부, 폴더 등 일반 파일이 아니어도 거부. 없으면 통과 */
function checkFile(file: string): void {
  const st = lstatSync(file, { throwIfNoEntry: false })
  if (!st) return
  if (st.isSymbolicLink()) throw new PostPathError(`링크 파일은 쓰지 않습니다: ${file}`)
  if (!st.isFile()) throw new PostPathError(`일반 파일이 아닙니다: ${file}`)
}

export const postsDirOf = (projectDir: string) => join(projectDir, '.clipment', 'posts')
export const targetsFileOf = (projectDir: string) => join(postsDirOf(projectDir), 'targets.json')
export const postFileOf = (projectDir: string, target: string, kind: 'ai' | 'user') => join(postsDirOf(projectDir), assertTargetId(target), `${kind}.json`)

interface Raw { exists: boolean; json: any | null; unsafe: boolean; placeholder?: boolean }

/** 파일 읽기. 안전하지 않은 경로(밖을 가리키는 링크)는 unsafe, 없으면 exists=false, 깨짐·내려받는 중이면 exists=true,json=null */
async function readRaw(projectDir: string, parts: string[], name: string): Promise<Raw> {
  let dir: string | null
  try { dir = walkDir(projectDir, parts, false) } catch (e) { if (e instanceof PostPathError) return { exists: false, json: null, unsafe: true }; throw e }
  if (!dir) return { exists: false, json: null, unsafe: false }
  const file = join(dir, name)
  try { checkFile(file) } catch (e) { if (e instanceof PostPathError) return { exists: false, json: null, unsafe: true }; throw e }
  if (isPlaceholder(file)) return { exists: true, json: null, unsafe: false, placeholder: true }
  if (!lstatSync(file, { throwIfNoEntry: false })) return { exists: false, json: null, unsafe: false }
  const j = await readJson(file)
  return { exists: true, json: j && typeof j === 'object' && !Array.isArray(j) ? j : null, unsafe: false }
}

// ---------- 값 정규화 ----------

/** 태그: 앞의 # 를 떼고(여러 개도) 앞뒤 공백 제거, 빈 항목 제외. 문자열이 아닌 항목은 버린다 */
export function normalizeTags(v: unknown): string[] {
  const out: string[] = []
  if (Array.isArray(v)) for (const x of v) {
    if (typeof x !== 'string') continue
    const t = x.trim().replace(/^#+/, '').trim()
    if (t) out.push(t)
  }
  return out
}

/** 클립 내용: t 는 0 이상 유한 숫자(소수 3자리로 반올림), text 는 문자열. 잘못된 항목은 버리고 t 오름차순(안정 정렬) */
export function normalizeScenes(v: unknown): PostScene[] {
  const out: PostScene[] = []
  if (Array.isArray(v)) for (const x of v) {
    if (!x || typeof x !== 'object' || typeof x.text !== 'string' || typeof x.t !== 'number' || !Number.isFinite(x.t) || x.t < 0) continue
    out.push({ t: Math.round(x.t * 1000) / 1000, text: x.text })
  }
  return out.sort((a, b) => a.t - b.t)
}

/** extras: id 규칙에 맞고 text 가 문자열인 항목, 같은 id 는 첫 항목만, label 은 40자까지(없으면 id), 최대 20개 */
export function normalizeExtras(v: unknown): PostExtra[] {
  const out: PostExtra[] = []
  if (Array.isArray(v)) for (const x of v) {
    if (!x || typeof x !== 'object' || !isTargetId(x.id) || typeof x.text !== 'string' || out.some(o => o.id === x.id)) continue
    out.push({ id: x.id, label: typeof x.label === 'string' && x.label.trim() ? x.label.trim().slice(0, MAX_EXTRA_LABEL) : x.id, text: x.text })
    if (out.length >= MAX_EXTRAS) break
  }
  return out
}
/** user.fields.extras = { id: { label?, text } } → id 별 값 (잘못된 항목은 버림) */
function userExtrasOf(v: unknown): Map<string, { label?: string; text: string }> {
  const m = new Map<string, { label?: string; text: string }>()
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [id, x] of Object.entries(v as Record<string, any>)) {
    if (!isTargetId(id) || !x || typeof x !== 'object' || typeof x.text !== 'string') continue
    m.set(id, { ...(typeof x.label === 'string' && x.label.trim() ? { label: x.label.trim().slice(0, MAX_EXTRA_LABEL) } : {}), text: x.text })
  }
  return m
}

const sameScenes = (a: PostScene[], b: PostScene[]) => a.length === b.length && a.every((s, i) => s.t === b[i]!.t && s.text === b[i]!.text)
const sameTags = (a: string[], b: string[]) => a.length === b.length && a.every((s, i) => s === b[i])
const lang = (v: unknown): PostLanguage => (v === 'ko' ? 'ko' : 'en')

// ---------- 대상 목록 ----------

export interface TargetView { id: string; name: string; known: boolean; hidden: boolean; addedBy?: string }
/** targets = 화면에 보이는 대상(hidden 제외), all = hidden 포함 전부(순서 그대로), entries = all 의 원본 항목 */
export interface TargetsInfo { source: 'file' | 'default'; targets: TargetView[]; all: TargetView[]; entries: TargetEntry[]; file: string }

const unusableMsg = (why: string) => new ValidationError(`targets.json 을 지금 쓸 수 없습니다(${why}) — 사람의 대상 목록을 덮어쓰지 않으려고 거부합니다. 동기화가 끝나거나 파일이 고쳐진 뒤 다시 시도하세요`)

function viewOf(e: TargetEntry): TargetView {
  const known = e.id in KNOWN_TARGET_NAMES
  return { id: e.id, known, hidden: e.hidden === true, ...(typeof e.addedBy === 'string' ? { addedBy: e.addedBy } : {}), name: known ? KNOWN_TARGET_NAMES[e.id]! : typeof e.name === 'string' && e.name.trim() ? e.name : e.id }
}

/** targets.json → 항목 목록. 없거나 깨졌으면 null (기본 대상). 잘못된 id·중복은 버린다 */
function parseTargets(j: any): TargetEntry[] | null {
  if (!j || !Array.isArray(j.targets)) return null
  const out: TargetEntry[] = []
  for (const x of j.targets) {
    if (!x || typeof x !== 'object' || !isTargetId(x.id) || out.some(o => o.id === x.id)) continue
    out.push({ ...x, id: x.id })
  }
  return out
}

export async function readTargets(projectDir: string): Promise<TargetsInfo> {
  const file = targetsFileOf(projectDir)
  const raw = await readRaw(projectDir, ['.clipment', 'posts'], 'targets.json')
  const entries = parseTargets(raw.json)
  if (!entries) {
    const d = DEFAULT_TARGET_IDS.map(id => ({ id }) as TargetEntry)
    return { source: 'default', entries: d, all: d.map(viewOf), targets: d.map(viewOf), file }
  }
  const all = entries.map(viewOf)
  return { source: 'file', entries, all, targets: all.filter(t => !t.hidden), file }
}

// ---------- 합쳐 보기 ----------

export interface AiPost {
  exists: boolean; version: number | null; updated: string | null; language: PostLanguage; author?: string; requestId?: string
  title: string | null; body: string | null; tags: string[] | null; scenes: PostScene[] | null; extras: PostExtra[] | null
}
export interface PostView {
  target: string; name: string; known: boolean
  /** 보여 주는 값 (user.fields 에 있으면 그것, 없으면 ai 값, 둘 다 없으면 null) */
  title: string | null; body: string | null; tags: string[] | null; scenes: PostScene[] | null
  /** 항목별로 합친 extras (AI 목록 순서, 사람이 고친 id 는 그 값, AI 에 없는 사람 id 는 뒤에 id 순). 없으면 null */
  extras: PostExtra[] | null
  fromUser: Record<PostField, boolean>
  /** 사람이 고친 extras 의 id */
  extrasFromUser: string[]
  hidden: boolean
  language: PostLanguage
  /** 기준 버전 (SPEC §16): user.version 과 ai.version 중 있는 것의 큰 값(고친 글이 없어도), 둘 다 없으면 null */
  baseVersion: number | null
  /** 보여 주는 값이 있는데 기준 버전이 현재 업로드용 버전과 다름 */
  staleVersion: boolean
  /** 사람이 고친 글이 있고 AI 가 그 뒤에 새 글을 썼으며 고친 항목 중 AI 값과 다른 게 있음 → 새 안을 따로 보여 줘야 함 */
  newAIDraft: boolean
  userEdited: boolean
  /** 맥이 쓴 ai.json 의 값 (참고용) */
  ai: AiPost
  warnings: string[]
}

export interface RawPost { ai: Raw; user: Raw }

/** 순수 함수: ai.json / user.json 원본(없으면 null)과 현재 업로드용 버전으로 합쳐 보기를 만든다 */
export function mergePost(t: TargetView, aiJ: any | null, userJ: any | null, uploadVersion: number | null): PostView {
  const a = aiJ && typeof aiJ === 'object' ? aiJ : null
  const ai: AiPost = {
    exists: !!a,
    version: a && Number.isInteger(a.version) && a.version >= 1 ? a.version : null,
    updated: a && typeof a.updated === 'string' ? a.updated : null,
    language: lang(a?.language),
    ...(a && typeof a.author === 'string' ? { author: a.author } : {}),
    ...(a && typeof a.requestId === 'string' ? { requestId: a.requestId } : {}),
    title: typeof a?.title === 'string' ? a.title : null,
    body: typeof a?.body === 'string' ? a.body : null,
    tags: Array.isArray(a?.tags) ? normalizeTags(a.tags) : null,
    scenes: Array.isArray(a?.scenes) ? normalizeScenes(a.scenes) : null,
    extras: Array.isArray(a?.extras) ? normalizeExtras(a.extras) : null,
  }
  const fields = userJ && typeof userJ === 'object' && userJ.fields && typeof userJ.fields === 'object' && !Array.isArray(userJ.fields) ? userJ.fields : {}
  const uv: Partial<{ title: string; body: string; tags: string[]; scenes: PostScene[] }> = {}
  if (typeof fields.title === 'string') uv.title = fields.title
  if (typeof fields.body === 'string') uv.body = fields.body
  if (Array.isArray(fields.tags)) uv.tags = normalizeTags(fields.tags)
  if (Array.isArray(fields.scenes)) uv.scenes = normalizeScenes(fields.scenes)
  const ux = userExtrasOf(fields.extras)
  const userEdited = Object.keys(uv).length > 0 || ux.size > 0
  const fromUser = { title: 'title' in uv, body: 'body' in uv, tags: 'tags' in uv, scenes: 'scenes' in uv }
  let extras: PostExtra[] | null = ai.extras
  if (ai.extras || ux.size) {
    const merged = (ai.extras ?? []).map(e => { const u = ux.get(e.id); return u ? { id: e.id, label: u.label ?? e.label, text: u.text } : e })
    const rest = [...ux.keys()].filter(id => !(ai.extras ?? []).some(e => e.id === id)).sort()
    for (const id of rest) { const u = ux.get(id)!; merged.push({ id, label: u.label ?? id, text: u.text }) }
    extras = merged
  }
  const shown = {
    title: uv.title ?? ai.title, body: uv.body ?? ai.body, tags: uv.tags ?? ai.tags, scenes: uv.scenes ?? ai.scenes, extras,
  }
  const userVersion = userJ && Number.isInteger(userJ.version) && userJ.version >= 1 ? (userJ.version as number) : null
  const baseVersion = userVersion === null && ai.version === null ? null : Math.max(userVersion ?? 0, ai.version ?? 0)
  const hasShown = shown.title !== null || shown.body !== null || shown.tags !== null || shown.scenes !== null || (extras !== null && extras.length > 0)
  const staleVersion = hasShown && baseVersion !== null && uploadVersion !== null && baseVersion !== uploadVersion
  const seenAI = typeof userJ?.seenAI === 'string' ? userJ.seenAI : ''
  // 양쪽에 있는 항목만 비교한다 (사람만 가진 항목은 새 안을 만들지 않는다)
  const differs = (uv.title !== undefined && ai.title !== null && uv.title !== ai.title)
    || (uv.body !== undefined && ai.body !== null && uv.body !== ai.body)
    || (uv.tags !== undefined && ai.tags !== null && !sameTags(uv.tags, ai.tags))
    || (uv.scenes !== undefined && ai.scenes !== null && !sameScenes(uv.scenes, ai.scenes))
    || [...ux].some(([id, u]) => { const a2 = ai.extras?.find(e => e.id === id); return !!a2 && (a2.text !== u.text || (u.label !== undefined && u.label !== a2.label)) })
  const newAIDraft = userEdited && !!ai.updated && seenAI !== ai.updated && differs
  const warnings: string[] = []
  if (a && ai.version === null) warnings.push('ai.json 에 유효한 version 이 없습니다')
  return { target: t.id, name: t.name, known: t.known, hidden: t.hidden, ...shown, fromUser, extrasFromUser: [...ux.keys()], language: ai.language, baseVersion, staleVersion, newAIDraft, userEdited, ai, warnings }
}

export interface PostsInfo {
  /** 숨긴 대상 id (화면·요청에서 제외됨) */
  hiddenTargets?: string[]

  project: string; file: string; targetsSource: 'file' | 'default'; uploadVersion: number | null
  targets: TargetView[]; posts: PostView[]
}

async function viewTarget(projectDir: string, t: TargetView, uploadVersion: number | null): Promise<PostView> {
  const ai = await readRaw(projectDir, ['.clipment', 'posts', t.id], 'ai.json')
  const user = await readRaw(projectDir, ['.clipment', 'posts', t.id], 'user.json')
  const v = mergePost(t, ai.json, user.json, uploadVersion)
  if (ai.unsafe || user.unsafe) v.warnings.push('프로젝트 밖을 가리키는 링크라 읽지 않았습니다')
  if (ai.exists && !ai.json) v.warnings.push('ai.json 을 지금 읽을 수 없습니다(내려받는 중이거나 깨짐)')
  if (user.exists && !user.json) v.warnings.push('user.json 을 지금 읽을 수 없습니다(내려받는 중이거나 깨짐)')
  return v
}

/** 대상별 합쳐 본 글. only 가 있으면 그 id 들(목록에 있는 것만)로 좁힌다 */
export async function getPosts(ref: string, opts: { only?: string[] } = {}): Promise<PostsInfo> {
  const { dir, workspace, slug } = resolveProject(ref)
  const info = await readTargets(dir)
  const upload = await getUploadInfo(ref).catch(() => null)
  const uploadVersion = upload?.version ?? null
  const targets = opts.only?.length ? info.targets.filter(t => opts.only!.includes(t.id)) : info.targets
  const posts: PostView[] = []
  for (const t of targets) posts.push(await viewTarget(dir, t, uploadVersion))
  return { project: `${workspace.name}/${slug}`, file: postsDirOf(dir), targetsSource: info.source, uploadVersion, hiddenTargets: info.all.filter(t => t.hidden).map(t => t.id), targets, posts }
}

/** write_post 요청에 AI 에게 줄 내용: 풀어낸 대상 목록(요청 targets 가 비면 전체, 목록에 없는 id 는 건너뜀)과 대상별 현재 글 */
export async function postsForRequest(ref: string, req: Pick<Request, 'targets'>): Promise<PostsInfo & { skippedTargets: string[] }> {
  const wanted = req.targets ?? []
  const all = await getPosts(ref)
  if (!wanted.length) return { ...all, skippedTargets: [] }
  const have = new Set(all.targets.map(t => t.id)) // 숨긴 대상은 건너뜀
  return { ...all, targets: all.targets.filter(t => wanted.includes(t.id)), posts: all.posts.filter(p => wanted.includes(p.target)), skippedTargets: wanted.filter(id => !have.has(id)) }
}

// ---------- 쓰기 ----------

export interface ExtraInput { id: string; label?: string; text: string }
export interface WritePostInput {
  version: number
  title?: string; body?: string; tags?: string[]; scenes?: { t: number; text: string }[]
  /** id 별 병합(있으면 고치고 없으면 덧붙임). 빼려면 removeExtras */
  extras?: ExtraInput[]; removeExtras?: string[]
  language?: PostLanguage; requestId?: string
  /** 목록에 없는 대상이라 새로 추가할 때만 쓰는 표시 이름 */
  targetName?: string
}
export interface WritePostOptions { author: string; force?: boolean }
export interface WritePostResult { file: string; post: PostView; warnings: string[]; targetAdded: boolean; hidden: boolean }

function checkInput(i: WritePostInput): void {
  if (!Number.isInteger(i.version) || i.version < 1 || i.version > 999) throw new ValidationError(`version 은 1~999 정수여야 합니다: ${JSON.stringify(i.version)}`)
  if (i.title !== undefined && (typeof i.title !== 'string' || i.title.length > MAX_POST_TITLE)) throw new ValidationError(`title 은 ${MAX_POST_TITLE}자 이하 문자열`)
  if (i.body !== undefined && (typeof i.body !== 'string' || i.body.length > MAX_POST_BODY)) throw new ValidationError(`body 는 ${MAX_POST_BODY}자 이하 문자열`)
  if (i.tags !== undefined) {
    if (!Array.isArray(i.tags) || i.tags.length > MAX_POST_TAGS || i.tags.some(t => typeof t !== 'string' || t.length > MAX_POST_TAG)) throw new ValidationError(`tags 는 문자열 배열(최대 ${MAX_POST_TAGS}개, 항목 ${MAX_POST_TAG}자 이하)`)
  }
  if (i.scenes !== undefined) {
    if (!Array.isArray(i.scenes) || i.scenes.length > MAX_POST_SCENES) throw new ValidationError(`scenes 는 배열(최대 ${MAX_POST_SCENES}개)`)
    i.scenes.forEach((s, n) => {
      if (!s || typeof s !== 'object' || typeof s.t !== 'number' || !Number.isFinite(s.t) || s.t < 0) throw new ValidationError(`scenes[${n}].t 는 0 이상의 초(숫자)여야 합니다`)
      if (typeof s.text !== 'string' || !s.text.trim() || s.text.length > MAX_POST_SCENE_TEXT) throw new ValidationError(`scenes[${n}].text 는 비어 있지 않은 ${MAX_POST_SCENE_TEXT}자 이하 문자열`)
    })
  }
  if (i.extras !== undefined) {
    if (!Array.isArray(i.extras) || i.extras.length > MAX_EXTRAS) throw new ValidationError(`extras 는 배열(최대 ${MAX_EXTRAS}개)`)
    const seen = new Set<string>()
    i.extras.forEach((x, n) => {
      if (!x || typeof x !== 'object') throw new ValidationError(`extras[${n}] 가 잘못됐습니다`)
      assertTargetId(x.id)
      if (seen.has(x.id)) throw new ValidationError(`extras 중복 id: ${x.id}`)
      seen.add(x.id)
      if (typeof x.text !== 'string' || x.text.length > MAX_EXTRA_TEXT) throw new ValidationError(`extras[${n}].text 는 ${MAX_EXTRA_TEXT}자 이하 문자열`)
      if (x.label !== undefined && (typeof x.label !== 'string' || x.label.length > MAX_EXTRA_LABEL)) throw new ValidationError(`extras[${n}].label 은 ${MAX_EXTRA_LABEL}자 이하 문자열`)
    })
  }
  if (i.removeExtras !== undefined) {
    if (!Array.isArray(i.removeExtras) || i.removeExtras.length > MAX_EXTRAS) throw new ValidationError('remove_extras 는 id 배열')
    i.removeExtras.forEach(id => assertTargetId(id))
    for (const x of i.extras ?? []) if (i.removeExtras.includes(x.id)) throw new ValidationError(`extras 와 remove_extras 에 같은 id: ${x.id}`)
  }
  if (i.targetName !== undefined && (typeof i.targetName !== 'string' || i.targetName.length > 100)) throw new ValidationError('target_name 은 100자 이하 문자열')
  if (i.language !== undefined && !(POST_LANGUAGES as readonly string[]).includes(i.language)) throw new ValidationError(`language 는 ${POST_LANGUAGES.join('|')}`)
  if (i.requestId !== undefined && !isId(i.requestId)) throw new ValidationError(`잘못된 request_id: ${JSON.stringify(i.requestId)} (소문자 UUID)`)
}

async function assertWritable(ref: string, force?: boolean) {
  const { workspace } = resolveProject(ref)
  await assertWorkspaceWritable(workspace.path)
  if (!force) await assertUnlocked(ref)
}

/** targets.json 현재 상태 (쓰기용): 내려받는 중·밖을 가리키는 링크면 거부, 깨졌거나 없으면 기본 대상 */
async function loadTargetsForWrite(dir: string): Promise<{ raw: any; info: TargetsInfo; unusable: string | null }> {
  const cur = await readRaw(dir, ['.clipment', 'posts'], 'targets.json')
  if (cur.unsafe) throw new PostPathError('프로젝트 밖을 가리키는 링크라 쓰지 않습니다: targets.json')
  const info = await readTargets(dir)
  // 파일이 있는데 내려받는 중이거나 깨졌으면 사람의 목록을 덮어쓰지 않도록 목록을 바꾸는 쓰기는 거부한다
  const unusable = cur.placeholder ? '내려받는 중' : cur.exists && info.source === 'default' ? '깨짐' : null
  return { raw: info.source === 'file' && cur.json ? { ...cur.json } : { schema: 1 }, info, unusable }
}

async function saveTargets(dir: string, raw: any, entries: TargetEntry[], o: { author: string; authorName?: string }): Promise<void> {
  if (typeof raw.schema !== 'number') raw.schema = 1
  raw.targets = entries
  raw.author = o.author
  if (o.authorName?.trim()) raw.authorName = o.authorName.trim().slice(0, 64)
  raw.via = 'mac'
  raw.updated = new Date().toISOString()
  const dirPath = walkDir(dir, ['.clipment', 'posts'], true)!
  const file = join(dirPath, 'targets.json')
  checkFile(file)
  await atomicWriteReplace(file, JSON.stringify(raw, null, 2) + '\n')
}

/**
 * 대상의 ai.json 을 쓴다 (맥은 user.json 을 쓰지 않는다). 넘긴 필드만 바꾸고 나머지·모르는 필드는 보존한다.
 * version 은 항상 넘겨야 한다. 기존 글과 다른 버전이면 넘기지 않은 항목은 옛 버전 기준으로 남으므로 경고를 돌려준다.
 * 목록에 없는 대상이면 목록 끝에 `{id, name?, addedBy}` 로 추가한다(파일이 없거나 깨졌으면 기본 대상을 먼저 적는다; 숨김 포함 최대 20개).
 * 숨긴 대상이면 글만 쓰고 숨김은 그대로 둔다(결과 hidden=true). extras 는 id 별 병합, removeExtras 로만 뺀다.
 * 잠긴 프로젝트·더 새 계약은 거부.
 */
export async function writePost(ref: string, target: string, input: WritePostInput, opts: WritePostOptions): Promise<WritePostResult> {
  assertTargetId(target)
  checkInput(input)
  await assertWritable(ref, opts.force)
  const { dir } = resolveProject(ref)
  if (!existsSync(join(versionDir(ref, input.version), 'meta.json'))) throw new ValidationError(`버전 ${input.version} 을(를) 찾을 수 없습니다`)
  const { raw: traw, info, unusable } = await loadTargetsForWrite(dir)
  const existing = info.all.find(t => t.id === target)
  if (!existing && unusable) throw unusableMsg(unusable)
  if (!existing && info.entries.length >= MAX_TARGETS) throw new ValidationError(`대상은 숨김 포함 최대 ${MAX_TARGETS}개입니다. 기존 대상을 재사용하세요 (${info.entries.map(e => e.id).join(', ')})`)
  const parts = ['.clipment', 'posts', target]
  const cur = await readRaw(dir, parts, 'ai.json')
  if (cur.unsafe) throw new PostPathError(`프로젝트 밖을 가리키는 링크라 쓰지 않습니다: ${target}`)
  if (cur.exists && !cur.json) throw new ValidationError(`ai.json 을 지금 읽을 수 없습니다(내려받는 중이거나 깨짐): ${target}`)
  const raw: any = cur.json ? { ...cur.json } : { schema: 1 }
  const prevVersion = Number.isInteger(raw.version) ? raw.version : null
  if (typeof raw.schema !== 'number') raw.schema = 1
  raw.target = target
  raw.version = input.version
  if (input.title !== undefined) raw.title = input.title
  if (input.body !== undefined) raw.body = input.body
  if (input.tags !== undefined) raw.tags = normalizeTags(input.tags).filter((t, i, a) => a.indexOf(t) === i)
  if (input.scenes !== undefined) raw.scenes = normalizeScenes(input.scenes)
  if (input.extras !== undefined || input.removeExtras !== undefined) {
    let list: any[] = Array.isArray(raw.extras) ? [...raw.extras] : []
    if (input.removeExtras?.length) list = list.filter(x => !(x && input.removeExtras!.includes(x.id)))
    for (const x of input.extras ?? []) {
      const label = x.label?.trim() || undefined
      const at = list.findIndex(y => y && y.id === x.id)
      if (at >= 0) list[at] = { ...list[at], id: x.id, text: x.text, ...(label ? { label } : {}) }
      else list.push({ id: x.id, label: label ?? x.id, text: x.text })
    }
    if (normalizeExtras(list).length > MAX_EXTRAS || list.length > MAX_EXTRAS) throw new ValidationError(`extras 는 대상당 최대 ${MAX_EXTRAS}개입니다. remove_extras 로 정리하거나 기존 id 를 재사용하세요`)
    raw.extras = list
  }
  if (input.language !== undefined) raw.language = input.language
  if (input.requestId !== undefined) raw.requestId = input.requestId
  raw.author = opts.author
  raw.updated = new Date().toISOString()
  const warnings: string[] = []
  if (cur.json && prevVersion !== null && prevVersion !== input.version) {
    const missing = POST_FIELDS.filter(f => input[f] === undefined && raw[f] !== undefined)
    if (missing.length) warnings.push(`기준 버전이 v${prevVersion} → v${input.version} 로 바뀌었는데 ${missing.join('·')} 은(는) 넘기지 않아 이전 값이 남아 있습니다. 영상에 맞는지 확인해 다시 쓰세요`)
  }
  let entries = info.entries
  let targetAdded = false
  if (!existing) {
    const name = input.targetName?.trim()
    entries = [...info.entries, { id: target, ...(name ? { name } : {}), addedBy: opts.author }]
    targetAdded = true
    warnings.push(`대상 ${target} 이(가) 목록에 없어 끝에 추가했습니다`)
  }
  // 모든 검증을 마친 뒤에 쓴다: 대상 목록(추가 시) → ai.json
  if (targetAdded) await saveTargets(dir, traw, entries, { author: opts.author })
  const dirPath = walkDir(dir, parts, true)!
  const file = join(dirPath, 'ai.json')
  checkFile(file)
  await atomicWriteReplace(file, JSON.stringify(raw, null, 2) + '\n')
  const hidden = existing?.hidden === true
  if (hidden) warnings.push(`대상 ${target} 은(는) 사람이 목록에서 뺀(숨긴) 대상입니다. 글만 썼고 숨김은 그대로입니다. 다시 켜지 않습니다`)
  const view = viewOf(entries.find(e => e.id === target)!)
  const upload = await getUploadInfo(ref).catch(() => null)
  const user = await readRaw(dir, parts, 'user.json')
  return { file, post: mergePost(view, raw, user.json, upload?.version ?? null), warnings, targetAdded, hidden }
}

export interface AddTargetResult { added: boolean; hidden: boolean; targets: TargetsInfo }

/** 대상 하나를 목록 끝에 추가한다. 이미 있으면(숨김 포함) 아무것도 바꾸지 않는다(숨김은 켜지 않음). 숨김 포함 최대 20개 */
export async function addPostTarget(ref: string, target: string, name: string | undefined, opts: { author: string; authorName?: string; force?: boolean }): Promise<AddTargetResult> {
  assertTargetId(target)
  if (name !== undefined && (typeof name !== 'string' || name.length > 100)) throw new ValidationError('이름은 100자 이하 문자열')
  await assertWritable(ref, opts.force)
  const { dir } = resolveProject(ref)
  const { raw, info, unusable } = await loadTargetsForWrite(dir)
  const ex = info.all.find(t => t.id === target)
  if (ex) return { added: false, hidden: ex.hidden, targets: info }
  if (unusable) throw unusableMsg(unusable)
  if (info.entries.length >= MAX_TARGETS) throw new ValidationError(`대상은 숨김 포함 최대 ${MAX_TARGETS}개입니다 (${info.entries.map(e => e.id).join(', ')})`)
  await saveTargets(dir, raw, [...info.entries, { id: target, ...(name?.trim() ? { name: name.trim() } : {}), addedBy: opts.author }], opts)
  return { added: true, hidden: false, targets: await readTargets(dir) }
}

/**
 * 대상 순서 바꾸기 — 사람이 직접 부탁했을 때만. 새 순서는 지금 항목(숨김 포함)과 정확히 같은 id 집합이어야 한다
 * (추가·삭제·숨김 변경 불가). 항목의 모르는 필드·hidden 은 그대로.
 */
export async function reorderPostTargets(ref: string, ids: string[], opts: { author: string; authorName?: string; force?: boolean }): Promise<TargetsInfo> {
  if (!Array.isArray(ids)) throw new ValidationError('targets 는 id 배열이어야 합니다')
  ids.forEach(id => assertTargetId(id))
  if (new Set(ids).size !== ids.length) throw new ValidationError('중복된 대상 id')
  await assertWritable(ref, opts.force)
  const { dir } = resolveProject(ref)
  const { raw, info, unusable } = await loadTargetsForWrite(dir)
  if (unusable) throw unusableMsg(unusable)
  const cur = info.entries.map(e => e.id)
  if (ids.length !== cur.length || cur.some(id => !ids.includes(id)))
    throw new ValidationError(`순서만 바꿀 수 있습니다: 현재 대상(숨김 포함) 전부 — ${cur.join(', ')} — 와 같은 id 여야 합니다`)
  await saveTargets(dir, raw, ids.map(id => info.entries.find(e => e.id === id)!), opts)
  return readTargets(dir)
}
