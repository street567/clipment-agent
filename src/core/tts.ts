import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bin, run } from './media.ts'
import { ValidationError } from './paths.ts'
import type { ScriptLanguage } from './script.ts'

/**
 * AI 음성 합성 엔진. 결과는 AAC m4a 파일로 `out` 에 쓴다 (호출자가 임시 이름을 주고 rename 한다).
 * 엔진 설정 우선순위: 환경변수 CLIPMENT_TTS_ENGINE > ~/.config/clipment/daemon.json 의 ttsEngine > say
 */
export interface TtsEngine {
  readonly name: string
  synth(text: string, o: { language: ScriptLanguage; out: string }): Promise<void>
}

/** 엔진을 쓸 수 없는 설정 문제(음성 없음·API 키 없음 등). 줄마다 같은 오류가 반복되므로 호출자는 중단한다. */
export class TtsConfigError extends ValidationError {}

export const TTS_ENGINES = ['say', 'openai', 'elevenlabs'] as const
export type TtsEngineName = (typeof TTS_ENGINES)[number]
export const DEFAULT_TTS_ENGINE: TtsEngineName = 'say'

/** 언어별 기본 음성. CLIPMENT_TTS_VOICE_EN / CLIPMENT_TTS_VOICE_KO 로 바꿀 수 있다. */
export const SAY_VOICES: Record<ScriptLanguage, string> = { en: 'Samantha', ko: 'Yuna' }
const LOCALE_PREFIX: Record<ScriptLanguage, string> = { en: 'en_', ko: 'ko_' }

export function parseSayVoices(listing: string): { name: string; locale: string }[] {
  const out: { name: string; locale: string }[] = []
  for (const line of listing.split('\n')) {
    const m = /^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/.exec(line.trim())
    if (m) out.push({ name: m[1]!.trim(), locale: m[2]! })
  }
  return out
}

export interface SayEngineDeps { run?: typeof run; voices?: Partial<Record<ScriptLanguage, string>> }

export function sayEngine(deps: SayEngineDeps = {}): TtsEngine {
  const exec = deps.run ?? run
  return {
    name: 'say',
    async synth(text, { language, out }) {
      const voice = deps.voices?.[language] || process.env[`CLIPMENT_TTS_VOICE_${language.toUpperCase()}`]?.trim() || SAY_VOICES[language]
      const work = await mkdtemp(join(tmpdir(), 'clipment-tts-'))
      try {
        const txt = join(work, 'text.txt')
        const aiff = join(work, 'voice.aiff')
        await writeFile(txt, text.normalize('NFC').trim() + '\n')
        let used = voice
        let r = await sayOnce(exec, used, txt, aiff)
        if (r.code !== 0 && /not found/i.test(r.err)) {
          // 지정 음성이 없으면 같은 언어(로캘)의 설치된 다른 음성을 찾는다
          const list = await exec('say', ['-v', '?']).catch(() => null)
          const alt = list ? parseSayVoices(list.out.toString('utf8')).find(v => v.locale.startsWith(LOCALE_PREFIX[language]) && v.name !== voice) : undefined
          if (!alt) throw new TtsConfigError(`say 음성 "${voice}" 을(를) 찾을 수 없습니다 (${language}). 설치된 음성 확인: say -v '?' — 시스템 설정 > 손쉬운 사용 > 말하기 콘텐츠에서 음성을 내려받거나 CLIPMENT_TTS_VOICE_${language.toUpperCase()} 로 다른 음성을 지정하세요`)
          used = alt.name
          r = await sayOnce(exec, used, txt, aiff)
        }
        if (r.code !== 0) throw new Error(`say 실패 (음성 ${used}): ${r.err.trim() || r.code}`)
        const f = await exec(bin('ffmpeg'), ['-y', '-v', 'error', '-i', aiff, '-vn', '-c:a', 'aac', '-b:a', '96k', '-ar', '44100', '-ac', '1', '-f', 'ipod', out])
        if (f.code !== 0) throw new Error(`ffmpeg(aiff → m4a) 실패: ${f.err.trim()}`)
      } finally {
        await rm(work, { recursive: true, force: true })
      }
    },
  }
}

async function sayOnce(exec: typeof run, voice: string, textFile: string, aiff: string) {
  try { return await exec('say', ['-v', voice, '-f', textFile, '-o', aiff]) }
  catch (e) { throw new TtsConfigError(`say 를 실행할 수 없습니다 (macOS 전용): ${e instanceof Error ? e.message : e}`) }
}

/** 클라우드 TTS 자리표시자: 네트워크 호출 없이 항상 설정 필요 오류 */
function placeholderEngine(name: 'openai' | 'elevenlabs', keyEnv: string): TtsEngine {
  return {
    name,
    async synth() {
      throw new TtsConfigError(`API 키 설정 필요: ${name} TTS 엔진은 아직 연결되지 않았습니다 (${keyEnv} 설정과 구현 필요). 지금은 CLIPMENT_TTS_ENGINE=say 를 쓰세요`)
    },
  }
}

export function resolveTtsEngineName(name?: string | null): TtsEngineName {
  const n = (name ?? process.env.CLIPMENT_TTS_ENGINE ?? '').trim().toLowerCase()
  if (!n) return DEFAULT_TTS_ENGINE
  if (!(TTS_ENGINES as readonly string[]).includes(n)) throw new ValidationError(`알 수 없는 TTS 엔진: ${n} (${TTS_ENGINES.join('|')})`)
  return n as TtsEngineName
}

export function createTtsEngine(name?: string | null): TtsEngine {
  const n = resolveTtsEngineName(name)
  if (n === 'openai') return placeholderEngine('openai', 'OPENAI_API_KEY')
  if (n === 'elevenlabs') return placeholderEngine('elevenlabs', 'ELEVENLABS_API_KEY')
  return sayEngine()
}
