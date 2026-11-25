export const TAGS = ['cut', 'subtitle', 'broll_swap', 'broll_remove', 'layout', 'audio', 'other'] as const
export type Tag = (typeof TAGS)[number]

export const COMMENT_STATUSES = ['open', 'doing', 'done', 'question', 'wontfix'] as const
export type CommentStatus = (typeof COMMENT_STATUSES)[number]

export const REQUEST_TYPES = ['apply_feedback', 'answer', 'rerender', 'cancel', 'apply_script'] as const
export type RequestType = (typeof REQUEST_TYPES)[number]

export const PROGRESS_STATES = ['received', 'working', 'done', 'failed'] as const
export type ProgressState = (typeof PROGRESS_STATES)[number]

export interface Project { schema: number; id: string; title: string; created: string }

export interface LockEvent {
  schema: number; id: string; state: 'locked' | 'unlocked'; author: string; authorName?: string; note: string; created: string
}
export interface ProjectListing extends Project { workspace: string; ref: string; locked: boolean; lock?: LockEvent }

export interface VersionMeta {
  schema: number; version: number; label: string; file: string
  duration: number; fps: number; width: number; height: number
  note: string; source: string; created: string
  /** 이 버전을 만들 때 쓴 작업용 화질 (SPEC §13). 없으면 알 수 없음 */
  quality?: Quality
  /** 업로드용 원본 (SPEC §12). 없으면 미리보기만 있는 버전 */
  original?: VersionOriginal
}

export interface VersionOriginal { file: string; bytes: number; width?: number; height?: number; fps?: number; duration?: number }

/** `<프로젝트>/.clipment/upload.json` 업로드용 버전 지정 (SPEC §12, 고쳐 쓰는 파일) */
export interface UploadDesignation {
  schema: number; version: number; author: string; authorName?: string; via: 'app' | 'mac'; updated: string
}

/** 화면 영역: 영상 프레임 기준 0~1 정규화 사각형 (SPEC §6) */
export interface Region { x: number; y: number; w: number; h: number; label?: string }
/** 출력용: 순번·표시 라벨·위치 힌트 포함 */
export interface RegionView extends Region { index: number; label: string; hint: string }

export interface Comment {
  schema: number; id: string; version: number; t: number; end: number | null
  tag: Tag; text: string; author: string; authorName?: string; created: string
  regions?: Region[]
  /** 사람이 앱 밖(채널·터미널)에서 한 요청을 AI 가 대신 남긴 코멘트 (SPEC §15). 그 외 값·없음 = 앱 */
  via?: 'channel'
}

export interface CommentWithStatus extends Comment {
  status: CommentStatus
  fixedIn: number | null
  /** 반환한 fixedIn 과 같은 답글의 fixedAt (fixedIn 버전 영상에서 바뀐 곳의 시작 초). 없으면 null */
  fixedAt: number | null
  /** 확인됨 (SPEC §15): done|wontfix 이고 사람이 approved 로 확인했으며 그 뒤 새 status 답글이 없음 */
  approved: boolean
  replyCount: number
  /** 현재 영역(답글의 최신 regions, 없으면 코멘트 것). 없으면 [] */
  currentRegions: RegionView[]
}

export interface Reply {
  schema: number; id: string; commentId: string; author: string; authorName?: string; text: string
  status?: CommentStatus; fixedIn?: number; created: string
  /** fixedIn 버전 영상에서 바뀐 곳의 시작 시각(초, SPEC §15). fixedIn 이 있을 때만 의미 */
  fixedAt?: number
  /** 사람의 확인(author=user, kind=review 일 때만 의미, SPEC §15). AI 는 쓰지 않는다 */
  review?: 'approved' | 'pending'
  regions?: Region[]; kind?: 'regions' | 'review'
}

export interface Request {
  schema: number; id: string; type: RequestType; version: number
  commentIds: string[] | null; agent: string; authorName?: string; message: string; created: string
  /** apply_script 전용 (SPEC §14): true = 대본 초안만 쓰기(영상 안 만듦), 아니면 대본+음성을 영상에 반영 */
  draft?: boolean
}

export interface ProgressEvent {
  schema: number; id: string; requestId: string; state: ProgressState
  message: string; agent: string; created: string
}

/** 요청의 현재 상태: 가장 최근 이벤트의 state, 없으면 'pending'(대기) */
export type RequestState = ProgressState | 'pending'
export interface RequestWithState extends Request { state: RequestState }

/** 작업용 화질 (SPEC §13). 긴 변 640/960/1280/1920 */
export const QUALITIES = ['360p', '540p', '720p', '1080p'] as const
export type Quality = (typeof QUALITIES)[number]
export const DEFAULT_QUALITY: Quality = '720p'
/** 옛 'lite' 는 540p 의 별칭. 모르는 값은 null */
export function parseQuality(v: unknown): Quality | null {
  if (v === 'lite') return '540p'
  return typeof v === 'string' && (QUALITIES as readonly string[]).includes(v) ? (v as Quality) : null
}

/** `<프로젝트>/.clipment/quality.json` 프로젝트 화질 지정 (SPEC §13, 고쳐 쓰는 파일) */
export interface QualityDesignation {
  schema: number; quality: Quality; author: string; authorName?: string; via: 'app' | 'mac'; updated: string
}
