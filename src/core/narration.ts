import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { isPlaceholder, materialize } from './fsutil.ts'
import { bin, run } from './media.ts'
import { resolveProject, ValidationError } from './paths.ts'
import { aiStatus, readScript, voiceFileOf } from './script.ts'

export interface NarrationPlacement { id: string; source: 'mine' | 'ai'; file: string; start: number; audioSec: number }
export interface NarrationResult {
  out: string; duration: number
  placed: NarrationPlacement[]
  skipped: { id: string; reason: string }[]
  warnings: string[]
}

export const DEFAULT_NARRATION_TAIL = 0.5

async function audioDuration(file: string): Promise<number> {
  const r = await run(bin('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
  const d = Number(r.out.toString('utf8').trim())
  if (r.code !== 0 || !Number.isFinite(d)) throw new Error(`음성 길이를 읽을 수 없습니다: ${file} ${r.err.trim()}`)
  return d
}

/** ffmpeg 인자 구성 (테스트 가능하도록 분리). 줄마다 adelay 로 start 에 놓고 amix(normalize=0)로 합친 뒤 duration 에 맞춰 패딩/자른다. */
export function buildNarrationArgs(placed: { file: string; start: number }[], duration: number, tmpOut: string): string[] {
  const D = duration.toFixed(3)
  const args = ['-y', '-v', 'error']
  if (!placed.length) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', D)
  } else {
    for (const p of placed) args.push('-i', p.file)
    const parts = placed.map((p, i) => {
      const ms = Math.max(0, Math.round(p.start * 1000))
      return `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${ms}|${ms}[a${i}]`
    })
    const mixIn = placed.map((_, i) => `[a${i}]`).join('')
    parts.push(`${mixIn}amix=inputs=${placed.length}:normalize=0:duration=longest:dropout_transition=0,apad=whole_dur=${D},atrim=end=${D}[out]`)
    args.push('-filter_complex', parts.join(';'), '-map', '[out]')
  }
  // 같은 입력 → 같은 출력: 메타데이터·비트정확 플래그
  args.push('-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-f', 'ipod', tmpOut)
  return args
}

/**
 * 나레이션 트랙 만들기: 줄마다 voice==="mine" 이고 녹음이 있으면 그것, 아니면 최신 AI 음성(없거나 오래됐으면 건너뛰고 경고)을
 * start 초에 놓는다. duration 을 주면 그 길이로 패딩/자른다 (기본: 마지막 음성 끝 + tail). 읽기 전용(프로젝트에 쓰지 않음).
 */
export async function buildNarration(ref: string, o: { out: string; duration?: number; tail?: number }): Promise<NarrationResult> {
  if (o.duration !== undefined && (!Number.isFinite(o.duration) || o.duration <= 0)) throw new ValidationError(`--duration 은 0 보다 큰 초: ${o.duration}`)
  const r = resolveProject(ref)
  const script = await readScript(ref)
  if (!script) throw new ValidationError(`대본이 없습니다(또는 내려받는 중): ${ref}`)
  const placed: NarrationPlacement[] = []
  const skipped: NarrationResult['skipped'] = []
  const warnings: string[] = []
  let lastEnd = 0
  for (const l of script.lines) {
    const mine = voiceFileOf(r.dir, l.id, 'mine')
    const ai = voiceFileOf(r.dir, l.id, 'ai')
    const mineOk = existsSync(mine) && !isPlaceholder(mine)
    let source: 'mine' | 'ai' | null = null
    if (l.voice === 'mine' && mineOk) source = 'mine'
    else {
      const st = aiStatus(r.dir, l, script.language)
      if (st === 'fresh') source = 'ai'
      else {
        const why = st === 'empty' ? '텍스트가 비어 있음' : l.voice === 'mine' ? `내 녹음이 없고 AI 음성도 ${st === 'stale' ? '오래됨' : '없음'}` : `AI 음성이 ${st === 'stale' ? '오래됨' : '없음'} (clipment voice 필요)`
        skipped.push({ id: l.id, reason: why })
        if (st !== 'empty') warnings.push(`줄 ${l.id.slice(0, 8)} "${l.text.slice(0, 20)}" 건너뜀: ${why}`)
        continue
      }
      if (l.voice === 'mine') warnings.push(`줄 ${l.id.slice(0, 8)}: 내 녹음 파일이 없어 AI 음성을 씁니다`)
    }
    const file = source === 'mine' ? mine : ai
    await materialize(file)
    const audioSec = await audioDuration(file)
    placed.push({ id: l.id, source, file, start: l.start, audioSec })
    lastEnd = Math.max(lastEnd, l.start + audioSec)
  }
  const duration = o.duration ?? (placed.length ? lastEnd + (o.tail ?? DEFAULT_NARRATION_TAIL) : 0)
  if (!(duration > 0)) throw new ValidationError('배치할 음성이 없습니다 (--duration 으로 무음 트랙 길이를 지정하거나 clipment voice 로 음성을 만드세요)')
  const out = resolve(o.out)
  const tmp = join(dirname(out), `.${basename(out)}.tmp`)
  const f = await run(bin('ffmpeg'), buildNarrationArgs(placed, duration, tmp))
  if (f.code !== 0) { await rm(tmp, { force: true }); throw new Error(`ffmpeg 나레이션 합성 실패: ${f.err.trim()}`) }
  await rename(tmp, out)
  return { out, duration, placed: placed.map(p => ({ ...p })), skipped, warnings }
}
