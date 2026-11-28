import { beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addReply, extractFrame, getVersion, initProject, listVersions, previewPath, probe, publishVersion, buildEncodeArgs, PRESETS, setDownloader, targetSize,
  originalFileName, getUploadInfo, setUploadVersion, clearUploadVersion, resolveUploadVersion, setLock,
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

describe('lite preset args', () => {
  const src = { width: 1920, height: 1080, rotation: 0, fps: 60, duration: 2 }
  test('default stays', () => {
    const a = buildEncodeArgs('in.mp4', 'out.mp4', { ...src, fps: 30 })
    expect(a).toContain('scale=1280:720')
    expect(a[a.indexOf('-crf') + 1]).toBe('26')
    expect(a[a.indexOf('-b:a') + 1]).toBe('128k')
    expect(a).not.toContain('-r')
  })
  test('lite: 960 edge, crf 30, fps cap 30, aac 96k, faststart', () => {
    const a = buildEncodeArgs('in.mp4', 'out.mp4', src, 'lite')
    expect(a).toContain('scale=960:540')
    expect(a[a.indexOf('-crf') + 1]).toBe('30')
    expect(a[a.indexOf('-r') + 1]).toBe('30')
    expect(a[a.indexOf('-b:a') + 1]).toBe('96k')
    expect(a).toContain('+faststart')
    expect(PRESETS.lite.longEdge).toBe(960)
  })
  test('lite rotated portrait -> 540x960', () => {
    expect(targetSize({ width: 3840, height: 2160, rotation: -90 }, 960)).toMatchObject({ width: 540, height: 960 })
  })
  test('lite publish end-to-end', async () => {
    tempRoot(); setDownloader(null)
    await initProject('lt')
    const m = await publishVersion('lt', landscape, { lite: true })
    expect([m.width, m.height]).toEqual([960, 540])
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
    expect(readdirSync(join(vdir, 'v001')).sort()).toEqual(['meta.json', 'original.mp4', 'preview.mp4'])
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

describe('업로드용 영상 (SPEC §12)', () => {
  test('publish 기본: original 복사 + meta.original, --no-original 은 생략', async () => {
    const root = tempRoot(); setDownloader(null)
    await initProject('up')
    const a = await publishVersion('up', rotated)
    expect(a.original).toMatchObject({ file: 'original.mp4', width: 1080, height: 1920 })
    expect(a.original!.bytes).toBe(statSync(rotated).size)
    expect(a.original!.duration).toBeGreaterThan(1.5)
    const vdir = join(root, 'up', 'versions', 'v001')
    expect(readdirSync(vdir).sort()).toEqual(['meta.json', 'original.mp4', 'preview.mp4'])
    expect(readFileSync(join(vdir, 'original.mp4')).equals(readFileSync(rotated))).toBe(true)   // 변환 없는 복사
    expect(JSON.parse(readFileSync(join(vdir, 'meta.json'), 'utf8')).original.file).toBe('original.mp4')
    expect((await getVersion('up', 1))!.original!.bytes).toBe(a.original!.bytes)

    const b = await publishVersion('up', landscape, { noOriginal: true })
    expect(b.original).toBeUndefined()
    expect(readdirSync(join(root, 'up', 'versions', 'v002')).sort()).toEqual(['meta.json', 'preview.mp4'])
    expect(readdirSync(join(root, 'up', 'versions')).every(n => !n.startsWith('.'))).toBe(true)   // staging 정리
  })

  test('원본은 미리보기·meta 공개 뒤에 복사, 실패하면 원본 없는 meta', async () => {
    const root = tempRoot(); setDownloader(null)
    await initProject('ord')
    const vdir = join(root, 'ord', 'versions', 'v001')
    let seen: string[] = []
    const m = await publishVersion('ord', rotated, {
      copyOriginal: async (src, dst) => { seen = readdirSync(vdir).sort(); copyFileSync(src, dst) },
    })
    expect(seen).toEqual(['meta.json', 'preview.mp4'])   // 복사 시작 시점: 작은 파일만 있고 원본 없음
    expect(m.original?.file).toBe('original.mp4')
    expect(readdirSync(vdir).sort()).toEqual(['meta.json', 'original.mp4', 'preview.mp4'])   // 임시 이름 정리

    await expect(publishVersion('ord', rotated, { copyOriginal: async (_s, d) => { writeFileSync(d, 'x'); throw new Error('디스크 가득') } })).rejects.toThrow('원본 복사 실패')
    const v2 = join(root, 'ord', 'versions', 'v002')
    expect(readdirSync(v2).sort()).toEqual(['meta.json', 'preview.mp4'])
    expect(JSON.parse(readFileSync(join(v2, 'meta.json'), 'utf8')).original).toBeUndefined()
  })

  test('확장자는 소문자 유지(.mov), 이상하면 mp4', () => {
    expect(originalFileName('/x/CLIP.MOV')).toBe('original.mov')
    expect(originalFileName('/x/clip')).toBe('original.mp4')
    expect(originalFileName('/x/a.weird-ext!')).toBe('original.mp4')
  })

  test('업로드용 지정: 기본 규칙 → 지정 → 해제, publish --upload, 잠금 거부', async () => {
    const root = tempRoot(); setDownloader(null)
    await initProject('uv')
    expect(await getUploadInfo('uv')).toBeNull()
    await publishVersion('uv', landscape)                       // v1 원본
    await publishVersion('uv', landscape, { noOriginal: true }) // v2 원본 없음
    let i = (await getUploadInfo('uv'))!
    expect([i.version, i.designated, i.hasOriginal, i.newer]).toEqual([1, false, true, 2])   // 원본 있는 최신, v2 가 더 최신
    await setUploadVersion('uv', 2, { author: 'claude', authorName: '클로드' })
    i = (await getUploadInfo('uv'))!
    expect([i.version, i.designated, i.hasOriginal, i.newer]).toEqual([2, true, false, null])
    const file = join(root, 'uv', '.clipment', 'upload.json')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ schema: 1, version: 2, author: 'claude', authorName: '클로드', via: 'mac' })
    await expect(setUploadVersion('uv', 9, { author: 'claude' })).rejects.toThrow('찾을 수 없')
    await publishVersion('uv', landscape, { upload: true })     // v3 게시와 함께 지정
    expect((await getUploadInfo('uv'))!.version).toBe(3)
    expect(readdirSync(join(root, 'uv', '.clipment')).filter(n => n.endsWith('.tmp'))).toEqual([])
    // 앱이 고쳐 써도(via app) 읽힌다
    writeFileSync(file, JSON.stringify({ schema: 1, version: 1, author: 'user', authorName: '개미', via: 'app', updated: iso() }))
    const j = (await getUploadInfo('uv'))!
    expect([j.version, j.designated, j.designation!.via]).toEqual([1, true, 'app'])
    // 깨진 파일 → 기본 규칙
    writeFileSync(file, 'nope')
    expect((await getUploadInfo('uv'))!.designated).toBe(false)
    expect(await clearUploadVersion('uv')).toBe(true)
    expect(await clearUploadVersion('uv')).toBe(false)
    // 잠금
    await setLock('uv', 'locked', { author: 'user' })
    await expect(setUploadVersion('uv', 1, { author: 'claude' })).rejects.toThrow('잠긴')
    await expect(clearUploadVersion('uv')).rejects.toThrow('잠긴')
    await setUploadVersion('uv', 1, { author: 'claude', force: true })
  })

  test('resolveUploadVersion 순수 규칙', () => {
    const m = (version: number, original = false) => ({ version, original: original ? { file: 'original.mp4', bytes: 1 } : undefined }) as any
    expect(resolveUploadVersion([], null)).toBeNull()
    expect(resolveUploadVersion([m(1), m(2)], null)!.version).toBe(2)                 // 원본 없으면 최신
    expect(resolveUploadVersion([m(1, true), m(2), m(3, true)], null)!.version).toBe(3)
    expect(resolveUploadVersion([m(1, true), m(2)], { version: 2 } as any)!.designated).toBe(true)
    expect(resolveUploadVersion([m(1, true), m(2)], { version: 7 } as any)!.version).toBe(1)   // 없는 버전 지정 무시
  })

  test('옛/잘못된 meta.original 은 원본 없음', async () => {
    const root = tempRoot()
    await initProject('old')
    for (const [n, o] of [[1, undefined], [2, { file: '../x.mp4', bytes: 3 }], [3, { file: 'original.mp4' }], [4, { file: 'original.mov', bytes: 5, width: 3840 }]] as const)
      appWrite(root, 'old', `versions/v00${n}/meta.json`, { schema: 1, version: n, file: 'preview.mp4', created: iso(), ...(o ? { original: o } : {}) })
    const vs = await listVersions('old')
    expect(vs.map(v => v.original)).toEqual([undefined, undefined, undefined, { file: 'original.mov', bytes: 5, width: 3840 }])
  })
})

describe('대본 스냅샷 (SPEC §14)', () => {
  test('script/script.json 이 있으면 versions/vNNN/script.json 으로 그대로 복사, 없으면 만들지 않음', async () => {
    const root = tempRoot(); setDownloader(null)
    await initProject('sc')
    await publishVersion('sc', landscape, { noOriginal: true })
    expect(readdirSync(join(root, 'sc', 'versions', 'v001')).sort()).toEqual(['meta.json', 'preview.mp4'])
    const raw = JSON.stringify({ schema: 1, language: 'ko', future: { a: 1 }, lines: [{ id: uid(), start: 0, text: '안녕', x: 1 }] }, null, 1)
    appWriteRaw(root, 'sc', 'script/script.json', raw)
    await publishVersion('sc', landscape, { noOriginal: true })
    const v2 = join(root, 'sc', 'versions', 'v002')
    expect(readdirSync(v2).sort()).toEqual(['meta.json', 'preview.mp4', 'script.json'])
    expect(readFileSync(join(v2, 'script.json'), 'utf8')).toBe(raw)   // 변환 없음
    // 이후 대본이 바뀌어도 옛 스냅샷은 그대로
    appWriteRaw(root, 'sc', 'script/script.json', '{"lines":[]}')
    expect(readFileSync(join(v2, 'script.json'), 'utf8')).toBe(raw)
    expect(readdirSync(join(root, 'sc', 'versions')).every(n => !n.startsWith('.'))).toBe(true)
  })
})

function appWriteRaw(root: string, slug: string, rel: string, text: string) {
  const p = join(root, slug, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}
