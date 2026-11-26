import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeInput, normalizeSessionId, resolveAgent, formatStop } from '../../src/kanban/core/agent.ts'
import { cardId } from '../../src/kanban/core/ids.ts'
import { allFilesText, appBoardOp, appComment, appManualCard, appTeam, boardDir, cards, PLUGIN, readJ, runHook, setup, SID, sleep, type Env } from './helpers.ts'

process.env.AGENT_KANBAN_NO_DOWNLOAD = '1'

const RAW = 'thr_01HZXABCDEF'
const CODEX_SID = normalizeSessionId('codex', RAW)!
const cbase = (extra: Record<string, any> = {}) => ({ session_id: RAW, transcript_path: null, cwd: '/Users/me/proj', model: 'gpt-x', permission_mode: 'default', ...extra })
const C = (e: Env, ev: string, extra: Record<string, any> = {}, env: Record<string, string> = { AGENT_KANBAN_AGENT: 'codex' }) => runHook(e, { ...cbase(), hook_event_name: ev, ...extra }, env)
const sc = cardId('session', CODEX_SID, '')

describe('agent 정규화 (순수)', () => {
  test('resolveAgent: --agent 인자 > 환경변수 > claude, 잘못된 이름은 claude', () => {
    expect(resolveAgent(['--agent', 'codex'], {})).toBe('codex')
    expect(resolveAgent(['--agent=gemini'], {})).toBe('gemini')
    expect(resolveAgent([], { AGENT_KANBAN_AGENT: 'codex' })).toBe('codex')
    expect(resolveAgent(['--agent', 'claude'], { AGENT_KANBAN_AGENT: 'codex' })).toBe('claude')
    expect(resolveAgent(['--agent', '../x'], {})).toBe('claude')
    expect(resolveAgent([], {})).toBe('claude')
  })
  test('세션 id: 형식이 맞으면 그대로, 아니면 sha256(agent|id) UUID 모양', () => {
    expect(normalizeSessionId('codex', SID)).toBe(SID)
    const a = normalizeSessionId('codex', 'thr_123')!
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(normalizeSessionId('codex', 'thr_123')).toBe(a)
    expect(normalizeSessionId('gemini', 'thr_123')).not.toBe(a)
    expect(normalizeSessionId('codex', '../../etc')).toMatch(/^[0-9a-f-]{36}$/)
    expect(normalizeSessionId('codex', '')).toBeNull()
  })
  test('Codex 입력: turn_id→prompt_id, apply_patch→Edit(패치 내용 버림)', () => {
    const o = normalizeInput('codex', { session_id: 'thr_1', turn_id: 't9', tool_name: 'apply_patch', tool_input: { command: 'SECRET_PATCH' } })
    expect(o.prompt_id).toBe('t9')
    expect(o.tool_name).toBe('Edit')
    expect(JSON.stringify(o.tool_input)).not.toContain('SECRET')
    expect(o.session_id).toBe(normalizeSessionId('codex', 'thr_1'))
    const c = { session_id: 'x_y', turn_id: 't' }
    expect(normalizeInput('claude', c)).toBe(c) // Claude Code 는 그대로
  })
  test('Stop 출력: Codex 는 decision block, Claude 는 additionalContext', () => {
    expect(JSON.parse(formatStop('codex', '글'))).toEqual({ decision: 'block', reason: '글' })
    expect(JSON.parse(formatStop('claude', '글'))).toEqual({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: '글' } })
  })
})

describe('Codex hook (--agent codex)', () => {
  test('흐름: 세션(agent=codex, 해시 id) · turn_id · apply_patch 내용 안 씀 · Stop 은 decision block · Interrupt 는 paused', async () => {
    const e = setup({})
    const ss = await C(e, 'SessionStart', { source: 'startup' })
    expect(JSON.parse(ss.stdout).hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(JSON.parse(ss.stdout).hookSpecificOutput.additionalContext).not.toContain('TaskCreate')
    expect(readJ(join(boardDir(e), 'sessions', CODEX_SID, 'session.json'))).toMatchObject({ id: CODEX_SID, name: 'proj', agent: 'codex' })
    await C(e, 'PostToolUse', { turn_id: 't1', tool_name: 'apply_patch', tool_use_id: 'u1', tool_input: { command: '*** Begin Patch\n*** Update File: /Users/me/proj/SECRET_FILE_BODY.swift\n+secret_patch_body' }, tool_response: 'OUT_MARKER' })
    expect(readJ(join(boardDir(e), 'sessions', CODEX_SID, 'now.json'))).toMatchObject({ state: 'working', summary: '파일 고치는 중', tool: 'Edit' })
    await C(e, 'PostToolUse', { turn_id: 't1', tool_name: 'Bash', tool_use_id: 'u2', tool_input: { command: 'cat ~/.ssh/id_rsa CMD_MARKER' }, tool_response: 'OUT_MARKER' })
    await C(e, 'UserPromptSubmit', { turn_id: 't1', prompt: '로그인 화면 고쳐 줘 제발' })
    const all = allFilesText(e.root)
    for (const bad of ['secret_patch_body', 'SECRET_FILE_BODY', 'CMD_MARKER', 'OUT_MARKER', '.ssh']) expect(all.includes(bad)).toBe(false)
    let cs = cards(e)
    expect(cs.length).toBe(1)
    expect(cs[0].id).toBe(sc)
    expect(cs[0].derived.list).toBe('working')
    // 권한 요청 → info
    await C(e, 'PermissionRequest', { turn_id: 't1', tool_name: 'Bash', tool_input: { command: 'rm -rf x', description: '정리' } })
    expect(cards(e)[0].derived.list).toBe('mine')
    // 사람 코멘트 → Stop 은 {"decision":"block","reason":…}
    appComment(e, sc, '버튼을 키워 주세요')
    const st = await C(e, 'Stop', { turn_id: 't1', stop_hook_active: false, last_assistant_message: '고쳤어요' })
    const out = JSON.parse(st.stdout)
    expect(Object.keys(out)).toEqual(['decision', 'reason'])
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('버튼을 키워 주세요')
    expect(out.reason).toContain('보통 요청')
    // 전달할 것이 없으면 Stop 은 출력 없음 + 세션 카드 완료
    const st2 = await C(e, 'Stop', { turn_id: 't1', stop_hook_active: true, last_assistant_message: '끝' })
    expect(st2.stdout).toBe('')
    expect(cards(e)[0].derived.list).toBe('done')
    // 새 턴 → 다시 일하다 Interrupt → paused(대기), now idle
    await C(e, 'UserPromptSubmit', { turn_id: 't2', prompt: '다른 걸 이어서 해 주세요' })
    expect(cards(e)[0].derived.list).toBe('working')
    const ir = await C(e, 'Interrupt', { turn_id: 't2' })
    expect(ir.stdout).toBe('')
    cs = cards(e)
    expect(cs[0].events.at(-1).type).toBe('paused')
    expect(cs[0].derived.list).toBe('waiting')
    expect(readJ(join(boardDir(e), 'sessions', CODEX_SID, 'now.json')).state).toBe('idle')
    // 모든 hook 은 exit 0
    expect((await C(e, 'SessionEnd', { reason: 'other' })).code).toBe(0)
  })
  test('--agent 인자도 같다 (환경변수 없이), 형식이 맞는 세션 id 는 그대로', async () => {
    const e = setup({})
    const p = Bun.spawn([process.execPath, join(PLUGIN, 'src/kanban/hook.ts'), '--agent', 'codex'], { env: e.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    p.stdin.write(JSON.stringify({ ...cbase({ session_id: SID }), hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: '인자로 agent 를 줍니다' }))
    p.stdin.end()
    await p.exited
    expect(readJ(join(boardDir(e), 'sessions', SID, 'session.json')).agent).toBe('codex')
  })
  test('Claude 기본은 agent=claude 로 session.json 에 적고, 모르는 이벤트는 무시', async () => {
    const e = setup({})
    const r = await runHook(e, { session_id: SID, cwd: '/Users/me/proj', hook_event_name: 'UserPromptSubmit', prompt_id: 'p', prompt: 'agent 기본값을 확인합니다' })
    expect(r.code).toBe(0)
    expect(readJ(join(boardDir(e), 'sessions', SID, 'session.json')).agent).toBe('claude')
    expect((await runHook(e, { session_id: SID, cwd: '/x', hook_event_name: 'Interrupt' })).stdout).toBe('') // Claude 에서도 Interrupt 는 조용히 paused 처리
  })
  test('Codex 세션의 맡긴 일: llm-codex 담당 카드는 codex 세션만', async () => {
    const e = setup({})
    await C(e, 'SessionStart', { source: 'startup' })
    appBoardOp(e, { 'member.u-minsu': { name: '민수', kind: 'human', rank: 0 } })
    appManualCard(e, { title: '코덱스 일', set: { 'assignee.llm-codex': true } })
    appManualCard(e, { title: '클로드 일', set: { 'assignee.llm-claude': true } })
    const r = await C(e, 'SessionStart', { source: 'resume' })
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('맡겨진 일이 1건')
  })
})

describe('hook 은 카드가 많아도 보드를 훑지 않는다', () => {
  test('카드 300장: SessionStart 만 한 번 훑고(맡긴 일 안내), 그 밖의 hook 은 0번', async () => {
    const e = setup({})
    await runHook(e, { session_id: SID, cwd: '/Users/me/proj', hook_event_name: 'SessionStart' }) // 폴더 준비
    appTeam(e)
    for (let i = 0; i < 300; i++) appManualCard(e, { title: `카드 ${i}`, set: { 'assignee.alpha': i % 2 === 0, 'label.l-dev': true } })
    const env = { AGENT_KANBAN_DEBUG_SCANS: '1' }
    const scans = (r: { stderr: string }) => Number(/scans=(\d+)/.exec(r.stderr)?.[1] ?? NaN)
    const send = (ev: string, extra: Record<string, any> = {}) => runHook(e, { session_id: SID, cwd: '/Users/me/proj', hook_event_name: ev, prompt_id: 'p1', ...extra }, env)
    const s = await send('SessionStart')
    expect(scans(s)).toBe(1)
    expect(JSON.parse(s.stdout).hookSpecificOutput.additionalContext).toContain('맡겨진 일이 150건')
    for (const [ev, x] of [
      ['UserPromptSubmit', { prompt: '카드가 많을 때도 빨라야 합니다' }],
      ['PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/a/b.ts' }, tool_response: {} }],
      ['PostToolUse', { tool_name: 'Bash', tool_input: { description: '빌드' }, tool_response: {} }],
      ['PermissionRequest', { tool_name: 'Bash', tool_input: {} }],
      ['Stop', { last_assistant_message: '끝', background_tasks: [] }],
    ] as const) {
      const r = await send(ev, x)
      expect(r.code).toBe(0)
      expect(scans(r)).toBe(0)
    }
    const ms: number[] = []
    for (let i = 0; i < 8; i++) ms.push((await send('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: `/a/${i}.ts` }, tool_response: {} })).ms)
    ms.sort((a, b) => a - b)
    console.log(`[카드 300장 hook 시간] PostToolUse 중앙값 ${ms[4].toFixed(0)}ms`)
    expect(ms[4]).toBeLessThan(500)
  })
})

describe('텔레그램: 담당 문구', () => {
  function fake() {
    const got: { body: any }[] = []
    const srv = Bun.serve({ port: 0, async fetch(req) { got.push({ body: await req.json().catch(() => null) }); return Response.json({ ok: true }) } })
    return { got, srv, base: `http://127.0.0.1:${srv.port}` }
  }
  const TOKEN = '987654321:AAFakeTokenFakeTokenFakeTokenFake123'
  test('사람 차례면 "담당: 민수, 지연", 미정이면 "담당: 미정"', async () => {
    const f = fake()
    const e = setup({ telegram: { enabled: true, chatId: '1', apiBase: f.base } }, { AGENT_KANBAN_TELEGRAM_TOKEN: TOKEN })
    const H = (ev: string, extra: Record<string, any> = {}) => runHook(e, { session_id: SID, cwd: '/Users/me/proj', hook_event_name: ev, prompt_id: 'p', ...extra })
    await H('SessionStart')
    await H('UserPromptSubmit', { prompt: '담당 문구를 확인합니다 정말로' })
    await H('PermissionRequest', { tool_name: 'Bash', tool_input: { description: '배포' } })
    expect(f.got[0].body.text).toContain('권한 확인: 배포')
    expect(f.got[0].body.text.endsWith('담당: 미정')).toBe(true) // 멤버·기본 담당이 없음
    appBoardOp(e, { 'member.u-minsu': { name: '민수', kind: 'human', rank: 0 }, 'member.u-jiyeon': { name: '지연', kind: 'human', rank: 1 } })
    // 세션 카드에 사람 담당을 붙이면 문구에 나온다
    const sess = cardId('session', SID, '')
    const { appCardOp } = await import('./helpers.ts')
    appCardOp(e, sess, { 'assignee.u-minsu': true, 'assignee.u-jiyeon': true })
    await H('StopFailure', { error: 'rate_limit' })
    expect(f.got[1].body.text).toContain('사용량 한도')
    expect(f.got[1].body.text.endsWith('담당: 민수, 지연')).toBe(true)
    await sleep(10)
    f.srv.stop(true)
    void existsSync
    void readdirSync
  })
})
