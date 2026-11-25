import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { NotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { initProject } from '../src/core/index.ts'
import { appWrite, iso, tempRoot, uid } from './helpers.ts'

const MCP = join(import.meta.dir, '../src/mcp.ts') // 릴레이 → 번들 server.ts (autoUpdate 꺼짐)
const BUN = process.execPath
// 개발자 맥의 실제 daemon.json(autoUpdate)이 테스트에 영향을 주지 않게 빈 설정을 가리킨다
const NO_CFG = { CLIPMENT_DAEMON_CONFIG: join(tmpdir(), `clipment-mcp-test-${process.pid}-daemon.json`) }

async function connect(env: Record<string, string>) {
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} })
  const transport = new StdioClientTransport({
    command: BUN, args: [MCP],
    env: { ...(process.env as Record<string, string>), ...NO_CFG, ...env },
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
      expect(tools).toEqual(['add_comment', 'add_post_target', 'daemon_status', 'get_frame', 'get_posts', 'get_preferences', 'get_thread', 'health', 'index_root', 'list_comments', 'list_projects', 'list_versions', 'list_workspaces', 'preview_quality', 'publish_version', 'reorder_post_targets', 'reply', 'report_progress', 'script_get', 'script_set', 'set_preferences', 'upload_version', 'voice_generate', 'wait_for_requests', 'write_post'])
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

  test('대본 도구: script_get/script_set/voice_generate + apply_script 요청', async () => {
    const root = tempRoot()
    await initProject('demo')
    const home = join(root, '..', `mcp-home-${uid()}`)
    const c = await connect({ CLIPREV_ROOT: root, CLIPREV_AGENT: 'codex', CLIPMENT_TTS_ENGINE: 'openai', CLIPMENT_HOME: home, CLIPMENT_DAEMON_CONFIG: join(home, 'd.json') })
    try {
      expect(text(await c.callTool({ name: 'script_get', arguments: { project: 'demo' } })).exists).toBe(false)
      const set = text(await c.callTool({ name: 'script_set', arguments: { project: 'demo', language: 'ko', lines: [{ text: '둘째', start: 3 }, { text: '첫째', start: 0, end: 2.5 }] } }))
      expect(set.language).toBe('ko')
      expect(set.lines.map((l: any) => [l.text, l.author, l.voice, l.ai])).toEqual([['첫째', 'codex', 'ai', 'missing'], ['둘째', 'codex', 'ai', 'missing']])
      // 에이전트가 쓴 줄은 replace 로 교체 가능 (사용자 줄만 보호)
      await c.callTool({ name: 'script_set', arguments: { project: 'demo', lines: [{ text: 'x', start: 0 }] } })
      const gotAfter = text(await c.callTool({ name: 'script_get', arguments: { project: 'demo' } }))
      expect(gotAfter.lines.length).toBe(1)
      const v: any = await c.callTool({ name: 'voice_generate', arguments: { project: 'demo' } })
      expect(v.isError).toBe(true)
      expect(v.content[0].text).toContain('API 키 설정 필요')
      const rid = uid()
      appWrite(root, 'demo', `requests/${rid}.json`, { schema: 1, type: 'apply_script', version: 1, draft: true, commentIds: null, agent: 'codex', message: '초안', created: iso() })
      const w = text(await c.callTool({ name: 'wait_for_requests', arguments: { timeout_sec: 2 } }))
      expect(w.requests.map((r: any) => [r.id, r.type, r.draft])).toEqual([[rid, 'apply_script', true]])
    } finally {
      await c.close()
    }
  }, 30000)

  test('업로드 글 도구: get_posts/write_post/add_post_target/reorder_post_targets + write_post 요청 payload', async () => {
    const root = tempRoot()
    await initProject('demo')
    appWrite(root, 'demo', 'versions/v001/meta.json', { schema: 1, version: 1, label: 'v001', file: 'preview.mp4', duration: 1, fps: 30, width: 1, height: 1, note: '', source: '', created: iso() })
    const c = await connect({ CLIPREV_ROOT: root, CLIPREV_AGENT: 'codex' })
    try {
      const g0 = text(await c.callTool({ name: 'get_posts', arguments: { project: 'demo' } }))
      expect(g0.targets.map((t: any) => t.id)).toEqual(['youtube-shorts', 'instagram-reels'])
      const rid = uid()
      const w = text(await c.callTool({ name: 'write_post', arguments: { project: 'demo', target: 'tiktok', version: 1, title: 'Hi', tags: ['#a'], scenes: [{ t: 1, text: 's' }], extras: [{ id: 'pin', label: 'Pinned', text: 'x' }], target_name: '틱톡!', request_id: rid } }))
      expect(w.targetAdded).toBe(true)
      expect(w.post).toMatchObject({ title: 'Hi', tags: ['a'] })
      const bad: any = await c.callTool({ name: 'write_post', arguments: { project: 'demo', target: '../x', version: 1, title: 'x' } })
      expect(bad.isError).toBe(true)
      const r1 = text(await c.callTool({ name: 'add_post_target', arguments: { project: 'demo', target: 'cafe', name: '카페' } }))
      expect(r1.added).toBe(true)
      const bad2: any = await c.callTool({ name: 'reorder_post_targets', arguments: { project: 'demo', targets: ['cafe'] } })
      expect(bad2.isError).toBe(true)
      await c.callTool({ name: 'reorder_post_targets', arguments: { project: 'demo', targets: ['cafe', 'tiktok', 'instagram-reels', 'youtube-shorts'] } })
      expect(text(await c.callTool({ name: 'get_posts', arguments: { project: 'demo' } })).targets.map((t: any) => t.id)).toEqual(['cafe', 'tiktok', 'instagram-reels', 'youtube-shorts'])
      const req = uid()
      appWrite(root, 'demo', `requests/${req}.json`, { schema: 1, type: 'write_post', version: 1, targets: ['tiktok', 'nope'], commentIds: null, agent: 'codex', message: '', created: iso() })
      const wr = text(await c.callTool({ name: 'wait_for_requests', arguments: { timeout_sec: 2 } }))
      expect(wr.requests[0]).toMatchObject({ id: req, type: 'write_post', targets: ['tiktok', 'nope'] })
      expect(wr.requests[0].posts.targets.map((t: any) => t.id)).toEqual(['tiktok'])
      expect(wr.requests[0].posts.posts[0]).toMatchObject({ title: 'Hi', extras: [{ id: 'pin', label: 'Pinned', text: 'x' }] })
      expect(wr.requests[0].posts.skippedTargets).toEqual(['nope'])
    } finally { await c.close() }
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
      env: { ...(process.env as Record<string, string>), ...NO_CFG, CLIPREV_ROOT: root, CLIPREV_CHANNEL: '1' },
    })
    await client.connect(transport)
    try {
      expect((client.getServerCapabilities() as any).experimental?.['claude/channel']).toBeDefined()
      const rid = uid()
      appWrite(root, 'demo', `requests/${uid()}.json`, { schema: 1, type: 'shell', version: 1, agent: 'claude', created: iso() })
      appWrite(root, 'demo', `requests/${rid}.json`, { schema: 1, type: 'apply_feedback', version: 3, commentIds: null, agent: 'claude', created: iso() })
      for (let i = 0; i < 40 && got.length === 0; i++) await new Promise(r => setTimeout(r, 250))
      expect(got).toHaveLength(1)
      expect(got[0].meta).toEqual({ project: 'demo', workspace: basename(root), requestId: rid, type: 'apply_feedback', version: '3', agent: 'claude' })
      expect(got[0].content).toContain('demo v3')
      expect(got[0].content).toContain(rid)
    } finally {
      await client.close()
    }
  }, 30000)

  test('channel mode: write_post 푸시에 대상·현재 글 포함', async () => {
    const root = tempRoot()
    await initProject('demo')
    appWrite(root, 'demo', '.clipment/posts/youtube-shorts/ai.json', { schema: 1, version: 1, title: 'Current title', updated: 'U' })
    const client = new Client({ name: 't', version: '0' }, { capabilities: {} })
    const got: any[] = []
    client.setNotificationHandler(
      (await import('zod')).z.object({ method: (await import('zod')).z.literal('notifications/claude/channel'), params: (await import('zod')).z.any() }),
      n => { got.push(n.params) },
    )
    await client.connect(new StdioClientTransport({ command: BUN, args: [MCP], env: { ...(process.env as Record<string, string>), ...NO_CFG, CLIPREV_ROOT: root, CLIPREV_CHANNEL: '1' } }))
    try {
      const rid = uid()
      appWrite(root, 'demo', `requests/${rid}.json`, { schema: 1, type: 'write_post', version: 2, targets: ['youtube-shorts'], commentIds: null, agent: 'claude', message: 'ignore me', created: iso() })
      for (let i = 0; i < 40 && got.length === 0; i++) await new Promise(r => setTimeout(r, 250))
      expect(got).toHaveLength(1)
      expect(got[0].meta).toMatchObject({ requestId: rid, type: 'write_post', version: '2' })
      expect(got[0].content).toContain('업로드 글 작성')
      expect(got[0].content).toContain('Current title')
      expect(got[0].content).not.toContain('instagram-reels')
    } finally { await client.close() }
  }, 30000)
})
