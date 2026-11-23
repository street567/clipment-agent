import { beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initProject, publishVersion, buildEncodeArgs, PRESETS, QUALITY_PRESETS, QUALITIES, setDownloader, targetSize, parseQuality, pickQuality,
  getEffectiveQuality, setProjectQuality, clearProjectQuality, setWorkspaceQuality, getWorkspaceQualityInfo, readQualityDesignation, setLock,
} from '../src/core/index.ts'
import { tempRoot, iso } from './helpers.ts'

const FF = '/opt/homebrew/bin/ffmpeg'
let landscape: string
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'cliprev-q-'))
  landscape = join(dir, 'land.mp4')
  expect(spawnSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', landscape]).status).toBe(0)
})

const CLI = join(import.meta.dir, '../src/cli.ts')
const cli = (...args: string[]) => Bun.spawnSync(['bun', CLI, ...args], { env: process.env })
const out = (r: { stdout: Buffer }) => r.stdout.toString()

describe('presets', () => {
  test('quality table', () => {
    expect(QUALITIES).toEqual(['360p', '540p', '720p', '1080p'])
    expect(QUALITY_PRESETS['360p']).toEqual({ longEdge: 640, crf: 32, maxFps: 30, audioBitrate: '64k' })
    expect(QUALITY_PRESETS['540p']).toEqual({ longEdge: 960, crf: 30, maxFps: 30, audioBitrate: '96k' })
    expect(QUALITY_PRESETS['720p']).toEqual({ longEdge: 1280, crf: 26, maxFps: 60, audioBitrate: '128k' })
    expect(QUALITY_PRESETS['1080p']).toEqual({ longEdge: 1920, crf: 24, maxFps: 60, audioBitrate: '160k' })
  })
  test('aliases: default = 720p, lite = 540p', () => {
    expect(PRESETS.default).toEqual(QUALITY_PRESETS['720p'])
    expect(PRESETS.lite).toEqual(QUALITY_PRESETS['540p'])
    expect(parseQuality('lite')).toBe('540p')
    expect(parseQuality('4k')).toBeNull()
  })
  test('encode args per quality; fps cap; never upscale', () => {
    const src = { width: 1920, height: 1080, rotation: 0, fps: 60, duration: 2 }
    const a = buildEncodeArgs('i', 'o', src, '360p')
    expect(a).toContain('scale=640:360'); expect(a[a.indexOf('-r') + 1]).toBe('30'); expect(a[a.indexOf('-b:a') + 1]).toBe('64k')
    const b = buildEncodeArgs('i', 'o', src, '1080p')
    expect(b).toContain('scale=1920:1080'); expect(b).not.toContain('-r'); expect(b[b.indexOf('-crf') + 1]).toBe('24')
    // 소스가 작으면 키우지 않음
    expect(buildEncodeArgs('i', 'o', { ...src, width: 1280, height: 720 }, '1080p')).toContain('scale=1280:720')
    expect(targetSize({ width: 3840, height: 2160, rotation: -90 }, 640)).toMatchObject({ width: 360, height: 640 })
  })
})

describe('resolution order', () => {
  test('pickQuality pure', () => {
    expect(pickQuality(null, null, null)).toEqual({ quality: '720p', source: 'default' })
    expect(pickQuality(null, null, '1080p')).toEqual({ quality: '1080p', source: 'workspace' })
    expect(pickQuality(null, '360p', '1080p')).toEqual({ quality: '360p', source: 'project' })
    expect(pickQuality('540p', '360p', '1080p')).toEqual({ quality: '540p', source: 'explicit' })
  })

  test('workspace write preserves fields; project override; clear; app-written file; broken file', async () => {
    const root = tempRoot(); setDownloader(null)
    await initProject('q1')
    const wsFile = join(root, 'workspace.json')
    const before = JSON.parse(readFileSync(wsFile, 'utf8'))
    const wsName = root.split('/').pop()!
    expect((await getEffectiveQuality('q1')).source).toBe('default')
    await setWorkspaceQuality(wsName, '1080p')
    const after = JSON.parse(readFileSync(wsFile, 'utf8'))
    expect(after).toMatchObject({ ...before, previewQuality: '1080p' })
    expect(await getEffectiveQuality('q1')).toMatchObject({ quality: '1080p', source: 'workspace' })
    await setProjectQuality('q1', '540p', { author: 'claude', authorName: '클로드' })
    expect(JSON.parse(readFileSync(join(root, 'q1', '.clipment', 'quality.json'), 'utf8'))).toMatchObject({ schema: 1, quality: '540p', author: 'claude', via: 'mac' })
    expect(await getEffectiveQuality('q1')).toMatchObject({ quality: '540p', source: 'project' })
    expect(await getEffectiveQuality('q1', '360p')).toMatchObject({ quality: '360p', source: 'explicit' })
    // 앱이 고쳐 써도 읽힌다 / 깨진·모르는 값은 무시
    const f = join(root, 'q1', '.clipment', 'quality.json')
    writeFileSync(f, JSON.stringify({ schema: 1, quality: '360p', author: 'user', via: 'app', updated: iso() }))
    expect((await readQualityDesignation(join(root, 'q1')))!.via).toBe('app')
    writeFileSync(f, JSON.stringify({ schema: 1, quality: '8k' }))
    expect((await getEffectiveQuality('q1')).source).toBe('workspace')
    writeFileSync(f, 'nope')
    expect((await getEffectiveQuality('q1')).source).toBe('workspace')
    expect(await clearProjectQuality('q1')).toBe(true)
    expect(await clearProjectQuality('q1')).toBe(false)
    await setWorkspaceQuality(wsName, null)
    expect('previewQuality' in JSON.parse(readFileSync(wsFile, 'utf8'))).toBe(false)
    expect((await getEffectiveQuality('q1')).source).toBe('default')
    // 잠금
    await setLock('q1', 'locked', { author: 'user' })
    await expect(setProjectQuality('q1', '360p', { author: 'claude' })).rejects.toThrow('잠긴')
    await setProjectQuality('q1', '360p', { author: 'claude', force: true })
  })

  test('publish uses resolved quality and records meta.quality', async () => {
    const root = tempRoot(); setDownloader(null)
    await initProject('q2')
    let m = await publishVersion('q2', landscape, { noOriginal: true })
    expect([m.quality, m.width, m.height]).toEqual(['720p', 1280, 720])
    await setProjectQuality('q2', '360p', { author: 'claude' })
    m = await publishVersion('q2', landscape, { noOriginal: true })
    expect([m.quality, m.width, m.height]).toEqual(['360p', 640, 360])
    expect(JSON.parse(readFileSync(join(root, 'q2', 'versions', 'v002', 'meta.json'), 'utf8')).quality).toBe('360p')
    m = await publishVersion('q2', landscape, { noOriginal: true, quality: '1080p' })   // 명시 인자가 이김
    expect([m.quality, m.width]).toEqual(['1080p', 1920])
    m = await publishVersion('q2', landscape, { noOriginal: true, lite: true })
    expect([m.quality, m.width]).toEqual(['540p', 960])
    await expect(publishVersion('q2', landscape, { quality: 'bad' as any })).rejects.toThrow('잘못된 화질')
    expect(existsSync(join(root, 'q2', 'versions', 'v001', 'preview.mp4'))).toBe(true)  // 기존 버전 그대로
    expect(JSON.parse(readFileSync(join(root, 'q2', 'versions', 'v001', 'meta.json'), 'utf8')).quality).toBe('720p')
  })
})

describe('CLI quality', () => {
  test('project get/set/clear and workspace', async () => {
    const root = tempRoot(); setDownloader(null)
    await initProject('c1')
    const ws = root.split('/').pop()!
    expect(out(cli('quality', 'c1'))).toContain('720p')
    expect(out(cli('quality', 'c1'))).toContain('기본값')
    expect(out(cli('quality', '--workspace', ws, '1080p'))).toContain('1080p')
    expect(out(cli('quality', 'c1'))).toContain('워크스페이스 기본')
    expect(out(cli('quality', 'c1', '360p'))).toContain('프로젝트 지정')
    const j = JSON.parse(out(cli('quality', 'c1', '--json')))
    expect([j.quality, j.source, j.project.quality, j.workspace]).toEqual(['360p', 'project', '360p', '1080p'])
    expect(out(cli('quality', 'c1', '--clear'))).toContain('해제')
    expect(JSON.parse(out(cli('quality', 'c1', '--json'))).source).toBe('workspace')
    expect(cli('quality', 'c1', '999p').exitCode).not.toBe(0)
    expect(cli('quality', 'c1', '360p', '--clear').exitCode).not.toBe(0)
    expect(out(cli('quality', '--workspace', ws, '--clear'))).toContain('기본값')
    const pub = cli('publish', 'c1', landscape, '--no-original', '--quality', '540p')
    expect(JSON.parse(out(pub)).quality).toBe('540p')
  })
})
