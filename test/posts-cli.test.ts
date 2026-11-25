import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initProject } from '../src/core/index.ts'
import { appWrite, iso, tempRoot } from './helpers.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')
function run(root: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, CLIPREV_ROOT: root, CLIPREV_CONFIG: join(root, '..', 'cfg-' + Math.random() + '.json'), CLIPREV_AGENT: 'codex' } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

describe('CLI posts', () => {
  test('post-write / posts / post-targets', async () => {
    const root = tempRoot()
    await initProject('demo')
    appWrite(root, 'demo', 'versions/v001/meta.json', { schema: 1, version: 1, label: 'v001', file: 'preview.mp4', duration: 1, fps: 30, width: 1, height: 1, note: '', source: '', created: iso() })
    const w = run(root, 'post-write', 'demo', 'youtube-shorts', '--version', '1', '--title', 'Hello', '--body', 'Line', '--tags', '#a,b', '--scenes', '[{"t":2,"text":"x"},{"t":0,"text":"y"}]', '--extras', '[{"id":"pin","text":"P"}]', '--json')
    expect(w.code).toBe(0)
    const f = JSON.parse(readFileSync(join(root, 'demo/.clipment/posts/youtube-shorts/ai.json'), 'utf8'))
    expect(f).toMatchObject({ title: 'Hello', tags: ['a', 'b'], author: 'codex', extras: [{ id: 'pin', text: 'P' }] })
    expect(f.scenes[0].t).toBe(0)
    const p = JSON.parse(run(root, 'posts', 'demo', '--json').out)
    expect(p.posts[0]).toMatchObject({ target: 'youtube-shorts', title: 'Hello' })
    expect(run(root, 'posts', 'demo').out).toContain('제목: Hello')
    expect(run(root, 'post-write', 'demo', '../x', '--version', '1', '--title', 'x').code).not.toBe(0)
    expect(run(root, 'post-write', 'demo', 'youtube-shorts', '--title', 'x').code).not.toBe(0)
    expect(run(root, 'post-targets', 'demo', 'add', 'cafe', '--name', '카페').code).toBe(0)
    const t = JSON.parse(run(root, 'post-targets', 'demo', '--json').out)
    expect(t.targets.map((x: any) => x.id)).toEqual(['youtube-shorts', 'instagram-reels', 'cafe'])
    expect(run(root, 'post-targets', 'demo', 'reorder', 'cafe', 'youtube-shorts').code).not.toBe(0)
    expect(run(root, 'post-targets', 'demo', 'reorder', 'cafe', 'youtube-shorts', 'instagram-reels').code).toBe(0)
    expect(run(root, 'post-targets', 'demo').out).toContain('카페')
  })
})
