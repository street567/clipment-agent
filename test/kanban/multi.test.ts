import { afterEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { routeWorkspace, normalizeWorkspaces } from '../../src/kanban/config.ts'
import { PLUGIN, runHook, setup, SID } from './helpers.ts'

process.env.AGENT_KANBAN_NO_DOWNLOAD = '1'
const clients: Client[] = []
afterEach(async () => { while (clients.length) await clients.pop()!.close().catch(() => {}) })
async function connect(env: Record<string, string>) {
  const t = new StdioClientTransport({ command: process.execPath, args: [join(PLUGIN, 'src/kanban/mcp.ts')], env, stderr: 'ignore' })
  const c = new Client({ name: 'test', version: '1' })
  await c.connect(t)
  clients.push(c)
  return async (name: string, args: any = {}) => {
    const r: any = await c.callTool({ name, arguments: args })
    return { err: !!r.isError, j: JSON.parse(r.content[0].text) }
  }
}
const ws = (root: string, includePaths: string[] = [], extra: any = {}) => ({ root, board: 'main', includePaths, excludePaths: [], ...extra })
const hookAt = (e: any, cwd: string, sid = SID) => runHook(e, { session_id: sid, transcript_path: '/nonexistent/t.jsonl', cwd, hook_event_name: 'SessionStart', source: 'startup' })
const files = (dir: string): string[] => { try { return readdirSync(dir, { recursive: true }).map(String) } catch { return [] } }
const hasSession = (root: string) => files(join(root, 'boards', 'main')).some((f) => f.includes(SID.slice(0, 8)) || f.startsWith('sessions') || f.startsWith('cards'))

describe('routeWorkspace', () => {
  const A = ws('/r/a'), B = ws('/r/b', ['/p/b']), C = ws('/r/c', ['/p/b/sub'])
  test('범위가 있는 두 워크스페이스: 가장 긴 접두사', () => {
    const all = { workspaces: [B, C], excludePaths: [] }
    expect(routeWorkspace(all, '/p/b/x').workspace?.root).toBe('/r/b')
    expect(routeWorkspace(all, '/p/b/sub/x').workspace?.root).toBe('/r/c')
    expect(routeWorkspace(all, '/p/other').workspace).toBeUndefined()
  })
  test('기본 + 범위', () => {
    const all = { workspaces: [A, B], excludePaths: [] }
    expect(routeWorkspace(all, '/p/b').workspace?.root).toBe('/r/b')
    expect(routeWorkspace(all, '/elsewhere').workspace?.root).toBe('/r/a')
    expect(routeWorkspace(all, undefined).workspace?.root).toBe('/r/a')
  })
  test('기본이 둘이면 모호 → 추적 안 함', () => {
    const r = routeWorkspace({ workspaces: [A, ws('/r/a2')], excludePaths: [] }, '/x')
    expect(r.workspace).toBeUndefined()
    expect(r.ambiguous).toBe(true)
  })
  test('같은 includePaths 가 둘이면 모호', () => {
    expect(routeWorkspace({ workspaces: [B, ws('/r/b2', ['/p/b'])], excludePaths: [] }, '/p/b/x').ambiguous).toBe(true)
  })
  test('exclude: 전역·워크스페이스별', () => {
    expect(routeWorkspace({ workspaces: [A], excludePaths: ['/x/skip'] }, '/x/skip/y').workspace).toBeUndefined()
    expect(routeWorkspace({ workspaces: [ws('/r/a', [], { excludePaths: ['/x/skip'] })], excludePaths: [] }, '/x/skip').workspace).toBeUndefined()
    expect(routeWorkspace({ workspaces: [A], excludePaths: ['/x/skip'] }, '/x/ok').workspace?.root).toBe('/r/a')
  })
  test('legacy root 정규화 + 중복 제거', () => {
    const w = normalizeWorkspaces({ root: '/r/a', includePaths: ['/p'], workspaces: [{ root: '/r/a/' }, { root: '/r/z' }] })
    expect(w.map((x) => x.root)).toEqual(['/r/a', '/r/z'])
    expect(normalizeWorkspaces({ root: '/r/a', board: 'x', includePaths: ['/p'] })[0]).toMatchObject({ board: 'x', includePaths: ['/p'] })
  })
})

describe('hook 라우팅', () => {
  test('범위 안 → B root 만, 밖 → A, 추적 안 함 → 아무것도 안 씀', async () => {
    const e = setup(null as any)
    const a = join(e.dir, 'A'), b = join(e.dir, 'B'), pb = join(e.dir, 'projB')
    mkdirSync(a); mkdirSync(b); mkdirSync(pb)
    writeFileSync(e.cfgPath, JSON.stringify({ enabled: true, workspaces: [ws(a), ws(b, [pb])] }))
    expect((await hookAt(e, join(pb, 'x'))).code).toBe(0)
    expect(files(b).length).toBeGreaterThan(0)
    expect(files(a)).toEqual([])
    const sid2 = '3bd65158-0726-4cee-bfdc-c38ff9c05a98'
    await hookAt(e, '/Users/me/other', sid2)
    expect(files(a).length).toBeGreaterThan(0)
  })
  test('기본 둘 → 조용히 무시 + status 경고', async () => {
    const e = setup(null as any)
    const a = join(e.dir, 'A'), b = join(e.dir, 'B')
    mkdirSync(a); mkdirSync(b)
    writeFileSync(e.cfgPath, JSON.stringify({ enabled: true, workspaces: [ws(a), ws(b)] }))
    const r = await hookAt(e, '/Users/me/x')
    expect(r.code).toBe(0); expect(r.stdout).toBe('')
    expect(files(a)).toEqual([]); expect(files(b)).toEqual([])
    const call = await connect(e.env)
    const s = await call('kanban_status')
    expect(s.j.current.tracked).toBe(false)
    expect(s.j.warnings.join(' ')).toContain('기본 워크스페이스')
  })
  test('legacy root 만 있는 설정은 그대로 동작', async () => {
    const e = setup({})
    await hookAt(e, '/Users/me/proj')
    expect(files(e.root).length).toBeGreaterThan(0)
  })
  test('AGENT_KANBAN_ROOT 는 단일 워크스페이스 override', async () => {
    const e = setup(null as any)
    const a = join(e.dir, 'A'), o = join(e.dir, 'O')
    mkdirSync(a); mkdirSync(o)
    writeFileSync(e.cfgPath, JSON.stringify({ enabled: true, workspaces: [ws(a)] }))
    await runHook(e, { session_id: SID, transcript_path: '/n', cwd: '/x', hook_event_name: 'SessionStart', source: 'startup' }, { AGENT_KANBAN_ROOT: o })
    expect(files(o).length).toBeGreaterThan(0)
    expect(files(a)).toEqual([])
  })
})

describe('kanban_setup / status / remove (다중)', () => {
  test('created → needsScope(변경 없음) → added → updated → remove', async () => {
    const e = setup(null as any)
    const a = join(e.dir, 'A'), b = join(e.dir, 'B'), pb = join(e.dir, 'projB')
    mkdirSync(a); mkdirSync(b); mkdirSync(pb)
    const call = await connect(e.env)
    const r1 = await call('kanban_setup', { root: a, name: '개인' })
    expect(r1.j).toMatchObject({ result: 'created', workspaces: [{ name: '개인', root: a, includePaths: [] }] })
    const before = readFileSync(e.cfgPath, 'utf8')
    const r2 = await call('kanban_setup', { root: b, name: '회사' })
    expect(r2.err).toBe(false)
    expect(r2.j.result).toBe('needsScope')
    expect(r2.j.existingWorkspaces[0]).toMatchObject({ name: '개인', root: a })
    expect(readFileSync(e.cfgPath, 'utf8')).toBe(before)
    expect(existsSync(e.cfgPath + '.bak')).toBe(false)
    const r3 = await call('kanban_setup', { root: b, name: '회사', includePaths: [pb] })
    expect(r3.j.result).toBe('added')
    expect(readFileSync(e.cfgPath + '.bak', 'utf8')).toBe(before)
    expect(r3.j.workspaces.length).toBe(2)
    expect((await call('kanban_setup', { root: b, includePaths: [pb] })).j.result).toBe('unchanged')
    expect((await call('kanban_setup', { root: b, name: '회사2' })).j.result).toBe('updated')
    const st = await call('kanban_status')
    expect(st.j.workspaces.map((w: any) => w.root)).toEqual([a, b])
    expect(st.j.workspaces[0]).toMatchObject({ reachable: true, hasKanbanJson: true, isDefault: true })
    // remove
    const x1 = await call('kanban_remove', { root: b })
    expect(x1.err).toBe(true); expect(x1.j.result).toBe('refused')
    expect(JSON.parse(readFileSync(e.cfgPath, 'utf8')).workspaces.length).toBe(2)
    const x2 = await call('kanban_remove', { root: b, confirm: true })
    expect(x2.j).toMatchObject({ result: 'removed', defaultRemoved: false })
    expect(existsSync(join(b, 'kanban.json'))).toBe(true)
    const x3 = await call('kanban_remove', { root: a, confirm: true })
    expect(x3.j.defaultRemoved).toBe(true)
  })
  test('legacy 설정에 추가하면 workspaces 로 옮기고 전역 옵션은 유지', async () => {
    const e = setup({ includeHeadless: true, excludePaths: ['/skip'] })
    const b = join(e.dir, 'B'), pb = join(e.dir, 'projB')
    mkdirSync(b)
    const call = await connect(e.env)
    expect((await call('kanban_setup', { root: b, includePaths: [pb] })).j.result).toBe('added')
    const raw = JSON.parse(readFileSync(e.cfgPath, 'utf8'))
    expect(raw.root).toBeUndefined()
    expect(raw.workspaces.map((w: any) => w.root)).toEqual([e.root, b])
    expect(raw).toMatchObject({ includeHeadless: true, excludePaths: ['/skip'] })
  })
  test('confirmReplace: 기본 워크스페이스 root 교체', async () => {
    const e = setup({})
    const b = join(e.dir, 'B'); mkdirSync(b)
    const call = await connect(e.env)
    const r = await call('kanban_setup', { root: b, confirmReplace: true })
    expect(r.j.result).toBe('replaced')
    expect(r.j.workspaces.map((w: any) => w.root)).toEqual([b])
  })
})
