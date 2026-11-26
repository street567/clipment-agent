import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeSessionId } from '../../src/kanban/core/agent.ts'
import { Store } from '../../src/kanban/core/store.ts'
import { appCardOp, appManualCard, base, boardDir, cards, PLUGIN, readJ, runHook, setup, SID, type Env } from './helpers.ts'

process.env.AGENT_KANBAN_NO_DOWNLOAD = '1'
async function cli(e: Env, ...args: string[]) {
  const p = Bun.spawn([process.execPath, join(PLUGIN, 'src/kanban/cli.ts'), ...args], { env: e.env, cwd: join(e.dir), stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { stdout, stderr, code }
}
const store = (e: Env) => new Store(e.root, e.board)

describe('모든 하위 명령의 --help 는 아무것도 실행하지 않는다', () => {
  const cmds = [
    ['init'],
    ['status'],
    ['board'],
    ['member'],
    ['member', 'add', '민수', '--default'],
    ['member', 'list'],
    ['member', 'remove', '민수'],
    ['label'],
    ['label', 'add', '개발', '--assignees', '민수'],
    ['label', 'list'],
    ['label', 'remove', '개발'],
    ['agent', 'start', '--session', 'sess-12345678', '--agent', 'gemini'],
    ['agent', 'ask', '--text', '질문', '--session', 'sess-12345678'],
    ['doctor'],
    ['probe', '-n', '3'],
    ['upload-probe'],
    ['prune', '--days', '1', '--apply'],
  ]
  for (const c of cmds) {
    for (const h of ['--help', '-h']) {
      test(`${c.slice(0, 2).join(' ')} ${h}`, async () => {
        const e = setup(null as any)
        const r = await cli(e, ...c, h)
        expect(r.code).toBe(0)
        expect(r.stdout).toContain('사용법')
        expect(r.stdout).toContain('member')
        expect(existsSync(e.cfgPath)).toBe(false)
        expect(readdirSync(e.root)).toEqual([])
        expect(existsSync(e.state)).toBe(false)
        expect(existsSync(e.log)).toBe(false)
      })
    }
  }
  test('설정이 있어도 --help 는 보드를 만들지 않는다', async () => {
    const e = setup({})
    for (const c of [['member', 'add', 'x'], ['label', 'add', 'x'], ['agent', 'start']]) await cli(e, ...c, '--help')
    expect(readdirSync(e.root)).toEqual([])
  })
})

describe('kanban member / label', () => {
  test('member add·list·remove: by.author=user, 이름·종류·기본 담당, 스키마 통과', async () => {
    const e = setup({})
    expect((await cli(e, 'member', 'add', '민수', '--default')).code).toBe(0)
    expect((await cli(e, 'member', 'add', '지연', '--as', '민수')).code).toBe(0)
    const llm = await cli(e, 'member', 'add', '알파', '--agent', 'claude', '--project', 'proj', '--color', '4')
    expect(llm.stdout).toContain('알파')
    const list = (await cli(e, 'member', 'list')).stdout
    expect(list).toContain('[사람] 민수')
    expect(list).toContain('기본 담당')
    expect(list).toContain('[사람] 지연')
    expect(list).toMatch(/\[LLM\] 알파 \(llm-알파|\[LLM\] 알파 \(llm-[0-9a-z-]+\) — claude · 프로젝트 proj/)
    const ops = store(e).boardOps()
    expect(ops.length).toBe(3)
    expect(ops[0].by).toEqual({ author: 'user', name: '나' })
    expect(ops[1].by).toMatchObject({ author: 'user', name: '민수', member: expect.stringMatching(/^u-/) }) // 이미 있는 사람 멤버 이름이면 member 도 적는다
    expect(new Set(ops.map((o) => o.created)).size).toBe(3)
    const Ajv = (await import('ajv/dist/2020.js')).default
    const ajv = new Ajv({ strict: false, allErrors: true })
    const v = ajv.compile(readJ(join(PLUGIN, 'spec-kanban/schemas/board-op.schema.json')))
    for (const f of readdirSync(join(boardDir(e), 'ops'))) expect(v(readJ(join(boardDir(e), 'ops', f)))).toBe(true)
    // 같은 이름 id 충돌 회피
    const dup = await cli(e, 'member', 'add', 'Bob')
    const dup2 = await cli(e, 'member', 'add', 'Bob')
    expect(dup.stdout).toContain('(u-bob)')
    expect(dup2.stdout).toContain('(u-bob-2)')
    // remove: 기본 담당이면 defaultHuman 도 지운다
    expect((await cli(e, 'member', 'remove', '민수')).stdout).toContain('지웠어요')
    const l2 = (await cli(e, 'member', 'list')).stdout
    expect(l2).not.toContain('민수 (')
    expect(l2).not.toContain('기본 담당')
    const bad = await cli(e, 'member', 'remove', '유령')
    expect(bad.code).toBe(1)
    expect(bad.stdout).toContain('지연')
  })
  test('member add 입력 검증', async () => {
    const e = setup({})
    for (const args of [['member', 'add'], ['member', 'add', 'x', '--kind', 'robot'], ['member', 'add', 'x', '--color', '10'], ['member', 'add', 'x', '--id', '../x'], ['member', 'add', 'x', '--agent', 'A B'], ['member', 'add', 'x', '--kind', 'llm', '--default'], ['member', 'bogus']]) {
      const r = await cli(e, ...args)
      expect(r.code).toBe(1)
    }
    expect(existsSync(join(boardDir(e), 'ops'))).toBe(false)
    const long = await cli(e, 'member', 'add', '가'.repeat(30))
    expect(long.code).toBe(0)
    expect(Object.values(store(e).boardOps()[0].set)[0]).toMatchObject({ name: '가'.repeat(19) + '…' })
  })
  test('label add·list·remove, 기본 담당은 존재하는 멤버만', async () => {
    const e = setup({})
    await cli(e, 'member', 'add', '지연')
    const bad = await cli(e, 'label', 'add', '개발', '--assignees', '유령')
    expect(bad.code).toBe(1)
    expect(bad.stdout).toContain('지연')
    expect((await cli(e, 'label', 'add', '개발', '--assignees', '지연', '--color', '2')).code).toBe(0)
    expect((await cli(e, 'label', 'add', '운영')).code).toBe(0)
    const l = (await cli(e, 'label', 'list')).stdout
    expect(l).toContain('개발')
    expect(l).toContain('기본 담당: 지연')
    expect(l).toContain('운영')
    expect((await cli(e, 'label', 'remove', '운영')).stdout).toContain('지웠어요')
    expect((await cli(e, 'label', 'list')).stdout).not.toContain('운영')
    expect((await cli(e, 'label', 'remove', '없음')).code).toBe(1)
  })
  test('board: 담당 [사람]/[LLM], 카테고리, 기한 표시 · 보관 카드는 숨기고 --archived 로 본다', async () => {
    const e = setup({})
    await runHook(e, { ...base(), hook_event_name: 'SessionStart' })
    await runHook(e, { ...base(), hook_event_name: 'UserPromptSubmit', prompt_id: 'p', prompt: '로그인 화면 고쳐 줘' })
    await cli(e, 'member', 'add', '민수', '--default')
    await cli(e, 'member', 'add', '알파', '--agent', 'claude', '--project', 'proj')
    await cli(e, 'label', 'add', '개발')
    const ms = [...store(e).boardOps()].flatMap((o) => Object.keys(o.set)).filter((k) => k.startsWith('member.'))
    const humanId = ms.find((k) => k.includes('u-'))!.slice(7)
    const labelId = [...store(e).boardOps()].flatMap((o) => Object.keys(o.set)).find((k) => k.startsWith('label.'))!.slice(6)
    const c1 = appManualCard(e, { title: '사람 카드 둘', set: { [`assignee.${humanId}`]: true, [`label.${labelId}`]: true, due: '2026-11-28', state: 'mine' } })
    const c2 = appManualCard(e, { title: '보관된 카드', set: { archived: true } })
    const b = (await cli(e, 'board')).stdout
    expect(b).toContain('== 사람 차례')
    expect(b).toMatch(/사람 카드 둘.*담당: \[사람\] 민수.*#개발.*기한 2026-11-28/)
    expect(b).toMatch(/로그인 화면 고쳐 줘.*담당: \[LLM\] 알파/)
    expect(b).not.toContain('보관된 카드')
    const a = (await cli(e, 'board', '--archived')).stdout
    expect(a).toContain('== 보관함 (1) ==')
    expect(a).toContain('보관된 카드')
    expect(a).not.toContain('로그인 화면')
    appCardOp(e, c2, { archived: null })
    expect((await cli(e, 'board')).stdout).toContain('보관된 카드')
    void c1
  })
})

describe('kanban agent (hooks 없는 LLM 의 자기 보고)', () => {
  const S = 'gem-session-0001'
  const run = (e: Env, ...a: string[]) => cli(e, 'agent', ...a, '--agent', 'gemini', '--session', S, '--name', 'myproj')
  test('start → progress → ask → report → fail → done: 모든 이벤트에 via:self, 세션 agent=gemini', async () => {
    const e = setup({})
    await cli(e, 'member', 'add', '민수')
    expect((await run(e, 'start', '--text', '제미니가 로그인 화면을 고칩니다')).code).toBe(0)
    expect((await run(e, 'progress', '--text', '파일을 읽는 중')).code).toBe(0)
    const ask = await run(e, 'ask', '--text', '배포할까요?', '--kind', 'decide', '--options', '지금,내일', '--to', '민수')
    expect(ask.code).toBe(0)
    expect((await run(e, 'report', '--text', '중간 보고 sk-ant-api03-ABCDEFGHIJKLMNOPQRST')).code).toBe(0)
    expect((await run(e, 'fail', '--text', '쿼터 초과')).code).toBe(0)
    expect((await run(e, 'done')).code).toBe(0)
    expect(readJ(join(boardDir(e), 'sessions', S, 'session.json'))).toMatchObject({ id: S, name: 'myproj', agent: 'gemini' })
    const cs = cards(e)
    const sess = cs.find((c) => c.card.kind === 'session')!
    expect(sess.card.title).toBe('제미니가 로그인 화면을 고칩니다')
    expect(sess.events.map((x) => x.type)).toEqual(['created', 'progress', 'report', 'failed', 'done'])
    const askCard = cs.find((c) => c.card.kind === 'ask')!
    expect(askCard.events.find((x) => x.type === 'needs_human').ask).toEqual({ kind: 'decide', options: ['지금', '내일'], to: [expect.stringMatching(/^u-/)] })
    for (const c of cs) for (const ev of c.events) expect(ev.via).toBe('self')
    expect(JSON.stringify(sess.events)).not.toContain('ABCDEFGH')
    expect(readJ(join(boardDir(e), 'sessions', S, 'now.json')).state).toBe('idle')
    // 스키마(via·agent·to)
    const Ajv = (await import('ajv/dist/2020.js')).default
    const ajv = new Ajv({ strict: false, allErrors: true })
    const ev = ajv.compile(readJ(join(PLUGIN, 'spec-kanban/schemas/event.schema.json')))
    const ss = ajv.compile(readJ(join(PLUGIN, 'spec-kanban/schemas/session.schema.json')))
    for (const c of cs) for (const x of c.events) expect(ev(x)).toBe(true)
    expect(ss(readJ(join(boardDir(e), 'sessions', S, 'session.json')))).toBe(true)
    // 로컬 상태는 그 세션 것
    expect(readJ(join(e.state, 'sessions', `${S}.json`)).agent).toBe('gemini')
    // 담당은 gemini 멤버(llm-gemini), board 에도 보인다
    expect((await cli(e, 'board')).stdout).toContain('[LLM] Gemini')
  })
  test('형식이 다른 세션 id 는 해시 UUID, 필수 인자 없으면 실패, 잘못된 --to 는 안 쓴다', async () => {
    const e = setup({})
    const weird = 'thr_weird/id'
    const h = normalizeSessionId('gemini', weird)!
    expect((await cli(e, 'agent', 'start', '--agent', 'gemini', '--session', weird, '--name', 'p')).code).toBe(0)
    expect(existsSync(join(boardDir(e), 'sessions', h, 'session.json'))).toBe(true)
    expect((await cli(e, 'agent', 'start', '--agent', 'gemini')).code).toBe(1) // --session 없음
    expect((await cli(e, 'agent', 'ask', '--agent', 'gemini', '--session', weird)).code).toBe(1) // --text 없음
    expect((await cli(e, 'agent', 'bogus')).code).toBe(1)
    const r = await cli(e, 'agent', 'ask', '--agent', 'gemini', '--session', weird, '--text', '질문', '--to', '유령')
    expect(r.code).toBe(1)
    expect(cards(e).filter((c) => c.card.kind === 'ask').length).toBe(0)
    expect((await cli(e, 'agent', 'ask', '--agent', 'gemini', '--session', weird, '--text', '결정', '--kind', 'decide')).code).toBe(1) // options 없음
    void SID
  })
  test('includePaths 밖 폴더는 기록하지 않는다', async () => {
    const e = setup({ includePaths: [join(tmpdir(), 'ak-none-xyz')] })
    const r = await cli(e, 'agent', 'start', '--agent', 'gemini', '--session', S)
    expect(r.code).toBe(1)
    expect(existsSync(join(boardDir(e), 'sessions'))).toBe(false)
  })
})
