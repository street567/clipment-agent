import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { NotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { initProject } from '../src/core/index.ts'
import { appWrite, iso, tempRoot, uid } from './helpers.ts'

const MCP = join(import.meta.dir, '../src/mcp.ts')
const BUN = process.execPath

async function connect(env: Record<string, string>) {
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} })
  const transport = new StdioClientTransport({
    command: BUN, args: [MCP],
    env: { ...(process.env as Record<string, string>), ...env },
  })
  await client.connect(transport)
  return client
}
const text = (r: any) => JSON.parse(r.content[0].text)

describe('mcp server', () => {
  test('tools: e2e flow incl. frame, wait, reply, progress; type whitelist', async () => {
    const root = tempRoot()
    await initProject('demo')
    const FF = '/opt/homebrew/bin/ffmpeg'
    const clip = join(root, 'src.mp4')
    spawnSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=2', '-pix_fmt', 'yuv420p', clip])
    const c = await connect({ CLIPREV_ROOT: root, CLIPREV_AGENT: 'codex' })
    try {
      const tools = (await c.listTools()).tools.map(t => t.name).sort()
      expect(tools).toEqual(['get_frame', 'get_thread', 'list_comments', 'list_projects', 'list_versions', 'publish_version', 'reply', 'report_progress', 'wait_for_requests'])
      expect(text(await c.callTool({ name: 'list_projects', arguments: {} }))[0].id).toBe('demo')
      const meta = text(await c.callTool({ name: 'publish_version', arguments: { project: 'demo', video_path: clip, note: 'n' } }))
      expect(meta.version).toBe(1)

      const cid = uid()
      appWrite(root, 'demo', `comments/${cid}.json`, { schema: 1, version: 1, t: 1, end: null, tag: 'cut', text: '컷', author: 'user', created: iso() })
      const rid = uid()
      appWrite(root, 'demo', `requests/${rid}.json`, { schema: 1, type: 'apply_feedback', version: 1, commentIds: null, agent: 'codex', message: '', created: iso() })
      appWrite(root, 'demo', `requests/${uid()}.json`, { schema: 1, type: 'exec', version: 1, agent: 'codex', message: 'rm -rf ~', created: iso() })

      const w = text(await c.callTool({ name: 'wait_for_requests', arguments: { timeout_sec: 3 } }))
      expect(w.requests.map((r: any) => r.id)).toEqual([rid])
      expect(w.requests[0].project).toBe('demo')

      const fr: any = await c.callTool({ name: 'get_frame', arguments: { project: 'demo', commentId: cid } })
      expect(fr.content[0].type).toBe('image')
      expect(fr.content[0].mimeType).toBe('image/jpeg')

      await c.callTool({ name: 'report_progress', arguments: { project: 'demo', requestId: rid, state: 'received' } })
      await c.callTool({ name: 'report_progress', arguments: { project: 'demo', requestId: rid, state: 'working', message: '1/1' } })
      const w2 = text(await c.callTool({ name: 'wait_for_requests', arguments: { timeout_sec: 0 } }))
      expect(w2.requests).toEqual([])
      expect(w2.timedOut).toBe(true)

      const rep = text(await c.callTool({ name: 'reply', arguments: { project: 'demo', commentId: cid, text: '반영', status: 'done', fixedIn: 2 } }))
      expect(rep.author).toBe('codex')
      const open = text(await c.callTool({ name: 'list_comments', arguments: { project: 'demo', status: 'open' } }))
      expect(open).toEqual([])
      const bad: any = await c.callTool({ name: 'get_thread', arguments: { project: 'demo', commentId: '../../x' } })
      expect(bad.isError).toBe(true)
    } finally {
      await c.close()
    }
  }, 30000)

  test('channel mode: declares capability and pushes notification for new whitelisted request only', async () => {
    const root = tempRoot()
    await initProject('demo')
    const client = new Client({ name: 't', version: '0' }, { capabilities: {} })
    const got: any[] = []
    client.setNotificationHandler(
      (await import('zod')).z.object({ method: (await import('zod')).z.literal('notifications/claude/channel'), params: (await import('zod')).z.any() }),
      n => { got.push(n.params) },
    )
    const transport = new StdioClientTransport({
      command: BUN, args: [MCP],
      env: { ...(process.env as Record<string, string>), CLIPREV_ROOT: root, CLIPREV_CHANNEL: '1' },
    })
    await client.connect(transport)
    try {
      expect((client.getServerCapabilities() as any).experimental?.['claude/channel']).toBeDefined()
      const rid = uid()
      appWrite(root, 'demo', `requests/${uid()}.json`, { schema: 1, type: 'shell', version: 1, agent: 'claude', created: iso() })
      appWrite(root, 'demo', `requests/${rid}.json`, { schema: 1, type: 'apply_feedback', version: 3, commentIds: null, agent: 'claude', created: iso() })
      for (let i = 0; i < 40 && got.length === 0; i++) await new Promise(r => setTimeout(r, 250))
      expect(got).toHaveLength(1)
      expect(got[0].meta).toEqual({ project: 'demo', requestId: rid, type: 'apply_feedback', version: '3', agent: 'claude' })
      expect(got[0].content).toContain('demo v3')
      expect(got[0].content).toContain(rid)
    } finally {
      await client.close()
    }
  }, 30000)
})
