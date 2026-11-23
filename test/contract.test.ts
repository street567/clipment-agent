import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addReply, addWorkspace, assertWorkspaceWritable, compat, CONTRACT_STAMP, ensureWorkspaceJson, indexRoot, initProject, listComments,
  newerContractMessage, parseContract, pendingRequests, publishVersion, setLock, SUPPORTED, ValidationError, waitForRequests,
} from '../src/core/index.ts'
import { Daemon } from '../src/daemon/daemon.ts'
import { iso, tempRoot, uid } from './helpers.ts'

const saved = { ...process.env }
let root: string
beforeEach(() => { root = tempRoot(); process.env.CLIPMENT_HOME = join(root, '..', `home-${uid()}`) })
afterEach(() => { process.env = { ...saved } })

const wsJson = (dir: string, contract?: unknown) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ schema: 1, name: 'x', ...(contract === undefined ? {} : { contract }) }))
}
function mkProject(slug = 'p') {
  mkdirSync(join(root, slug, 'requests'), { recursive: true })
  writeFileSync(join(root, slug, 'project.json'), JSON.stringify({ schema: 1, id: slug, title: slug, created: iso() }))
  const id = uid()
  writeFileSync(join(root, slug, 'requests', id + '.json'), JSON.stringify({ schema: 1, type: 'apply_feedback', version: 1, commentIds: null, agent: 'claude', message: '', created: iso() }))
  return id
}

describe('contract.json 동기화', () => {
  test('SUPPORTED == spec/contract.json version', () => {
    const c = JSON.parse(readFileSync(join(import.meta.dir, '../spec/contract.json'), 'utf8'))
    const [maj, min] = String(c.version).split('.').map(Number)
    expect({ major: maj, minor: min }).toEqual({ ...SUPPORTED })
    expect(c.minReaderMajor).toBe(SUPPORTED.major)
  })
})

describe('parse / compat', () => {
  test('parse', () => {
    expect(parseContract('1.6')).toEqual({ major: 1, minor: 6 })
    expect(parseContract('2.0.3')).toEqual({ major: 2, minor: 0 })
    for (const bad of [undefined, null, '', 'abc', 'v1.2', '1', 3, {}]) expect(parseContract(bad)).toEqual({ major: 1, minor: 0 })
  })
  test('compat', () => {
    expect(compat({ major: 1, minor: 0 })).toBe('ok')
    expect(compat({ major: 1, minor: 6 })).toBe('ok')
    expect(compat({ major: 1, minor: 99 })).toBe('newer-minor')
    expect(compat({ major: 2, minor: 0 })).toBe('newer-major')
    expect(compat({ major: 0, minor: 9 })).toBe('ok')
  })
})

describe('쓰는 쪽 스탬프', () => {
  test('ensureWorkspaceJson / init 은 contract 를 찍고, 기존 파일은 안 고친다', async () => {
    const d = join(root, 'new')
    expect(await ensureWorkspaceJson(d)).toBe(true)
    expect(JSON.parse(readFileSync(join(d, 'workspace.json'), 'utf8')).contract).toBe(CONTRACT_STAMP)
    const old = join(root, 'old'); wsJson(old)
    expect(await ensureWorkspaceJson(old)).toBe(false)
    expect(JSON.parse(readFileSync(join(old, 'workspace.json'), 'utf8')).contract).toBeUndefined()
    await initProject('proj1')
    expect(JSON.parse(readFileSync(join(root, 'workspace.json'), 'utf8')).contract).toBe(CONTRACT_STAMP)
  })
  test('workspaces add / index --fix / index.json', async () => {
    const w = join(root, 'ws-add')
    await addWorkspace(w)
    expect(JSON.parse(readFileSync(join(w, 'workspace.json'), 'utf8')).contract).toBe(CONTRACT_STAMP)
    const r = join(root, 'rootx'); mkdirSync(join(r, 'a', 'pp'), { recursive: true })
    writeFileSync(join(r, 'a', 'pp', 'project.json'), '{}')
    const res = await indexRoot(r, { fix: true, register: false })
    expect(res.created).toEqual(['a'])
    expect(JSON.parse(readFileSync(join(r, 'a', 'workspace.json'), 'utf8')).contract).toBe(CONTRACT_STAMP)
    expect(JSON.parse(readFileSync(join(r, '.clipment', 'index.json'), 'utf8')).contract).toBe(CONTRACT_STAMP)
  })
})

describe('더 새 major 워크스페이스', () => {
  test('요청 건너뜀 (경고 1회), 같은 major 상위 minor 는 정상', async () => {
    const id = mkProject()
    wsJson(root, '2.0')
    expect(await pendingRequests(undefined, null, () => {})).toEqual([])
    const msgs: string[] = []
    await pendingRequests(undefined, null, (_w, m) => msgs.push(m))
    expect(msgs[0]).toBe('이 워크스페이스는 더 새 계약(2.0)이에요 · clipment update 필요')
    expect(await waitForRequests({ timeoutSec: 0 })).toEqual([])
    wsJson(root, '1.99')
    expect((await pendingRequests(undefined, null)).map(r => r.id)).toEqual([id])
  })
  test('init/reply/lock/publish 거부 (force 로도)', async () => {
    mkProject(); wsJson(root, '2.1')
    const msg = newerContractMessage({ major: 2, minor: 1 })
    await expect(assertWorkspaceWritable(root)).rejects.toThrow(msg)
    await expect(initProject('np')).rejects.toThrow(ValidationError)
    expect(existsSync(join(root, 'np'))).toBe(false)
    await expect(setLock('p', 'locked', { author: 'claude' })).rejects.toThrow(msg)
    await expect(addReply('p', uid(), { text: 'x', author: 'claude', force: true })).rejects.toThrow(msg)
    await expect(publishVersion('p', '/nonexistent.mp4', { force: true })).rejects.toThrow(msg)
    expect(await listComments('p')).toEqual([]) // 읽기는 가능
  })
  test('CLI requests 는 경고 + 빈 목록', () => {
    mkProject(); wsJson(root, '3.0')
    const r = Bun.spawnSync(['bun', join(import.meta.dir, '../src/cli.ts'), 'requests', 'p', '--json'], { env: process.env })
    expect(r.stdout.toString().trim()).toBe('[]')
    expect(r.stderr.toString()).toContain('더 새 계약(3.0)')
  })
  test('데몬 상태에 contract/compat, 로그는 한 번만', async () => {
    mkProject(); wsJson(root, '2.0')
    const lines: string[] = []
    const logger: any = { log: (_l: string, m: string) => lines.push(m) }
    const d = new Daemon({ logger, noWatch: true, notifier: async () => {}, config: () => ({ notify: false, autoRun: 'off' } as any) })
    await d.tick(); await d.tick()
    expect(lines.filter(m => m.includes('더 새 계약')).length).toBe(1)
    const st = JSON.parse(readFileSync(join(process.env.CLIPMENT_HOME!, 'state.json'), 'utf8'))
    expect(st.workspaces[0]).toMatchObject({ contract: '2.0', compat: 'newer-major', readOnly: true })
  })
})
