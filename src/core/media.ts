import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { versionDir, versionLabel, projectDir, safeJoin, ValidationError } from './paths.ts'
import { isPlaceholder } from './fsutil.ts'
import { getVersion, nextVersionNumber, previewPath, requireProject } from './store.ts'
import type { VersionMeta } from './types.ts'

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

/** 회전 적용 후 표시 크기와 목표 크기(긴 변 1280, 업스케일 안 함) 계산 */
export function targetSize(p: Pick<ProbeResult, 'width' | 'height' | 'rotation'>) {
  const swap = Math.abs(Math.round(p.rotation)) % 180 === 90
  const dw = swap ? p.height : p.width
  const dh = swap ? p.width : p.height
  const scale = Math.min(1, 1280 / Math.max(dw, dh))
  return { displayW: dw, displayH: dh, width: even(dw * scale), height: even(dh * scale) }
}

async function encodePreview(src: string, out: string, p: ProbeResult) {
  const t = targetSize(p)
  const args = [
    '-y', '-v', 'error', '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?',
    // ffmpeg 기본 autorotate 로 회전이 먼저 적용된 뒤 scale 이 동작한다
    '-vf', `scale=${t.width}:${t.height}`,
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '26', '-preset', 'veryfast',
    ...(p.fps > 60 ? ['-r', '60'] : []),
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', out,
  ]
  const r = await run(bin('ffmpeg'), args)
  if (r.code !== 0) throw new Error(`ffmpeg 인코딩 실패: ${r.err}`)
}

export interface PublishOptions { note?: string }

export async function publishVersion(slug: string, video: string, opts: PublishOptions = {}): Promise<VersionMeta> {
  await requireProject(slug)
  if (!existsSync(video)) throw new ValidationError(`영상 파일 없음: ${video}`)
  if (isPlaceholder(video)) throw new ValidationError(`영상이 아직 iCloud에서 내려받아지지 않았습니다: ${video}`)
  const src = await probe(video)

  const work = await mkdtemp(join(tmpdir(), 'cliprev-'))
  try {
    const tmpOut = join(work, 'preview.mp4')
    await encodePreview(video, tmpOut, src)
    const outProbe = await probe(tmpOut)

    const n = await nextVersionNumber(slug)
    const finalDir = versionDir(slug, n)
    const stage = safeJoin(projectDir(slug), 'versions', `.${versionLabel(n)}.tmp`)
    await rm(stage, { recursive: true, force: true })
    await mkdir(stage, { recursive: true })
    await copyFile(tmpOut, join(stage, 'preview.mp4'))
    const meta: VersionMeta = {
      schema: 1, version: n, label: versionLabel(n), file: 'preview.mp4',
      duration: Math.round(outProbe.duration * 100) / 100,
      fps: Math.round(Math.min(src.fps, 60) * 100) / 100,
      width: outProbe.width, height: outProbe.height,
      note: opts.note ?? '', source: basename(video), created: new Date().toISOString(),
    }
    await writeFile(join(stage, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
    await rename(stage, finalDir) // 폴더째 원자적 공개: 앱은 meta.json 이 있는 완성 폴더만 본다
    return meta
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** 해당 버전 preview 의 t초 프레임을 JPEG 버퍼로 */
export async function extractFrame(slug: string, version: number, t: number): Promise<Buffer> {
  const meta = await getVersion(slug, version)
  if (!meta) throw new ValidationError(`버전 ${version} 을(를) 찾을 수 없습니다`)
  const file = previewPath(slug, version)
  if (!existsSync(file) || isPlaceholder(file)) throw new ValidationError(`preview.mp4 가 아직 없거나 내려받는 중입니다 (v${version})`)
  const at = Math.max(0, meta.duration > 0 ? Math.min(t, Math.max(0, meta.duration - 0.05)) : t)
  const r = await run(bin('ffmpeg'), [
    '-v', 'error', '-ss', at.toFixed(3), '-i', file, '-frames:v', '1', '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
  ])
  if (r.code !== 0 || r.out.length === 0) throw new Error(`프레임 추출 실패: ${r.err}`)
  return r.out
}
