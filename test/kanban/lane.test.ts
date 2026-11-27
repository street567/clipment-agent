import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { loadAllConfig } from '../../src/kanban/config.ts'
import { derive } from '../../src/kanban/core/derive.ts'
import { agentKeyOf, detectLane, laneCardId, machineId, resolveMachineName, sanitizeLabel, tmuxSessionName } from '../../src/kanban/core/lane.ts'
import { kanbanStatus, setMachine, setupKanban } from '../../src/kanban/setup.ts'
import { appComment, base, boardDir, cards, PLUGIN, readJ, runHook, SPEC, setup, sleep, type Env } from './helpers.ts'

process.env.AGENT_KANBAN_NO_DOWNLOAD = '1'
const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const C = 'cccccccc-0000-4000-8000-000000000003'
const TG = (name: string) => ({ TELEGRAM_STATE_DIR: `/home/u/.claude/channels/${name}` })
const H = (e: Env, sid: string, ev: string, extra: Record<string, any> = {}, env: Record<string, string> = {}) => runHook(e, { ...base(sid), hook_event_name: ev, ...extra }, env)
const start = async (e: Env, sid: string, env: Record<string, string> = {}, prompt = '로그인 화면 고쳐 줘') => {
  await H(e, sid, 'SessionStart', { source: 'startup' }, env)
  await H(e, sid, 'UserPromptSubmit', { prompt_id: 'p-' + sid.slice(0, 4), prompt }, env)
}
const keyOf = (e: Env, lane: string) => agentKeyOf(readJ(join(e.state, 'machine.json')).id, lane, e.root)
const sessionCards = (e: Env) => cards(e).filter((c) => c.card.kind === 'session')

/** 이 프로세스의 환경변수를 잠깐 바꿔 쓰는 단위 테스트용 */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
  try {
    return fn()
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

describe('컴퓨터 이름', () => {
  test('sanitize: 공백 정리 · 40자 · 경로 구분자 제거 · 제어문자 제거', () => {
    expect(sanitizeLabel('  맥 미니  ')).toBe('맥 미니')
    expect(sanitizeLabel('a/b\\c')).toBe('abc')
    expect(sanitizeLabel('x'.repeat(100))).toHaveLength(40)
    expect(sanitizeLabel('줄\n바꿈\t탭')).toBe('줄 바꿈 탭')
    expect(sanitizeLabel('///')).toBe('')
    expect(sanitizeLabel(undefined)).toBe('')
  })
  test('기본값: 설정 → ComputerName → hostname(.local 제거) → 마지막 대비', () => {
    expect(resolveMachineName('설정이름', () => 'CN')).toEqual({ name: '설정이름', source: 'config' })
    if (process.platform === 'darwin') {
      expect(resolveMachineName(undefined, () => 'Mac Mini')).toEqual({ name: 'Mac Mini', source: 'computername' })
      expect(resolveMachineName(undefined, () => null, () => 'box.local')).toEqual({ name: 'box', source: 'hostname' })
    }
    expect(resolveMachineName(undefined, () => null, () => 'box.local').name).toBe('box')
    expect(resolveMachineName(undefined, () => null, () => '').source).toBe('fallback')
  })
  test('setMachine: 보기 · 정하기(백업) · 정리 · 같은 이름 · 깨진 설정 거부', () => {
    const e = setup({})
    withEnv({ AGENT_KANBAN_CONFIG: e.cfgPath }, () => {
      const shown = setMachine({})
      expect(shown.result).toBe('shown')
      expect(shown.name).toBeTruthy()
      const r = setMachine({ name: '  맥/미니  ' })
      expect(r).toMatchObject({ ok: true, result: 'set', name: '맥미니', source: 'config' })
      expect(r.backup).toBe(e.cfgPath + '.bak')
      expect(existsSync(r.backup!)).toBe(true)
      expect(readJ(e.cfgPath)).toMatchObject({ enabled: true, machineName: '맥미니' }) // 다른 설정은 그대로
      expect(setMachine({}).configured).toBe('맥미니')
      expect(setMachine({ name: '맥미니' }).result).toBe('unchanged')
      expect(setMachine({ name: ' / ' }).ok).toBe(false)
      expect(loadAllConfig()!.machineName).toBe('맥미니')
      writeFileSync(e.cfgPath, '{깨짐')
      expect(setMachine({ name: 'x' }).ok).toBe(false)
      expect(readFileSync(e.cfgPath, 'utf8')).toBe('{깨짐')
    })
  })
  test('설정이 없어도 정할 수 있고(칸반은 꺼진 채), 이어서 kanban_setup 이 거부 없이 이름을 보존한다', () => {
    const e = setup(null as any)
    withEnv({ AGENT_KANBAN_CONFIG: e.cfgPath }, () => {
      expect(setMachine({ name: '노트북' })).toMatchObject({ ok: true, result: 'set' })
      expect(loadAllConfig()).toBeNull() // 아직 꺼짐
      expect(kanbanStatus().machine?.name).toBe('노트북')
      expect(kanbanStatus().configured).toBe(false)
      const r = setupKanban({ root: e.root })
      expect(r).toMatchObject({ ok: true, result: 'created' })
      expect(readJ(e.cfgPath)).toMatchObject({ enabled: true, machineName: '노트북' })
      expect(loadAllConfig()!.machineName).toBe('노트북')
    })
  })
})

describe('레인 감지 순서', () => {
  const none = () => null
  test('(a) 환경변수가 가장 먼저', () => {
    expect(detectLane({ env: { AGENT_KANBAN_LANE: 'mine', ...TG('telegram-core'), TMUX: '1' }, tmux: () => 'cam-x', cwd: '/p/proj' })).toEqual({ lane: 'mine', source: 'env' })
  })
  test('(b) 텔레그램 상태 폴더: telegram-<x> → x, telegram → telegram, 슬래시 끝·그 밖 이름', () => {
    expect(detectLane({ env: TG('telegram-core'), tmux: () => 'cam-x', cwd: '/p/proj' })).toEqual({ lane: 'core', source: 'telegram' })
    expect(detectLane({ env: { TELEGRAM_STATE_DIR: '/a/b/telegram/' }, cwd: '/p/proj' })).toEqual({ lane: 'telegram', source: 'telegram' })
    expect(detectLane({ env: TG('alpha-bot'), cwd: '/p/proj' })).toEqual({ lane: 'alpha-bot', source: 'telegram' })
  })
  test('(c) tmux 세션 이름: 접두어 제거 · 숫자만 있는 기본 이름은 무시 · $TMUX 없으면 안 부름', () => {
    expect(detectLane({ env: { TMUX: '/tmp/x,1,0' }, tmux: () => 'cam-core', stripPrefixes: ['cam-'], cwd: '/p/proj' })).toEqual({ lane: 'core', source: 'tmux' })
    expect(detectLane({ env: { TMUX: '1' }, tmux: () => 'cam-core', cwd: '/p/proj' })).toEqual({ lane: 'cam-core', source: 'tmux' })
    expect(detectLane({ env: { TMUX: '1' }, tmux: () => '0', cwd: '/p/proj' })).toEqual({ lane: 'proj', source: 'folder' })
    expect(detectLane({ env: { TMUX: '1' }, tmux: () => 'cam-', stripPrefixes: ['cam-'], cwd: '/p/proj' })).toEqual({ lane: 'cam-', source: 'tmux' }) // 접두어만 있는 이름은 그대로
    let called = false
    expect(detectLane({ env: {}, tmux: () => { called = true; return 'x' }, cwd: '/p/proj' })?.source).toBe('folder')
    expect(called).toBe(false)
    expect(tmuxSessionName({}, () => 'x')).toBeNull()
    expect(tmuxSessionName({ TMUX: '1', TMUX_PANE: '%3' }, (_c, a) => a.join(' '))).toBe('display -p -t %3 #S')
  })
  test('(d) 작업 폴더 이름(이어지지 않음) · 아무것도 없으면 null', () => {
    expect(detectLane({ env: {}, tmux: none, cwd: '/Users/me/zippy-react' })).toEqual({ lane: 'zippy-react', source: 'folder' })
    expect(detectLane({ env: {}, tmux: none })).toBeNull()
  })
})

describe('agentKey · 카드 id', () => {
  test('컴퓨터 이름을 바꿔도 같은 키(machineId 는 이름과 무관), 레인·root 가 다르면 다른 키', () => {
    const e = setup({ machineName: '맥미니' })
    const id = withEnv({ AGENT_KANBAN_STATE: e.state }, () => machineId())
    expect(withEnv({ AGENT_KANBAN_STATE: e.state }, () => machineId())).toBe(id) // 저장돼 안정적
    const k1 = agentKeyOf(id, 'core', '/r')
    writeFileSync(e.cfgPath, JSON.stringify({ enabled: true, root: e.root, machineName: '새 이름' }))
    expect(agentKeyOf(id, 'core', '/r')).toBe(k1)
    expect(agentKeyOf(id, 'alpha', '/r')).not.toBe(k1)
    expect(agentKeyOf(id, 'core', '/r2')).not.toBe(k1)
    const e2 = setup({})
    expect(withEnv({ AGENT_KANBAN_STATE: e2.state }, () => machineId())).not.toBe(id) // 다른 컴퓨터
    expect(k1).toMatch(/^[0-9a-f]{32}$/)
  })
  test('계약 fixtures/lane.json 의 벡터와 일치', () => {
    const v = readJ(join(SPEC, 'fixtures/lane.json'))
    const k = agentKeyOf(v.machineId, v.lane, v.root)
    expect(k).toBe(v.agentKey)
    expect(laneCardId(k)).toBe(v.cardId)
  })
})

describe('이어지는 세션 카드 (hook)', () => {
  test('재시작: 같은 컴퓨터·레인의 새 세션은 같은 카드에 이어지고 replaced 이벤트·이전 세션 종료 표시·전달', async () => {
    const e = setup({ machineName: '맥미니' })
    const env = TG('telegram-core')
    await start(e, A, env)
    await H(e, A, 'Stop', { last_assistant_message: '1차 보고', background_tasks: [] }, env)
    const key = keyOf(e, 'core')
    const LC = laneCardId(key)
    expect(sessionCards(e).map((c) => c.id)).toEqual([LC])
    // 사람이 두 세션 사이(재시작 중)에 코멘트를 남긴다
    const cm = appComment(e, LC, '재시작 사이에 남긴 의견')
    // 재시작: 새 세션 B
    await H(e, B, 'SessionStart', { source: 'startup' }, env)
    const cs = sessionCards(e)
    expect(cs.length).toBe(1) // 카드는 하나
    const lc = cs[0]
    expect(lc.id).toBe(LC)
    expect(lc.card).toMatchObject({ kind: 'session', title: '맥미니 · core', lane: 'core', machine: '맥미니', agentKey: key, sessionId: A })
    const rep = lc.events.filter((x) => x.type === 'replaced')
    expect(rep.length).toBe(1)
    expect(rep[0]).toMatchObject({ sessionId: B, from: A, summary: '새 세션으로 이어짐' })
    expect(lc.events.some((x) => x.sessionId === A && x.type === 'report')).toBe(true) // 옛 기록 유지
    expect(derive(lc.events, lc.actions).list).toBe('done') // replaced 는 상태를 바꾸지 않음(A 는 Stop 으로 done)
    // 이전 세션은 끝난 것으로
    expect(readJ(join(boardDir(e), 'sessions', A, 'now.json'))).toMatchObject({ state: 'ended', replacedBy: B })
    expect(readJ(join(boardDir(e), 'sessions', B, 'now.json'))).toMatchObject({ state: 'idle', cardId: LC })
    expect(readJ(join(boardDir(e), 'sessions', B, 'session.json'))).toMatchObject({ machine: '맥미니', lane: 'core', agentKey: key })
    // B 의 첫 프롬프트: 같은 카드가 일하는 중. 제목은 고정
    await H(e, B, 'UserPromptSubmit', { prompt_id: 'pb', prompt: '다음 요청입니다' }, env)
    expect(sessionCards(e).length).toBe(1)
    expect(sessionCards(e)[0].card.title).toBe('맥미니 · core')
    expect(derive(sessionCards(e)[0].events, []).list).toBe('working')
    expect(derive(sessionCards(e)[0].events, []).title).toBeUndefined() // 프롬프트로 제목이 바뀌지 않음
    // 재시작 사이의 코멘트는 B 가 받는다(A 가 아님)
    const r = await H(e, B, 'Stop', { last_assistant_message: '2차', background_tasks: [] }, env)
    expect(r.stdout).toContain('재시작 사이에 남긴 의견')
    const rc = readJ(join(boardDir(e), 'cards', LC, 'receipts', `${cm}.json`))
    expect(rc.sessionId).toBe(B)
    // B 가 받은 뒤 다시 C 로 재시작해도 한 장, replaced 가 쌓인다
    await H(e, C, 'SessionStart', { source: 'startup' }, env)
    expect(sessionCards(e).length).toBe(1)
    expect(sessionCards(e)[0].events.filter((x) => x.type === 'replaced').map((x) => x.from)).toEqual([A, B])
  })
  test('같은 세션 id 를 다시 열어도(resume) replaced 를 쓰지 않는다', async () => {
    const e = setup({ machineName: '맥미니' })
    await start(e, A, TG('telegram-core'))
    await H(e, A, 'SessionStart', { source: 'resume' }, TG('telegram-core'))
    expect(sessionCards(e)[0].events.filter((x) => x.type === 'replaced').length).toBe(0)
  })
  test('컴퓨터 이름을 바꿔도 같은 카드, 새 세션부터 새 이름', async () => {
    const e = setup({ machineName: '맥미니' })
    const env = TG('telegram-core')
    await start(e, A, env)
    writeFileSync(e.cfgPath, JSON.stringify({ enabled: true, root: e.root, machineName: '서재 맥' }))
    await start(e, B, env, '다음 일')
    expect(sessionCards(e).length).toBe(1)
    const c = sessionCards(e)[0]
    expect(c.card.title).toBe('맥미니 · core') // card.json 은 불변
    expect(derive(c.events, []).title).toBe('서재 맥 · core') // 제목 이벤트로 바뀜
    expect(readJ(join(boardDir(e), 'sessions', B, 'session.json')).machine).toBe('서재 맥')
  })
  test('tmux 레인(PATH 의 가짜 tmux) + laneStripPrefixes', async () => {
    const e = setup({ machineName: '맥미니', laneStripPrefixes: ['cam-'] })
    const bin = join(e.dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'tmux'), '#!/bin/sh\necho cam-core\n')
    chmodSync(join(bin, 'tmux'), 0o755)
    const env = { TMUX: '/tmp/tmux-1/default,1,0', TMUX_PANE: '%1', PATH: `${bin}:${e.env.PATH}` }
    await start(e, A, env)
    await start(e, B, env)
    const cs = sessionCards(e)
    expect(cs.length).toBe(1)
    expect(cs[0].card).toMatchObject({ lane: 'core', title: '맥미니 · core' })
  })
  test('레인이 다르면 다른 카드, 환경변수 레인이 텔레그램보다 먼저', async () => {
    const e = setup({ machineName: '맥미니' })
    await start(e, A, TG('telegram-core'))
    await start(e, B, TG('telegram-alpha'))
    await start(e, C, { ...TG('telegram-core'), AGENT_KANBAN_LANE: 'x' })
    expect(sessionCards(e).map((c) => c.card.lane).sort()).toEqual(['alpha', 'core', 'x'])
  })
  test('레인 없음(폴더만): 같은 폴더의 병렬 세션은 세션별 카드로 따로, 이어지지 않는다', async () => {
    const e = setup({ machineName: '맥미니' })
    await start(e, A)
    await start(e, B)
    const cs = sessionCards(e)
    expect(cs.length).toBe(2)
    expect(cs.every((c) => !c.card.agentKey && !c.events.some((x) => x.type === 'replaced'))).toBe(true)
    // 표시용으로 machine · lane(폴더)만 session.json 에
    expect(readJ(join(boardDir(e), 'sessions', A, 'session.json'))).toMatchObject({ name: 'proj', machine: '맥미니', lane: 'proj' })
    expect(readJ(join(boardDir(e), 'sessions', A, 'session.json')).agentKey).toBeUndefined()
    expect(existsSync(join(e.state, 'lanes'))).toBe(false)
  })
  test('같은 레인에 두 세션이 동시에 살아 있으면: 가장 새로운 세션이 이기고 옛 세션은 별도 카드·경고, 전달은 새 세션에만', async () => {
    const e = setup({ machineName: '맥미니', monitor: { intervalSec: 0.2, busyDelaySec: 0 } })
    const env = TG('telegram-core')
    await start(e, A, env)
    await start(e, B, env) // A 는 아직 살아 있음(SessionEnd 없음)
    const LC = laneCardId(keyOf(e, 'core'))
    const comment = appComment(e, LC, '동시 실행 중 의견')
    // 옛 세션 A 가 일을 계속한다 → 밀려남
    await H(e, A, 'PostToolUse', { prompt_id: 'p-aaaa', tool_name: 'Edit', tool_input: { file_path: '/p/a.ts' }, tool_response: {} }, env)
    const stA = readJ(join(e.state, 'sessions', `${A}.json`))
    expect(stA.lane).toMatchObject({ superseded: true, replacedBy: B })
    expect(stA.cards[LC]).toBeUndefined()
    const ra = await H(e, A, 'Stop', { last_assistant_message: 'A 보고', background_tasks: [] }, env)
    expect(ra.stdout).toBe('') // A 는 받지 않는다
    const cs = sessionCards(e)
    expect(cs.length).toBe(2) // 레인 카드 + A 의 별도 세션 카드
    const lc = cs.find((c) => c.id === LC)!
    expect(lc.events.filter((x) => x.sessionId === A && x.type !== 'created' && x.type !== 'progress' && x.type !== 'report' && x.type !== 'done').length).toBe(0)
    expect(lc.events.some((x) => x.sessionId === A && x.created > lc.events.find((y) => y.type === 'replaced')!.created)).toBe(false) // 밀려난 뒤 A 는 레인 카드에 쓰지 않음
    const rb = await H(e, B, 'Stop', { last_assistant_message: 'B 보고', background_tasks: [] }, env)
    expect(rb.stdout).toContain('동시 실행 중 의견')
    expect(readJ(join(boardDir(e), 'cards', LC, 'receipts', `${comment}.json`)).sessionId).toBe(B)
    // 상태 경고: kanban_status 쪽 정보(로컬 상태) + 감시가 한 번 알림
    const m = Bun.spawn([process.execPath, join(PLUGIN, 'src/kanban/monitor.ts')], { env: { ...e.env, CLAUDE_PID: String(process.pid), CLAUDE_CODE_SESSION_ID: A }, stdout: 'pipe', stderr: 'ignore' })
    const out: string[] = []
    ;(async () => { for await (const ch of m.stdout as any) out.push(new TextDecoder().decode(ch)) })()
    const t0 = Date.now()
    while (!out.join('').includes('더 새로운 세션') && Date.now() - t0 < 5000) await sleep(50)
    await sleep(700)
    m.kill()
    expect(out.join('').match(/더 새로운 세션/g)?.length).toBe(1)
  })
  test('감시(monitor): 재시작한 새 세션이 레인 카드의 코멘트 신호를 받는다', async () => {
    const e = setup({ machineName: '맥미니', monitor: { intervalSec: 0.2, busyDelaySec: 0 } })
    const env = TG('telegram-core')
    await start(e, A, env)
    await H(e, A, 'Stop', { last_assistant_message: '끝', background_tasks: [{ id: 'm', type: 'monitor', status: 'running' }] }, env)
    await start(e, B, env)
    await H(e, B, 'Stop', { last_assistant_message: '끝', background_tasks: [{ id: 'm', type: 'monitor', status: 'running' }] }, env)
    const LC = laneCardId(keyOf(e, 'core'))
    const mon = (sid: string) => {
      const p = Bun.spawn([process.execPath, join(PLUGIN, 'src/kanban/monitor.ts')], { env: { ...e.env, CLAUDE_PID: String(process.pid), CLAUDE_CODE_SESSION_ID: sid }, stdout: 'pipe', stderr: 'ignore' })
      const out: string[] = []
      ;(async () => { for await (const ch of p.stdout as any) out.push(new TextDecoder().decode(ch)) })()
      return { p, out }
    }
    const mb = mon(B)
    await sleep(500)
    appComment(e, LC, '새 세션에게')
    const t0 = Date.now()
    while (!mb.out.join('').includes('새 의견 1건') && Date.now() - t0 < 5000) await sleep(50)
    mb.p.kill()
    expect(mb.out.join('')).toContain('새 의견 1건')
    // 옛 세션 A 는 레인 카드를 받지 않는다(밀려남 경고만)
    const ma = mon(A)
    await sleep(1500)
    ma.p.kill()
    expect(ma.out.join('')).not.toContain('새 의견')
  })
  test('옛 계약(1.1) 필드만 읽는 앱: 레인 카드·세션·이벤트가 1.1 필수 필드를 갖고 derive 가 같다', async () => {
    const e = setup({ machineName: '맥미니' })
    await start(e, A, TG('telegram-core'))
    await start(e, B, TG('telegram-core'))
    const c = sessionCards(e)[0]
    // 1.1 카드 필수: id kind title created / 1.1 이벤트 필수: id cardId sessionId type created / 세션: id
    expect(c.card).toMatchObject({ kind: 'session' })
    for (const k of ['id', 'kind', 'title', 'created']) expect(c.card[k]).toBeTruthy()
    for (const ev of c.events) for (const k of ['id', 'cardId', 'sessionId', 'type', 'created']) expect(ev[k]).toBeTruthy()
    // 모르는 type(replaced)을 걸러낸 1.1 리더의 결과와 같다
    expect(derive(c.events.filter((x) => x.type !== 'replaced'), c.actions)).toEqual(derive(c.events, c.actions))
    expect(readJ(join(e.root, 'kanban.json')).contract).toBe('1.2')
    expect(Number(readJ(join(e.root, 'kanban.json')).contract.split('.')[0])).toBe(Number(readJ(join(SPEC, 'contract.json')).minReaderMajor)) // MAJOR 동일 → 읽기 전용 아님
    // 스키마(1.2)
    const Ajv = (await import('ajv/dist/2020.js')).default
    const ajv = new Ajv({ strict: false, allErrors: true })
    const sch = (n: string) => ajv.compile(readJ(join(SPEC, 'schemas', `${n}.schema.json`)))
    const chk = (n: string, f: string) => {
      const v = sch(n)
      if (!v(readJ(f))) throw new Error(`${n} ${f}: ${JSON.stringify(v.errors)}`)
    }
    chk('kanban', join(e.root, 'kanban.json'))
    chk('card', join(boardDir(e), 'cards', c.id, 'card.json'))
    for (const ev of c.events) chk('event', join(boardDir(e), 'cards', c.id, 'events', ev._file))
    for (const s of [A, B]) {
      chk('session', join(boardDir(e), 'sessions', s, 'session.json'))
      chk('now', join(boardDir(e), 'sessions', s, 'now.json'))
    }
  })
  test('옛 세션 상태(레인 정보 없음)는 그대로 세션별 카드로 계속된다', async () => {
    const e = setup({ machineName: '맥미니' })
    await H(e, A, 'SessionStart', { source: 'startup' }) // 레인 없음으로 시작
    // 같은 세션이 나중에 텔레그램 환경으로 이벤트를 받아도 레인을 새로 정하지 않는다(세션 중 이름이 바뀌지 않음)
    await H(e, A, 'UserPromptSubmit', { prompt_id: 'p1', prompt: '요청 하나 있어요 정말' }, TG('telegram-core'))
    const cs = sessionCards(e)
    expect(cs.length).toBe(1)
    expect(cs[0].card.agentKey).toBeUndefined()
  })
})

describe('kanban merge-lanes', () => {
  const cli = (e: Env, ...args: string[]) => {
    const r = Bun.spawnSync([process.execPath, join(PLUGIN, 'src/kanban/cli.ts'), ...args], { env: e.env, stdout: 'pipe', stderr: 'pipe' })
    return { out: r.stdout.toString(), code: r.exitCode }
  }
  test('기본은 미리보기, --apply 는 가장 최근 것만 두고 archive/ 로 옮긴다(삭제 없음). 살아 있는 세션·레인 카드는 건드리지 않음', async () => {
    const e = setup({ machineName: '맥미니' })
    const OLD = [A, B, C]
    for (const s of OLD) {
      await start(e, s)
      await H(e, s, 'Stop', { last_assistant_message: '끝', background_tasks: [] })
      await H(e, s, 'SessionEnd', {})
      await sleep(15)
    }
    const live = 'dddddddd-0000-4000-8000-000000000004'
    await start(e, live) // 아직 살아 있음, 가장 최근
    await start(e, 'eeeeeeee-0000-4000-8000-000000000005', TG('telegram-core')) // 레인 카드
    const before = sessionCards(e).length
    expect(before).toBe(5)
    const dry = cli(e, 'merge-lanes')
    expect(dry.code).toBe(0)
    expect(dry.out).toContain('대상')
    expect(dry.out).toContain('3개 대상(미리보기)')
    expect(sessionCards(e).length).toBe(5) // 아무것도 안 옮김
    const dry2 = cli(e, 'merge-lanes', '--dry-run')
    expect(dry2.out).toContain('3개 대상(미리보기)')
    expect(cli(e, 'merge-lanes', '--apply', '--dry-run').code).toBe(2)
    const ap = cli(e, 'merge-lanes', '--apply')
    expect(ap.out).toContain('3개를 archive/ 로 옮겼어요(삭제 없음)')
    const left = sessionCards(e)
    expect(left.length).toBe(2) // 살아 있던 폴더 세션 + 레인 카드
    expect(left.some((c) => c.card.agentKey)).toBe(true)
    expect(readdirSync(join(boardDir(e), 'archive')).length).toBe(3)
    expect(readdirSync(join(boardDir(e), 'archive')).every((id) => existsSync(join(boardDir(e), 'archive', id, 'card.json')))).toBe(true)
  })
})

describe('MCP kanban_machine · kanban_status', () => {
  const clients: Client[] = []
  afterEach(async () => {
    while (clients.length) await clients.pop()!.close().catch(() => {})
  })
  async function connect(e: Env, extra: Record<string, string> = {}) {
    const t = new StdioClientTransport({ command: process.execPath, args: [join(PLUGIN, 'src/kanban/mcp.ts')], env: { ...e.env, ...extra }, stderr: 'ignore' })
    const c = new Client({ name: 'test', version: '1' })
    await c.connect(t)
    clients.push(c)
    return async (name: string, args: any) => {
      const r: any = await c.callTool({ name, arguments: args })
      return { err: !!r.isError, text: r.content?.[0]?.text as string }
    }
  }
  test('이름 보기 · 정하기 · 상태에 표시 · 세션 없이도 · 설정 없이도 · 설정 순서(status → machine → setup)', async () => {
    const e = setup(null as any)
    const call = await connect(e)
    const st0 = JSON.parse((await call('kanban_status', {})).text)
    expect(st0.configured).toBe(false)
    expect(st0.machine.name).toBeTruthy()
    expect(st0.machine.source).not.toBe('config')
    const shown = JSON.parse((await call('kanban_machine', {})).text)
    expect(shown.result).toBe('shown')
    const set = await call('kanban_machine', { name: '맥미니' })
    expect(set.err).toBe(false)
    expect(JSON.parse(set.text)).toMatchObject({ result: 'set', name: '맥미니' })
    expect((await call('kanban_machine', { name: '//' })).err).toBe(true)
    const setup1 = JSON.parse((await call('kanban_setup', { root: e.root })).text)
    expect(setup1.result).toBe('created')
    const st1 = JSON.parse((await call('kanban_status', {})).text)
    expect(st1.configured).toBe(true)
    expect(st1.machine).toMatchObject({ name: '맥미니', source: 'config', configured: '맥미니' })
    expect(readJ(e.cfgPath).machineName).toBe('맥미니')
  })
  test('세션이 레인에 있으면 kanban_status 가 레인·밀려남 경고를 보여 준다', async () => {
    const e = setup({ machineName: '맥미니' })
    const env = TG('telegram-core')
    await start(e, A, env)
    await start(e, B, env)
    await H(e, A, 'PostToolUse', { prompt_id: 'x1', tool_name: 'Edit', tool_input: { file_path: '/p/a.ts' }, tool_response: {} }, env) // A 밀려남 확정
    const callB = await connect(e, { CLAUDE_CODE_SESSION_ID: B })
    const sB = JSON.parse((await callB('kanban_status', {})).text)
    expect(sB.session).toMatchObject({ lane: 'core', source: 'telegram', machine: '맥미니', superseded: false })
    const callA = await connect(e, { CLAUDE_CODE_SESSION_ID: A })
    const sA = JSON.parse((await callA('kanban_status', {})).text)
    expect(sA.session).toMatchObject({ lane: 'core', superseded: true, replacedBy: B })
    expect(sA.session.warning).toContain('더 새로운 세션')
    expect((await callA('board_inbox', {})).text).toContain('경고')
  })
})
