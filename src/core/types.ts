export const TAGS = ['cut', 'subtitle', 'broll_swap', 'broll_remove', 'layout', 'audio', 'other'] as const
export type Tag = (typeof TAGS)[number]

export const COMMENT_STATUSES = ['open', 'doing', 'done', 'question', 'wontfix'] as const
export type CommentStatus = (typeof COMMENT_STATUSES)[number]

export const REQUEST_TYPES = ['apply_feedback', 'answer', 'rerender', 'cancel'] as const
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
}

export interface CommentWithStatus extends Comment {
  status: CommentStatus
  fixedIn: number | null
  replyCount: number
  /** 현재 영역(답글의 최신 regions, 없으면 코멘트 것). 없으면 [] */
  currentRegions: RegionView[]
}

export interface Reply {
  schema: number; id: string; commentId: string; author: string; authorName?: string; text: string
  status?: CommentStatus; fixedIn?: number; created: string
  regions?: Region[]; kind?: 'regions'
}

export interface Request {
  schema: number; id: string; type: RequestType; version: number
  commentIds: string[] | null; agent: string; authorName?: string; message: string; created: string
}

export interface ProgressEvent {
  schema: number; id: string; requestId: string; state: ProgressState
  message: string; agent: string; created: string
}

/** 요청의 현재 상태: 가장 최근 이벤트의 state, 없으면 'pending'(대기) */
export type RequestState = ProgressState | 'pending'
export interface RequestWithState extends Request { state: RequestState }
