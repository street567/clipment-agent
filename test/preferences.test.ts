import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  combinePreferences, draftPreferences, initProject, initWorkspacePrefs, prefsPath, readPreferences, setDownloader, setLock, setPreferences,
  ValidationError,
} from '../src/core/index.ts'
import { buildPrompt } from '../src/daemon/autorun.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')
const saved = { ...process.env }
let tmp: string, ws: string

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cliprev-prefs-'))
  ws = join(tmp, 'work')
  mkdirSync(join(tmp, 'cfg'), { recursive: true }); mkdirSync(ws)
  delete process.env.CLIPREV_ROOT
  process.env.CLIPREV_CONFIG = join(tmp, 'cfg', 'workspaces.json')
  writeFileSync(process.env.CLIPREV_CONFIG, JSON.stringify({ workspaces: [{ name: 'work', path: ws }] }))
  await initProject('work/demo', 'Demo')
})
afterEach(() => { process.env = { ...saved }; setDownloader(null) })

describe('작업 지침 (SPEC §11)', () => {
  test('없으면 null, 프로젝트 > 워크스페이스 순으로 합친다', async () => {
    const none = await readPreferences('work/demo')
    expect(none.combined).toBeNull()
    await setPreferences('work', '- 자막 필요 없음')
    await setPreferences('work/demo', '- 결과물 1080p')
    const p = await readPreferences('demo')
    expect(p.project).toBe('work/demo')
    expect(p.workspacePrefs).toBe('- 자막 필요 없음')
    expect(p.projectPrefs).toBe('- 결과물 1080p')
    const c = p.combined!
    expect(c.indexOf('프로젝트 지침')).toBeLessThan(c.indexOf('워크스페이스 지침'))
    expect(c).toContain('요청의 추가 지시(message) > 프로젝트 지침 > 워크스페이스 지침')
    // 워크스페이스 이름만 주면 워크스페이스 지침만
    const w = await readPreferences('work')
    expect(w.project).toBeNull()
    expect(w.combined).toContain('자막 필요 없음')
    expect(w.combined).not.toContain('1080p')
  })

  test('고쳐 쓰는 파일: 다시 쓰면 교체, 빈 글은 지침 없음', async () => {
    await setPreferences('work', 'a')
    await setPreferences('work', 'b')
    expect(readFileSync(prefsPath(ws), 'utf8')).toBe('b\n')
    await setPreferences('work', '  \n')
    expect((await readPreferences('work')).combined).toBeNull()
  })

  test('iCloud 자리표시자면 내려받기 요청 후 null', async () => {
    const asked: string[] = []
    setDownloader(p => asked.push(p))
    mkdirSync(join(ws, '.clipment'), { recursive: true })
    writeFileSync(join(ws, '.clipment', '.preferences.md.icloud'), '')
    expect((await readPreferences('work')).workspacePrefs).toBeNull()
    expect(asked).toEqual([prefsPath(ws)])
  })

  test('잠긴 프로젝트 지침은 force 없이 쓰지 않는다', async () => {
    await setLock('work/demo', 'locked', { author: 'user' })
    await expect(setPreferences('work/demo', 'x')).rejects.toBeInstanceOf(ValidationError)
    await setPreferences('work/demo', 'x', { force: true })
    expect((await readPreferences('work/demo')).projectPrefs).toBe('x')
  })

  test('combine 단독', () => {
    expect(combinePreferences(null, null)).toBeNull()
    expect(combinePreferences('w', null)).toContain('## 워크스페이스 지침\nw')
  })
})

describe('초안', () => {
  test('작업 방식을 가정하지 않고, 도구는 "사용 가능"으로만', () => {
    const d = draftPreferences('work', ['ffmpeg', 'Final Cut Pro'])
    expect(d).toContain('- 자막: 정해지지 않음 — 필요하면 질문 답글')
    expect(d).toContain('- 편집 프로그램·편집 위치: 정해지지 않음 — 필요하면 질문 답글')
    expect(d).toContain('## 사용 가능 도구 (이 맥에서 찾음 · 쓴다는 뜻은 아님)\n- ffmpeg\n- Final Cut Pro')
    expect(draftPreferences('w', [])).toContain('- (찾지 못함)')
  })

  test('init 은 없을 때만 만들고 있으면 그대로 둔다', async () => {
    const r1 = await initWorkspacePrefs('work', [])
    expect(r1.created).toBe(true)
    expect(existsSync(prefsPath(ws))).toBe(true)
    await setPreferences('work', '내 지침')
    const r2 = await initWorkspacePrefs('work', ['ffmpeg'])
    expect(r2.created).toBe(false)
    expect(readFileSync(prefsPath(ws), 'utf8')).toBe('내 지침\n')
    await expect(initWorkspacePrefs('nope')).rejects.toBeInstanceOf(ValidationError)
  })

  test('CLI prefs init/show/set', () => {
    const env = { ...process.env }
    const run = (...a: string[]) => spawnSync('bun', [CLI, ...a], { env, encoding: 'utf8' })
    expect(run('prefs', 'init', 'work').stdout).toContain('초안 생성')
    expect(run('prefs', 'init', '--all').stdout).toContain('이미 있음')
    const f = join(tmp, 'p.md'); writeFileSync(f, '- 결과물 4K')
    expect(run('prefs', 'set', 'work/demo', '--file', f).status).toBe(0)
    const show = run('prefs', 'work/demo').stdout
    expect(show).toContain('결과물 4K')
    expect(show).toContain('정해지지 않음')
  })
})

test('데몬 프롬프트는 지침을 먼저 읽게 한다', () => {
  const p = buildPrompt({ id: 'q1', type: 'apply_feedback', version: 2, ref: 'work/demo' } as any)
  expect(p).toContain('get_preferences(ref=work/demo)')
})
