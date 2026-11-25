import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addPostTarget, getPosts, initProject, listRequests, mergePost, normalizeExtras, normalizeScenes, normalizeTags, pendingRequests, postsForRequest, readTargets,
  REQUEST_TYPES, reorderPostTargets, resolveProject, setLock, SUPPORTED, TARGET_ID_RE, ValidationError, writePost,
} from '../src/core/index.ts'
import { Daemon } from '../src/daemon/daemon.ts'
import { notificationBody } from '../src/daemon/notify.ts'
import { unclaimedLine } from './posts-helpers.ts'
import { appWrite, iso, tempRoot, uid } from './helpers.ts'

let root: string
const saved = { ...process.env }
const A = { author: 'Claude' }
const read = (rel: string) => JSON.parse(readFileSync(join(root, 'p', rel), 'utf8'))
const put = (rel: string, obj: unknown) => appWrite(root, 'p', rel, obj)
const mkVersion = (n: number) => put(`versions/v00${n}/meta.json`, { schema: 1, version: n, label: `v00${n}`, file: 'preview.mp4', duration: 1, fps: 30, width: 1, height: 1, note: '', source: '', created: iso() })

beforeEach(async () => {
  root = tempRoot()
  await initProject('p')
  mkVersion(1); mkVersion(2)
})
afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved) })

describe('계약 1.12', () => {
  test('SUPPORTED 1.12, write_post 는 화이트리스트', () => {
    expect(SUPPORTED).toEqual({ major: 1, minor: 12 })
    expect(REQUEST_TYPES).toContain('write_post')
  })
})

describe('대상 id 경로 안전', () => {
  for (const bad of ['../x', 'a/b', '.hidden', '-a', 'A', 'a b', '', 'a'.repeat(41), 'a\\b', '..', 'a\0b'])
    test(`거부: ${JSON.stringify(bad)}`, async () => {
      await expect(writePost('p', bad, { version: 1, title: 't' }, A)).rejects.toThrow(ValidationError)
      expect(existsSync(join(root, 'p/.clipment/posts'))).toBe(false)
    })
  test('정규식', () => { expect(TARGET_ID_RE.test('youtube-shorts')).toBe(true); expect(TARGET_ID_RE.test('a'.repeat(40))).toBe(true) })
  test('targets.json 의 잘못된 id 항목·폴더는 무시', async () => {
    put('.clipment/posts/targets.json', { schema: 1, targets: [{ id: '../evil' }, { id: 'ok' }, { id: 'ok', name: 'dup' }, 'x', { id: 'Bad' }] })
    expect((await readTargets(resolveProject('p').dir)).targets.map(t => t.id)).toEqual(['ok'])
  })
  test('프로젝트 밖을 가리키는 링크 폴더·파일은 쓰기 거부, 읽기 무시', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'posts-out-'))
    writeFileSync(join(outside, 'ai.json'), JSON.stringify({ version: 1, title: 'SECRET' }))
    mkdirSync(join(root, 'p/.clipment/posts'), { recursive: true })
    symlinkSync(outside, join(root, 'p/.clipment/posts/youtube-shorts'))
    await expect(writePost('p', 'youtube-shorts', { version: 1, title: 'x' }, A)).rejects.toThrow(/밖을 가리키는/)
    expect(readdirSync(outside)).toEqual(['ai.json'])
    expect(JSON.parse(readFileSync(join(outside, 'ai.json'), 'utf8')).title).toBe('SECRET')
    const g = await getPosts('p')
    const yt = g.posts.find(x => x.target === 'youtube-shorts')!
    expect(yt.title).toBeNull()
    expect(yt.warnings.join()).toContain('링크')
  })
  test('링크 파일(ai.json -> 밖)은 쓰기 거부', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'posts-out-'))
    writeFileSync(join(outside, 'f.json'), '{"version":1}')
    mkdirSync(join(root, 'p/.clipment/posts/youtube-shorts'), { recursive: true })
    symlinkSync(join(outside, 'f.json'), join(root, 'p/.clipment/posts/youtube-shorts/ai.json'))
    await expect(writePost('p', 'youtube-shorts', { version: 1, title: 'x' }, A)).rejects.toThrow(/링크/)
    expect(readFileSync(join(outside, 'f.json'), 'utf8')).toBe('{"version":1}')
  })
  test('targets.json 이 밖을 가리키는 링크 폴더 아래면 거부', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'posts-out-'))
    mkdirSync(join(root, 'p/.clipment'), { recursive: true })
    symlinkSync(outside, join(root, 'p/.clipment/posts'))
    await expect(addPostTarget('p', 'cafe', undefined, A)).rejects.toThrow(/밖을 가리키는/)
    expect(readdirSync(outside)).toEqual([])
  })
})

describe('대상 목록', () => {
  const ids = async () => (await readTargets(resolveProject('p').dir)).targets.map(t => t.id)
  test('파일 없음 = 기본 2개, 이름', async () => {
    const t = await readTargets(resolveProject('p').dir)
    expect(t.source).toBe('default')
    expect(t.targets.map(x => [x.id, x.name])).toEqual([['youtube-shorts', '유튜브 쇼츠'], ['instagram-reels', '인스타 릴스']])
  })
  test('깨진 파일·targets 가 배열 아님 = 기본, 빈 배열 = 없음', async () => {
    mkdirSync(join(root, 'p/.clipment/posts'), { recursive: true })
    writeFileSync(join(root, 'p/.clipment/posts/targets.json'), '{broken')
    expect(await ids()).toEqual(['youtube-shorts', 'instagram-reels'])
    put('.clipment/posts/targets.json', { schema: 1, targets: 'x' })
    expect(await ids()).toEqual(['youtube-shorts', 'instagram-reels'])
    put('.clipment/posts/targets.json', { schema: 1, targets: [] })
    expect(await ids()).toEqual([])
  })
  test('사용자 대상 이름, hidden 은 화면에서 제외(all 에는 있음)', async () => {
    put('.clipment/posts/targets.json', { schema: 1, targets: [{ id: 'cafe', name: '카페' }, { id: 'x' }, { id: 'tiktok', hidden: true }] })
    const t = await readTargets(resolveProject('p').dir)
    expect(t.targets.map(x => [x.id, x.name])).toEqual([['cafe', '카페'], ['x', 'x']])
    expect(t.all.map(x => [x.id, x.name, x.hidden])).toEqual([['cafe', '카페', false], ['x', 'x', false], ['tiktok', '틱톡', true]])
  })
  test('addPostTarget: 파일 없으면 기본을 먼저 적고 끝에 추가(addedBy), 이미 있으면 그대로', async () => {
    const r = await addPostTarget('p', 'cafe', '카페', A)
    expect(r.added).toBe(true)
    expect(read('.clipment/posts/targets.json').targets).toEqual([{ id: 'youtube-shorts' }, { id: 'instagram-reels' }, { id: 'cafe', name: '카페', addedBy: 'Claude' }])
    expect(read('.clipment/posts/targets.json')).toMatchObject({ via: 'mac', author: 'Claude' })
    expect((await addPostTarget('p', 'cafe', 'other', A)).added).toBe(false)
    expect(read('.clipment/posts/targets.json').targets.length).toBe(3)
  })
  test('앱이 쓴 항목·모르는 필드·hidden 보존, hidden 은 다시 켜지 않음', async () => {
    put('.clipment/posts/targets.json', { schema: 1, targets: [{ id: 'tiktok', hidden: true, mine: 1 }, { id: 'cafe', name: 'C' }], keep: 'me', via: 'app', author: 'user' })
    const r = await addPostTarget('p', 'tiktok', undefined, A)
    expect(r).toMatchObject({ added: false, hidden: true })
    await addPostTarget('p', 'new-one', undefined, A)
    const f = read('.clipment/posts/targets.json')
    expect(f.keep).toBe('me')
    expect(f.targets).toEqual([{ id: 'tiktok', hidden: true, mine: 1 }, { id: 'cafe', name: 'C' }, { id: 'new-one', addedBy: 'Claude' }])
  })
  test('최대 20개(숨김 포함) 초과 거부', async () => {
    const t = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, ...(i < 5 ? { hidden: true } : {}) }))
    put('.clipment/posts/targets.json', { schema: 1, targets: t })
    await expect(addPostTarget('p', 'one-more', undefined, A)).rejects.toThrow(/최대 20/)
    await expect(writePost('p', 'one-more', { version: 1, title: 'x' }, A)).rejects.toThrow(/최대 20/)
    expect(existsSync(join(root, 'p/.clipment/posts/one-more'))).toBe(false)
    await writePost('p', 't7', { version: 1, title: 'x' }, A) // 기존 대상은 가능
  })
  test('reorder: 같은 id 집합만(숨김 포함), 추가·삭제·누락 거부, hidden·필드 유지', async () => {
    put('.clipment/posts/targets.json', { schema: 1, targets: [{ id: 'a', hidden: true, z: 1 }, { id: 'b' }, { id: 'c', name: 'C' }] })
    await expect(reorderPostTargets('p', ['b', 'c'], A)).rejects.toThrow(/순서만/)
    await expect(reorderPostTargets('p', ['a', 'b', 'c', 'd'], A)).rejects.toThrow(/순서만/)
    await expect(reorderPostTargets('p', ['a', 'b', 'd'], A)).rejects.toThrow(/순서만/)
    await expect(reorderPostTargets('p', ['a', 'a', 'b'], A)).rejects.toThrow(ValidationError)
    await reorderPostTargets('p', ['c', 'a', 'b'], A)
    expect(read('.clipment/posts/targets.json').targets).toEqual([{ id: 'c', name: 'C' }, { id: 'a', hidden: true, z: 1 }, { id: 'b' }])
  })
  test('내려받는 중(.icloud)인 targets.json 은 쓰기 거부', async () => {
    mkdirSync(join(root, 'p/.clipment/posts'), { recursive: true })
    writeFileSync(join(root, 'p/.clipment/posts/.targets.json.icloud'), '')
    await expect(addPostTarget('p', 'cafe', undefined, A)).rejects.toThrow(/덮어쓰지 않/)
  })
})

describe('writePost', () => {
  test('새로 쓰기: 필드·정규화(# 제거, scenes 정렬)·author·updated, user.json 안 만듦', async () => {
    const r = await writePost('p', 'youtube-shorts', {
      version: 2, title: 'T', body: 'B', tags: ['#simracing', '##lmu', '  #  ', 'simracing', 42 as any].slice(0, 4), language: 'en',
      scenes: [{ t: 12.4, text: 'b' }, { t: 0, text: 'a' }, { t: 1.23456, text: 'c' }], requestId: uid(),
    }, A)
    const f = read('.clipment/posts/youtube-shorts/ai.json')
    expect(f).toMatchObject({ schema: 1, target: 'youtube-shorts', version: 2, title: 'T', body: 'B', tags: ['simracing', 'lmu'], language: 'en', author: 'Claude' })
    expect(f.scenes).toEqual([{ t: 0, text: 'a' }, { t: 1.235, text: 'c' }, { t: 12.4, text: 'b' }])
    expect(typeof f.updated).toBe('string')
    expect(existsSync(join(root, 'p/.clipment/posts/youtube-shorts/user.json'))).toBe(false)
    expect(readdirSync(join(root, 'p/.clipment/posts/youtube-shorts'))).toEqual(['ai.json'])
    expect(r.post.title).toBe('T')
    expect(r.targetAdded).toBe(false)
  })
  test('부분 쓰기는 다른 필드·모르는 필드 보존', async () => {
    put('.clipment/posts/youtube-shorts/ai.json', { schema: 1, version: 2, title: 'old', body: 'keep', tags: ['a'], mystery: { x: 1 }, updated: '2020-01-01T00:00:00Z' })
    const r = await writePost('p', 'youtube-shorts', { version: 2, title: 'new' }, A)
    const f = read('.clipment/posts/youtube-shorts/ai.json')
    expect(f).toMatchObject({ title: 'new', body: 'keep', tags: ['a'], mystery: { x: 1 }, version: 2 })
    expect(f.updated).not.toBe('2020-01-01T00:00:00Z')
    expect(r.warnings).toEqual([])
  })
  test('버전이 바뀌면 version 반영 + 남은 항목 경고', async () => {
    put('.clipment/posts/youtube-shorts/ai.json', { schema: 1, version: 1, title: 'old', body: 'b', updated: 'x' })
    const r = await writePost('p', 'youtube-shorts', { version: 2, title: 'new' }, A)
    expect(read('.clipment/posts/youtube-shorts/ai.json').version).toBe(2)
    expect(r.warnings.join()).toContain('body')
  })
  test('user.json 은 절대 안 건드림(바이트 동일)', async () => {
    const f = put('.clipment/posts/youtube-shorts/user.json', { schema: 1, fields: { title: 'mine', extras: { c: { text: 'x' } } }, seenAI: '', version: 1, weird: [1] })
    const before = readFileSync(f, 'utf8')
    await writePost('p', 'youtube-shorts', { version: 2, title: 'ai', extras: [{ id: 'c', text: 'ai' }] }, A)
    await writePost('p', 'youtube-shorts', { version: 2, body: 'b', removeExtras: ['c'] }, A)
    await addPostTarget('p', 'cafe', undefined, A)
    expect(readFileSync(f, 'utf8')).toBe(before)
  })
  test('검증 거부', async () => {
    const bad = (i: any) => expect(writePost('p', 'youtube-shorts', { version: 1, ...i }, A)).rejects.toThrow(ValidationError)
    await bad({ title: 'x'.repeat(501) })
    await bad({ scenes: [{ t: -1, text: 'a' }] })
    await bad({ scenes: [{ t: NaN, text: 'a' }] })
    await bad({ scenes: [{ t: 1, text: '' }] })
    await bad({ tags: [1] })
    await bad({ language: 'fr' })
    await bad({ requestId: 'nope' })
    await bad({ extras: [{ id: '../x', text: 'a' }] })
    await bad({ extras: [{ id: 'a', text: 'a' }, { id: 'a', text: 'b' }] })
    await bad({ extras: [{ id: 'a', text: 'a', label: 'l'.repeat(41) }] })
    await bad({ extras: [{ id: 'a', text: 'a' }], removeExtras: ['a'] })
    await expect(writePost('p', 'youtube-shorts', { version: 0 }, A)).rejects.toThrow(ValidationError)
    await expect(writePost('p', 'youtube-shorts', { version: 9 }, A)).rejects.toThrow(/찾을 수 없/)
    expect(existsSync(join(root, 'p/.clipment/posts/youtube-shorts'))).toBe(false)
  })
  test('깨지거나 내려받는 중인 기존 ai.json 은 덮지 않음', async () => {
    mkdirSync(join(root, 'p/.clipment/posts/youtube-shorts'), { recursive: true })
    writeFileSync(join(root, 'p/.clipment/posts/youtube-shorts/ai.json'), '{broken')
    await expect(writePost('p', 'youtube-shorts', { version: 1, title: 'x' }, A)).rejects.toThrow(/읽을 수 없/)
    expect(readFileSync(join(root, 'p/.clipment/posts/youtube-shorts/ai.json'), 'utf8')).toBe('{broken')
  })
  test('목록에 없는 대상에 쓰면 끝에 추가(+target_name, addedBy), 기본 대상 먼저 기록', async () => {
    const r = await writePost('p', 'tiktok', { version: 2, title: 'x', targetName: 'TT' }, A)
    expect(r.targetAdded).toBe(true)
    expect(r.warnings.join()).toContain('추가')
    expect(read('.clipment/posts/targets.json').targets).toEqual([{ id: 'youtube-shorts' }, { id: 'instagram-reels' }, { id: 'tiktok', name: 'TT', addedBy: 'Claude' }])
    expect((await getPosts('p')).targets.map(t => t.id)).toEqual(['youtube-shorts', 'instagram-reels', 'tiktok'])
  })
  test('깨진·내려받는 중 targets.json: 추가가 필요한 쓰기는 통째로 거부(아무것도 안 씀), 기본 목록에 있는 대상은 ai.json 만 씀', async () => {
    mkdirSync(join(root, 'p/.clipment/posts'), { recursive: true })
    const tf = join(root, 'p/.clipment/posts/targets.json')
    writeFileSync(tf, '{oops')
    await expect(writePost('p', 'cafe', { version: 1, title: 'x' }, A)).rejects.toThrow(/덮어쓰지 않/)
    await expect(addPostTarget('p', 'cafe', undefined, A)).rejects.toThrow(/덮어쓰지 않/)
    await expect(reorderPostTargets('p', ['instagram-reels', 'youtube-shorts'], A)).rejects.toThrow(/덮어쓰지 않/)
    expect(existsSync(join(root, 'p/.clipment/posts/cafe'))).toBe(false)
    expect(readFileSync(tf, 'utf8')).toBe('{oops')
    await writePost('p', 'youtube-shorts', { version: 1, title: 'ok' }, A)
    expect(read('.clipment/posts/youtube-shorts/ai.json').title).toBe('ok')
    expect(readFileSync(tf, 'utf8')).toBe('{oops')
    expect((await addPostTarget('p', 'youtube-shorts', undefined, A)).added).toBe(false)
    // targets 가 배열이 아닌 JSON 도 깨진 것으로 본다
    writeFileSync(tf, '{"schema":1,"targets":"x"}')
    await expect(addPostTarget('p', 'cafe', undefined, A)).rejects.toThrow(/덮어쓰지 않/)
    // 내려받는 중
    rmSync(tf)
    writeFileSync(join(root, 'p/.clipment/posts/.targets.json.icloud'), '')
    await expect(writePost('p', 'cafe', { version: 1, title: 'x' }, A)).rejects.toThrow(/덮어쓰지 않/)
    await writePost('p', 'instagram-reels', { version: 1, title: 'y' }, A)
  })
  test('숨긴 대상: 글은 쓰고 숨김 유지, 결과로 알림', async () => {
    put('.clipment/posts/targets.json', { schema: 1, targets: [{ id: 'youtube-shorts' }, { id: 'tiktok', hidden: true }] })
    const r = await writePost('p', 'tiktok', { version: 1, title: 'hi' }, A)
    expect(r.hidden).toBe(true)
    expect(r.warnings.join()).toContain('숨긴')
    expect(read('.clipment/posts/tiktok/ai.json').title).toBe('hi')
    expect(read('.clipment/posts/targets.json').targets[1]).toEqual({ id: 'tiktok', hidden: true })
    expect((await getPosts('p')).posts.map(x => x.target)).toEqual(['youtube-shorts'])
    expect((await getPosts('p')).hiddenTargets).toEqual(['tiktok'])
  })
  test('extras: id 별 병합(수정·덧붙임·모르는 필드 보존), remove 로만 삭제, 최대 20', async () => {
    put('.clipment/posts/youtube-shorts/ai.json', { schema: 1, version: 1, updated: 'u', extras: [{ id: 'a', label: 'A', text: '1', keep: true }, { id: 'b', label: 'B', text: '2' }] })
    await writePost('p', 'youtube-shorts', { version: 1, extras: [{ id: 'a', text: '1b' }, { id: 'c', label: 'C', text: '3' }] }, A)
    expect(read('.clipment/posts/youtube-shorts/ai.json').extras).toEqual([{ id: 'a', label: 'A', text: '1b', keep: true }, { id: 'b', label: 'B', text: '2' }, { id: 'c', label: 'C', text: '3' }])
    await writePost('p', 'youtube-shorts', { version: 1, title: 't' }, A)
    expect(read('.clipment/posts/youtube-shorts/ai.json').extras.length).toBe(3)
    await writePost('p', 'youtube-shorts', { version: 1, removeExtras: ['b', 'zzz'] }, A)
    expect(read('.clipment/posts/youtube-shorts/ai.json').extras.map((e: any) => e.id)).toEqual(['a', 'c'])
    const many = Array.from({ length: 19 }, (_, i) => ({ id: `e${i}`, text: 'x' }))
    await expect(writePost('p', 'youtube-shorts', { version: 1, extras: many }, A)).rejects.toThrow(/최대 20/)
    expect(read('.clipment/posts/youtube-shorts/ai.json').extras.length).toBe(2)
  })
  test('잠긴 프로젝트 거부(force 로만), 더 새 계약 워크스페이스는 force 로도 거부', async () => {
    await setLock('p', 'locked', { author: 'user' })
    await expect(writePost('p', 'youtube-shorts', { version: 1, title: 'x' }, A)).rejects.toThrow()
    await expect(addPostTarget('p', 'cafe', undefined, A)).rejects.toThrow()
    await expect(reorderPostTargets('p', ['youtube-shorts', 'instagram-reels'], A)).rejects.toThrow()
    expect(existsSync(join(root, 'p/.clipment/posts'))).toBe(false)
    await writePost('p', 'youtube-shorts', { version: 1, title: 'x' }, { ...A, force: true })
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({ schema: 1, name: 'x', contract: '2.0' }))
    await expect(writePost('p', 'youtube-shorts', { version: 1, title: 'y' }, { ...A, force: true })).rejects.toThrow(/더 새 계약/)
    await expect(addPostTarget('p', 'cafe', undefined, { ...A, force: true })).rejects.toThrow(/더 새 계약/)
    expect(read('.clipment/posts/youtube-shorts/ai.json').title).toBe('x')
  })
})

describe('합쳐 보기 파생', () => {
  const T = { id: 'youtube-shorts', name: 'n', known: true, hidden: false }
  const ai = (o: any = {}) => ({ schema: 1, version: 7, title: 'AI title', body: 'AI body', tags: ['a'], scenes: [{ t: 0, text: 's' }], updated: 'U2', ...o })
  test('보여 주는 값: user 있으면 그것, 없으면 ai, # 제거', () => {
    const v = mergePost(T, ai({ tags: ['#a'] }), { fields: { title: 'mine', tags: ['#x'] }, seenAI: 'U2', version: 7 }, 7)
    expect(v).toMatchObject({ title: 'mine', body: 'AI body', tags: ['x'], fromUser: { title: true, body: false, tags: true, scenes: false }, userEdited: true })
    expect(v.ai.tags).toEqual(['a'])
  })
  test('빈 문자열·빈 배열도 고친 것', () => {
    const v = mergePost(T, ai(), { fields: { body: '', tags: [] }, seenAI: 'U2' }, 7)
    expect(v).toMatchObject({ body: '', tags: [], fromUser: { body: true, tags: true } })
  })
  test('둘 다 없으면 null', () => {
    const v = mergePost(T, null, null, 3)
    expect(v).toMatchObject({ title: null, body: null, tags: null, scenes: null, extras: null, staleVersion: false, newAIDraft: false, baseVersion: null, userEdited: false })
  })
  test('newAIDraft: 고친 것 있음 + ai.updated != seenAI + 양쪽에 있는 항목 값이 다름', () => {
    expect(mergePost(T, ai(), { fields: { title: 'mine' }, seenAI: 'U1' }, 7).newAIDraft).toBe(true)
    expect(mergePost(T, ai(), { fields: { title: 'mine' } }, 7).newAIDraft).toBe(true) // seenAI 없음
    expect(mergePost(T, ai(), { fields: { title: 'mine' }, seenAI: 'U2' }, 7).newAIDraft).toBe(false) // 이미 봄
    expect(mergePost(T, ai(), { fields: { title: 'AI title' }, seenAI: 'U1' }, 7).newAIDraft).toBe(false) // 같은 값
    expect(mergePost(T, ai(), { fields: {}, seenAI: 'U1' }, 7).newAIDraft).toBe(false) // 고친 것 없음
    expect(mergePost(T, ai({ updated: undefined }), { fields: { title: 'm' }, seenAI: '' }, 7).newAIDraft).toBe(false) // ai.updated 없음
    expect(mergePost(T, null, { fields: { title: 'm' }, seenAI: '' }, 7).newAIDraft).toBe(false)
    expect(mergePost(T, ai(), { fields: { tags: ['#a'] }, seenAI: 'U1' }, 7).newAIDraft).toBe(false) // 정규화 후 같음
    expect(mergePost(T, ai(), { fields: { scenes: [{ t: 0, text: 'other' }] }, seenAI: 'U1' }, 7).newAIDraft).toBe(true)
    // AI 쪽에 없는 항목은 비교하지 않음
    expect(mergePost(T, ai({ title: undefined, scenes: undefined }), { fields: { title: 'mine', scenes: [{ t: 1, text: 'x' }] }, seenAI: 'U1' }, 7).newAIDraft).toBe(false)
    expect(mergePost(T, ai({ title: undefined }), { fields: { title: 'mine', body: 'other' }, seenAI: 'U1' }, 7).newAIDraft).toBe(true)
  })
  test('staleVersion / baseVersion', () => {
    expect(mergePost(T, ai(), null, 7).staleVersion).toBe(false)
    expect(mergePost(T, ai(), null, 8)).toMatchObject({ staleVersion: true, baseVersion: 7 })
    expect(mergePost(T, ai(), { fields: { title: 'm' }, version: 9, seenAI: 'U2' }, 9)).toMatchObject({ baseVersion: 9, staleVersion: false })
    expect(mergePost(T, ai(), { fields: { title: 'm' }, version: 3, seenAI: 'U2' }, 8).baseVersion).toBe(7) // 큰 값
    expect(mergePost(T, ai(), { fields: {}, version: 99, seenAI: 'U2' }, 7).baseVersion).toBe(7) // 고친 것 없으면 user.version 무시
    expect(mergePost(T, null, null, null).staleVersion).toBe(false)
  })
  test('extras 항목별 병합·정렬·newAIDraft', () => {
    const a = ai({ extras: [{ id: 'z', label: 'Z', text: 'zt' }, { id: 'a', label: 'A', text: 'at' }] })
    const v = mergePost(T, a, { fields: { extras: { a: { text: 'mine' }, m: { label: 'M', text: 'mt' }, k: { text: 'kt' } } }, seenAI: 'U2' }, 7)
    expect(v.extras).toEqual([{ id: 'z', label: 'Z', text: 'zt' }, { id: 'a', label: 'A', text: 'mine' }, { id: 'k', label: 'k', text: 'kt' }, { id: 'm', label: 'M', text: 'mt' }])
    expect(v.extrasFromUser.sort()).toEqual(['a', 'k', 'm'])
    expect(v.userEdited).toBe(true)
    expect(v.newAIDraft).toBe(false)
    expect(mergePost(T, a, { fields: { extras: { a: { text: 'mine' } } }, seenAI: 'U1' }, 7).newAIDraft).toBe(true)
    expect(mergePost(T, a, { fields: { extras: { a: { text: 'at' } } }, seenAI: 'U1' }, 7).newAIDraft).toBe(false)
    expect(mergePost(T, a, { fields: { extras: { m: { text: 'person only' } } }, seenAI: 'U1' }, 7).newAIDraft).toBe(false) // 사람만 가진 extra
    expect(mergePost(T, a, { fields: { extras: {} }, seenAI: 'U1' }, 7)).toMatchObject({ userEdited: false, newAIDraft: false })
    expect(mergePost(T, a, { fields: { extras: { bad: 1, '../x': { text: 'x' } } }, seenAI: 'U1' }, 7).userEdited).toBe(false)
  })
  test('normalize 도우미', () => {
    expect(normalizeTags(['#a', ' b ', '', '#', 3])).toEqual(['a', 'b'])
    expect(normalizeScenes([{ t: 2, text: 'b' }, { t: 1, text: 'a' }, { t: -1, text: 'x' }, { t: 1, text: 5 }, null])).toEqual([{ t: 1, text: 'a' }, { t: 2, text: 'b' }])
    const ex = normalizeExtras([{ id: 'a', text: 'x', label: 'l'.repeat(60) }, { id: 'a', text: 'dup' }, { id: 'B', text: 'x' }, { id: 'c' }, ...Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, text: 't' }))])
    expect(ex[0]!.label.length).toBe(40)
    expect(ex.length).toBe(20)
    expect(ex.map(e => e.id)).not.toContain('B')
  })
  test('getPosts: 업로드용 버전 반영(지정 없음 = 최신 v2) + 파일 읽기', async () => {
    put('.clipment/posts/youtube-shorts/ai.json', ai({ version: 1 }))
    put('.clipment/posts/youtube-shorts/user.json', { fields: { title: 'mine' }, seenAI: 'U1', version: 1 })
    const g = await getPosts('p')
    expect(g.uploadVersion).toBe(2)
    expect(g.posts[0]).toMatchObject({ target: 'youtube-shorts', title: 'mine', staleVersion: true, newAIDraft: true, baseVersion: 1 })
    expect(g.posts[1]).toMatchObject({ target: 'instagram-reels', title: null })
  })
})

describe('요청 write_post', () => {
  const mk = (over: Record<string, unknown> = {}) => {
    const id = uid()
    appWrite(root, 'p', `requests/${id}.json`, { schema: 1, type: 'write_post', version: 2, commentIds: null, agent: '', message: 'rm -rf ~', created: iso(), ...over })
    return id
  }
  test('화이트리스트: targets 정규화(잘못된 id·중복 제거), 다른 type 은 targets 없음, 모르는 type 무시', async () => {
    const a = mk({ targets: ['youtube-shorts', '../x', 'youtube-shorts', 5, 'Bad'] }), b = mk({}), c = mk({ targets: 'nope' })
    const o = mk({ type: 'apply_feedback', targets: ['x'] }), bad = mk({ type: 'write_posts' })
    const rs = new Map((await listRequests('p')).map(r => [r.id, r]))
    expect(rs.get(a)).toMatchObject({ type: 'write_post', targets: ['youtube-shorts'], state: 'pending', message: 'rm -rf ~' })
    expect(rs.get(b)!.targets).toEqual([])
    expect(rs.get(c)!.targets).toEqual([])
    expect('targets' in rs.get(o)!).toBe(false)
    expect(rs.has(bad)).toBe(false)
    expect((await pendingRequests('p')).length).toBe(4)
  })
  test('잠긴 프로젝트·더 새 계약은 가져가지 않음', async () => {
    mk()
    await setLock('p', 'locked', { author: 'user' })
    expect(await pendingRequests('p')).toEqual([])
  })
  test('더 새 계약 워크스페이스는 가져가지 않음', async () => {
    mk()
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({ schema: 1, name: 'x', contract: '2.0' }))
    expect(await pendingRequests('p', null, () => {})).toEqual([])
  })
  test('postsForRequest: 비면 보이는 대상 전체(숨김 제외), 지정하면 그것만, 목록에 없거나 숨긴 id 는 건너뜀', async () => {
    put('.clipment/posts/targets.json', { schema: 1, targets: [{ id: 'youtube-shorts' }, { id: 'cafe', name: 'C' }, { id: 'tiktok', hidden: true }] })
    put('.clipment/posts/cafe/ai.json', { schema: 1, version: 2, title: 'cafe t', updated: 'U' })
    const all = await postsForRequest('p', { targets: [] })
    expect(all.targets.map(t => t.id)).toEqual(['youtube-shorts', 'cafe'])
    expect(all.posts.map(x => x.title)).toEqual([null, 'cafe t'])
    expect(all.skippedTargets).toEqual([])
    const some = await postsForRequest('p', { targets: ['cafe', 'tiktok', 'nope'] })
    expect(some.targets.map(t => t.id)).toEqual(['cafe'])
    expect(some.skippedTargets).toEqual(['tiktok', 'nope'])
    expect((await postsForRequest('p', {})).posts.length).toBe(2)
  })
  test('알림 문구와 미처리 요약에 write_post', async () => {
    const id = mk({ targets: ['cafe'] })
    const r = (await pendingRequests('p')).find(x => x.id === id)!
    expect(notificationBody(r, 0)).toBe('새 요청 · p v2 · 업로드 글 (cafe)')
    expect(unclaimedLine(r)).toContain('write_post')
  })
  test('데몬: write_post 는 코멘트 수를 세지 않고 자동 실행 대상 아님', async () => {
    const { AUTO_TYPES } = await import('../src/daemon/autorun.ts')
    expect((AUTO_TYPES as readonly string[]).includes('write_post')).toBe(false)
    expect(typeof Daemon).toBe('function')
  })
})
