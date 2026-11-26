import { afterEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN, runHook, setup } from './helpers.ts'

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
const cli = async (e: { env: Record<string, string> }, ...args: string[]) => {
  const p = Bun.spawn([process.execPath, join(PLUGIN, 'src/kanban/cli.ts'), ...args], { env: e.env, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(p.stdout).text()
  return { out, code: await p.exited }
}

describe('kanban_setup / kanban_status (설정 없는 세션에서)', () => {
  test('설정 없음 → not set up, hook 은 조용히 종료', async () => {
    const e = setup(null as any)
    const call = await connect(e.env)
    const s = await call('kanban_status')
    expect(s.j.configured).toBe(false)
    expect(s.j.message).toContain('not set up')
    const h = await runHook(e, { hook_event_name: 'SessionStart', session_id: '11111111-2222-4333-8444-555555555555', cwd: '/x' })
    expect(h.code).toBe(0)
    expect(h.stdout).toBe('')
  })

  test('setup → status → 다른 root 는 거부 → confirm 이면 백업', async () => {
    const e = setup(null as any)
    const a = join(e.dir, 'a'), b = join(e.dir, 'b')
    mkdirSync(a); mkdirSync(b)
    const call = await connect(e.env)
    const r1 = await call('kanban_setup', { root: a })
    expect(r1.j.result).toBe('created')
    expect(existsSync(join(a, 'kanban.json'))).toBe(true)
    const s = await call('kanban_status')
    expect(s.j).toMatchObject({ configured: true, root: a, rootReachable: true })
    expect((await call('kanban_setup', { root: a })).j.result).toBe('unchanged')
    const before = readFileSync(e.cfgPath, 'utf8')
    const r2 = await call('kanban_setup', { root: b })
    expect(r2.err).toBe(false)
    expect(r2.j).toMatchObject({ result: 'needsScope', newRoot: b })
    expect(r2.j.existingWorkspaces).toEqual([{ root: a, board: 'main', includePaths: [] }])
    expect(readFileSync(e.cfgPath, 'utf8')).toBe(before)
    expect(existsSync(e.cfgPath + '.bak')).toBe(false)
    const r3 = await call('kanban_setup', { root: b, confirmReplace: true })
    expect(r3.j.result).toBe('replaced')
    expect(readFileSync(e.cfgPath + '.bak', 'utf8')).toBe(before)
    expect(JSON.parse(readFileSync(e.cfgPath, 'utf8')).workspaces[0].root).toBe(b)
  })

  test('없는 폴더는 만들지 않고 거부(create 명시 때만 생성)', async () => {
    const e = setup(null as any)
    const call = await connect(e.env)
    const nope = join(e.dir, 'cloud', 'Kanban')
    const r = await call('kanban_setup', { root: nope })
    expect(r.err).toBe(true)
    expect(existsSync(nope)).toBe(false)
    expect(existsSync(e.cfgPath)).toBe(false)
    expect((await call('kanban_setup', { root: nope, create: true })).j.result).toBe('created')
    expect(existsSync(join(nope, 'kanban.json'))).toBe(true)
  })

  test('깨진 설정 파일도 confirm 없이는 건드리지 않는다', async () => {
    const e = setup(null as any)
    const a = join(e.dir, 'a'); mkdirSync(a)
    writeFileSync(e.cfgPath, '{broken')
    const call = await connect(e.env)
    expect((await call('kanban_setup', { root: a })).j.result).toBe('refused')
    expect(readFileSync(e.cfgPath, 'utf8')).toBe('{broken')
    expect((await call('kanban_setup', { root: a, confirmReplace: true })).j.result).toBe('replaced')
    expect(readFileSync(e.cfgPath + '.bak', 'utf8')).toBe('{broken')
  })

  test('CLI: setup / status --json', async () => {
    const e = setup(null as any)
    const a = join(e.dir, 'a'); mkdirSync(a)
    expect((await cli(e, 'status')).out).toContain('not set up')
    const r = await cli(e, 'setup', '--root', a)
    expect(r.code).toBe(0)
    expect(JSON.parse((await cli(e, 'status', '--json')).out)).toMatchObject({ configured: true, root: a })
    const b = join(e.dir, 'b'); mkdirSync(b)
    const x = await cli(e, 'setup', '--root', b)
    expect(x.code).toBe(3)
    expect((await cli(e, 'setup', '--root', b, '--confirm-replace')).code).toBe(0)
  })
})
