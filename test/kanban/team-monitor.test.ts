import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { cardId } from '../../src/kanban/core/ids.ts'
import { Store } from '../../src/kanban/core/store.ts'
import { appBoardOp, appCardOp, appManualCard, appTeam, base, boardDir, PLUGIN, runHook, SID, setup, sleep, type Env } from './helpers.ts'

process.env.AGENT_KANBAN_NO_DOWNLOAD = '1'
const H = (e: Env, ev: string, extra: Record<string, any> = {}) => runHook(e, { ...base(), hook_event_name: ev, ...extra })

const procs: any[] = []
afterEach(() => {
  while (procs.length) procs.pop().kill()
})
function monitor(e: Env, extra: Record<string, string> = {}) {
  const p = Bun.spawn([process.execPath, join(PLUGIN, 'src/kanban/monitor.ts')], { env: { ...e.env, CLAUDE_PID: String(process.pid), CLAUDE_CODE_SESSION_ID: SID, ...extra }, stdout: 'pipe', stderr: 'pipe' })
  procs.push(p)
  const lines: string[] = []
  const errs: string[] = []
  const pump = async (stream: any, into: string[]) => {
    let buf = ''
    const dec = new TextDecoder()
    for await (const chunk of stream) {
      buf += dec.decode(chunk)
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        into.push(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    }
  }
  pump(p.stdout, lines)
  pump(p.stderr, errs)
  return { p, lines, errs }
}
const until = async (f: () => boolean, ms = 4000) => {
  const t0 = Date.now()
  while (!f() && Date.now() - t0 < ms) await sleep(30)
  return f()
}
const cfg = { monitor: { intervalSec: 0.2, busyDelaySec: 0 } }
async function idleSession(e: Env) {
  await H(e, 'SessionStart', { source: 'startup' })
  await H(e, 'UserPromptSubmit', { prompt_id: 'p1', prompt: '로그인 화면 고쳐 줘' })
  await H(e, 'Stop', { last_assistant_message: '끝', background_tasks: [{ id: 'm', type: 'monitor', status: 'running' }] })
}
const SIGNAL = '[에이전트 칸반] 맡긴 일 1건 — board_inbox 도구로 읽고 board_take 로 맡으세요'

describe('monitor: 맡긴 일 신호', () => {
  test('project 멤버에게 맡긴 카드: 신호 한 줄(본문·제목 없음), receipt 없음, 맡으면 멈춤', async () => {
    const e = setup(cfg)
    await idleSession(e)
    appTeam(e)
    const m = monitor(e)
    await sleep(500)
    expect(m.lines).toEqual([])
    const id = appManualCard(e, { title: '비밀스러운 제목', detail: '비밀 설명', set: { 'assignee.alpha': true } })
    expect(await until(() => m.lines.length >= 1)).toBe(true)
    await sleep(800)
    expect(m.lines).toEqual([SIGNAL])
    expect(m.lines.join('')).not.toContain('비밀')
    expect(existsSync(join(boardDir(e), 'cards', id, 'receipts'))).toBe(false)
    // 맡으면 더 이상 신호 없음 (다른 카드가 새로 오면 그것만)
    new Store(e.root, e.board).writeTake(id, SID, null)
    const id2 = appManualCard(e, { title: '둘째', set: { 'assignee.alpha': true } })
    expect(await until(() => m.lines.length >= 2)).toBe(true)
    expect(m.lines[1]).toBe(SIGNAL)
    void id2
  })
  test('안 맡으면 다시 신호(최대 3회)', async () => {
    const e = setup(cfg)
    await idleSession(e)
    appTeam(e)
    appManualCard(e, { title: '안 맡는 카드', set: { 'assignee.alpha': true } })
    const m = monitor(e, { AGENT_KANBAN_RESIGNAL_MS: '500' })
    expect(await until(() => m.lines.length >= 3, 6000)).toBe(true)
    await sleep(1500)
    expect(m.lines.length).toBe(3)
  })
  test('공용 llm-<agent> 에 맡긴 카드·project 가 다른 멤버·사람 담당·에이전트가 만든 카드는 신호 없음', async () => {
    const e = setup(cfg)
    await idleSession(e)
    appTeam(e, { 'member.alpha': { name: '알파', kind: 'llm', agent: 'claude', project: 'zzz', rank: 2 } }) // 이 세션(proj)은 공용 llm-claude
    appManualCard(e, { title: '공용', set: { 'assignee.llm-claude': true } })
    appManualCard(e, { title: '알파 일', set: { 'assignee.alpha': true } })
    appManualCard(e, { title: '사람 일', set: { 'assignee.u-jiyeon': true } })
    appManualCard(e, { title: '에이전트가 만듦', by: { author: 'agent', name: 'Claude' }, set: { 'assignee.llm-claude': true } })
    const m = monitor(e)
    await sleep(1500)
    expect(m.lines).toEqual([])
  })
  test('project 세션도 공용 llm-<agent> 담당 카드는 맡을 수 있지만 신호는 없다', async () => {
    const e = setup(cfg)
    await idleSession(e)
    appTeam(e) // 이 세션(proj)은 project 멤버 알파
    appManualCard(e, { title: '공용', set: { 'assignee.llm-claude': true } })
    const m = monitor(e)
    await sleep(1200)
    expect(m.lines).toEqual([])
  })
  test('끝난 카드·보관한 카드는 신호 없음, 멤버가 나중에 바뀌면(보드 op) 반영', async () => {
    const e = setup(cfg)
    await idleSession(e)
    appTeam(e)
    const done = appManualCard(e, { title: '끝', set: { 'assignee.alpha': true, state: 'done' } })
    const arch = appManualCard(e, { title: '보관', set: { 'assignee.alpha': true, archived: true } })
    const m = monitor(e)
    await sleep(1000)
    expect(m.lines).toEqual([])
    appCardOp(e, done, { state: 'waiting' })
    expect(await until(() => m.lines.length >= 1)).toBe(true)
    appCardOp(e, arch, { archived: null })
    expect(await until(() => m.lines.length >= 2)).toBe(true)
    appBoardOp(e, { 'member.alpha': null })
    void arch
  })
  test('카드가 많아도 한가한 틱에는 카드를 다시 읽지 않고, 바뀐 카드만 읽는다', async () => {
    const e = setup(cfg)
    await idleSession(e)
    appTeam(e)
    const ids: string[] = []
    for (let i = 0; i < 120; i++) ids.push(appManualCard(e, { title: `카드 ${i}`, set: { 'assignee.u-jiyeon': true } }))
    const m = monitor(e, { AGENT_KANBAN_DEBUG_SCANS: '1' })
    const tick = (s: string) => ({ scans: Number(/scans=(\d+)/.exec(s)![1]), reads: Number(/reads=(\d+)/.exec(s)![1]) })
    expect(await until(() => m.errs.length >= 3)).toBe(true)
    const a = tick(m.errs.at(-1)!)
    expect(a.scans).toBe(1)
    expect(a.reads).toBeGreaterThanOrEqual(120)
    await sleep(900)
    const b = tick(m.errs.at(-1)!)
    expect(m.errs.length).toBeGreaterThan(4)
    expect(b).toEqual(a) // 한가한 틱: 카드 읽기 없음, 폴더 훑기 없음
    appCardOp(e, ids[7], { 'assignee.alpha': true }) // 카드 하나만 바뀜
    expect(await until(() => m.lines.length >= 1)).toBe(true)
    await sleep(500)
    const c = tick(m.errs.at(-1)!)
    expect(c.scans).toBe(1)
    expect(c.reads - a.reads).toBeLessThanOrEqual(2)
    expect(cardId('session', SID, '')).toBeTruthy()
  })
})
