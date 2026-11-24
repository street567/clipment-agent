import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertId, assertSlug, assertVersionNum, commentsDir, isId, isSlug, isVersionNum, locksDir, progressDir,
  projectDir, repliesDir, requestsDir, resolveProject, safeJoin, workspaces, type Workspace, ValidationError, versionDir, versionLabel,
} from './paths.ts'
import { assertWorkspaceWritable } from './contract.ts'
import { currentRegionViews, normalizeRegions } from './regions.ts'
import { listJsonStems, listSubdirs, readJson, writeJsonNew } from './fsutil.ts'
import {
  COMMENT_STATUSES, PROGRESS_STATES, REQUEST_TYPES, TAGS,
  type Comment, type CommentStatus, type CommentWithStatus, type ProgressEvent, type ProgressState,
  type LockEvent, type Project, type ProjectListing, type Reply, type Request, type RequestType, type RequestWithState, type VersionMeta, type VersionOriginal,
} from './types.ts'

const nowIso = () => new Date().toISOString()
/** 같은 스레드 안에서 created 가 단조 증가하도록 보정 (같은 ms 동률로 순서가 뒤집히는 것 방지) */
const nextIso = (prev: { created: string }[]): string => {
  let t = Date.now()
  for (const p of prev) {
    const pt = Date.parse(p.created)
    if (Number.isFinite(pt) && pt >= t) t = pt + 1
  }
  return new Date(t).toISOString()
}
const byCreated = <T extends { created: string }>(a: T, b: T) =>
  a.created < b.created ? -1 : a.created > b.created ? 1 : 0
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d)
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const inList = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v)

// ---------- 프로젝트 ----------

export async function initProject(ref: string, title?: string): Promise<Project> {
  const { slug, dir, workspace } = resolveProject(ref, { allowMissing: true })
  await assertWorkspaceWritable(workspace.path)
  const file = join(dir, 'project.json')
  const existing = await readJson(file)
  if (existing) return normalizeProject(slug, existing)
  const p: Project = { schema: 1, id: slug, title: title ?? slug, created: nowIso() }
  const { ensureWorkspaceJson } = await import('./workspaces.ts')
  await ensureWorkspaceJson(workspace.path)
  await mkdir(join(dir, 'versions'), { recursive: true })
  await writeJsonNew(file, p)
  return p
}

function normalizeProject(slug: string, j: any): Project {
  return { schema: num(j.schema, 1), id: slug, title: str(j.title, slug), created: str(j.created) }
}

export async function getProject(ref: string): Promise<Project | null> {
  const { slug, dir } = resolveProject(ref)
  const j = await readJson(join(dir, 'project.json'))
  return j ? normalizeProject(slug, j) : null
}

/** 워크스페이스 루트 아래 프로젝트들. workspace.json·점(.) 항목 무시, project.json 있는 slug 폴더만. */
export async function listWorkspaceProjects(w: Workspace): Promise<Project[]> {
  const out: Project[] = []
  for (const name of await listSubdirs(w.path)) {
    if (name.startsWith('.') || !isSlug(name)) continue
    const j = await readJson(join(w.path, name, 'project.json'))
    if (j) out.push(normalizeProject(name, j))
  }
  return out
}

/** 모든 워크스페이스의 프로젝트 (workspace/ref/locked 포함). 같은 이름이 여러 곳이면 ref 로만 구분됨. */
export async function listProjects(): Promise<ProjectListing[]> {
  const out: ProjectListing[] = []
  for (const w of workspaces()) {
    for (const p of await listWorkspaceProjects(w)) {
      const ref = `${w.name}/${p.id}`
      const lock = await currentLock(ref)
      out.push({ ...p, workspace: w.name, ref, locked: !!lock, ...(lock ? { lock } : {}) })
    }
  }
  return out.sort(byCreated)
}

export async function requireProject(slug: string): Promise<Project> {
  const p = await getProject(slug)
  if (!p) throw new ValidationError(`프로젝트 없음(또는 아직 내려받는 중): ${slug}`)
  return p
}

// ---------- 버전 ----------

export function normalizeMeta(version: number, j: any): VersionMeta {
  return {
    schema: num(j.schema, 1), version, label: versionLabel(version), file: 'preview.mp4',
    duration: num(j.duration), fps: num(j.fps), width: num(j.width), height: num(j.height),
    note: str(j.note), source: str(j.source), created: str(j.created),
    ...(normalizeOriginal(j.original) ? { original: normalizeOriginal(j.original)! } : {}),
  }
}

/** meta.original: file·bytes 가 올바르지 않거나 버전 폴더 밖을 가리키면 원본 없음으로 본다 (SPEC §12) */
function normalizeOriginal(o: any): VersionOriginal | undefined {
  if (!o || typeof o !== 'object') return undefined
  const file = str(o.file)
  if (!file || file.includes('/') || file === '..' || file === '.' || typeof o.bytes !== 'number' || !Number.isFinite(o.bytes)) return undefined
  const r: VersionOriginal = { file, bytes: o.bytes }
  for (const k of ['width', 'height', 'fps', 'duration'] as const) if (typeof o[k] === 'number' && Number.isFinite(o[k])) r[k] = o[k]
  return r
}

export async function listVersions(slug: string): Promise<VersionMeta[]> {
  resolveProject(slug)
  const out: VersionMeta[] = []
  for (const name of await listSubdirs(join(projectDir(slug), 'versions'))) {
    const m = /^v(\d{3})$/.exec(name)
    if (!m) continue
    const n = Number(m[1])
    if (!isVersionNum(n)) continue
    const j = await readJson(join(versionDir(slug, n), 'meta.json'))
    if (j) out.push(normalizeMeta(n, j))
  }
  return out.sort((a, b) => a.version - b.version)
}

export async function getVersion(slug: string, version: number): Promise<VersionMeta | null> {
  assertVersionNum(version)
  const j = await readJson(join(versionDir(slug, version), 'meta.json'))
  return j ? normalizeMeta(version, j) : null
}

/** 다음 버전 번호 (폴더명 기준 최대+1, 임시폴더 제외) */
export async function nextVersionNumber(slug: string): Promise<number> {
  let max = 0
  try {
    for (const name of await readdir(join(projectDir(slug), 'versions'))) {
      const m = /^v(\d{3})$/.exec(name)
      if (m) max = Math.max(max, Number(m[1]))
    }
  } catch {}
  return max + 1
}

export function previewPath(slug: string, version: number): string {
  return join(versionDir(slug, version), 'preview.mp4')
}

// ---------- 코멘트 / 답글 ----------

function normalizeComment(id: string, j: any): Comment | null {
  if (!j || typeof j !== 'object') return null
  const version = num(j.version, -1)
  if (!Number.isInteger(version) || version < 0 || version > 999) return null
  const t = num(j.t, 0)
  const c: Comment = {
    schema: num(j.schema, 1), id, version, t,
    end: typeof j.end === 'number' && Number.isFinite(j.end) && j.end > t ? j.end : null,
    tag: inList(TAGS, j.tag) ? j.tag : 'other',
    text: str(j.text), author: str(j.author, 'user'), created: str(j.created),
  }
  if (str(j.authorName).trim()) c.authorName = str(j.authorName).trim()
  const regions = normalizeRegions(j.regions)
  if (regions && regions.length) c.regions = regions
  return c
}

function normalizeReply(commentId: string, id: string, j: any): Reply | null {
  if (!j || typeof j !== 'object') return null
  const r: Reply = {
    schema: num(j.schema, 1), id, commentId, author: str(j.author, 'user'),
    text: str(j.text), created: str(j.created),
  }
  if (str(j.authorName).trim()) r.authorName = str(j.authorName).trim()
  if (inList(COMMENT_STATUSES, j.status)) r.status = j.status
  if (isVersionNum(j.fixedIn)) r.fixedIn = j.fixedIn
  const regions = normalizeRegions(j.regions)
  if (regions) r.regions = regions // 빈 배열 = 영역 모두 삭제 (보존)
  if (j.kind === 'regions') r.kind = 'regions'
  return r
}

export async function listReplies(slug: string, commentId: string): Promise<Reply[]> {
  const dir = repliesDir(slug, commentId)
  const out: Reply[] = []
  for (const stem of await listJsonStems(dir)) {
    if (!isId(stem)) continue
    const r = normalizeReply(commentId, stem, await readJson(join(dir, stem + '.json')))
    if (r) out.push(r)
  }
  return out.sort(byCreated)
}

export function deriveStatus(replies: Reply[]): { status: CommentStatus; fixedIn: number | null } {
  const sorted = [...replies].sort(byCreated)
  let status: CommentStatus = 'open'
  let fixedIn: number | null = null
  for (const r of sorted) {
    if (r.status) {
      status = r.status
      fixedIn = r.fixedIn ?? null
    }
  }
  return { status, fixedIn }
}

export interface CommentFilter { version?: number; status?: CommentStatus; tag?: string }

export async function listComments(slug: string, filter: CommentFilter = {}): Promise<CommentWithStatus[]> {
  resolveProject(slug)
  const dir = commentsDir(slug)
  const out: CommentWithStatus[] = []
  for (const stem of await listJsonStems(dir)) {
    if (!isId(stem)) continue
    const c = normalizeComment(stem, await readJson(join(dir, stem + '.json')))
    if (!c) continue
    if (filter.version !== undefined && c.version !== filter.version) continue
    if (filter.tag && c.tag !== filter.tag) continue
    const replies = await listReplies(slug, c.id)
    const d = deriveStatus(replies)
    if (filter.status && d.status !== filter.status) continue
    out.push({ ...c, ...d, replyCount: replies.length, currentRegions: currentRegionViews(c, replies) })
  }
  return out.sort(byCreated)
}

export async function getComment(slug: string, commentId: string): Promise<Comment | null> {
  assertId(commentId, 'commentId')
  const j = await readJson(join(commentsDir(slug), commentId + '.json'))
  return normalizeComment(commentId, j)
}

export async function getThread(slug: string, commentId: string) {
  const comment = await getComment(slug, commentId)
  if (!comment) throw new ValidationError(`코멘트 없음: ${commentId}`)
  const replies = await listReplies(slug, commentId)
  return { comment, replies, ...deriveStatus(replies), currentRegions: currentRegionViews(comment, replies) }
}

export interface ReplyInput { text: string; author: string; authorName?: string; status?: CommentStatus; fixedIn?: number; force?: boolean }

export async function addReply(slug: string, commentId: string, input: ReplyInput): Promise<Reply> {
  await assertWorkspaceWritable(resolveProject(slug).workspace.path)
  assertId(commentId, 'commentId')
  if (!input.force) await assertUnlocked(slug)
  if (!(await getComment(slug, commentId))) throw new ValidationError(`코멘트 없음: ${commentId}`)
  if (!input.text || !input.text.trim()) throw new ValidationError('답글 내용이 비어 있습니다')
  assertAuthor(input.author)
  if (input.status !== undefined && !inList(COMMENT_STATUSES, input.status))
    throw new ValidationError(`잘못된 status: ${input.status} (${COMMENT_STATUSES.join('|')})`)
  if (input.fixedIn !== undefined) assertVersionNum(input.fixedIn)
  const id = randomUUID()
  const created = nextIso(await listReplies(slug, commentId))
  const r: Reply = { schema: 1, id, commentId, author: input.author, text: input.text, created }
  const an = input.authorName?.trim()
  if (an) r.authorName = an.slice(0, 64)
  if (input.status) r.status = input.status
  if (input.fixedIn !== undefined) r.fixedIn = input.fixedIn
  await writeJsonNew(join(repliesDir(slug, commentId), id + '.json'), r)
  return r
}

export function assertAuthor(a: string): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(a)) throw new ValidationError(`잘못된 author: ${JSON.stringify(a)}`)
  return a
}

// ---------- 요청 / 진행 ----------

/** 화이트리스트 밖 type 의 요청을 본 적이 있는지 (폰 앱이 맥 에이전트보다 새롭다는 신호 → 데몬이 업데이트 확인). 읽고 비운다. */
const unknownTypes = new Map<string, string>()
export function drainUnknownRequestTypes(): { id: string; type: string }[] {
  const out = [...unknownTypes].map(([id, type]) => ({ id, type }))
  unknownTypes.clear()
  return out
}
const seenUnknown = new Set<string>()

function normalizeRequest(id: string, j: any): Request | null {
  if (!j || typeof j !== 'object') return null
  if (!inList(REQUEST_TYPES, j.type)) return null // 화이트리스트 밖 type 은 무시
  const version = num(j.version, -1)
  if (!Number.isInteger(version) || version < 0 || version > 999) return null
  let commentIds: string[] | null = null
  if (Array.isArray(j.commentIds)) commentIds = j.commentIds.filter(isId)
  const req: Request = {
    schema: num(j.schema, 1), id, type: j.type as RequestType, version, commentIds,
    agent: str(j.agent), message: str(j.message), created: str(j.created),
  }
  if (str(j.authorName).trim()) req.authorName = str(j.authorName).trim()
  if (req.type === 'apply_script') req.draft = j.draft === true
  return req
}

export async function listProgress(slug: string, requestId: string): Promise<ProgressEvent[]> {
  const dir = progressDir(slug, requestId)
  const out: ProgressEvent[] = []
  for (const stem of await listJsonStems(dir)) {
    if (!isId(stem)) continue
    const j = await readJson(join(dir, stem + '.json'))
    if (!j || !inList(PROGRESS_STATES, j.state)) continue
    out.push({
      schema: num(j.schema, 1), id: stem, requestId, state: j.state,
      message: str(j.message), agent: str(j.agent), created: str(j.created),
    })
  }
  return out.sort(byCreated)
}

export async function listRequests(slug: string, opts: { pendingOnly?: boolean } = {}): Promise<RequestWithState[]> {
  resolveProject(slug)
  const dir = requestsDir(slug)
  const out: RequestWithState[] = []
  for (const stem of await listJsonStems(dir)) {
    if (!isId(stem)) continue
    const raw = await readJson(join(dir, stem + '.json'))
    const r = normalizeRequest(stem, raw)
    if (!r) {
      // 새 type(예: 더 새 앱이 보낸 것)은 실행하지 않고 흔적만 남긴다 (같은 id 는 한 번만)
      if (typeof raw?.type === 'string' && !inList(REQUEST_TYPES, raw.type) && !seenUnknown.has(stem) && seenUnknown.size < 5000) {
        seenUnknown.add(stem); unknownTypes.set(stem, raw.type.slice(0, 64))
      }
      continue
    }
    const events = await listProgress(slug, r.id)
    const state = events.length ? events[events.length - 1]!.state : 'pending'
    if (opts.pendingOnly && !(state === 'pending' || state === 'received')) continue
    out.push({ ...r, state })
  }
  return out.sort(byCreated)
}

export async function addProgress(
  slug: string, requestId: string, state: ProgressState, message: string, agent: string,
): Promise<ProgressEvent> {
  await assertWorkspaceWritable(resolveProject(slug).workspace.path)
  assertId(requestId, 'requestId')
  if (!inList(PROGRESS_STATES, state)) throw new ValidationError(`잘못된 state: ${state} (${PROGRESS_STATES.join('|')})`)
  assertAuthor(agent)
  if (!existsSync(safeJoin(requestsDir(slug), requestId + '.json'))) throw new ValidationError(`요청 없음: ${requestId}`)
  const id = randomUUID()
  const created = nextIso(await listProgress(slug, requestId))
  const e: ProgressEvent = { schema: 1, id, requestId, state, message, agent, created }
  await writeJsonNew(join(progressDir(slug, requestId), id + '.json'), e)
  return e
}

// ---------- 완료 잠금 (SPEC §8) ----------

export async function listLocks(ref: string): Promise<LockEvent[]> {
  const dir = locksDir(ref)
  const out: LockEvent[] = []
  for (const stem of await listJsonStems(dir)) {
    if (!isId(stem)) continue
    const j = await readJson(join(dir, stem + '.json'))
    if (!j || (j.state !== 'locked' && j.state !== 'unlocked')) continue
    const e: LockEvent = { schema: num(j.schema, 1), id: stem, state: j.state, author: str(j.author, 'user'), note: str(j.note), created: str(j.created) }
    if (str(j.authorName).trim()) e.authorName = str(j.authorName).trim()
    out.push(e)
  }
  return out.sort(byCreated)
}

/** 현재 잠겨 있으면 가장 최근 lock 이벤트, 아니면 null */
export async function currentLock(ref: string): Promise<LockEvent | null> {
  const ev = await listLocks(ref)
  const last = ev[ev.length - 1]
  return last && last.state === 'locked' ? last : null
}

export async function assertUnlocked(ref: string): Promise<void> {
  const l = await currentLock(ref)
  if (l) throw new ValidationError(`잠긴(완료) 프로젝트입니다: ${ref}${l.note ? ` — ${l.note}` : ''}${l.authorName ? ` (${l.authorName})` : ''}. 사람이 명시적으로 요청한 경우에만 force(--force)로 진행하세요.`)
}

export async function setLock(ref: string, state: 'locked' | 'unlocked', o: { author: string; authorName?: string; note?: string }): Promise<LockEvent> {
  await assertWorkspaceWritable(resolveProject(ref).workspace.path)
  assertAuthor(o.author)
  const id = randomUUID()
  const created = nextIso(await listLocks(ref))
  const e: LockEvent = { schema: 1, id, state, author: o.author, note: o.note ?? '', created }
  const an = o.authorName?.trim()
  if (an) e.authorName = an.slice(0, 64)
  await writeJsonNew(join(locksDir(ref), id + '.json'), e)
  return e
}

/** force 로 잠긴 프로젝트를 건드릴 때 붙일 경고 (잠겨 있지 않으면 null) */
export async function forceWarning(ref: string): Promise<string | null> {
  const l = await currentLock(ref)
  return l ? `경고: 잠긴(완료) 프로젝트 ${ref} 에 --force 로 쓰기 작업을 했습니다${l.note ? ` (${l.note})` : ''}` : null
}
