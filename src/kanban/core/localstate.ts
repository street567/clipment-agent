// 이 맥에만 있는 상태 (클라우드에 올리지 않음). ~/.agent-kanban/state (AGENT_KANBAN_STATE 로 교체)
// 세션별 JSON + mkdir 락. 락은 2초 넘으면 포기하고 조용히 진행, 오래된 락은 회수.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readJson, writeReplace } from './fs.ts'
import { assertSessionId } from './ids.ts'
import { redact } from './redact.ts'

export const stateDir = () => process.env.AGENT_KANBAN_STATE || join(homedir(), '.agent-kanban/state')
export const logDir = () => process.env.AGENT_KANBAN_LOG || join(dirname(stateDir()), 'log')

export type CardStatus = 'waiting' | 'working' | 'paused' | 'done' | 'failed'
export interface CardLocal {
  kind: 'session' | 'task' | 'ask' | 'manual'
  status: CardStatus
  title: string // 원하는 제목
  shownTitle: string // 마지막으로 이벤트/카드에 올린 제목
  lastMs: number // 마지막 이벤트 시각(단조 증가 보장용)
  taken?: boolean // manual: board_take 로 이 세션이 맡은 카드
  recalled?: boolean // manual: 맡았다가 풀렸거나 회수됨(board_list/inbox 에서 한 번 알려 준다)
  submitted?: boolean // manual(taken): board_submit 으로 확인 요청 중(사람이 승인/거절하기 전까지 더 쓰지 않음)
}
export interface OpenInfo {
  cardId: string
  eventId: string
  toolUseId?: string
}
export interface NowLocal {
  state: 'working' | 'idle' | 'ended'
  cardId?: string
  summary?: string
  tool?: string
  ts: string
  writtenMs: number // now.json 을 마지막으로 쓴 시각
  aliveMs: number
}
export interface SessionState {
  v: 1
  sessionId: string
  boardId: string
  name: string
  agent?: string // LLM 종류(없으면 claude)
  taken?: string[] // 맡은 카드(맡은 순서)
  inited: boolean
  cards: Record<string, CardLocal>
  tasks: Record<string, string> // taskId → cardId
  currentTaskId?: string
  openInfos: OpenInfo[]
  submitPromptId?: string // UserPromptSubmit 이 온 마지막 prompt_id
  lastPromptId?: string // 마지막으로 본 prompt_id
  lastReportKey?: string
  pid?: number // 이 세션의 claude 프로세스 pid(매핑 기록용)
  now?: NowLocal
  updatedMs: number
}

export function newSessionState(sessionId: string, boardId: string, name: string): SessionState {
  return { v: 1, sessionId, boardId, name, inited: false, cards: {}, tasks: {}, openInfos: [], updatedMs: Date.now() }
}

const sessionFile = (sid: string) => join(stateDir(), 'sessions', `${assertSessionId(sid)}.json`)
export const sessionMtime = (sid: string): number | null => {
  try {
    return statSync(sessionFile(sid)).mtimeMs
  } catch {
    return null
  }
}
export const loadSession = (sid: string): SessionState | null => {
  const s = readJson<SessionState>(sessionFile(sid))
  return s && s.v === 1 && s.sessionId === sid ? s : null
}
function saveSession(st: SessionState) {
  st.updatedMs = Date.now()
  writeReplace(sessionFile(st.sessionId), st)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const LOCK_WAIT_MS = 2000
const LOCK_STALE_MS = 10_000

async function acquire(dir: string): Promise<boolean> {
  mkdirSync(dirname(dir), { recursive: true })
  const t0 = Date.now()
  for (;;) {
    try {
      mkdirSync(dir)
      return true
    } catch (e: any) {
      if (e?.code !== 'EEXIST') return false
      try {
        if (Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS) {
          try {
            rmdirSync(dir)
          } catch {}
          continue
        }
      } catch {} // 방금 풀림
    }
    if (Date.now() - t0 > LOCK_WAIT_MS) return false
    await sleep(8 + Math.random() * 20)
  }
}

/** 세션 상태를 락 안에서 읽고 고쳐 저장한다. 락을 못 얻으면(2초) 락 없이 진행한다. */
export async function withSession<T>(sid: string, init: () => SessionState, fn: (st: SessionState) => Promise<T> | T): Promise<T> {
  const lock = join(stateDir(), 'locks', `${assertSessionId(sid)}.lock`)
  const got = await acquire(lock)
  try {
    const st = loadSession(sid) ?? init()
    try {
      return await fn(st)
    } finally {
      try {
        saveSession(st)
      } catch {}
    }
  } finally {
    if (got) {
      try {
        rmdirSync(lock)
      } catch {}
    }
  }
}

// ── pid → 세션 매핑
const pidFile = (pid: number) => join(stateDir(), 'pids', `${Math.trunc(pid)}.json`)
export function setPidMap(pid: number, sessionId: string) {
  if (!Number.isInteger(pid) || pid <= 1) return
  writeReplace(pidFile(pid), { pid, sessionId, ts: Date.now() })
}
export function getPidMap(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  const m = readJson<{ sessionId?: string }>(pidFile(pid))
  return m?.sessionId && /^[A-Za-z0-9-]{8,64}$/.test(m.sessionId) ? m.sessionId : null
}
export function clearPidMap(pid: number) {
  try {
    unlinkSync(pidFile(pid))
  } catch {}
}

// ── 로그 (1MB 회전). 토큰·비밀은 가려서만 남긴다.
export function logLine(kind: string, msg: string) {
  try {
    const dir = logDir()
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 'hook.log')
    try {
      if (statSync(f).size > 1_000_000) renameSync(f, f + '.1')
    } catch {}
    appendFileSync(f, `${new Date().toISOString()} ${kind} ${redact(msg).replace(/\s+/g, ' ').slice(0, 600)}\n`)
  } catch {}
}
export const logFileExists = () => existsSync(join(logDir(), 'hook.log'))

// ── claude 프로세스 pid 찾기: CLAUDE_PID → 조상 중 이름이 claude 인 것 → 부모
import { spawnSync } from 'node:child_process'
export function ancestors(start: number, max = 8): { pid: number; cmd: string }[] {
  const out: { pid: number; cmd: string }[] = []
  let pid = start
  for (let i = 0; i < max && pid > 1; i++) {
    const r = spawnSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 })
    const line = (r.stdout || '').trim()
    if (!line) break
    const m = /^(\d+)\s+(.*)$/.exec(line)
    if (!m) break
    out.push({ pid, cmd: m[2] })
    pid = Number(m[1])
  }
  return out
}
export function findClaudePid(): number {
  const e = Number(process.env.CLAUDE_PID)
  if (Number.isInteger(e) && e > 1) return e
  try {
    for (const a of ancestors(process.ppid)) {
      const first = a.cmd.split(/\s+/)[0] ?? ''
      if (/(^|\/)(claude|codex)$/.test(first)) return a.pid
    }
  } catch {}
  return process.ppid
}
