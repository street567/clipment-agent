// 여러 LLM (SPEC §15): agent 이름·세션 id 정규화, Codex hook 입력/출력 정리 (순수 함수)
import { createHash } from 'node:crypto'
import { agentName } from './team.ts'
import { isSessionId } from './ids.ts'

export const AGENT_RE = /^[a-z0-9-]{1,20}$/

/** `--agent X` 인자 → AGENT_KANBAN_AGENT → claude. 잘못된 이름은 claude */
export function resolveAgent(argv: string[], env: Record<string, string | undefined> = process.env): string {
  let v: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent') v = argv[i + 1]
    else if (argv[i].startsWith('--agent=')) v = argv[i].slice(8)
  }
  v = (v ?? env.AGENT_KANBAN_AGENT ?? '').trim().toLowerCase()
  return AGENT_RE.test(v) ? v : 'claude'
}

/** LLM 이 준 세션 id 를 쓰되 형식이 다르면 sha256(agent|원래 id) 로 만든 UUID 모양 */
export function normalizeSessionId(agent: string, raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 500) return null
  if (isSessionId(raw)) return raw
  const h = createHash('sha256').update(`${agent}|${raw}`).digest('hex').slice(0, 32)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

export const displayAgent = (agent: string) => agentName(agent)

const CODEX_TOOL: Record<string, string> = { apply_patch: 'Edit', spawn_agent: 'Agent' }

/** Codex hook 입력을 Claude Code 모양으로: turn_id→prompt_id, apply_patch→Edit(패치 내용은 버림), session_id 정규화 */
export function normalizeInput(agent: string, input: any): any {
  if (!input || typeof input !== 'object' || agent === 'claude') return input // Claude Code 는 id 를 그대로(형식이 다르면 hook 이 무시)
  const out: any = { ...input }
  if (typeof out.session_id === 'string' || typeof out.session_id === 'number') {
    const n = normalizeSessionId(agent, String(out.session_id))
    if (n) out.session_id = n
  }
  if (agent === 'codex') {
    if (typeof out.prompt_id !== 'string' && typeof out.turn_id === 'string') out.prompt_id = out.turn_id
    const t = typeof out.tool_name === 'string' ? out.tool_name : ''
    if (CODEX_TOOL[t]) {
      out.tool_name = CODEX_TOOL[t]
      if (t === 'apply_patch') out.tool_input = {} // 패치(파일 내용)는 쓰지 않는다
      else if (t === 'spawn_agent') out.tool_input = {}
    }
    // Codex 의 tool_input.command 는 명령 내용이라 요약에 쓰지 않는다 (Bash 는 description 만 사용)
  }
  return out
}

/** Stop 에서 전달할 글을 agent 별 출력으로. Codex 는 {"decision":"block","reason":…} 로 이어 감 */
export function formatStop(agent: string, text: string): string {
  if (agent === 'codex') return JSON.stringify({ decision: 'block', reason: text })
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: text } })
}
export function formatSessionStart(_agent: string, text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })
}
