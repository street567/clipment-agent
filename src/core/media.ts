import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { versionDir, versionLabel, projectDir, safeJoin, resolveProject, ValidationError } from './paths.ts'
import { isPlaceholder, materialize } from './fsutil.ts'
import { assertUnlocked, getVersion, nextVersionNumber, previewPath, requireProject } from './store.ts'
import { assertWorkspaceWritable } from './contract.ts'
import { writeUploadDesignation } from './upload.ts'
import { agentName } from './wait.ts'
import { buildDrawboxFilter } from './regions.ts'
import type { Region, VersionMeta } from './types.ts'

const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']
function bin(name: string): string {
  for (const d of BIN_DIRS) if (existsSync(join(d, name))) return join(d, name)
  return name
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: Buffer; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    p.stdout.on('data', d => out.push(d))
    p.stderr.on('data', d => { err = (err + d).slice(-4000) })
    p.on('error', reject)
    p.on('close', code => resolve({ code: code ?? 1, out: Buffer.concat(out), err }))
  })
}

export interface ProbeResult { width: number; height: number; rotation: number; fps: number; duration: number }

function parseRate(r: unknown): number {
  if (typeof r !== 'string') return 0
  const [a, b] = r.split('/').map(Number)
  if (!a || !b) return 0
  return a / b
}

export async function probe(file: string): Promise<ProbeResult> {
  const r = await run(bin('ffprobe'), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file])
  if (r.code !== 0) throw new Error(`ffprobe 실패: ${r.err}`)
  const j = JSON.parse(r.out.toString('utf8'))
  const v = (j.streams ?? []).find((s: any) => s.codec_type === 'video')
  if (!v) throw new Error('비디오 스트림이 없습니다')
  let rotation = 0
  for (const sd of v.side_data_list ?? []) if (typeof sd.rotation === 'number') rotation = sd.rotation
  if (!rotation && v.tags?.rotate) rotation = Number(v.tags.rotate) || 0
  const fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30
  const duration = Number(j.format?.duration ?? v.duration ?? 0)
  return { width: v.width, height: v.height, rotation, fps, duration }
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

export type PreviewPreset = 'default' | 'lite'
export const PRESETS: Record<PreviewPreset, { longEdge: number; crf: number; maxFps: number; audioBitrate: string }> = {
  default: { longEdge: 1280, crf: 26, maxFps: 60, audioBitrate: '128k' },
  lite: { longEdge: 960, crf: 30, maxFps: 30, audioBitrate: '96k' },
}

/** 회전 적용 후 표시 크기와 목표 크기(기본 긴 변 1280, 업스케일 안 함) 계산 */
export function targetSize(p: Pick<ProbeResult, 'width' | 'height' | 'rotation'>, longEdge = 1280) {
  const swap = Math.abs(Math.round(p.rotation)) % 180 === 90
  const dw = swap ? p.height : p.width
  const dh = swap ? p.width : p.height
  const scale = Math.min(1, longEdge / Math.max(dw, dh))
  return { displayW: dw, displayH: dh, width: even(dw * scale), height: even(dh * scale) }
}

/** ffmpeg 인자 구성 (테스트 가능하도록 분리) */
export function buildEncodeArgs(src: string, out: string, p: ProbeResult, preset: PreviewPreset = 'default'): string[] {
  const cfg = PRESETS[preset]
  const t = targetSize(p, cfg.longEdge)
  return [
    '-y', '-v', 'error', '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?',
    // ffmpeg 기본 autorotate 로 회전이 먼저 적용된 뒤 scale 이 동작한다
    '-vf', `scale=${t.width}:${t.height}`,
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', String(cfg.crf), '-preset', 'veryfast',
    ...(p.fps > cfg.maxFps ? ['-r', String(cfg.maxFps)] : []),
    '-c:a', 'aac', '-b:a', cfg.audioBitrate,
    '-movflags', '+faststart', out,
  ]
}

async function encodePreview(src: string, out: string, p: ProbeResult, preset: PreviewPreset) {
  const args = buildEncodeArgs(src, out, p, preset)
  const r = await run(bin('ffmpeg'), args)
  if (r.code !== 0) throw new Error(`ffmpeg 인코딩 실패: ${r.err}`)
}

export interface PublishOptions {
  note?: string; lite?: boolean; force?: boolean
  /** true 면 원본을 복사하지 않는다 (용량이 큰 소스용). 기본: 원본 포함 (SPEC §12) */
  noOriginal?: boolean
  /** true 면 이 새 버전을 업로드용으로 지정한다 */
  upload?: boolean
}

/** 원본 파일 이름: original.<소스 확장자(소문자)>, 확장자가 없거나 이상하면 mp4 */
export function originalFileName(video: string): string {
  const ext = extname(video).slice(1).toLowerCase()
  return `original.${/^[a-z0-9]{1,8}$/.test(ext) ? ext : 'mp4'}`
}

export async function publishVersion(slug: string, video: string, opts: PublishOptions = {}): Promise<VersionMeta> {
  await requireProject(slug)
  await assertWorkspaceWritable(resolveProject(slug).workspace.path)
  if (!opts.force) await assertUnlocked(slug)
  if (!existsSync(video)) throw new ValidationError(`영상 파일 없음: ${video}`)
  if (isPlaceholder(video)) throw new ValidationError(`영상이 아직 iCloud에서 내려받아지지 않았습니다: ${video}`)
  const src = await probe(video)

  const work = await mkdtemp(join(tmpdir(), 'cliprev-'))
  try {
    const tmpOut = join(work, 'preview.mp4')
    await encodePreview(video, tmpOut, src, opts.lite ? 'lite' : 'default')
    const outProbe = await probe(tmpOut)

    const n = await nextVersionNumber(slug)
    const finalDir = versionDir(slug, n)
    const stage = safeJoin(projectDir(slug), 'versions', `.${versionLabel(n)}.tmp`)
    await rm(stage, { recursive: true, force: true })
    await mkdir(stage, { recursive: true })
    await copyFile(tmpOut, join(stage, 'preview.mp4'))
    let original: VersionMeta['original']
    if (!opts.noOriginal) {
      // 소스를 변환 없이 그대로 복사 (staging 안이라 폴더 rename 때 함께 나타난다)
      const file = originalFileName(video)
      await copyFile(video, join(stage, file))
      const d = targetSize(src, Number.MAX_SAFE_INTEGER)   // 회전 적용 후 표시 크기
      original = {
        file, bytes: statSync(join(stage, file)).size, width: d.displayW, height: d.displayH,
        fps: Math.round(src.fps * 100) / 100, duration: Math.round(src.duration * 100) / 100,
      }
    }
    const meta: VersionMeta = {
      schema: 1, version: n, label: versionLabel(n), file: 'preview.mp4',
      duration: Math.round(outProbe.duration * 100) / 100,
      fps: Math.round(Math.min(src.fps, PRESETS[opts.lite ? 'lite' : 'default'].maxFps) * 100) / 100,
      width: outProbe.width, height: outProbe.height,
      note: opts.note ?? '', source: basename(video), created: new Date().toISOString(),
      ...(original ? { original } : {}),
    }
    await writeFile(join(stage, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
    await rename(stage, finalDir) // 폴더째 원자적 공개: 앱은 meta.json 이 있는 완성 폴더만 본다
    if (opts.upload) {
      await writeUploadDesignation(projectDir(slug), {
        schema: 1, version: n, author: agentName(), via: 'mac', updated: new Date().toISOString(),
        ...(process.env.CLIPREV_AGENT_NAME?.trim() ? { authorName: process.env.CLIPREV_AGENT_NAME.trim().slice(0, 64) } : {}),
      })
    }
    return meta
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** 해당 버전 preview 의 t초 프레임을 JPEG 버퍼로 */
export async function extractFrame(slug: string, version: number, t: number, opts: { regions?: Region[] } = {}): Promise<Buffer> {
  const meta = await getVersion(slug, version)
  if (!meta) throw new ValidationError(`버전 ${version} 을(를) 찾을 수 없습니다`)
  const file = previewPath(slug, version)
  if (!existsSync(file) || isPlaceholder(file)) throw new ValidationError(`preview.mp4 가 아직 없거나 내려받는 중입니다 (v${version})`)
  await materialize(file) // 온라인 전용(구글 드라이브 스트리밍 등) 파일을 끝까지 읽어 내려받는다
  const at = Math.max(0, meta.duration > 0 ? Math.min(t, Math.max(0, meta.duration - 0.05)) : t)
  // 좌표 기준은 preview 의 표시 크기 (ffmpeg autorotate 후)
  const vf = opts.regions?.length ? buildDrawboxFilter(opts.regions, meta.width, meta.height) : null
  const r = await run(bin('ffmpeg'), [
    '-v', 'error', '-ss', at.toFixed(3), '-i', file, ...(vf ? ['-vf', vf] : []), '-frames:v', '1', '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
  ])
  if (r.code !== 0 || r.out.length === 0) throw new Error(`프레임 추출 실패: ${r.err}`)
  return r.out
}
