import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addProgress, addReply, atomicWriteNew, assertId, assertSlug, deriveStatus, getThread, initProject, listComments,
  listRequests, pendingRequests, safeJoin, setDownloader, ValidationError, versionDir, waitForRequests,
} from '../src/core/index.ts'
import { appWrite, iso, tempRoot, uid } from './helpers.ts'

let root: string
beforeEach(async () => {
  root = tempRoot()
  setDownloader(null)
  await initProject('demo', '데모')
})

function mkComment(over: Record<string, unknown> = {}) {
  const id = uid()
  appWrite(root, 'demo', `comments/${id}.json`, {
    schema: 1, id, version: 1, t: 12.5, end: null, tag: 'cut', text: '컷', author: 'user', created: iso(), ...over,
  })
  return id
}
function mkRequest(over: Record<string, unknown> = {}) {
  const id = uid()
  appWrite(root, 'demo', `requests/${id}.json`, {
    schema: 1, id, type: 'apply_feedback', version: 1, commentIds: null, agent: 'claude', message: '', created: iso(), ...over,
  })
  return id
}

describe('validation', () => {
  test('slug', () => {
    for (const bad of ['', 'A', 'a/b', '../x', 'a..b', '-a', 'a-', 'a b', 'a_b', '한글'])
      expect(() => assertSlug(bad)).toThrow(ValidationError)
    expect(assertSlug('simracing-vertical')).toBe('simracing-vertical')
  })
  test('id must be lowercase uuid', () => {
    expect(() => assertId('../../etc/passwd')).toThrow(ValidationError)
    expect(() => assertId(uid().toUpperCase())).toThrow(ValidationError)
    expect(assertId(uid())).toBeTruthy()
  })
  test('safeJoin blocks traversal', () => {
    expect(() => safeJoin(root, '..', 'x')).toThrow(ValidationError)
    expect(versionDir('demo', 2)).toBe(join(root, 'demo', 'versions', 'v002'))
    expect(() => versionDir('demo', 0)).toThrow(ValidationError)
    expect(() => versionDir('../demo', 1)).toThrow(ValidationError)
  })
  test('reply/progress reject traversal ids', async () => {
    await expect(addReply('demo', '../../x', { text: 'a', author: 'claude' })).rejects.toThrow(ValidationError)
    await expect(addProgress('demo', '../x', 'working', '', 'claude')).rejects.toThrow(ValidationError)
    await expect(addReply('../x', uid(), { text: 'a', author: 'claude' })).rejects.toThrow(ValidationError)
  })
  test('malicious json fields cannot affect paths (files with non-uuid names ignored)', async () => {
    appWrite(root, 'demo', 'comments/evil.json', { version: 1, t: 1, tag: 'cut', text: 'x', created: iso() })
    appWrite(root, 'demo', 'comments/..%2f.json', { version: 1, t: 1 })
    const id = mkComment({ id: '../../evil' })
    const cs = await listComments('demo')
    expect(cs.map(c => c.id)).toEqual([id])
  })
})

describe('comments & status', () => {
  test('default open; latest status reply wins (by created, not filename)', async () => {
    const id = mkComment()
    expect((await listComments('demo'))[0]!.status).toBe('open')
    appWrite(root, 'demo', `replies/${id}/${uid()}.json`, { commentId: id, author: 'claude', text: 'a', status: 'doing', created: iso(1) })
    appWrite(root, 'demo', `replies/${id}/${uid()}.json`, { commentId: id, author: 'claude', text: 'b', status: 'done', fixedIn: 2, created: iso(3) })
    appWrite(root, 'demo', `replies/${id}/${uid()}.json`, { commentId: id, author: 'user', text: '질문 없는 메모', created: iso(5) })
    const [c] = await listComments('demo')
    expect(c!.status).toBe('done')
    expect(c!.fixedIn).toBe(2)
    expect(c!.replyCount).toBe(3)
    expect(await listComments('demo', { status: 'open' })).toHaveLength(0)
    expect(await listComments('demo', { status: 'done' })).toHaveLength(1)
  })
  test('deriveStatus pure', () => {
    expect(deriveStatus([]).status).toBe('open')
  })
  test('version filter, unknown tag -> other, unknown fields ignored', async () => {
    mkComment({ version: 1, tag: 'weird', future: 1 })
    mkComment({ version: 2 })
    expect(await listComments('demo', { version: 2 })).toHaveLength(1)
    expect((await listComments('demo', { version: 1 }))[0]!.tag).toBe('other')
  })
  test('reply writes immutable file, status validated, comment must exist', async () => {
    const id = mkComment()
    const r = await addReply('demo', id, { text: '반영', author: 'claude', status: 'done', fixedIn: 2 })
    expect(existsSync(join(root, 'demo', 'replies', id, r.id + '.json'))).toBe(true)
    await expect(addReply('demo', id, { text: 'x', author: 'claude', status: 'bogus' as any })).rejects.toThrow()
    await expect(addReply('demo', uid(), { text: 'x', author: 'claude' })).rejects.toThrow(ValidationError)
    await expect(addReply('demo', id, { text: '  ', author: 'claude' })).rejects.toThrow()
    expect((await getThread('demo', id)).status).toBe('done')
  })
})

describe('requests', () => {
  test('whitelist drops unknown types', async () => {
    const good = mkRequest({ type: 'rerender' })
    mkRequest({ type: 'run_shell', message: 'rm -rf /' })
    mkRequest({ type: 'Apply_Feedback' })
    const rs = await listRequests('demo')
    expect(rs.map(r => r.id)).toEqual([good])
  })
  test('state derived from latest progress; pending = none or only received', async () => {
    const a = mkRequest({ created: iso(0) })
    const b = mkRequest({ created: iso(1) })
    const c = mkRequest({ created: iso(2) })
    expect((await pendingRequests('demo', 'claude')).map(r => r.id)).toEqual([a, b, c])
    await addProgress('demo', b, 'received', '', 'claude')
    await addProgress('demo', c, 'received', '', 'claude')
    await addProgress('demo', c, 'working', '1/3', 'claude')
    const pend = await pendingRequests('demo', 'claude')
    expect(pend.map(r => r.id)).toEqual([a, b])
    const all = await listRequests('demo')
    expect(all.find(r => r.id === a)!.state).toBe('pending')
    expect(all.find(r => r.id === c)!.state).toBe('working')
  })
  test('other agent requests excluded; empty agent included', async () => {
    mkRequest({ agent: 'codex' })
    const mine = mkRequest({ agent: '' })
    expect((await pendingRequests('demo', 'claude')).map(r => r.id)).toEqual([mine])
  })
  test('progress needs existing request and valid state', async () => {
    await expect(addProgress('demo', uid(), 'working', '', 'claude')).rejects.toThrow(ValidationError)
    const r = mkRequest()
    await expect(addProgress('demo', r, 'nope' as any, '', 'claude')).rejects.toThrow(ValidationError)
  })
  test('waitForRequests returns existing immediately, [] on timeout', async () => {
    expect(await waitForRequests({ project: 'demo', timeoutSec: 0, agent: 'claude' })).toEqual([])
    const r = mkRequest()
    const got = await waitForRequests({ project: 'demo', timeoutSec: 5, agent: 'claude' })
    expect(got.map(x => x.id)).toEqual([r])
  })
  test('waitForRequests wakes up when a request appears', async () => {
    setTimeout(() => mkRequest(), 300)
    const t0 = Date.now()
    const got = await waitForRequests({ project: 'demo', timeoutSec: 5, agent: 'claude', pollMs: 100 })
    expect(got).toHaveLength(1)
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})

describe('atomic write & placeholders', () => {
  test('atomic write leaves no tmp and refuses overwrite', async () => {
    const p = join(root, 'demo', 'x', 'a.json')
    await atomicWriteNew(p, '{}')
    expect(readdirSync(join(root, 'demo', 'x'))).toEqual(['a.json'])
    await expect(atomicWriteNew(p, '{"a":1}')).rejects.toThrow()
  })
  test('tmp files (.x.tmp) are ignored by readers', async () => {
    const id = mkComment()
    writeFileSync(join(root, 'demo', 'comments', `.${uid()}.json.tmp`), '{partial')
    expect((await listComments('demo')).map(c => c.id)).toEqual([id])
  })
  test('icloud placeholders: skipped and download requested', async () => {
    const asked: string[] = []
    setDownloader(p => asked.push(p))
    const id = uid()
    // 자리표시자만 있는 코멘트
    mkdirSync(join(root, 'demo', 'comments'), { recursive: true })
    writeFileSync(join(root, 'demo', 'comments', `.${id}.json.icloud`), '')
    // 내려받기 대기 중 (파일과 자리표시자 공존) 인 코멘트도 건너뜀
    const id2 = mkComment()
    writeFileSync(join(root, 'demo', 'comments', `.${id2}.json.icloud`), '')
    const cs = await listComments('demo')
    expect(cs.filter(c => c.id === id)).toHaveLength(0)
    expect(asked).toContain(join(root, 'demo', 'comments', `${id}.json`))
    expect(asked).toContain(join(root, 'demo', 'comments', `${id2}.json`))
  })
})

describe('authorName / end / allowlist', () => {
  test('comment carries authorName and range end; bad end -> null', async () => {
    const a = mkComment({ authorName: '개미', t: 12.5, end: 15 })
    const b = mkComment({ t: 20, end: 10 })
    const cs = await listComments('demo')
    const ca = cs.find(c => c.id === a)!
    expect([ca.authorName, ca.t, ca.end]).toEqual(['개미', 12.5, 15])
    const cb = cs.find(c => c.id === b)!
    expect([cb.authorName, cb.end]).toEqual([undefined, null])
  })
  test('reply authorName optional', async () => {
    const c = mkComment()
    const r1 = await addReply('demo', c, { text: 'ok', author: 'claude', authorName: '클로드' })
    const r2 = await addReply('demo', c, { text: 'ok2', author: 'claude' })
    expect(r1.authorName).toBe('클로드')
    expect('authorName' in r2).toBe(false)
    expect((await getThread('demo', c)).replies.map(r => r.authorName)).toEqual(['클로드', undefined])
  })
  test('CLIPREV_ALLOW_AUTHORS filters pending requests', async () => {
    const ok1 = mkRequest({ authorName: '개미' })
    mkRequest({ authorName: '낯선사람' })
    mkRequest({})
    try {
      delete process.env.CLIPREV_ALLOW_AUTHORS
      expect((await pendingRequests('demo')).length).toBe(3)
      process.env.CLIPREV_ALLOW_AUTHORS = '개미, 사용자'
      expect((await pendingRequests('demo')).map(r => r.id)).toEqual([ok1])
      expect(await waitForRequests({ project: 'demo', timeoutSec: 0 })).toHaveLength(1)
    } finally {
      delete process.env.CLIPREV_ALLOW_AUTHORS
    }
  })
})
