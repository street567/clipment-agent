import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  aiStatus, aiTextHash, buildNarration, captionRanges, createTtsEngine, describeScript, generateVoices, initProject, listRequests, modifyScript,
  pendingRequests, readScript, REQUEST_TYPES, sayEngine, scriptPath, setLock, setScriptLines, TtsConfigError, ValidationError, voicePath,
  type TtsEngine, type ScriptLanguage,
} from '../src/core/index.ts'
import { configuredTtsEngine, DEFAULT_CONFIG } from '../src/daemon/config.ts'
import { Daemon } from '../src/daemon/daemon.ts'
import { Logger } from '../src/daemon/util.ts'
import { appWrite, iso, tempRoot, uid } from './helpers.ts'

const FF = '/opt/homebrew/bin/ffmpeg'
const saved = { ...process.env }
let root: string
let work: string
let tone: (hz: number, sec: number, file: string) => void

beforeAll(() => {
  tone = (hz, sec, file) => {
    const r = spawnSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${sec}`, '-ar', '44100', '-c:a', 'aac', '-f', 'ipod', file])
    expect(r.status).toBe(0)
  }
})
beforeEach(() => {
  root = tempRoot()
  work = mkdtempSync(join(tmpdir(), 'clipment-script-'))
  process.env.CLIPMENT_HOME = join(work, 'home')
  process.env.CLIPMENT_DAEMON_CONFIG = join(work, 'daemon.json')
  delete process.env.CLIPMENT_TTS_ENGINE
})
afterEach(() => { process.env = { ...saved } })

/** 테스트 엔진: say 대신 1초 사인파 m4a 를 쓰고 호출을 기록 */
function fakeEngine(sec = 1): TtsEngine & { calls: { text: string; language: ScriptLanguage }[] } {
  const calls: { text: string; language: ScriptLanguage }[] = []
  return { name: 'fake', calls, async synth(text, { language, out }) { calls.push({ text, language }); tone(300 + calls.length * 10, sec, out) } }
}

const L = (over: Record<string, unknown> = {}) => ({ id: uid(), start: 0, text: 'Hello there.', voice: 'ai', updated: iso(), ...over })
async function mkScript(slug: string, lines: any[], top: Record<string, unknown> = {}) {
  await initProject(slug)
  appWrite(root, slug, 'script/script.json', { schema: 1, language: 'en', updated: iso(), lines, ...top })
}
const rawScript = (slug: string) => JSON.parse(readFileSync(join(root, slug, 'script', 'script.json'), 'utf8'))

describe('aiTextHash / 최신 여부', () => {
  test('스펙 시험값', () => {
    expect(aiTextHash('en', 'This is how it starts.')).toBe('b6aa39f69905a507')
  })
  test('언어가 바뀌면 다른 해시, 모르는 언어는 en', () => {
    expect(aiTextHash('ko', 'This is how it starts.')).not.toBe('b6aa39f69905a507')
    expect(aiTextHash('fr', 'This is how it starts.')).toBe('b6aa39f69905a507')
    expect(aiTextHash(undefined, 'This is how it starts.')).toBe('b6aa39f69905a507')
  })
  test('앞뒤 공백·줄바꿈은 무시, NFC 로 정규화', () => {
    expect(aiTextHash('en', '  \nThis is how it starts.\n ')).toBe('b6aa39f69905a507')
    expect(aiTextHash('ko', '가́'.normalize('NFD'))).toBe(aiTextHash('ko', '가́'.normalize('NFC')))
    expect(aiTextHash('ko', '한글')).toBe(aiTextHash('ko', '한글'.normalize('NFD')))
    expect(aiTextHash('en', 'a b')).not.toBe(aiTextHash('en', 'a  b'))  // 안쪽 공백은 그대로
  })
  test('aiStatus: 파일 없음/오래됨/최신/빈 텍스트', async () => {
    const line = L({ text: 'Hi', aiTextHash: aiTextHash('en', 'Hi') })
    await mkScript('st', [line])
    const dir = join(root, 'st')
    expect(aiStatus(dir, line as any, 'en')).toBe('missing')
    mkdirSync(join(dir, 'script', 'ai'), { recursive: true })
    tone(440, 0.2, voicePath('st', line.id, 'ai'))
    expect(aiStatus(dir, line as any, 'en')).toBe('fresh')
    expect(aiStatus(dir, line as any, 'ko')).toBe('stale')                      // 언어 변경
    expect(aiStatus(dir, { ...line, text: 'Hi!' } as any, 'en')).toBe('stale')   // 글 변경
    expect(aiStatus(dir, { ...line, aiTextHash: undefined } as any, 'en')).toBe('stale')
    expect(aiStatus(dir, { ...line, text: '  ' } as any, 'en')).toBe('empty')
  })
})

describe('script 읽기/쓰기', () => {
  test('start 오름차순(안정), language 기본 en, 잘못된 줄은 보기에서만 제외, 유효하지 않은 end 제거', async () => {
    const a = L({ start: 5, text: 'a' }), b = L({ start: 1, text: 'b' }), c = L({ start: 1, text: 'c', end: 0.5 }), d = L({ start: 3, text: 'd', end: 4 })
    await mkScript('ord', [a, b, c, d, { id: 'nope', start: 0, text: 'x' }, L({ start: -1 })], { language: 'zz' })
    const s = (await readScript('ord'))!
    expect(s.language).toBe('en')
    expect(s.lines.map(l => l.text)).toEqual(['b', 'c', 'd', 'a'])
    expect(s.lines[1]!.end).toBeUndefined()
    expect(s.lines.map(l => l.voice)).toEqual(['ai', 'ai', 'ai', 'ai'])
    expect(await readScript('nothing-here')).toBeNull()
  })
  test('modifyScript: 모르는 필드(최상위·줄) 보존, 원자적(tmp 안 남음), false 면 쓰지 않음', async () => {
    const a = L({ text: 'a', x: { deep: 1 }, voice: 'weird' })
    await mkScript('keep', [a, { id: 'bad', note: 'keep me' }], { future: [1, 2] })
    const before = readFileSync(scriptPath('keep'), 'utf8')
    expect(await modifyScript('keep', () => false)).toBe(false)
    expect(readFileSync(scriptPath('keep'), 'utf8')).toBe(before)
    await modifyScript('keep', raw => { raw.lines[0].text = 'a2' })
    const j = rawScript('keep')
    expect(j.future).toEqual([1, 2])
    expect(j.lines[0]).toMatchObject({ x: { deep: 1 }, voice: 'weird', text: 'a2' })
    expect(j.lines[1]).toEqual({ id: 'bad', note: 'keep me' })
    expect(j.updated).not.toBe(JSON.parse(before).updated)
    expect(readdirSync(join(root, 'keep', 'script')).filter(n => n.endsWith('.tmp'))).toEqual([])
  })
  test('깨진 script.json 은 덮어쓰지 않고 거부', async () => {
    await initProject('broken')
    mkdirSync(join(root, 'broken', 'script'), { recursive: true })
    writeFileSync(scriptPath('broken'), '{nope')
    await expect(modifyScript('broken', () => true)).rejects.toThrow('읽을 수 없')
    expect(readFileSync(scriptPath('broken'), 'utf8')).toBe('{nope')
  })
  test('captionRanges: end > 다음 줄 시작 > 음성 길이 > 3초', () => {
    const ls = [{ id: 'a', start: 0, end: 2 }, { id: 'b', start: 3 }, { id: 'c', start: 6 }] as any
    expect(captionRanges(ls, l => (l.id === 'c' ? 1.5 : undefined)).map(r => r.end)).toEqual([2, 6, 7.5])
    expect(captionRanges([{ id: 'z', start: 1 }] as any).map(r => r.end)).toEqual([4])
  })
  test('setScriptLines: 새로 만들기 / append / replace 보호 / 기존 id 병합', async () => {
    await initProject('set')
    const v = await setScriptLines('set', [{ text: 'Second', start: 4 }, { text: 'First', start: 0, end: 3 }], { author: 'claude', language: 'ko' })
    expect(v.language).toBe('ko')
    expect(v.lines.map(l => l.text)).toEqual(['First', 'Second'])
    expect(v.lines.every(l => /^[0-9a-f-]{36}$/.test(l.id) && l.author === 'claude' && l.voice === 'ai' && l.ai === 'missing')).toBe(true)
    // append
    const v2 = await setScriptLines('set', [{ text: 'Third', start: 2 }], { author: 'claude', mode: 'append' })
    expect(v2.lines.map(l => l.text)).toEqual(['First', 'Third', 'Second'])
    // 사용자 줄 보호: 사용자 줄을 만들고 replace 시도
    const userLine = L({ text: 'mine!', start: 9, author: 'user', extra: 'keep' })
    await modifyScript('set', raw => { raw.lines.push(userLine) })
    await expect(setScriptLines('set', [{ text: 'X', start: 0 }], { author: 'claude' })).rejects.toThrow('사용자가 쓴 줄')
    const after = await setScriptLines('set', [{ id: userLine.id, text: 'edited', start: 9 }], { author: 'claude', mode: 'append' })
    const u = after.lines.find(l => l.id === userLine.id)!
    expect(u).toMatchObject({ text: 'edited', extra: 'keep', author: 'claude' })   // 모르는 필드 보존
    // 사용자 허락이 있으면 replace
    const v3 = await setScriptLines('set', [{ text: 'Only', start: 0 }], { author: 'claude', overwriteUserLines: true })
    expect(v3.lines.map(l => l.text)).toEqual(['Only'])
    // 검증
    await expect(setScriptLines('set', [{ text: '', start: 0 }], { author: 'claude' })).rejects.toThrow()
    await expect(setScriptLines('set', [{ text: 'a', start: 2, end: 1 }], { author: 'claude' })).rejects.toThrow('end')
    await expect(setScriptLines('set', [{ text: 'a', start: -1 }], { author: 'claude' })).rejects.toThrow('start')
    await expect(setScriptLines('set', [{ text: 'a', start: 0 }], { author: 'claude', language: 'fr' as any })).rejects.toThrow('language')
  })
  test('잠긴 프로젝트는 setScriptLines 거부 (force 로만)', async () => {
    await initProject('lk')
    await setLock('lk', 'locked', { author: 'user' })
    await expect(setScriptLines('lk', [{ text: 'a', start: 0 }], { author: 'claude' })).rejects.toThrow('잠긴')
    expect(existsSync(scriptPath('lk'))).toBe(false)
    await setScriptLines('lk', [{ text: 'a', start: 0 }], { author: 'claude', force: true })
    expect(existsSync(scriptPath('lk'))).toBe(true)
  })
})

describe('AI 음성 생성 (엔진 주입)', () => {
  test('없는/오래된 줄만 만들고 aiTextHash 를 기록, 다른 필드 보존, 두 번째는 아무 것도 안 함', async () => {
    const a = L({ start: 0, text: 'One.', foo: 1 }), b = L({ start: 2, text: 'Two.' }), e = L({ start: 4, text: '   ' })
    await mkScript('gen', [a, b, e], { future: true })
    const eng = fakeEngine()
    const r = await generateVoices('gen', { engine: eng })
    expect(r.generated.map(g => g.id).sort()).toEqual([a.id, b.id].sort())
    expect(r.skipped).toEqual([{ id: e.id, reason: '텍스트가 비어 있음' }])
    expect(eng.calls.map(c => c.language)).toEqual(['en', 'en'])
    const j = rawScript('gen')
    expect(j.future).toBe(true)
    expect(j.updated).toBe((await readScript('gen'))!.updated!)
    expect(j.lines[0]).toMatchObject({ foo: 1, aiTextHash: aiTextHash('en', 'One.'), updated: a.updated })
    expect(existsSync(voicePath('gen', a.id, 'ai'))).toBe(true)
    expect(readdirSync(join(root, 'gen', 'script', 'ai')).every(n => !n.startsWith('.'))).toBe(true)
    const again = await generateVoices('gen', { engine: eng })
    expect(again.generated).toEqual([])
    expect(eng.calls.length).toBe(2)
    // 글을 고치면 그 줄만 다시
    await modifyScript('gen', raw => { raw.lines[1].text = 'Two changed.' })
    expect((await generateVoices('gen', { engine: eng })).generated.map(g => g.id)).toEqual([b.id])
    // 언어를 바꾸면 전부 오래됨
    await modifyScript('gen', raw => { raw.language = 'ko' })
    expect((await generateVoices('gen', { engine: eng })).generated.length).toBe(2)
    expect(eng.calls.at(-1)!.language).toBe('ko')
    // --all
    expect((await generateVoices('gen', { engine: eng, all: true })).generated.length).toBe(2)
    // 파일이 지워지면 같은 해시여도 다시
    const { rmSync } = await import('node:fs')
    rmSync(voicePath('gen', a.id, 'ai'))
    expect((await generateVoices('gen', { engine: eng })).generated.map(g => g.id)).toEqual([a.id])
  })
  test('대본에 없는 줄의 AI 음성 파일 정리, 내 녹음은 건드리지 않음', async () => {
    const a = L({ text: 'One.' })
    await mkScript('orph', [a])
    const ghost = uid()
    mkdirSync(join(root, 'orph', 'script', 'ai'), { recursive: true })
    mkdirSync(join(root, 'orph', 'script', 'mine'), { recursive: true })
    tone(500, 0.2, voicePath('orph', ghost, 'ai'))
    tone(500, 0.2, voicePath('orph', ghost, 'mine'))
    const r = await generateVoices('orph', { engine: fakeEngine() })
    expect(r.removed).toEqual([ghost])
    expect(existsSync(voicePath('orph', ghost, 'ai'))).toBe(false)
    expect(existsSync(voicePath('orph', ghost, 'mine'))).toBe(true)
  })
  test('잠긴 프로젝트는 거부(force 만 예외), 대본 없음 오류', async () => {
    await mkScript('lockv', [L()])
    await setLock('lockv', 'locked', { author: 'user' })
    const eng = fakeEngine()
    await expect(generateVoices('lockv', { engine: eng })).rejects.toThrow('잠긴')
    expect(eng.calls.length).toBe(0)
    expect((await generateVoices('lockv', { engine: eng, force: true })).generated.length).toBe(1)
    await initProject('nos')
    await expect(generateVoices('nos', { engine: eng })).rejects.toThrow('대본이 없')
  })
  test('줄 하나가 실패해도 나머지는 계속, 설정 오류(TtsConfigError)는 중단하고 성공분 기록', async () => {
    const a = L({ start: 0, text: 'ok' }), b = L({ start: 1, text: 'bad' }), c = L({ start: 2, text: 'after' })
    await mkScript('fail', [a, b, c])
    const flaky: TtsEngine = { name: 'flaky', async synth(t, { out }) { if (t === 'bad') throw new Error('boom'); tone(400, 0.2, out) } }
    const r = await generateVoices('fail', { engine: flaky })
    expect(r.generated.length).toBe(2)
    expect(r.failed).toEqual([{ id: b.id, error: 'boom' }])
    expect(readdirSync(join(root, 'fail', 'script', 'ai')).filter(n => n.startsWith('.'))).toEqual([])
    await mkScript('cfg', [L({ start: 0, text: 'x' }), L({ start: 1, text: 'y' })])
    let n = 0
    const broken: TtsEngine = { name: 'b', async synth() { n++; throw new TtsConfigError('음성 없음') } }
    await expect(generateVoices('cfg', { engine: broken })).rejects.toThrow('음성 없음')
    expect(n).toBe(1)
  })
})

describe('TTS 엔진 선택', () => {
  test('openai/elevenlabs 는 네트워크 없이 "API 키 설정 필요" 오류', async () => {
    for (const name of ['openai', 'elevenlabs']) {
      const e = createTtsEngine(name)
      expect(e.name).toBe(name)
      const err = await e.synth('hi', { language: 'en', out: join(work, 'x.m4a') }).catch(x => x)
      expect(err).toBeInstanceOf(TtsConfigError)
      expect(String(err.message)).toContain('API 키 설정 필요')
    }
    expect(existsSync(join(work, 'x.m4a'))).toBe(false)
  })
  test('엔진 이름: 환경변수 > daemon.json > say, 모르는 이름은 오류', () => {
    expect(createTtsEngine().name).toBe('say')
    process.env.CLIPMENT_TTS_ENGINE = 'OpenAI'
    expect(createTtsEngine().name).toBe('openai')
    expect(configuredTtsEngine({ ttsEngine: 'say' })).toBe('OpenAI')
    delete process.env.CLIPMENT_TTS_ENGINE
    expect(configuredTtsEngine({ ttsEngine: 'elevenlabs' })).toBe('elevenlabs')
    expect(DEFAULT_CONFIG.ttsEngine).toBe('say')
    expect(() => createTtsEngine('piper')).toThrow(ValidationError)
  })
  test('say 엔진: 음성이 없으면 say -v ? 안내 오류 (say 실행은 주입)', async () => {
    const fakeRun = async (cmd: string, args: string[]) => {
      if (args[0] === '-v' && args[1] === '?') return { code: 0, out: Buffer.from('Alex                en_US    # x\n'), err: '' }
      return { code: 1, out: Buffer.alloc(0), err: "Voice `Yuna' not found" }
    }
    const e = sayEngine({ run: fakeRun as any })
    const err = await e.synth('안녕', { language: 'ko', out: join(work, 'k.m4a') }).catch(x => x)
    expect(err).toBeInstanceOf(TtsConfigError)
    expect(err.message).toContain("say -v '?'")
    expect(err.message).toContain('Yuna')
  })
  const hasSay = existsSync('/usr/bin/say')
  test.skipIf(!hasSay)('say 엔진 실제 합성 (en)', async () => {
    const out = join(work, 'say.m4a')
    try { await sayEngine().synth('This is a test.', { language: 'en', out }) } catch (e) { if (e instanceof TtsConfigError) return; throw e }
    const d = Number(spawnSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout)
    expect(d).toBeGreaterThan(0.3)
  }, 60_000)
})

describe('narration 조립', () => {
  const silences = (file: string) => {
    const r = spawnSync(FF, ['-v', 'info', '-i', file, '-af', 'silencedetect=n=-45dB:d=0.3', '-f', 'null', '-'], { encoding: 'utf8' })
    const starts = [...r.stderr.matchAll(/silence_start: ([\d.]+)/g)].map(m => Number(m[1]))
    const ends = [...r.stderr.matchAll(/silence_end: ([\d.]+)/g)].map(m => Number(m[1]))
    return { starts, ends }
  }
  const dur = (f: string) => Number(spawnSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout)

  test('mine/ai 선택, 시작 위치, duration 패딩, 오래된 AI 는 건너뜀+경고, 결정적', async () => {
    const m = L({ start: 0, text: 'mine line', voice: 'mine' })
    const a = L({ start: 2, text: 'ai line', voice: 'ai', aiTextHash: aiTextHash('en', 'ai line') })
    const stale = L({ start: 5, text: 'stale line', voice: 'ai', aiTextHash: 'deadbeefdeadbeef' })
    const noMine = L({ start: 6, text: 'no mine', voice: 'mine', aiTextHash: aiTextHash('en', 'no mine') })
    await mkScript('nar', [m, a, stale, noMine])
    for (const d of ['mine', 'ai']) mkdirSync(join(root, 'nar', 'script', d), { recursive: true })
    tone(880, 1, voicePath('nar', m.id, 'mine'))
    tone(440, 1, voicePath('nar', a.id, 'ai'))
    tone(330, 1, voicePath('nar', stale.id, 'ai'))
    tone(220, 1, voicePath('nar', noMine.id, 'ai'))
    const out = join(work, 'n.m4a')
    const r = await buildNarration('nar', { out, duration: 8 })
    expect(r.placed.map(p => [p.id, p.source])).toEqual([[m.id, 'mine'], [a.id, 'ai'], [noMine.id, 'ai']])
    expect(r.skipped.map(s => s.id)).toEqual([stale.id])
    expect(r.warnings.some(w => w.includes('건너뜀'))).toBe(true)
    expect(r.warnings.some(w => w.includes('내 녹음 파일이 없어'))).toBe(true)
    expect(dur(out)).toBeGreaterThan(7.9)
    expect(dur(out)).toBeLessThan(8.2)
    // 소리 구간: 0-1(mine), 2-3(ai), 6-7(ai 대체) → 무음: 1-2, 3-6, 7-8
    const s = silences(out)
    expect(s.starts.length).toBe(3)
    expect(s.starts[0]!).toBeGreaterThan(0.9); expect(s.starts[0]!).toBeLessThan(1.15)
    expect(s.ends[0]!).toBeGreaterThan(1.9); expect(s.ends[0]!).toBeLessThan(2.15)
    expect(s.starts[1]!).toBeGreaterThan(2.9); expect(s.starts[1]!).toBeLessThan(3.15)
    expect(s.ends[1]!).toBeGreaterThan(5.9); expect(s.ends[1]!).toBeLessThan(6.15)
    // 결정적
    const out2 = join(work, 'n2.m4a')
    await buildNarration('nar', { out: out2, duration: 8 })
    expect(readFileSync(out2).equals(readFileSync(out))).toBe(true)
    expect(readdirSync(work).filter(n => n.endsWith('.tmp'))).toEqual([])
    // 프로젝트 폴더는 건드리지 않음 (읽기 전용)
    expect(readFileSync(scriptPath('nar'), 'utf8')).toContain(m.id)
  })
  test('duration 이 짧으면 자르고, 생략하면 마지막 음성 끝 + 0.5초', async () => {
    const a = L({ start: 1, text: 'only', aiTextHash: aiTextHash('en', 'only') })
    await mkScript('dur', [a])
    mkdirSync(join(root, 'dur', 'script', 'ai'), { recursive: true })
    tone(440, 2, voicePath('dur', a.id, 'ai'))
    const o1 = join(work, 'd1.m4a'), o2 = join(work, 'd2.m4a')
    const r1 = await buildNarration('dur', { out: o1 })
    expect(r1.duration).toBeCloseTo(3.5, 1)
    expect(dur(o1)).toBeGreaterThan(3.4); expect(dur(o1)).toBeLessThan(3.8)
    await buildNarration('dur', { out: o2, duration: 2 })
    expect(dur(o2)).toBeLessThan(2.2)
    await expect(buildNarration('dur', { out: o2, duration: 0 })).rejects.toThrow('duration')
  })
  test('배치할 음성이 없으면 오류(duration 을 주면 무음 트랙)', async () => {
    await mkScript('none', [L({ text: 'x' })])
    await expect(buildNarration('none', { out: join(work, 'z.m4a') })).rejects.toThrow('배치할 음성이 없')
    const r = await buildNarration('none', { out: join(work, 'z.m4a'), duration: 2 })
    expect(r.placed).toEqual([])
    expect(dur(join(work, 'z.m4a'))).toBeGreaterThan(1.9)
  })
})

describe('요청 화이트리스트 apply_script', () => {
  const mk = (slug: string, over: Record<string, unknown>) => {
    const id = uid()
    appWrite(root, slug, `requests/${id}.json`, { schema: 1, type: 'apply_script', version: 1, commentIds: null, agent: '', message: '', created: iso(), ...over })
    return id
  }
  test('apply_script 는 허용(draft 포함), 모르는 type 은 무시', async () => {
    expect(REQUEST_TYPES).toContain('apply_script')
    await initProject('rq')
    const d = mk('rq', { draft: true }), f = mk('rq', {}), g = mk('rq', { draft: 'yes' }), bad = mk('rq', { type: 'apply_scripts' }), bad2 = mk('rq', { type: 'delete_all' })
    const rs = await listRequests('rq')
    const byId = new Map(rs.map(r => [r.id, r]))
    expect(byId.get(d)).toMatchObject({ type: 'apply_script', draft: true, state: 'pending' })
    expect(byId.get(f)!.draft).toBe(false)
    expect(byId.get(g)!.draft).toBe(false)
    expect(byId.has(bad)).toBe(false)
    expect(byId.has(bad2)).toBe(false)
    expect((await pendingRequests('rq')).map(r => r.id).sort()).toEqual([d, f, g].sort())
  })
  test('잠긴 프로젝트는 apply_script 를 가져가지 않음', async () => {
    await initProject('rql')
    mk('rql', { draft: true })
    expect((await pendingRequests('rql')).length).toBe(1)
    await setLock('rql', 'locked', { author: 'user' })
    expect(await pendingRequests('rql')).toEqual([])
  })
  test('다른 요청 type 은 draft 필드를 갖지 않음', async () => {
    await initProject('rqo')
    mk('rqo', { type: 'apply_feedback', draft: true })
    expect('draft' in (await listRequests('rqo'))[0]!).toBe(false)
  })
})

describe('daemon 대본 점검 (scriptPass)', () => {
  const mkDaemon = (eng: TtsEngine) => new Daemon({ tts: eng, noWatch: true, logger: new Logger(join(work, 'd.log')), config: () => ({ ...DEFAULT_CONFIG }) })

  test('script.json 이 바뀐 프로젝트만 음성을 만들고, 자기 write-back 으로 루프 돌지 않음', async () => {
    await mkScript('dp', [L({ text: 'One.' }), L({ start: 2, text: 'Two.' })])
    const eng = fakeEngine()
    const d = mkDaemon(eng)
    const r1 = await d.scriptPass()
    expect(r1.map(x => x.ref.split('/')[1])).toEqual(['dp'])
    expect(r1[0]!.result!.generated.length).toBe(2)
    expect(eng.calls.length).toBe(2)
    expect(rawScript('dp').lines.every((l: any) => /^[0-9a-f]{16}$/.test(l.aiTextHash))).toBe(true)
    // write-back 으로 파일이 바뀌었으니 한 번 더 읽지만 할 일이 없다
    const r2 = await d.scriptPass()
    expect(r2.every(x => x.result!.generated.length === 0)).toBe(true)
    // 그 다음부터는 아예 읽지 않는다
    expect(await d.scriptPass()).toEqual([])
    expect(eng.calls.length).toBe(2)
    // 글이 바뀌면(앱이 씀) 그 줄만 다시
    const j = rawScript('dp'); j.lines[0].text = 'One changed.'
    writeFileSync(scriptPath('dp'), JSON.stringify(j))
    const r3 = await d.scriptPass()
    expect(r3[0]!.result!.generated.length).toBe(1)
    expect(eng.calls.length).toBe(3)
  })
  test('잠긴 프로젝트는 건너뛰고, 잠금 해제 뒤에는 만든다', async () => {
    await mkScript('dl', [L({ text: 'x' })])
    const eng = fakeEngine()
    const d = mkDaemon(eng)
    await setLock('dl', 'locked', { author: 'user' })
    expect(await d.scriptPass()).toEqual([])
    expect(eng.calls.length).toBe(0)
    expect(existsSync(join(root, 'dl', 'script', 'ai'))).toBe(false)
    await setLock('dl', 'unlocked', { author: 'user' })
    expect((await d.scriptPass())[0]!.result!.generated.length).toBe(1)
  })
  test('더 새 계약(읽기 전용) 워크스페이스는 건너뜀', async () => {
    await mkScript('dr', [L({ text: 'x' })])
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({ schema: 1, name: 'x', contract: '2.0' }))
    const eng = fakeEngine()
    expect(await mkDaemon(eng).scriptPass()).toEqual([])
    expect(eng.calls.length).toBe(0)
  })
  test('엔진 설정 오류는 기록만 하고 대본이 바뀌기 전에는 재시도하지 않음', async () => {
    await mkScript('de', [L({ text: 'x' })])
    let n = 0
    const d = mkDaemon({ name: 'openai', async synth() { n++; throw new TtsConfigError('API 키 설정 필요: x') } })
    const r = await d.scriptPass()
    expect(r[0]!.error).toContain('API 키 설정 필요')
    expect(await d.scriptPass()).toEqual([])
    expect(n).toBe(1)
  })
  test('대본이 없는 프로젝트는 아무 일도 하지 않음', async () => {
    await initProject('dn')
    expect(await mkDaemon(fakeEngine()).scriptPass()).toEqual([])
  })
})
