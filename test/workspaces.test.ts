import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  addReply, addWorkspace, currentLock, initProject, listComments, listProjects, pendingRequests, removeWorkspace, resolveProject,
  rootDir, setLock, ValidationError, waitForRequests, workspaces, workspaceStatuses, listRequests, publishVersion, DEFAULT_ROOT,
} from '../src/core/index.ts'
import { iso, uid } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')
let tmp: string, cfg: string, a: string, b: string
const saved = { ...process.env }

function put(root: string, slug: string, rel: string, obj: unknown) {
  const p = join(root, slug, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify(obj))
}
const req = (root: string, slug: string, over: Record<string, unknown> = {}) => {
  const id = uid()
  put(root, slug, `requests/${id}.json`, { schema: 1, type: 'apply_feedback', version: 1, commentIds: null, agent: 'claude', message: '', created: iso(), ...over })
  return id
}
const writeCfg = (list: unknown[]) => writeFileSync(cfg, JSON.stringify({ workspaces: list }))

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cliprev-ws-'))
  cfg = join(tmp, 'cfg', 'workspaces.json')
  a = join(tmp, 'icloud'); b = join(tmp, 'gdrive')
  mkdirSync(a); mkdirSync(b)
  delete process.env.CLIPREV_ROOT
  delete process.env.CLIPREV_ALLOW_AUTHORS
  process.env.CLIPREV_CONFIG = cfg
})
afterEach(() => { process.env = { ...saved } })

describe('config precedence', () => {
  test('default when nothing set', () => {
    expect(workspaces().map(w => w.path)).toEqual([DEFAULT_ROOT])
  })
  test('config beats default; CLIPREV_ROOT beats config', () => {
    mkdirSync(join(tmp, 'cfg'))
    writeCfg([{ name: 'a', path: a }, { name: 'b', path: b, allowAuthors: ['개미'] }])
    expect(workspaces().map(w => w.name)).toEqual(['a', 'b'])
    expect(workspaces()[1]!.allowAuthors).toEqual(['개미'])
    process.env.CLIPREV_ROOT = b
    expect(workspaces().map(w => w.path)).toEqual([b])
    expect(rootDir()).toBe(b)
  })
})

describe('workspaces add/remove', () => {
  test('add creates config + workspace.json; remove keeps files', async () => {
    const w = await addWorkspace(a, { name: 'icloud', allowAuthors: ['개미', '나'] })
    expect(w.name).toBe('icloud')
    expect(JSON.parse(readFileSync(cfg, 'utf8')).workspaces[0].allowAuthors).toEqual(['개미', '나'])
    const wj = JSON.parse(readFileSync(join(a, 'workspace.json'), 'utf8'))
    expect(wj.schema).toBe(1)
    await expect(addWorkspace(b, { name: 'icloud' })).rejects.toThrow('이미')
    await addWorkspace(b)
    expect(workspaces().map(x => x.name)).toEqual(['icloud', 'gdrive'])
    removeWorkspace('icloud')
    expect(workspaces().map(x => x.name)).toEqual(['gdrive'])
    expect(existsSync(join(a, 'workspace.json'))).toBe(true)
    expect(() => removeWorkspace('nope')).toThrow(ValidationError)
  })
  test('existing workspace.json is not overwritten', async () => {
    writeFileSync(join(a, 'workspace.json'), '{"schema":1,"name":"내 작업"}')
    await addWorkspace(a)
    expect(JSON.parse(readFileSync(join(a, 'workspace.json'), 'utf8')).name).toBe('내 작업')
  })
  test('path containing project.json is rejected', async () => {
    writeFileSync(join(a, 'project.json'), '{}')
    await expect(addWorkspace(a)).rejects.toThrow('프로젝트 폴더가 아니라 워크스페이스 폴더를 지정하세요')
  })
  test('status lists reachable and project count; listing ignores workspace.json/dot entries', async () => {
    mkdirSync(join(tmp, 'cfg'))
    writeCfg([{ name: 'a', path: a }, { name: 'gone', path: join(tmp, 'missing') }])
    await initProject('a/one')
    put(a, '.hidden', 'project.json', { schema: 1 })
    mkdirSync(join(a, 'plain'))
    const st = await workspaceStatuses()
    expect(st.map(s => [s.name, s.reachable, s.projects])).toEqual([['a', true, 1], ['gone', false, 0]])
    expect((await listProjects()).map(p => p.ref)).toEqual(['a/one'])
    expect(existsSync(join(a, 'workspace.json'))).toBe(true) // init 이 생성
  })
})

describe('project resolution', () => {
  beforeEach(async () => {
    mkdirSync(join(tmp, 'cfg'))
    writeCfg([{ name: 'a', path: a }, { name: 'b', path: b }])
    await initProject('a/shared'); await initProject('b/shared'); await initProject('b/solo')
  })
  test('qualified, bare unique, ambiguous', () => {
    expect(resolveProject('b/shared').dir).toBe(join(b, 'shared'))
    expect(resolveProject('solo').workspace.name).toBe('b')
    expect(() => resolveProject('shared')).toThrow(/a\/shared, b\/shared/)
    expect(() => resolveProject('zzz/solo')).toThrow('알 수 없는 워크스페이스')
    expect(() => resolveProject('nothing')).toThrow('프로젝트 없음')
    expect(() => resolveProject('a/../x')).toThrow(ValidationError)
  })
  test('listProjects spans workspaces with prefix', async () => {
    expect((await listProjects()).map(p => p.ref).sort()).toEqual(['a/shared', 'b/shared', 'b/solo'])
  })
  test('bare init with several workspaces needs qualification', async () => {
    await expect(initProject('newone')).rejects.toThrow('워크스페이스')
  })
})

describe('multi-workspace wait + allowlist', () => {
  beforeEach(async () => {
    mkdirSync(join(tmp, 'cfg'))
    writeCfg([{ name: 'a', path: a }, { name: 'b', path: b, allowAuthors: ['개미'] }])
    await initProject('a/p1'); await initProject('b/p2'); await initProject('b/p1')
  })
  test('collects across workspaces with workspace names; ambiguous slug is qualified', async () => {
    const r1 = req(a, 'p1'); const r2 = req(b, 'p2', { authorName: '개미' })
    const got = await pendingRequests()
    expect(got.map(r => r.id).sort()).toEqual([r1, r2].sort())
    const g1 = got.find(r => r.id === r1)!, g2 = got.find(r => r.id === r2)!
    expect([g1.workspace, g1.project]).toEqual(['a', 'a/p1'])
    expect([g2.workspace, g2.project]).toEqual(['b', 'p2'])
    const w = await waitForRequests({ timeoutSec: 1, pollMs: 50 })
    expect(w.length).toBe(2)
  })
  test('per-workspace allowAuthors overrides env', async () => {
    process.env.CLIPREV_ALLOW_AUTHORS = '나'
    const okA = req(a, 'p1', { authorName: '나' })   // a: env 적용
    const noA = req(a, 'p1', { authorName: '개미' })
    const okB = req(b, 'p2', { authorName: '개미' }) // b: 워크스페이스 목록 적용
    const noB = req(b, 'p2', { authorName: '나' })
    const ids = (await pendingRequests()).map(r => r.id)
    expect(ids.sort()).toEqual([okA, okB].sort())
    expect(ids).not.toContain(noA); expect(ids).not.toContain(noB)
  })
  test('project-scoped wait accepts qualified id', async () => {
    req(a, 'p1'); const r = req(b, 'p1', { authorName: '개미' })
    expect((await pendingRequests('b/p1')).map(x => x.id)).toEqual([r])
  })
})

describe('completion lock', () => {
  beforeEach(async () => {
    process.env.CLIPREV_ROOT = a
    await initProject('demo')
  })
  test('latest event wins; locked excludes requests, refuses reply/publish unless force', async () => {
    expect(await currentLock('demo')).toBeNull()
    const cid = uid()
    put(a, 'demo', `comments/${cid}.json`, { schema: 1, version: 1, t: 1, end: null, tag: 'cut', text: 'x', author: 'user', created: iso() })
    const rid = req(a, 'demo')
    await setLock('demo', 'locked', { author: 'claude', note: '최종본 v003' })
    expect((await currentLock('demo'))?.note).toBe('최종본 v003')
    expect(await pendingRequests()).toEqual([])
    expect((await listProjects())[0]!.locked).toBe(true)
    await expect(addReply('demo', cid, { text: 'hi', author: 'claude' })).rejects.toThrow('잠긴')
    await expect(publishVersion('demo', '/nonexistent.mp4')).rejects.toThrow('잠긴')
    const r = await addReply('demo', cid, { text: 'hi', author: 'claude', force: true })
    expect(r.text).toBe('hi')
    expect((await listComments('demo')).length).toBe(1)
    await setLock('demo', 'unlocked', { author: 'user' })
    expect(await currentLock('demo')).toBeNull()
    expect((await pendingRequests()).map(x => x.id)).toEqual([rid])
    expect((await listRequests('demo')).length).toBe(1)
  })
  test('cli lock/unlock/requests/reply --force', async () => {
    const cid = uid()
    put(a, 'demo', `comments/${cid}.json`, { schema: 1, version: 1, t: 1, end: null, tag: 'cut', text: 'x', author: 'user', created: iso() })
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env: process.env as Record<string, string>, encoding: 'utf8' })
    expect(run('lock', 'demo', '--note', '끝').status).toBe(0)
    expect(run('projects').stdout).toContain('잠금')
    const denied = run('reply', 'demo', cid, 'hello')
    expect(denied.status).toBe(1)
    expect(denied.stderr).toContain('잠긴')
    const forced = run('reply', 'demo', cid, 'hello', '--force')
    expect(forced.status).toBe(0)
    expect(forced.stderr).toContain('경고')
    expect(run('unlock', 'demo').status).toBe(0)
    expect(run('reply', 'demo', cid, 'again').status).toBe(0)
  })
  test('cli workspaces add rejects project folder', () => {
    process.env.CLIPREV_CONFIG = cfg
    const r = spawnSync(process.execPath, [CLI, 'workspaces', 'add', join(a, 'demo')], { env: process.env as Record<string, string>, encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('워크스페이스 폴더를 지정하세요')
    expect(existsSync(cfg)).toBe(false)
  })
})
