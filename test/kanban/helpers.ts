import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { derive } from '../../src/kanban/core/derive.ts'

export const PLUGIN = join(import.meta.dir, '../..')
export const FIXTURES = join(import.meta.dir, 'fixtures')
export const SPEC = join(PLUGIN, 'spec-kanban')

export interface Env {
  dir: string
  root: string
  state: string
  log: string
  cfgPath: string
  env: Record<string, string>
  board: string
}

/** 임시 폴더 + 환경변수로만 동작하는 격리 환경 (실제 ~/.claude·~/.config·iCloud 를 건드리지 않는다) */
export function setup(cfg: Record<string, any> = {}, extraEnv: Record<string, string> = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), 'ak-test-'))
  const root = join(dir, 'root')
  const state = join(dir, 'state')
  const log = join(dir, 'log')
  const cfgPath = join(dir, 'config.json')
  mkdirSync(root, { recursive: true })
  if (cfg !== null) writeFileSync(cfgPath, JSON.stringify({ enabled: true, root, ...cfg }))
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: dir,
    AGENT_KANBAN_CONFIG: cfgPath,
    AGENT_KANBAN_STATE: state,
    AGENT_KANBAN_LOG: log,
    AGENT_KANBAN_NO_DOWNLOAD: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    ...extraEnv,
  }
  return { dir, root, state, log, cfgPath, env, board: cfg?.board ?? 'main' }
}

export async function runHook(e: Env, input: unknown, extraEnv: Record<string, string> = {}, raw?: string): Promise<{ stdout: string; stderr: string; code: number; ms: number }> {
  const t0 = performance.now()
  const p = Bun.spawn([process.execPath, join(PLUGIN, 'src/kanban/hook.ts')], { env: { ...e.env, ...extraEnv }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  p.stdin.write(raw ?? JSON.stringify(input))
  p.stdin.end()
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { stdout, stderr, code, ms: performance.now() - t0 }
}

export function loadJsonl(name: string): any[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

export function readJ(p: string): any {
  return JSON.parse(readFileSync(p, 'utf8'))
}

export interface CardView {
  id: string
  card: any
  events: any[]
  comments: any[]
  actions: any[]
  derived: ReturnType<typeof derive>
}
export function boardDir(e: Env) {
  return join(e.root, 'boards', e.board)
}
export function listFiles(dir: string): any[] {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith('.') && n.endsWith('.json')).map((n) => ({ ...readJ(join(dir, n)), _file: n }))
  } catch {
    return []
  }
}
export function cards(e: Env): CardView[] {
  const dir = join(boardDir(e), 'cards')
  let ids: string[] = []
  try {
    ids = readdirSync(dir)
  } catch {}
  return ids.map((id) => {
    const events = listFiles(join(dir, id, 'events')).sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1))
    const actions = listFiles(join(dir, id, 'actions'))
    return { id, card: readJ(join(dir, id, 'card.json')), events, comments: listFiles(join(dir, id, 'comments')), actions, derived: derive(events, actions) }
  })
}
export const byTitle = (cs: CardView[], t: string) => cs.find((c) => c.derived.title === t || c.card.title === t)

/** 앱처럼 사람 코멘트를 쓴다 */
export function appComment(e: Env, cardId: string, text: string, created = new Date().toISOString()) {
  const id = randomUUID()
  const d = join(boardDir(e), 'cards', cardId, 'comments')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, `${id}.json`), JSON.stringify({ schema: 1, id, cardId, author: 'user', authorName: '개미', text, replyTo: null, created }))
  return id
}
export function appAction(e: Env, cardId: string, ref: string, kind: string, extra: Record<string, any> = {}) {
  const id = randomUUID()
  const d = join(boardDir(e), 'cards', cardId, 'actions')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, `${id}.json`), JSON.stringify({ schema: 1, id, cardId, ref, kind, choice: null, text: '', authorName: '개미', created: new Date().toISOString(), ...extra }))
  return id
}

export function allFilesText(root: string): string {
  const out: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      statSync(p).isDirectory() ? walk(p) : out.push(`${p}\n${readFileSync(p, 'utf8')}`)
    }
  }
  walk(root)
  return out.join('\n')
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const SID = '2bd65158-0726-4cee-bfdc-c38ff9c05a98'
export function base(sid = SID, extra: Record<string, any> = {}) {
  return { session_id: sid, transcript_path: '/nonexistent/t.jsonl', cwd: '/Users/me/proj', ...extra }
}

// ── 1.1: 앱처럼 보드 ops·manual 카드·카드 ops 를 쓴다
let opSeq = 0
const opTime = () => new Date(Date.now() + ++opSeq).toISOString()
export function appBoardOp(e: Env, set: Record<string, unknown>, by: any = { author: 'user', name: '민수', member: 'u-minsu' }) {
  const id = randomUUID()
  const d = join(boardDir(e), 'ops')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, `${id}.json`), JSON.stringify({ schema: 1, id, by, set, created: opTime() }))
  return id
}
export function appCardOp(e: Env, cardId: string, set: Record<string, unknown>, by: any = { author: 'user', name: '민수', member: 'u-minsu' }) {
  const id = randomUUID()
  const d = join(boardDir(e), 'cards', cardId, 'ops')
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, `${id}.json`), JSON.stringify({ schema: 1, id, cardId, by, set, created: opTime() }))
  return id
}
export function appManualCard(e: Env, c: { title: string; detail?: string; by?: any; set?: Record<string, unknown>; opBy?: any; sessionId?: string }) {
  const id = randomUUID()
  const by = c.by ?? { author: 'user', name: '민수', member: 'u-minsu' }
  const d = join(boardDir(e), 'cards', id)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'card.json'), JSON.stringify({ schema: 1, id, kind: 'manual', title: c.title, ...(c.detail ? { detail: c.detail } : {}), ...(c.sessionId ? { sessionId: c.sessionId } : {}), by, created: new Date().toISOString() }))
  if (c.set) appCardOp(e, id, c.set, c.opBy ?? by)
  return id
}
/** 팀: 사람 둘, LLM(프로젝트 있는 알파), 카테고리 하나 */
export function appTeam(e: Env, extra: Record<string, unknown> = {}) {
  return appBoardOp(e, {
    'member.u-minsu': { name: '민수', kind: 'human', rank: 0 },
    'member.u-jiyeon': { name: '지연', kind: 'human', rank: 1 },
    'member.alpha': { name: '알파', kind: 'llm', agent: 'claude', project: 'proj', rank: 2 },
    'label.l-dev': { name: '개발', color: 2, rank: 0, assignees: ['u-jiyeon'] },
    defaultHuman: 'u-minsu',
    ...extra,
  })
}
