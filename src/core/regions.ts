import type { Comment, Region, RegionView, Reply } from './types.ts'

export const MAX_REGIONS = 8
const r4 = (n: number) => Math.round(n * 10000) / 10000
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/**
 * regions 검증/정규화 (SPEC §6). 배열이 아니면 undefined("필드 없음"),
 * 배열이면 잘못된 항목은 버리고 0~1 로 clamp(x+w, y+h 도 1 이하), 소수 4자리, 최대 8개.
 */
export function normalizeRegions(raw: unknown): Region[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: Region[] = []
  for (const it of raw) {
    if (out.length >= MAX_REGIONS) break
    if (!it || typeof it !== 'object') continue
    const { x, y, w, h, label } = it as Record<string, unknown>
    if (![x, y, w, h].every(v => typeof v === 'number' && Number.isFinite(v))) continue
    const X = clamp01(x as number), Y = clamp01(y as number)
    const W = Math.min(clamp01(w as number), 1 - X), H = Math.min(clamp01(h as number), 1 - Y)
    if (W <= 0 || H <= 0) continue
    const reg: Region = { x: r4(X), y: r4(Y), w: r4(W), h: r4(H) }
    if (typeof label === 'string' && label.trim()) reg.label = label.trim().slice(0, 16)
    out.push(reg)
  }
  return out
}

/** 현재 영역 = regions 필드가 있는 답글 중 가장 최근 것, 없으면 코멘트의 regions. 빈 배열 = 없음 */
export function currentRegions(comment: Pick<Comment, 'regions'>, replies: Reply[]): Region[] {
  let latest: Reply | undefined
  for (const r of replies)
    if (r.regions !== undefined && (!latest || r.created >= latest.created)) latest = r
  return latest ? latest.regions! : comment.regions ?? []
}

/** 박스 중심 기준 3x3 격자 위치 힌트 (예: "아래쪽 가운데") */
export function positionHint(r: Pick<Region, 'x' | 'y' | 'w' | 'h'>): string {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2
  const col = cx < 1 / 3 ? '왼쪽' : cx < 2 / 3 ? '가운데' : '오른쪽'
  const row = cy < 1 / 3 ? '위쪽' : cy < 2 / 3 ? '가운데' : '아래쪽'
  if (row === '가운데' && col === '가운데') return '화면 정중앙'
  return `${row} ${col}`
}

export function toRegionViews(regions: Region[]): RegionView[] {
  return regions.map((r, i) => ({ ...r, index: i + 1, label: r.label ?? String(i + 1), hint: positionHint(r) }))
}

export function currentRegionViews(comment: Pick<Comment, 'regions'>, replies: Reply[]): RegionView[] {
  return toRegionViews(currentRegions(comment, replies))
}

/** CLI 텍스트: "영역 2: [1] x0.12 y0.70 w0.40 h0.10 (아래쪽 가운데), [2] …" */
export function formatRegions(views: RegionView[]): string {
  if (!views.length) return ''
  const f = (n: number) => n.toFixed(2)
  return `영역 ${views.length}: ` + views
    .map(v => `[${v.label}] x${f(v.x)} y${f(v.y)} w${f(v.w)} h${f(v.h)} (${v.hint})`).join(', ')
}

// ---------- 프레임에 그리기 (ffmpeg drawbox) ----------

/** 박스별 고대비 색 (ffmpeg 색 이름, 한글 이름) */
export const REGION_COLORS: { ff: string; ko: string }[] = [
  { ff: 'red', ko: '빨강' }, { ff: 'yellow', ko: '노랑' }, { ff: 'cyan', ko: '하늘' }, { ff: 'magenta', ko: '분홍' },
  { ff: 'lime', ko: '연두' }, { ff: 'orange', ko: '주황' }, { ff: 'blue', ko: '파랑' }, { ff: 'white', ko: '흰색' },
]

/**
 * drawbox 필터 문자열. drawtext 가 없는 ffmpeg 빌드가 흔해서 숫자 대신
 * (1) 라벨 번호별 다른 색, (2) 박스 왼쪽 위 배지에 라벨 숫자를 7세그먼트(drawbox 조각)로 직접 그린다 (1~99).
 * 검은 외곽선 1px 으로 어떤 배경에서도 보이게 한다. 영역이 없으면 null.
 */
/** 라벨이 숫자 문자열이면 그 번호(1~), 아니면 순번 */
export function labelNumber(r: Pick<Region, 'label'>, i: number): number {
  const n = r.label && /^\d{1,2}$/.test(r.label) ? Number(r.label) : 0
  return n >= 1 ? n : i + 1
}
const colorIdx = (n: number) => (n - 1) % REGION_COLORS.length

/** 7세그먼트: 숫자 → 켜지는 세그먼트 (a 위, b 오른쪽 위, c 오른쪽 아래, d 아래, e 왼쪽 아래, f 왼쪽 위, g 가운데) */
export const DIGIT_SEGMENTS: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg',
  '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
}

/** 글자(숫자) 높이: 프레임 높이의 약 4%, 최소 14px */
export const digitHeight = (frameH: number) => Math.max(14, Math.round(frameH * 0.04))

/** 숫자 하나의 세그먼트 사각형들 (원점 ox,oy 기준 픽셀) */
export function digitRects(d: string, ox: number, oy: number, H: number): { x: number; y: number; w: number; h: number }[] {
  const th = Math.max(2, Math.round(H / 7))
  const W = Math.round(H * 0.55)
  const midY = Math.floor((H - th) / 2)
  const upH = midY + th // 위쪽 세로 획 높이 (가운데 가로획까지 포함)
  const lowY = midY
  const R: Record<string, { x: number; y: number; w: number; h: number }> = {
    a: { x: 0, y: 0, w: W, h: th }, d: { x: 0, y: H - th, w: W, h: th }, g: { x: 0, y: midY, w: W, h: th },
    f: { x: 0, y: 0, w: th, h: upH }, b: { x: W - th, y: 0, w: th, h: upH },
    e: { x: 0, y: lowY, w: th, h: H - lowY }, c: { x: W - th, y: lowY, w: th, h: H - lowY },
  }
  return [...(DIGIT_SEGMENTS[d] ?? '')].map(k => { const r = R[k]!; return { x: ox + r.x, y: oy + r.y, w: r.w, h: r.h } })
}

/** 라벨 번호 배지: 검은 판 + 색 테두리 + 흰 7세그먼트 숫자 (박스 왼쪽 위 모서리) */
export function badgeBoxes(num: number, bx: number, by: number, col: string, frameW: number, frameH: number): string[] {
  const H = digitHeight(frameH)
  const th = Math.max(2, Math.round(H / 7))
  const W = Math.round(H * 0.55)
  const digits = String(num)
  const pad = th + 2
  const gap = th + 1
  const bw = pad * 2 + digits.length * W + (digits.length - 1) * gap
  const bh = pad * 2 + H
  const x0 = Math.max(0, Math.min(bx, frameW - bw))
  const y0 = Math.max(0, Math.min(by, frameH - bh))
  const out = [
    `drawbox=x=${x0}:y=${y0}:w=${bw}:h=${bh}:color=black@1:t=fill`,
    `drawbox=x=${x0}:y=${y0}:w=${bw}:h=${bh}:color=${col}@1:t=2`,
  ]
  ;[...digits].forEach((d, i) => {
    for (const r of digitRects(d, x0 + pad + i * (W + gap), y0 + pad, H))
      out.push(`drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=white@1:t=fill`)
  })
  return out
}

export function buildDrawboxFilter(regions: Region[], width: number, height: number): string | null {
  if (!regions.length || width <= 0 || height <= 0) return null
  const stroke = width >= 600 ? 3 : 2
  const parts: string[] = []
  regions.slice(0, MAX_REGIONS).forEach((r, i) => {
    const num = labelNumber(r, i)
    const col = REGION_COLORS[colorIdx(num)]!.ff
    const x = Math.min(width - 2, Math.max(0, Math.round(r.x * width)))
    const y = Math.min(height - 2, Math.max(0, Math.round(r.y * height)))
    const w = Math.max(2, Math.min(width - x, Math.round(r.w * width)))
    const h = Math.max(2, Math.min(height - y, Math.round(r.h * height)))
    parts.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@1:t=${stroke + 2}`)
    parts.push(`drawbox=x=${x + 1}:y=${y + 1}:w=${Math.max(1, w - 2)}:h=${Math.max(1, h - 2)}:color=${col}@1:t=${stroke}`)
    parts.push(...badgeBoxes(num, x, y, col, width, height))
  })
  return parts.join(',')
}

/** 이미지에 그린 영역 설명 (drawtext 미사용 안내 포함) */
export function regionLegend(views: RegionView[]): string {
  if (!views.length) return ''
  const items = views.map((v, i) => {
    return `${v.label}번=${REGION_COLORS[colorIdx(labelNumber(v, i))]!.ko}`
  }).join(', ')
  return `이미지에 영역 ${views.length}개를 사각형으로 그렸습니다(이 ffmpeg 에는 drawtext 가 없어 박스 왼쪽 위 배지에 7세그먼트 숫자로 표시, 박스 색도 라벨별). 라벨→표시: ${items}. 코멘트의 "N번 영역"은 라벨 N 입니다.`
}
