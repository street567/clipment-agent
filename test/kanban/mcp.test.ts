import { afterEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cardId } from '../../src/kanban/core/ids.ts'
import { appAction, appComment, base, boardDir, cards, PLUGIN, readJ, runHook, SID, setup, sleep, type Env } from './helpers.ts'

process.env.AGENT_KANBAN_NO_DOWNLOAD = '1'
const SC = cardId('session', SID, '')
const H = (e: Env, ev: string, extra: Record<string, any> = {}) => runHook(e, { ...base(), hook_event_name: ev, ...extra })
const OTHER = '11111111-2222-4333-8444-555555555555'

const clients: Client[] = []
afterEach(async () => {
  while (clients.length) await clients.pop()!.close().catch(() => {})
})
async function connect(e: Env, extra: Record<string, string> = {}) {
  const t = new StdioClientTransport({ command: process.execPath, args: [join(PLUGIN, 'src/kanban/mcp.ts')], env: { ...e.env, CLAUDE_CODE_SESSION_ID: SID, ...extra }, stderr: 'ignore' })
  const c = new Client({ name: 'test', version: '1' })
  await c.connect(t)
  clients.push(c)
  const call = async (name: string, args: any) => {
    const r: any = await c.callTool({ name, arguments: args })
    return { err: !!r.isError, text: r.content?.[0]?.text as string }
  }
  return { c, call }
}
async function ready(e: Env) {
  await H(e, 'SessionStart', { source: 'startup' })
  await H(e, 'UserPromptSubmit', { prompt_id: 'p1', prompt: '질문 테스트를 해 봅니다' })
}

describe('MCP 왕복', () => {
  test('도구 목록 — 카드를 완료/이동시키는 도구는 없다', async () => {
    const e = setup({})
    await ready(e)
    const { c } = await connect(e)
    const names = (await c.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual(['board_ask', 'board_card', 'board_inbox', 'board_label', 'board_list', 'board_members', 'board_note', 'board_reply', 'board_submit', 'board_take', 'kanban_remove',
      'kanban_setup', 'kanban_status'])
    expect(names.some((n) => /done|complete|(^|_)move|finish/.test(n))).toBe(false)
  })

  test('board_inbox: 본문과 id 를 주고 receipt(via inbox)를 만들며 한 번만, 없으면 "새 의견 없음"', async () => {
    const e = setup({})
    await ready(e)
    const { call } = await connect(e)
    expect((await call('board_inbox', {})).text).toBe('새 의견 없음')
    const a = await call('board_ask', { kind: 'approve', question: '진행할까요?' })
    const cid = /card_id=([0-9a-f-]+)/.exec(a.text)![1]
    const nh = cards(e).find((c) => c.id === cid)!.events.find((x) => x.type === 'needs_human')
    const c1 = appComment(e, SC, '이 버튼을 키워 주세요')
    appAction(e, cid, nh.id, 'approve')
    const r = await call('board_inbox', {})
    expect(r.err).toBe(false)
    expect(r.text).toContain('이 버튼을 키워 주세요')
    expect(r.text).toContain(`comment_id=${c1}`)
    expect(r.text).toContain('승인')
    expect(r.text).toContain('진행할까요?')
    expect(r.text).toContain('보통 요청')
    expect(readJ(join(boardDir(e), 'cards', SC, 'receipts', `${c1}.json`)).via).toBe('inbox')
    expect(cards(e).find((c) => c.id === cid)!.derived.list).toBe('done') // closeAnswered
    expect((await call('board_inbox', {})).text).toBe('새 의견 없음')
    expect((await H(e, 'Stop', { last_assistant_message: '끝', background_tasks: [] })).stdout).toBe('')
  })
  test('Stop 과 board_inbox 가 경쟁해도 코멘트마다 정확히 한 번', async () => {
    const e = setup({})
    await ready(e)
    const { call } = await connect(e)
    const N = 10
    for (let i = 0; i < N; i++) appComment(e, SC, `경쟁 의견 ${i}번`)
    const rs = await Promise.all([
      call('board_inbox', {}), H(e, 'Stop', { last_assistant_message: 'a', background_tasks: [] }),
      call('board_inbox', {}), H(e, 'Stop', { last_assistant_message: 'b', background_tasks: [] }),
    ])
    const all = rs.map((r: any) => r.text ?? r.stdout).join('\n')
    for (let i = 0; i < N; i++) expect(all.split(`경쟁 의견 ${i}번`).length - 1).toBe(1)
  })
  test('board_inbox 도 allowAuthors 를 따른다', async () => {
    const e = setup({ allowAuthors: ['개미'] })
    await ready(e)
    const { call } = await connect(e)
    const d = join(boardDir(e), 'cards', SC, 'comments')
    mkdirSync(d, { recursive: true })
    const id = '0bbbbbbb-0000-4000-8000-000000000001'
    writeFileSync(join(d, `${id}.json`), JSON.stringify({ schema: 1, id, cardId: SC, author: 'user', authorName: '낯선이', text: '낯선 의견', created: new Date().toISOString() }))
    expect((await call('board_inbox', {})).text).toBe('새 의견 없음')
  })

  test('board_ask → 새 ask 카드(내 차례), 답은 코멘트 전달로 돌아오고 board_reply 로 답한다', async () => {
    const e = setup({})
    await ready(e)
    const { call } = await connect(e)
    const r = await call('board_ask', { kind: 'decide', question: '배포를 지금 할까요?', options: ['지금', '내일'] })
    expect(r.err).toBe(false)
    expect(r.text).toContain('나중에')
    const cid = /card_id=([0-9a-f-]+)/.exec(r.text)![1]
    let cs = cards(e)
    const ask = cs.find((c) => c.id === cid)!
    expect(ask.card.kind).toBe('ask')
    expect(ask.id).not.toBe(SC)
    expect(ask.derived.list).toBe('mine')
    const nh = ask.events.find((x) => x.type === 'needs_human')
    expect(nh.ask).toEqual({ kind: 'decide', options: ['지금', '내일'] })
    expect(nh.summary).toBe('배포를 지금 할까요?')
    expect(cs.find((c) => c.id === SC)!.derived.list).toBe('working') // 세션 카드는 그대로

    // 사람이 폰에서 코멘트 → Stop 으로 전달 → board_reply
    const cmt = appComment(e, cid, '내일 하세요')
    const s = await H(e, 'Stop', { last_assistant_message: '기다립니다', background_tasks: [] })
    const ctx = JSON.parse(s.stdout).hookSpecificOutput.additionalContext
    expect(ctx).toContain('내일 하세요')
    expect(ctx).toContain(`card_id=${cid}`)
    const rep = await call('board_reply', { card_id: cid, comment_id: cmt, text: '내일로 미뤘어요' })
    expect(rep.err).toBe(false)
    cs = cards(e)
    const reply = cs.find((c) => c.id === cid)!.comments.find((x) => x.author === 'agent')
    expect(reply.replyTo).toBe(cmt)
    expect(reply.text).toBe('내일로 미뤘어요')

    // 처리(action)로 답하면 전달 후 그 ask 카드는 끝난다
    appAction(e, cid, nh.id, 'choose', { choice: '내일' })
    const s2 = await H(e, 'Stop', { last_assistant_message: '또', background_tasks: [] })
    expect(JSON.parse(s2.stdout).hookSpecificOutput.additionalContext).toContain('내일')
    expect(cards(e).find((c) => c.id === cid)!.derived.list).toBe('done')
  })

  test('입력 검증: decide 는 options 필요, approve/do 는 가능', async () => {
    const e = setup({})
    await ready(e)
    const { call } = await connect(e)
    expect((await call('board_ask', { kind: 'decide', question: '무엇을?' })).err).toBe(true)
    expect((await call('board_ask', { kind: 'decide', question: '무엇을?', options: ['하나'] })).err).toBe(true)
    expect((await call('board_ask', { kind: 'approve', question: '진행할까요?' })).err).toBe(false)
    const d = await call('board_ask', { kind: 'do', question: '키체인에서 인증서를 직접 내보내 주세요' })
    expect(d.err).toBe(false)
    const kinds = cards(e).filter((c) => c.card.kind === 'ask').map((c) => c.events.find((x) => x.type === 'needs_human').ask.kind).sort()
    expect(kinds).toEqual(['approve', 'do'])
  })

  test('board_note: 기본은 세션 카드, 비밀은 가려서 씀', async () => {
    const e = setup({})
    await ready(e)
    const { call } = await connect(e)
    const r = await call('board_note', { text: '키 sk-ant-api03-ABCDEFGHIJKLMNOPQRST 는 쓰지 않았어요' })
    expect(r.err).toBe(false)
    const c = cards(e).find((x) => x.id === SC)!
    expect(c.comments.length).toBe(1)
    expect(c.comments[0].author).toBe('agent')
    expect(c.comments[0].text).not.toContain('ABCDEFGH')
  })

  test('다른 세션의 카드에는 쓰기를 거부한다', async () => {
    const e = setup({})
    await ready(e)
    await runHook(e, { ...base(OTHER), hook_event_name: 'SessionStart' })
    await runHook(e, { ...base(OTHER), hook_event_name: 'UserPromptSubmit', prompt_id: 'q', prompt: '다른 세션의 일입니다' })
    const other = cardId('session', OTHER, '')
    const oc = appComment(e, other, '남의 코멘트')
    const { call } = await connect(e)
    for (const [name, args] of [
      ['board_note', { text: '침입', card_id: other }],
      ['board_ask', { kind: 'approve', question: '침입?', card_id: other }],
      ['board_reply', { card_id: other, comment_id: oc, text: '침입' }],
    ] as const) {
      const r = await call(name, args)
      expect(r.err).toBe(true)
      expect(r.text).toContain('이 세션의 카드가 아니에요')
    }
    expect(cards(e).find((c) => c.id === other)!.comments.every((x) => x.author === 'user')).toBe(true)
    expect(cards(e).find((c) => c.id === other)!.events.some((x) => x.type === 'needs_human')).toBe(false)
    // 없는 카드·잘못된 id
    expect((await call('board_note', { text: 'x', card_id: '../../etc/passwd' })).err).toBe(true)
    expect((await call('board_note', { text: 'x', card_id: '99999999-9999-4999-8999-999999999999' })).err).toBe(true)
    // 내 카드에 없는 comment_id
    expect((await call('board_reply', { card_id: SC, comment_id: '99999999-9999-4999-8999-999999999999', text: 'x' })).err).toBe(true)
  })

  test('board_list: 이 세션 카드와 리스트·열린 요청·미전달 수', async () => {
    const e = setup({})
    await ready(e)
    await H(e, 'TaskCreated', { task_id: '1', task_subject: '작업 하나' })
    const { call } = await connect(e)
    await call('board_ask', { kind: 'approve', question: '진행할까요?' })
    appComment(e, SC, '미전달 의견')
    const r = await call('board_list', {})
    const j = JSON.parse(r.text)
    expect(j.session).toBe(SID)
    expect(j.cards.length).toBe(3)
    expect(j.cards.find((c: any) => c.kind === 'ask').list).toBe('mine')
    expect(j.cards.find((c: any) => c.kind === 'ask').open_requests[0].ask).toBe('approve')
    expect(j.cards.find((c: any) => c.kind === 'session').undelivered).toBe(1)
    expect(j.cards.find((c: any) => c.kind === 'task').list).toBe('waiting')
  })

  test('세션 id 는 환경변수가 없으면 pid 매핑(CLAUDE_PID)으로', async () => {
    const e = setup({})
    await ready(e)
    mkdirSync(join(e.state, 'pids'), { recursive: true })
    writeFileSync(join(e.state, 'pids', '4242.json'), JSON.stringify({ pid: 4242, sessionId: SID }))
    const t = new StdioClientTransport({ command: process.execPath, args: [join(PLUGIN, 'src/kanban/mcp.ts')], env: { ...e.env, CLAUDE_PID: '4242' }, stderr: 'ignore' })
    const c = new Client({ name: 't', version: '1' })
    await c.connect(t)
    clients.push(c)
    const r: any = await c.callTool({ name: 'board_list', arguments: {} })
    expect(r.isError).toBeFalsy()
    expect(JSON.parse(r.content[0].text).session).toBe(SID)
  })

  test('보드에 연결되지 않은 세션·꺼진 설정은 친절한 오류', async () => {
    const e = setup({})
    const { call } = await connect(e) // hooks 가 이 세션을 본 적 없음
    const r = await call('board_list', {})
    expect(r.err).toBe(true)
    expect(r.text).toContain('연결되어 있지 않아요')
    const e2 = setup(null as any)
    const { call: call2 } = await connect(e2)
    const r2 = await call2('board_ask', { kind: 'approve', question: '진행?' })
    expect(r2.err).toBe(true)
    expect(r2.text).toContain('꺼져 있거나')
  })

  test('board_ask 도 텔레그램을 한 번 보낸다(가짜 서버)', async () => {
    const got: any[] = []
    const srv = Bun.serve({ port: 0, async fetch(req) { got.push({ p: new URL(req.url).pathname, b: await req.json() }); return Response.json({ ok: true }) } })
    const TOKEN = '555555555:AAFakeTokenFakeTokenFakeTokenFake999'
    const e = setup({ telegram: { enabled: true, chatId: '7', apiBase: `http://127.0.0.1:${srv.port}` } }, { AGENT_KANBAN_TELEGRAM_TOKEN: TOKEN })
    await ready(e)
    const { call } = await connect(e)
    await call('board_ask', { kind: 'approve', question: '배포할까요?' })
    await sleep(100)
    expect(got.length).toBe(1)
    expect(got[0].b.text).toContain('배포할까요?')
    srv.stop(true)
    expect(boardDir(e)).toBeTruthy()
  })
})
