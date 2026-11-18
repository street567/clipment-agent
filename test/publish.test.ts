import { beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addReply, extractFrame, getVersion, initProject, listVersions, previewPath, probe, publishVersion, setDownloader, targetSize,
} from '../src/core/index.ts'
import { appWrite, iso, tempRoot, uid } from './helpers.ts'

const FF = '/opt/homebrew/bin/ffmpeg'
let dir: string
let landscape: string
let rotated: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cliprev-media-'))
  landscape = join(dir, 'land.mp4')
  rotated = join(dir, 'rot.mp4')
  const base = ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']
  expect(spawnSync(FF, [...base, landscape]).status).toBe(0)
  // DJI 세로처럼 1920x1080 픽셀 + display matrix rotation -90
  expect(spawnSync(FF, ['-y', '-v', 'error', '-display_rotation', '90', '-i', landscape, '-c', 'copy', rotated]).status).toBe(0)
})

describe('targetSize', () => {
  test('rotation swaps', () => {
    expect(targetSize({ width: 3840, height: 2160, rotation: -90 })).toMatchObject({ width: 720, height: 1280 })
    expect(targetSize({ width: 3840, height: 2160, rotation: 0 })).toMatchObject({ width: 1280, height: 720 })
    expect(targetSize({ width: 640, height: 360, rotation: 0 })).toMatchObject({ width: 640, height: 360 })
  })
})

describe('publish', () => {
  test('landscape: v001 then v002, atomic dirs, meta, frame', async () => {
    tempRoot(); setDownloader(null)
    await initProject('demo')
    const m1 = await publishVersion('demo', landscape, { note: '첫 컷' })
    expect(m1).toMatchObject({ version: 1, label: 'v001', file: 'preview.mp4', width: 1280, height: 720, note: '첫 컷', source: 'land.mp4' })
    expect(m1.duration).toBeGreaterThan(1.5)
    const m2 = await publishVersion('demo', landscape)
    expect(m2.version).toBe(2)
    const vdir = join(process.env.CLIPREV_ROOT!, 'demo', 'versions')
    expect(readdirSync(vdir).sort()).toEqual(['v001', 'v002'])
    expect(readdirSync(join(vdir, 'v001')).sort()).toEqual(['meta.json', 'preview.mp4'])
    expect((await listVersions('demo')).map(v => v.version)).toEqual([1, 2])
    const p = await probe(previewPath('demo', 1))
    expect(p.fps).toBeCloseTo(30, 0)
    const jpg = await extractFrame('demo', 1, 1.0)
    expect(jpg[0]).toBe(0xff)
    expect(jpg[1]).toBe(0xd8)
    expect((await getVersion('demo', 1))!.label).toBe('v001')
  })
  test('rotated source ends up 720x1280', async () => {
    tempRoot(); setDownloader(null)
    await initProject('rot')
    const src = await probe(rotated)
    expect(Math.abs(src.rotation)).toBe(90)
    const m = await publishVersion('rot', rotated)
    expect(m.width).toBe(720)
    expect(m.height).toBe(1280)
    const out = await probe(previewPath('rot', 1))
    expect([out.width, out.height, out.rotation]).toEqual([720, 1280, 0])
  })
  test('missing project / file rejected', async () => {
    tempRoot()
    await expect(publishVersion('nope', landscape)).rejects.toThrow()
    await initProject('demo')
    await expect(publishVersion('demo', join(dir, 'none.mp4'))).rejects.toThrow()
    expect(existsSync(join(process.env.CLIPREV_ROOT!, 'demo', 'versions', 'v001'))).toBe(false)
  })
})
