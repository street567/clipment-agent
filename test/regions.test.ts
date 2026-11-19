import { beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addReply, badgeBoxes, buildDrawboxFilter, digitHeight, digitRects, DIGIT_SEGMENTS, regionLegend, currentRegions, extractFrame, formatRegions, getThread, initProject, listComments,
  normalizeRegions, positionHint, publishVersion, setDownloader, toRegionViews, type Reply,
} from '../src/core/index.ts'
import { appWrite, iso, tempRoot, uid } from './helpers.ts'

const FF = '/opt/homebrew/bin/ffmpeg'
const rep = (created: string, regions?: any, extra: Partial<Reply> = {}): Reply =>
  ({ schema: 1, id: uid(), commentId: 'c', author: 'user', text: '', created, ...(regions !== undefined ? { regions } : {}), ...extra })

describe('normalizeRegions', () => {
  test('non-array -> undefined, empty stays empty', () => {
    expect(normalizeRegions(undefined)).toBeUndefined()
    expect(normalizeRegions('x')).toBeUndefined()
    expect(normalizeRegions([])).toEqual([])
  })
  test('clamps, rounds, drops invalid, keeps label', () => {
    const r = normalizeRegions([
      { x: -0.2, y: 0.5, w: 0.33333333, h: 0.1, label: ' A ' },
      { x: 0.9, y: 0.9, w: 0.5, h: 0.5 },
      { x: 0.1, y: 0.1, w: 0, h: 0.2 },
      { x: 'a', y: 0, w: 1, h: 1 },
      { x: NaN, y: 0, w: 1, h: 1 },
      null, 5,
      { x: 1, y: 0, w: 0.2, h: 0.2 },
    ])!
    expect(r).toEqual([
      { x: 0, y: 0.5, w: 0.3333, h: 0.1, label: 'A' },
      { x: 0.9, y: 0.9, w: 0.1, h: 0.1 },
    ])
  })
  test('max 8', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ x: 0.01 * i, y: 0, w: 0.1, h: 0.1 }))
    expect(normalizeRegions(many)!.length).toBe(8)
  })
})

describe('currentRegions', () => {
  const c = { regions: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] }
  test('falls back to comment, none -> []', () => {
    expect(currentRegions(c, [rep('2026-01-01T00:00:00.000Z')])).toEqual(c.regions)
    expect(currentRegions({}, [])).toEqual([])
  })
  test('latest reply with regions wins; empty array clears', () => {
    const a = rep('2026-01-01T00:00:01.000Z', [{ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }])
    const b = rep('2026-01-01T00:00:03.000Z', [])
    const plain = rep('2026-01-01T00:00:05.000Z')
    expect(currentRegions(c, [plain, a])).toEqual(a.regions!)
    expect(currentRegions(c, [b, plain, a])).toEqual([])
  })
})

describe('positionHint', () => {
  test('3x3 words', () => {
    expect(positionHint({ x: 0.3, y: 0.7, w: 0.4, h: 0.1 })).toBe('아래쪽 가운데')
    expect(positionHint({ x: 0, y: 0, w: 0.1, h: 0.1 })).toBe('위쪽 왼쪽')
    expect(positionHint({ x: 0.8, y: 0.45, w: 0.2, h: 0.1 })).toBe('가운데 오른쪽')
    expect(positionHint({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 })).toBe('화면 정중앙')
    expect(positionHint({ x: 0.7, y: 0.0, w: 0.3, h: 0.2 })).toBe('위쪽 오른쪽')
  })
  test('formatRegions', () => {
    const t = formatRegions(toRegionViews([{ x: 0.12, y: 0.7, w: 0.4, h: 0.1 }, { x: 0, y: 0, w: 0.1, h: 0.1, label: 'L' }]))
    expect(t).toBe('영역 2: [1] x0.12 y0.70 w0.40 h0.10 (아래쪽 왼쪽), [L] x0.00 y0.00 w0.10 h0.10 (위쪽 왼쪽)')
  })
})

describe('buildDrawboxFilter', () => {
  test('null when empty', () => expect(buildDrawboxFilter([], 1280, 720)).toBeNull())
  test('pixel coords, per-box color, number dots, stroke', () => {
    const f = buildDrawboxFilter([{ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, { x: 0, y: 0, w: 0.5, h: 0.5 }], 1280, 720)!
    expect(f).toContain('drawbox=x=320:y=180:w=640:h=360:color=black@1:t=5')
    expect(f).toContain('color=red@1:t=3')
    expect(f).toContain('color=yellow@1:t=3')
    // 배지(검정 판) 2개 + '1'(2 세그) + '2'(5 세그) 흰 조각
    expect(f.match(/color=white@1:t=fill/g)!.length).toBe(2 + 5)
    expect(f).not.toContain('drawtext')
  })
  test('small frame uses 2px stroke', () => {
    expect(buildDrawboxFilter([{ x: 0, y: 0, w: 1, h: 1 }], 320, 180)).toContain('color=red@1:t=2')
  })
})

describe('store integration', () => {
  let root: string
  beforeEach(async () => { root = tempRoot(); setDownloader(null); await initProject('demo') })

  test('listComments/getThread expose currentRegions; regions reply does not change status', async () => {
    const id = uid()
    appWrite(root, 'demo', `comments/${id}.json`, {
      schema: 1, id, version: 1, t: 1, end: null, tag: 'layout', text: '여기', author: 'user', created: iso(-10),
      regions: [{ x: 0.3, y: 0.7, w: 0.4, h: 0.1 }, { x: 2, y: 2, w: 1, h: 1 }],
    })
    let [c] = await listComments('demo')
    expect(c!.currentRegions.length).toBe(1)
    expect(c!.currentRegions[0]).toMatchObject({ index: 1, label: '1', hint: '아래쪽 가운데' })
    await addReply('demo', id, { text: '확인', author: 'claude', status: 'doing' })
    const rid = uid()
    appWrite(root, 'demo', `replies/${id}/${rid}.json`, {
      schema: 1, id: rid, commentId: id, author: 'user', text: '', kind: 'regions', regions: [], created: iso(5),
    })
    const th = await getThread('demo', id)
    expect(th.currentRegions).toEqual([])
    expect(th.status).toBe('doing')
    expect(th.replies[th.replies.length - 1]).toMatchObject({ kind: 'regions', regions: [] })
    ;[c] = await listComments('demo')
    expect(c!.status).toBe('doing')
    expect(c!.currentRegions).toEqual([])
  })
})

describe('extractFrame with regions (real ffmpeg)', () => {
  test('draws colored stroke on solid frame', async () => {
    tempRoot(); setDownloader(null)
    const dir = mkdtempSync(join(tmpdir(), 'cliprev-reg-'))
    const src = join(dir, 'gray.mp4')
    expect(spawnSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:size=640x360:rate=10:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]).status).toBe(0)
    await initProject('demo')
    await publishVersion('demo', src)
    const px = (jpg: Buffer, x: number, y: number) => {
      const jf = join(dir, 'f.jpg')
      writeFileSync(jf, jpg)
      const r = spawnSync(FF, ['-v', 'error', '-i', jf, '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])
      return [...r.stdout]
    }
    const plain = await extractFrame('demo', 1, 0.3)
    const drawn = await extractFrame('demo', 1, 0.3, { regions: [{ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }] })
    expect(drawn[0]).toBe(0xff)
    // 왼쪽 변 x=160, 1px 검정 외곽 뒤 빨강 스트로크 (x=162, y=180)
    const [r, g, b] = px(drawn, 162, 180) as [number, number, number]
    expect(r).toBeGreaterThan(200); expect(g).toBeLessThan(80); expect(b).toBeLessThan(80)
    const [pr, pg] = px(plain, 162, 180) as [number, number]
    expect(Math.abs(pr - pg)).toBeLessThan(20)
    // 박스 밖은 그대로
    const [or, og] = px(drawn, 20, 20) as [number, number]
    expect(Math.abs(or - og)).toBeLessThan(20)
  })
})

describe('stable numeric labels', () => {
  test('color and dots follow label, not position; legend maps label', () => {
    const f = buildDrawboxFilter([{ x: 0, y: 0, w: 0.5, h: 0.5, label: '3' }], 1280, 720)!
    expect(f).toContain('color=cyan@1:t=3')
    expect(f.match(/color=white@1:t=fill/g)!.length).toBe(5) // '3' = abcdg
    const v = toRegionViews([{ x: 0, y: 0, w: 0.5, h: 0.5, label: '3' }])
    expect(regionLegend(v)).toContain('3번=하늘')
  })
})

describe('7-segment glyphs', () => {
  test('digit -> segments', () => {
    expect(DIGIT_SEGMENTS['1']).toBe('bc')
    expect(DIGIT_SEGMENTS['7']).toBe('abc')
    expect(DIGIT_SEGMENTS['8']).toBe('abcdefg')
    expect(Object.keys(DIGIT_SEGMENTS).length).toBe(10)
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => digitRects(String(d), 0, 0, 28).length))
      .toEqual([6, 2, 5, 5, 4, 5, 6, 3, 7, 6])
  })
  test('size scales with frame, min 14', () => {
    expect(digitHeight(720)).toBe(29)
    expect(digitHeight(180)).toBe(14)
  })
  test('multi-digit badge is wider and stays inside frame', () => {
    const one = badgeBoxes(1, 0, 0, 'red', 1280, 720)
    const two = badgeBoxes(12, 0, 0, 'red', 1280, 720)
    const w = (b: string[]) => Number(/w=(\d+)/.exec(b[0]!)![1])
    expect(w(two)).toBeGreaterThan(w(one))
    const edge = badgeBoxes(99, 1279, 719, 'red', 1280, 720)
    expect(Number(/x=(\d+)/.exec(edge[0]!)![1]) + w(edge)).toBeLessThanOrEqual(1280)
  })
  test('real ffmpeg: segment pixel is white', async () => {
    tempRoot(); setDownloader(null)
    const dir = mkdtempSync(join(tmpdir(), 'cliprev-seg-'))
    const src = join(dir, 'gray.mp4')
    expect(spawnSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:size=1280x720:rate=10:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]).status).toBe(0)
    await initProject('demo')
    await publishVersion('demo', src)
    const jpg = await extractFrame('demo', 1, 0.3, { regions: [{ x: 0.25, y: 0.25, w: 0.5, h: 0.5, label: '8' }] })
    const jf = join(dir, 'f.jpg')
    writeFileSync(jf, jpg)
    const px = (x: number, y: number) => [...spawnSync(FF, ['-v', 'error', '-i', jf, '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']).stdout]
    const H = digitHeight(720), th = Math.max(2, Math.round(H / 7)), pad = th + 2
    const [seg] = digitRects('8', 320 + pad, 180 + pad, H) // 세그먼트 a (위 가로획)
    const [r, g, b] = px(seg!.x + Math.floor(seg!.w / 2), seg!.y + Math.floor(seg!.h / 2)) as number[]
    expect(Math.min(r!, g!, b!)).toBeGreaterThan(215)
    // 배지 안, 세그먼트 밖(숫자 8 안쪽 빈칸)은 어두움
    const [dr] = px(320 + pad + Math.round(H * 0.275), 180 + pad + Math.round(H * 0.25)) as number[]
    expect(dr!).toBeLessThan(60)
  })
})
