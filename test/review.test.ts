import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  addComment, addReply, deriveStatus, getThread, initProject, listComments, listReplies, pendingRequests, setLock, ValidationError,
} from '../src/core/index.ts'
import { buildHealthReport, findStaleComments, staleCommentsOf } from '../src/daemon/health.ts'
import { parseSeconds } from '../src/cliutil.ts'
import { appWrite, iso, tempRoot, uid } from './helpers.ts'

let root: string
beforeEach(async () => {
  root = tempRoot()
  process.env.CLIPMENT_HOME = mkdtempSync(join(tmpdir(), 'clipment-review-'))
  process.env.CLIPMENT_DAEMON_CONFIG = join(process.env.CLIPMENT_HOME, 'daemon.json')
  delete process.env.CLIPREV_ALLOW_AUTHORS
  await initProject('demo', '데모')
})

function mkComment(over: Record<string, unknown> = {}) {
  const id = uid()
  appWrite(root, 'demo', `comments/${id}.json`, { schema: 1, id, version: 1, t: 12.5, end: null, tag: 'cut', text: '컷', author: 'user', created: iso(-100), ...over })
  return id
}
function mkReply(cid: string, over: Record<string, unknown>) {
  const id = uid()
  appWrite(root, 'demo', `replies/${cid}/${id}.json`, { schema: 1, id, commentId: cid, author: 'claude', text: 't', created: iso(), ...over })
  return id
}
function mkVersion(n: number) {
  appWrite(root, 'demo', `versions/v${String(n).padStart(3, '0')}/meta.json`, { schema: 1, duration: 3, fps: 30, width: 640, height: 360, created: iso() })
}
const done = (cid: string, at: number, extra: Record<string, unknown> = {}) => mkReply(cid, { status: 'done', fixedIn: 2, created: iso(at), ...extra })
const review = (cid: string, at: number, v: unknown = 'approved', extra: Record<string, unknown> = {}) =>
  mkReply(cid, { author: 'user', kind: 'review', review: v, text: '확인했어요', created: iso(at), ...extra })
const state = async (cid: string) => (await listComments('demo')).find(c => c.id === cid)!

describe('deriveStatus: 확인됨', () => {
  test('done + review approved → 확인됨, 반영 시점 fixedAt', async () => {
    const c = mkComment()
    done(c, -50, { fixedAt: 3.14159 })
    expect(await state(c)).toMatchObject({ status: 'done', fixedIn: 2, fixedAt: 3.142, approved: false })
    review(c, -40)
    expect(await state(c)).toMatchObject({ status: 'done', approved: true })
  })
  test('확인 취소(pending) → 확인됨 아님', async () => {
    const c = mkComment()
    done(c, -50); review(c, -40); review(c, -30, 'pending')
    expect((await state(c)).approved).toBe(false)
    review(c, -20) // 다시 확인
    expect((await state(c)).approved).toBe(true)
  })
  test('다시 열리면(open) 풀리고, 새 done 이어도 풀림', async () => {
    const c = mkComment()
    done(c, -50); review(c, -40)
    mkReply(c, { author: 'user', status: 'open', text: '다시', created: iso(-30) })
    expect(await state(c)).toMatchObject({ status: 'open', approved: false })
    done(c, -20, { fixedIn: 3 })
    expect(await state(c)).toMatchObject({ status: 'done', fixedIn: 3, approved: false })
    review(c, -10)
    expect((await state(c)).approved).toBe(true)
  })
  test('wontfix 도 확인 가능, question·open 은 불가', async () => {
    const c = mkComment()
    mkReply(c, { status: 'wontfix', created: iso(-50) }); review(c, -40)
    expect((await state(c)).approved).toBe(true)
    const q = mkComment()
    mkReply(q, { status: 'question', created: iso(-50) }); review(q, -40)
    expect((await state(q)).approved).toBe(false)
  })
  test('AI 가 쓴 review 는 무시', async () => {
    const c = mkComment()
    done(c, -50)
    review(c, -40, 'approved', { author: 'claude' })
    expect((await state(c)).approved).toBe(false)
  })
  test('review 값이 모르는 것이면 무시, kind 가 review 가 아니면 무시, review 는 status 를 바꾸지 않음', async () => {
    const c = mkComment()
    done(c, -50)
    review(c, -40, 'maybe')
    mkReply(c, { author: 'user', review: 'approved', created: iso(-35) }) // kind 없음
    expect(await state(c)).toMatchObject({ status: 'done', approved: false, replyCount: 3 })
  })
  test('fixedAt: fixedIn 있을 때만, 음수/문자열 무시, 같은 답글에서만', async () => {
    const c = mkComment()
    mkReply(c, { status: 'doing', fixedAt: 5, created: iso(-60) }) // fixedIn 없음 → 무시
    expect((await listReplies('demo', c))[0]!.fixedAt).toBeUndefined()
    done(c, -50, { fixedAt: -1 })
    expect((await state(c)).fixedAt).toBeNull()
    done(c, -40, { fixedAt: '3' })
    expect((await state(c)).fixedAt).toBeNull()
    done(c, -30, { fixedAt: 7.5, fixedIn: 4 })
    expect(await state(c)).toMatchObject({ fixedIn: 4, fixedAt: 7.5 })
    mkReply(c, { status: 'doing', created: iso(-20) }) // fixedIn 없는 더 최근 status → 둘 다 null
    expect(await state(c)).toMatchObject({ fixedIn: null, fixedAt: null })
  })
  test('deriveStatus pure 반환 형태', () => {
    expect(deriveStatus([])).toEqual({ status: 'open', fixedIn: null, fixedAt: null, approved: false })
  })
})

describe('addReply fixedAt', () => {
  test('검증·반올림', async () => {
    const c = mkComment()
    expect((await addReply('demo', c, { text: 'x', author: 'claude', status: 'done', fixedIn: 2, fixedAt: 1.23456 })).fixedAt).toBe(1.235)
    expect((await addReply('demo', c, { text: 'x', author: 'claude', status: 'done', fixedIn: 2, fixedAt: 0 })).fixedAt).toBe(0)
    for (const bad of [-1, NaN, Infinity])
      await expect(addReply('demo', c, { text: 'x', author: 'claude', fixedIn: 2, fixedAt: bad })).rejects.toThrow(ValidationError)
    await expect(addReply('demo', c, { text: 'x', author: 'claude', fixedAt: 3 })).rejects.toThrow(ValidationError)
  })
  test('AI 쪽에는 review 를 쓰는 입력이 없다', async () => {
    const c = mkComment()
    const r: any = await addReply('demo', c, { text: 'x', author: 'claude', review: 'approved', kind: 'review' } as any)
    expect(r.review).toBeUndefined(); expect(r.kind).toBeUndefined()
  })
  test('parseSeconds', () => {
    expect(parseSeconds('12.5', 'x')).toBe(12.5)
    expect(parseSeconds('1:05', 'x')).toBe(65)
    expect(parseSeconds('1:05.5', 'x')).toBe(65.5)
    expect(() => parseSeconds('-1', 'x')).toThrow(ValidationError)
    expect(() => parseSeconds('a:b', 'x')).toThrow(ValidationError)
  })
})

describe('listComments ids', () => {
  test('여러 버전을 id 로, 없는 id 무시, version 무시', async () => {
    const a = mkComment({ version: 1 }), b = mkComment({ version: 2 }), c = mkComment({ version: 3 })
    const r = await listComments('demo', { ids: [a, c, uid()], version: 2 })
    expect(r.map(x => x.id).sort()).toEqual([a, c].sort())
    expect(await listComments('demo', { ids: [] })).toEqual([])
    expect((await listComments('demo', { version: 2 })).map(x => x.id)).toEqual([b])
  })
})

describe('health 덮음', () => {
  const now = Date.parse('2026-01-01T12:00:00Z')
  const at = (m: number) => new Date(now - m * 60_000).toISOString()
  const c = (id: string, ageMin: number, o: any = {}) => ({ id, version: 1, t: 1, created: at(ageMin), text: 'x', ...o })
  test('commentIds 배열에 포함이면 다른 버전 요청도 덮음, null 이면 version 조건', () => {
    const req = (o: any) => [{ type: 'apply_feedback', version: 3, commentIds: null, created: at(35), ...o }]
    expect(staleCommentsOf([c('a', 40)], req({ commentIds: ['a'] }), 'w/p', now, 30 * 60_000)).toEqual([])
    expect(staleCommentsOf([c('a', 40)], req({ commentIds: ['b'] }), 'w/p', now, 30 * 60_000).length).toBe(1)
    expect(staleCommentsOf([c('a', 40)], req({}), 'w/p', now, 30 * 60_000).length).toBe(1)
  })
  test('via=channel 제외', () => {
    expect(staleCommentsOf([c('a', 40, { via: 'channel' })], [], 'w/p', now, 30 * 60_000)).toEqual([])
  })
  test('다시 열린 코멘트는 열린 시점 기준', () => {
    const reqs = [{ type: 'apply_feedback', version: 1, commentIds: null, created: at(35) }]
    // 코멘트 40분 전 생성, 요청 35분 전 → 덮임
    expect(staleCommentsOf([c('a', 40)], reqs, 'w/p', now, 30 * 60_000)).toEqual([])
    // 34분 전에 다시 열림 → 요청(35분 전)은 열린 시점보다 앞서므로 덮지 못함
    expect(staleCommentsOf([c('a', 40, { openedAt: at(34) })], reqs, 'w/p', now, 30 * 60_000).length).toBe(1)
    // 열린 지 10분밖에 안 됐으면 아직 점검 대상 아님
    expect(staleCommentsOf([c('a', 40, { openedAt: at(10) })], reqs, 'w/p', now, 30 * 60_000)).toEqual([])
    // 다시 열린 뒤(30분 전)에 온 요청은 덮음
    expect(staleCommentsOf([c('a', 80, { openedAt: at(40) })], [{ ...reqs[0]!, created: at(31) }], 'w/p', now, 30 * 60_000)).toEqual([])
    expect(staleCommentsOf([c('a', 80, { openedAt: at(31) })], reqs, 'w/p', now, 30 * 60_000).length).toBe(1) // 열린 뒤 요청 없음
  })
  test('실제 파일: 오래전 done 이었다가 다시 열린 코멘트가 점검에 잡힌다', async () => {
    const id = mkComment({ created: iso(-3 * 3600) })
    done(id, -2 * 3600)
    mkReply(id, { author: 'user', status: 'open', text: '다시', created: iso(-3000) }) // 50분 전
    const stale = await findStaleComments(Date.now(), 30 * 60_000)
    expect(stale.map(s => s.commentId)).toEqual([id])
    // 코멘트 생성 직후의 옛 요청은 다시 열린 뒤가 아니므로 덮지 못함
    appWrite(root, 'demo', `requests/${uid()}.json`, { schema: 1, type: 'apply_feedback', version: 1, commentIds: null, agent: '', message: '', created: iso(-2.5 * 3600) })
    expect((await findStaleComments(Date.now(), 30 * 60_000)).length).toBe(1)
    appWrite(root, 'demo', `requests/${uid()}.json`, { schema: 1, type: 'apply_feedback', version: 1, commentIds: [id], agent: '', message: '', created: iso(-2400) })
    expect(await findStaleComments(Date.now(), 30 * 60_000)).toEqual([])
  })
})

describe('review 답글은 요청·알림을 만들지 않는다', () => {
  test('review 답글만으로 pending 요청·stale 코멘트가 생기지 않음', async () => {
    const c = mkComment({ created: iso(-3 * 3600) })
    done(c, -7000); review(c, -3600)
    expect(await pendingRequests(undefined, null, () => {})).toEqual([])
    expect(await findStaleComments(Date.now(), 30 * 60_000)).toEqual([]) // open 아님
    const rep = await buildHealthReport({ daemon: { installed: true, loaded: true, running: true, pid: 1 } })
    expect(rep.unclaimed).toEqual([]); expect(rep.staleComments).toEqual([])
    expect((await getThread('demo', c)).approved).toBe(true)
  })
})

describe('addComment', () => {
  test('기본값·via·authorName', async () => {
    const c = await addComment('demo', { text: '인트로 줄여줘', authorName: ' 개미 ' })
    expect(c).toMatchObject({ version: 0, t: 0, end: null, tag: 'other', author: 'user', via: 'channel', authorName: '개미' })
    const [got] = await listComments('demo')
    expect(got).toMatchObject({ id: c.id, via: 'channel', status: 'open', text: '인트로 줄여줘' })
    expect((await addComment('demo', { text: 'x' })).authorName).toBeUndefined()
  })
  test('version 존재 검사, t/end/tag 검증, 텍스트 검사', async () => {
    await expect(addComment('demo', { text: 'x', version: 2 })).rejects.toThrow(ValidationError)
    mkVersion(2)
    expect((await addComment('demo', { text: 'x', version: 2, t: 1.23456, end: 4, tag: 'cut' }))).toMatchObject({ version: 2, t: 1.235, end: 4, tag: 'cut' })
    await expect(addComment('demo', { text: 'x', version: 2, t: -1 })).rejects.toThrow(ValidationError)
    await expect(addComment('demo', { text: 'x', version: 2, t: 5, end: 4 })).rejects.toThrow(ValidationError)
    await expect(addComment('demo', { text: 'x', tag: 'nope' })).rejects.toThrow(ValidationError)
    await expect(addComment('demo', { text: '  ' })).rejects.toThrow(ValidationError)
    await expect(addComment('demo', { text: 'a'.repeat(4001) })).rejects.toThrow(ValidationError)
    await expect(addComment('demo', { text: 'x', version: 1000 })).rejects.toThrow(ValidationError)
  })
  test('잠금: force 없으면 거부', async () => {
    await setLock('demo', 'locked', { author: 'user' })
    await expect(addComment('demo', { text: 'x' })).rejects.toThrow(/잠긴/)
    expect((await addComment('demo', { text: 'x', force: true })).via).toBe('channel')
  })
  test('더 새 major 계약은 읽기 전용', async () => {
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({ schema: 1, name: 'x', contract: '2.0' }))
    await expect(addComment('demo', { text: 'x' })).rejects.toThrow(/계약/)
  })
  test('via=channel 코멘트는 요청이 없어도 stale 로 잡히지 않음 (파일 단위)', async () => {
    const c = await addComment('demo', { text: 'x' })
    // 생성시각을 과거로 되돌려 나이만 먹인 것과 동일하게 검사
    expect(await findStaleComments(Date.now() + 3600_000, 30 * 60_000)).toEqual([])
    expect((await listComments('demo', { ids: [c.id] })).length).toBe(1)
  })
  test('허용 목록: via=channel 코멘트는 목록과 무관하게 stale 제외, 이름 없으면 경고', async () => {
    const { authorAllowWarning } = await import('../src/core/index.ts')
    process.env.CLIPREV_ALLOW_AUTHORS = '개미'
    expect(authorAllowWarning(undefined, undefined)).toContain('개미')
    expect(authorAllowWarning(undefined, '개미')).toBeNull()
    process.env.CLIPREV_ALLOW_AUTHORS = ''
    expect(authorAllowWarning(undefined, undefined)).toBeNull()
  })
})

describe('MCP 왕복', () => {
  test('add_comment / reply(fixedAt) / list_comments(ids)', async () => {
    mkVersion(1)
    const client = new Client({ name: 't', version: '0' }, { capabilities: {} })
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [join(import.meta.dir, '../src/mcp.ts')],
      env: { ...(process.env as Record<string, string>), CLIPREV_ROOT: root, CLIPREV_AGENT: 'codex', CLIPREV_USER_NAME: '개미', CLIPMENT_DAEMON_CONFIG: join(process.env.CLIPMENT_HOME!, 'd.json') },
    }))
    const text = (r: any) => JSON.parse(r.content[0].text)
    try {
      const tools = (await client.listTools()).tools.map(t => t.name)
      expect(tools).toContain('add_comment')
      const cm = text(await client.callTool({ name: 'add_comment', arguments: { project: 'demo', text: '자막 아래로', version: 1, t: 1, tag: 'subtitle' } }))
      expect(cm).toMatchObject({ author: 'user', via: 'channel', authorName: '개미', version: 1, tag: 'subtitle' })
      const bad: any = await client.callTool({ name: 'add_comment', arguments: { project: 'demo', text: 'x', version: 9 } })
      expect(bad.isError).toBe(true)
      const rep = text(await client.callTool({ name: 'reply', arguments: { project: 'demo', commentId: cm.id, text: '옮김', status: 'done', fixedIn: 2, fixedAt: 4.5 } }))
      expect(rep).toMatchObject({ fixedIn: 2, fixedAt: 4.5 })
      const noIn: any = await client.callTool({ name: 'reply', arguments: { project: 'demo', commentId: cm.id, text: '옮김', fixedAt: 4.5 } })
      expect(noIn.isError).toBe(true)
      review(cm.id, 5)
      const other = mkComment({ version: 7 })
      const got = text(await client.callTool({ name: 'list_comments', arguments: { project: 'demo', ids: [cm.id, other, uid()] } }))
      expect(got.map((x: any) => x.id).sort()).toEqual([cm.id, other].sort())
      expect(got.find((x: any) => x.id === cm.id)).toMatchObject({ approved: true, fixedAt: 4.5, via: 'channel' })
      const th = text(await client.callTool({ name: 'get_thread', arguments: { project: 'demo', commentId: cm.id } }))
      expect(th.approved).toBe(true)
    } finally { await client.close() }
  }, 30000)
})
