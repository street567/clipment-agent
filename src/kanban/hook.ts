#!/usr/bin/env bun
// Claude Code hook 진입점. 절대 세션을 방해하지 않는다: 설정이 없거나 오류면 조용히 exit 0, Stop 의 정해진 JSON 외에는 stdout 에 아무것도 쓰지 않는다.
// 내장 모듈만 사용(node_modules 없이도 동작).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { basename } from 'node:path'
import { loadConfig, pathAllowed, type Config } from './config.ts'
import { formatSessionStart, formatStop, normalizeInput, resolveAgent } from './core/agent.ts'
import { checkMine, loadBoard, refreshTaken, scanAvailable } from './core/delegate.ts'
import { displayAgent } from './core/agent.ts'
import { closeAnswered, currentCardId, dropTaken, emit, ensureCard, needsHuman, newCtx, queueNotice, sessionCardId, setNow, setTitle, touchWorking, type Ctx } from './core/board.ts'
import { claim, collectPending, renderForStop } from './core/deliver.ts'
import { isSessionId } from './core/ids.ts'
import { clearPidMap, findClaudePid, loadSession, logLine, newSessionState, setPidMap, withSession } from './core/localstate.ts'
import { clean } from './core/redact.ts'
import { Store } from './core/store.ts'
import { summarizeTool } from './core/summarize.ts'
import { sendTelegram } from './core/telegram.ts'
import { promptTitle } from './core/title.ts'

/** 헤드리스(claude -p / SDK) 판단. CLAUDE_CODE_ENTRYPOINT 가 sdk-cli · sdk-ts · sdk-py 등 sdk 로 시작하면 헤드리스.
 *  값이 없으면 부모 프로세스 인자에서 -p/--print 를 찾고, 그래도 모르면 대화형으로 본다(보드에 보이는 쪽). */
export function isHeadless(): boolean {
  const ep = process.env.CLAUDE_CODE_ENTRYPOINT
  if (ep) return ep.toLowerCase().startsWith('sdk')
  try {
    const r = spawnSync('ps', ['-o', 'args=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 1500 })
    const toks = (r.stdout || '').trim().split(/\s+/)
    return toks.includes('-p') || toks.includes('--print')
  } catch {
    return false
  }
}

const FAIL_KO: Record<string, string> = {
  rate_limit: '사용량 한도에 도달했어요. 한도가 풀리면 이어서 할 수 있어요',
  authentication_failed: '로그인이 만료됐어요. 터미널에서 다시 로그인해 주세요',
  oauth_org_not_allowed: '이 조직에서 허용되지 않은 로그인이에요',
  account_on_hold: '계정이 보류 상태예요',
  billing_error: '결제 문제로 멈췄어요',
  invalid_request: '요청이 올바르지 않아 멈췄어요',
  model_not_found: '모델을 찾을 수 없어요',
  server_error: '서버 오류(또는 과부하)로 멈췄어요',
  max_output_tokens: '출력 길이 한도에 도달했어요',
  cloud_credential_error: '클라우드 자격 증명 오류로 멈췄어요',
  unknown: '알 수 없는 오류로 멈췄어요',
}
export function failureText(error: unknown): string {
  const e = typeof error === 'string' ? error : 'unknown'
  if (FAIL_KO[e]) return FAIL_KO[e]
  if (/auth|login|oauth|credential/i.test(e)) return FAIL_KO.authentication_failed
  return FAIL_KO.unknown
}

/** transcript 꼬리(마지막 256KB)에서 마지막 사람 입력의 제목을 찾는다. 실패하면 null */
export function titleFromTranscript(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return null
  let fd = -1
  try {
    fd = openSync(path, 'r')
    const st = fstatSync(fd)
    if (!st.isFile()) return null
    const len = Math.min(st.size, 256 * 1024)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, st.size - len)
    const lines = buf.toString('utf8').split('\n')
    if (st.size > len) lines.shift() // 잘린 첫 줄
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim()
      if (!l) continue
      let o: any
      try {
        o = JSON.parse(l)
      } catch {
        continue
      }
      if (o?.type !== 'user' || o.isMeta || o.isSidechain || o.message?.role !== 'user') continue
      const c = o.message.content
      if (typeof c === 'string') return promptTitle(c)
      if (Array.isArray(c)) {
        if (c.some((b: any) => b?.type === 'tool_result')) continue
        const t = c.find((b: any) => b?.type === 'text' && typeof b.text === 'string')
        return t ? promptTitle(t.text) : null
      }
    }
  } catch {
    return null
  } finally {
    if (fd >= 0) try { closeSync(fd) } catch {}
  }
  return null
}

// ── 핸들러 ────────────────────────────────────────────────

/** 일하는 중으로 되돌릴 카드: 세션 카드 + 현재 task 카드. 열린 info(도구 요청 아님)는 progress 로 닫는다 */
function closeInfos(ctx: Ctx) {
  const { st } = ctx
  const keep = st.openInfos.filter((i) => i.toolUseId)
  for (const i of st.openInfos.filter((x) => !x.toolUseId)) touchWorking(ctx, i.cardId, true)
  st.openInfos = keep
}

/** 턴이 새로 시작되거나 끝나면 남은 info 는 모두 무효(질문을 Esc 로 닫으면 PostToolUse 가 오지 않는다). 남겨 두면 다음 권한 확인이 가려진다 */
function dropInfos(ctx: Ctx) {
  for (const i of ctx.st.openInfos) emit(ctx, i.cardId, 'resolved', { ref: i.eventId })
  ctx.st.openInfos = []
}

function markWorking(ctx: Ctx): string {
  const sc = sessionCardId(ctx)
  const cur = currentCardId(ctx)
  touchWorking(ctx, sc)
  if (cur !== sc) touchWorking(ctx, cur)
  return cur
}

function ensureTask(ctx: Ctx, taskId: string, subject?: string): string {
  sessionCardId(ctx)
  const id = ensureCard(ctx, 'task', taskId, subject || `작업 ${taskId}`)
  ctx.st.tasks[taskId] = id
  return id
}

function finishTask(ctx: Ctx, taskId: string, subject?: string) {
  const id = ensureTask(ctx, taskId, subject)
  if (ctx.st.cards[id].status !== 'done') emit(ctx, id, 'done')
  if (ctx.st.currentTaskId === taskId) delete ctx.st.currentTaskId
}

function onTaskUpdate(ctx: Ctx, ti: any) {
  const raw = ti?.taskId ?? ti?.task_id
  const taskId = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : ''
  if (!taskId || taskId.length > 64) return
  const subject = typeof ti.subject === 'string' && ti.subject.trim() ? ti.subject : undefined
  const id = ensureTask(ctx, taskId, subject)
  const c = ctx.st.cards[id]
  if (subject) setTitle(ctx, id, subject)
  switch (ti.status) {
    case 'in_progress':
      ctx.st.currentTaskId = taskId
      touchWorking(ctx, id)
      break
    case 'pending':
      if (c.status !== 'waiting' && c.status !== 'paused') emit(ctx, id, 'paused')
      if (ctx.st.currentTaskId === taskId) delete ctx.st.currentTaskId
      break
    case 'completed':
    case 'deleted':
      finishTask(ctx, taskId, subject)
      break
    default:
      if (subject && c.status === 'working') touchWorking(ctx, id)
  }
}

const SESSION_START_NOTE =
  '이 세션은 사용자가 설치한 에이전트 칸반에 연결돼 있습니다. 사용자는 폰에서 보드를 보고 코멘트·결정을 남깁니다. ' +
  '그 의견은 보드 주인인 사용자의 보통 요청으로 다루고, 처리 후 board_reply 로 결과를 남기세요. ' +
  '삭제·결제·배포·외부 전송처럼 되돌리기 어려운 일은 대화에서 다시 확인하세요. ' +
  '큰 일은 TaskCreate 로 나누고 시작할 때 in_progress 로 바꾸세요. 사용자의 결정·승인이 필요하면 board_ask 를 쓰세요(to 로 누구에게 부탁하는지 적기). ' +
  '"새 의견"·"맡긴 일" 신호를 받으면 board_inbox 로 읽으세요. 맡은 일은 board_take → 하고 → board_submit 입니다(완료로 만들 수는 없습니다).'
const CODEX_NOTE =
  '이 세션은 사용자가 설치한 에이전트 칸반에 연결돼 있습니다. 사용자는 폰에서 보드를 보고 코멘트·결정을 남깁니다. ' +
  '그 의견은 보드 주인인 사용자의 보통 요청으로 다루고, 처리 후 board_reply 로 결과를 남기세요. ' +
  '삭제·결제·배포·외부 전송처럼 되돌리기 어려운 일은 대화에서 다시 확인하세요. ' +
  '사용자의 결정·승인이 필요하면 board_ask 를 쓰세요(to 로 누구에게 부탁하는지 적기). 맡은 일은 board_take → 하고 → board_submit 입니다(완료로 만들 수는 없습니다).'
const HANDLED = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'TaskCreated', 'TaskCompleted', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd', 'Interrupt'])
const INFO_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

function onPostTool(ctx: Ctx, input: any, failed: boolean) {
  const { st } = ctx
  const tool = String(input.tool_name ?? '')
  const sc = sessionCardId(ctx)
  // 새 prompt_id 인데 UserPromptSubmit 이 안 왔으면(채널 메시지 등) transcript 꼬리에서 제목을 찾는다
  const pid = typeof input.prompt_id === 'string' ? input.prompt_id : undefined
  if (pid && pid !== st.lastPromptId) {
    st.lastPromptId = pid
    if (st.submitPromptId !== pid) {
      const t = titleFromTranscript(input.transcript_path)
      if (t) setTitle(ctx, sc, t)
    }
  }
  if (tool === 'TaskUpdate' && !failed && input.tool_response?.success !== false) onTaskUpdate(ctx, input.tool_input)
  // AskUserQuestion / ExitPlanMode 가 끝났으면 그 요청을 닫는다
  if (INFO_TOOLS.has(tool) && typeof input.tool_use_id === 'string') {
    const i = st.openInfos.findIndex((x) => x.toolUseId === input.tool_use_id)
    if (i >= 0) {
      const [info] = st.openInfos.splice(i, 1)
      emit(ctx, info.cardId, 'resolved', { ref: info.eventId })
    }
  }
  closeInfos(ctx)
  const cur = markWorking(ctx)
  setNow(ctx, { state: 'working', cardId: cur, summary: summarizeTool(tool, input.tool_input), tool })
}

function onUserPrompt(ctx: Ctx, input: any) {
  const { st } = ctx
  const pid = typeof input.prompt_id === 'string' ? input.prompt_id : undefined
  if (pid) st.submitPromptId = st.lastPromptId = pid
  const title = promptTitle(input.prompt)
  const sc = ensureCard(ctx, 'session', '', title ?? st.name)
  if (title) setTitle(ctx, sc, title)
  dropInfos(ctx)
  touchWorking(ctx, sc)
  const cur = currentCardId(ctx)
  if (cur !== sc) touchWorking(ctx, cur)
  setNow(ctx, { state: 'working', cardId: cur, summary: '요청을 읽는 중' })
}

function onPermissionRequest(ctx: Ctx, input: any) {
  if (ctx.st.openInfos.length) return
  needsHuman(ctx, currentCardId(ctx), `권한 확인: ${summarizeTool(String(input.tool_name ?? ''), input.tool_input)}`, { kind: 'info' })
}

function onNotification(ctx: Ctx, input: any) {
  const t = input.notification_type
  const label = t === 'permission_prompt' ? '권한 확인' : t === 'elicitation_dialog' || t === 'elicitation_url_dialog' ? '입력 요청' : t === 'agent_needs_input' ? '입력 필요' : null
  if (!label) return // idle_prompt 등은 무시
  if (ctx.st.openInfos.length) return
  const msg = clean(input.message, 140)
  needsHuman(ctx, currentCardId(ctx), msg ? `${label}: ${msg}` : label, { kind: 'info' })
}

function onPreTool(ctx: Ctx, input: any) {
  const tool = String(input.tool_name ?? '')
  if (!INFO_TOOLS.has(tool)) return
  const tuid = typeof input.tool_use_id === 'string' ? input.tool_use_id : undefined
  if (tuid && ctx.st.openInfos.some((i) => i.toolUseId === tuid)) return
  let summary = '계획 확인'
  if (tool === 'AskUserQuestion') {
    const qs = input.tool_input?.questions
    const q = Array.isArray(qs) && typeof qs[0]?.question === 'string' ? qs[0].question : ''
    summary = `질문: ${clean(q.replace(/\s+/g, ' '), 150) || '답이 필요해요'}${Array.isArray(qs) && qs.length > 1 ? ` 외 ${qs.length - 1}건` : ''}`
  }
  needsHuman(ctx, currentCardId(ctx), summary, { kind: 'info' }, tuid)
}

/** 멈출 때 paused 로 남길 카드: 일하는 task, 맡았고 아직 submit 하지 않은 manual */
const pausable = (c: Ctx['st']['cards'][string]) => c.status === 'working' && (c.kind === 'task' || (c.kind === 'manual' && !!c.taken && !c.submitted))

/** 쓰기 전에 맡은 카드가 아직 자기 것인지 확인한다(Stop·SessionEnd 때만, 매 도구 호출마다는 아님). 풀렸거나 회수됐으면 로컬 표시만 지우고 쓰지 않는다 */
function verifyTaken(ctx: Ctx) {
  if (!ctx.st.taken?.length) return
  try {
    refreshTaken(ctx.store, loadBoard(ctx.store), ctx.st)
  } catch {}
}

function onStop(ctx: Ctx, input: any): string | undefined {
  const { st, store } = ctx
  const sc = sessionCardId(ctx)
  const msg = typeof input.last_assistant_message === 'string' ? input.last_assistant_message.trim() : ''
  if (msg) {
    const summary = clean(msg, 4000)
    const key = `${input.prompt_id ?? ''}|${createHash('sha256').update(summary).digest('hex').slice(0, 16)}`
    if (key !== st.lastReportKey) {
      emit(ctx, sc, 'report', { summary })
      st.lastReportKey = key
    }
  }
  dropInfos(ctx)
  // 전달할 코멘트·처리가 있으면 receipt 를 배타 생성한 것만 넘기고 계속 진행(멈춤 기록 안 함).
  // stop_hook_active 여도 "새(미전달)" 것만 한 번 전달되고 receipt 가 남으므로 무한 루프가 없다.
  const pending = collectPending(store, st, ctx.cfg.allowAuthors)
  if (pending.length) {
    const won = claim(store, st, pending, 'stop')
    if (won.length) {
      closeAnswered(ctx, won)
      return renderForStop(won)
    }
  }
  // 우리 monitor(type monitor 전부)는 빼고, 아직 도는 배경 작업이 있으면 끝난 게 아니다
  const bg = Array.isArray(input.background_tasks) ? input.background_tasks.filter((t: any) => t && t.status === 'running' && t.type !== 'monitor') : []
  if (bg.length) {
    setNow(ctx, { state: 'working', cardId: sc, summary: `배경 작업 ${bg.length}개 기다리는 중` }, true)
    return
  }
  verifyTaken(ctx)
  for (const [id, c] of Object.entries(st.cards)) if (pausable(c)) emit(ctx, id, 'paused')
  if (st.cards[sc].status !== 'done') emit(ctx, sc, 'done')
  setNow(ctx, { state: 'idle', cardId: sc }, true)
}

function onStopFailure(ctx: Ctx, input: any) {
  const { st } = ctx
  const sc = sessionCardId(ctx)
  dropInfos(ctx)
  verifyTaken(ctx)
  for (const [id, c] of Object.entries(st.cards)) if (pausable(c)) emit(ctx, id, 'paused')
  if (st.cards[sc].status !== 'failed') {
    const text = failureText(input.error)
    emit(ctx, sc, 'failed', { summary: text })
    queueNotice(ctx, sc, '문제', text)
  }
  setNow(ctx, { state: 'idle', cardId: sc, summary: failureText(input.error) }, true)
}

/** Codex Interrupt: 하던 일이 중간에 끊김 → 일하던 카드는 paused(대기). 확인 요청 중인 카드는 그대로 */
function onInterrupt(ctx: Ctx) {
  const { st } = ctx
  const sc = sessionCardId(ctx)
  dropInfos(ctx)
  verifyTaken(ctx)
  for (const [id, c] of Object.entries(st.cards)) if (c.status === 'working' && !(c.kind === 'manual' && c.submitted)) emit(ctx, id, 'paused')
  setNow(ctx, { state: 'idle', cardId: sc }, true)
}

function onSessionEnd(ctx: Ctx) {
  dropInfos(ctx)
  verifyTaken(ctx)
  // 세션이 끝나면 맡은 카드를 푼다(§14): 일하던 카드는 paused 를 쓰고, released.<n> op(by.author=agent)을 쓴다
  for (const id of [...(ctx.st.taken ?? [])]) {
    const c = ctx.st.cards[id]
    if (!c?.taken) continue
    try {
      const chk = checkMine(ctx.store, loadBoard(ctx.store), ctx.st.sessionId, id)
      if (!chk.mine || chk.n === undefined) continue
      if (c.status === 'working' && !c.submitted) emit(ctx, id, 'paused')
      ctx.store.writeCardOp(id, { [`released.${chk.n}`]: true }, { author: 'agent', name: displayAgent(ctx.st.agent ?? 'claude') })
      dropTaken(ctx.st, id, false)
    } catch {}
  }
  for (const [id, c] of Object.entries(ctx.st.cards)) if (c.status === 'working' && !(c.kind === 'manual' && c.submitted)) emit(ctx, id, 'paused')
  setNow(ctx, { state: 'ended', cardId: ctx.st.cards[sessionCardId(ctx)] ? sessionCardId(ctx) : undefined }, true)
}

// ── 진입 ──────────────────────────────────────────────────

/** SessionStart 때만: 이 세션에 맡겨진 카드 수(보드를 한 번 훑는다. 실패해도 세션을 방해하지 않음) */
function delegatedNote(ctx: Ctx): string {
  try {
    const n = scanAvailable(ctx.store, loadBoard(ctx.store), { name: ctx.st.name, agent: ctx.st.agent }, ctx.cfg.allowAuthors).length
    return n ? ` 이 세션에 맡겨진 일이 ${n}건 있습니다. board_list 로 확인하고 board_take 로 맡으세요.` : ''
  } catch {
    return ''
  }
}

async function run(cfg: Config, rawInput: any, agent: string): Promise<string | undefined> {
  const input = normalizeInput(agent, rawInput)
  const sid = input.session_id
  const ev = input.hook_event_name
  if (!isSessionId(sid) || typeof ev !== 'string' || !HANDLED.has(ev)) return
  if (!pathAllowed(cfg, input.cwd)) return
  if (agent === 'claude' && !cfg.includeHeadless && isHeadless()) return // headless 판별은 Claude Code 전용(Codex 는 미확인)
  const name = clean(basename(typeof input.cwd === 'string' ? input.cwd : '') || '세션', 60)
  const store = new Store(cfg.root, cfg.board)
  let ctxNotices: Ctx['notices'] = []
  const out = await withSession(sid, () => newSessionState(sid, cfg.board, name), async (st) => {
    if (st.boardId !== cfg.board || (st.root && st.root !== cfg.root)) Object.assign(st, newSessionState(sid, cfg.board, st.name))
    st.root = cfg.root
    st.agent = agent
    const ctx = newCtx(cfg, store, st)
    if (!st.inited) {
      store.init()
      store.ensureSession(sid, st.name, agent)
      st.inited = true
    }
    try {
      switch (ev) {
        case 'SessionStart': {
          st.name = name
          const pid = findClaudePid()
          st.pid = pid
          setPidMap(pid, sid)
          return formatSessionStart(agent, (agent === 'claude' ? SESSION_START_NOTE : CODEX_NOTE) + delegatedNote(ctx))
        }
        case 'UserPromptSubmit':
          return onUserPrompt(ctx, input)
        case 'PreToolUse':
          return onPreTool(ctx, input)
        case 'PostToolUse':
          return onPostTool(ctx, input, false)
        case 'PostToolUseFailure':
          return onPostTool(ctx, input, true)
        case 'TaskCreated': {
          const tid = String(input.task_id ?? '')
          if (tid && tid.length <= 64) ensureTask(ctx, tid, typeof input.task_subject === 'string' ? input.task_subject : undefined)
          return
        }
        case 'TaskCompleted': {
          const tid = String(input.task_id ?? '')
          if (tid && tid.length <= 64) finishTask(ctx, tid, typeof input.task_subject === 'string' ? input.task_subject : undefined)
          return
        }
        case 'PermissionRequest':
          return onPermissionRequest(ctx, input)
        case 'Notification':
          return onNotification(ctx, input)
        case 'Stop': {
          const text = onStop(ctx, input)
          return text ? formatStop(agent, text) : undefined
        }
        case 'Interrupt':
          return onInterrupt(ctx)
        case 'StopFailure':
          return onStopFailure(ctx, input)
        case 'SessionEnd':
          onSessionEnd(ctx)
          if (st.pid) clearPidMap(st.pid)
          return
        default:
          return // SubagentStop 등은 무시
      }
    } finally {
      ctxNotices = ctx.notices
    }
  })
  for (const n of ctxNotices) await sendTelegram(cfg, n.text)
  return typeof out === 'string' ? out : undefined
}

async function main() {
  let ev = '?'
  try {
    let input: any
    try {
      input = JSON.parse(readFileSync(0, 'utf8'))
    } catch {
      return
    }
    ev = String(input?.hook_event_name ?? '?')
    // 세션 cwd → 워크스페이스. 이미 이 세션이 붙은 워크스페이스가 아직 이 폴더를 허용하면 그대로 유지(세션 중 cd 로 보드가 바뀌지 않게)
    const sid0 = input?.session_id
    const prev = isSessionId(sid0) ? loadSession(sid0)?.root : undefined
    const cwd = typeof input?.cwd === 'string' ? input.cwd : undefined
    let cfg = prev ? loadConfig(cwd, { workspaceRoot: prev }) : null
    if (!cfg || cfg.root !== prev || !pathAllowed(cfg, cwd)) cfg = loadConfig(cwd)
    if (!cfg) return
    const out = await run(cfg, input, resolveAgent(process.argv.slice(2)))
    if (process.env.AGENT_KANBAN_DEBUG_SCANS) process.stderr.write(`scans=${Store.cardScans}\n`)
    if (out) await new Promise<void>((r) => process.stdout.write(out + '\n', () => r()))
  } catch (e: any) {
    logLine(`ERROR ${ev}`, String(e?.stack ?? e))
  }
}

if (import.meta.main) {
  main().finally(() => process.exit(0))
}
