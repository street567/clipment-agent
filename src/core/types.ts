export const TAGS = ['cut', 'subtitle', 'broll_swap', 'broll_remove', 'layout', 'audio', 'other'] as const
export type Tag = (typeof TAGS)[number]

export const COMMENT_STATUSES = ['open', 'doing', 'done', 'question', 'wontfix'] as const
export type CommentStatus = (typeof COMMENT_STATUSES)[number]

export const REQUEST_TYPES = ['apply_feedback', 'answer', 'rerender', 'cancel'] as const
export type RequestType = (typeof REQUEST_TYPES)[number]

export const PROGRESS_STATES = ['received', 'working', 'done', 'failed'] as const
export type ProgressState = (typeof PROGRESS_STATES)[number]

export interface Project { schema: number; id: string; title: string; created: string }

export interface VersionMeta {
  schema: number; version: number; label: string; file: string
  duration: number; fps: number; width: number; height: number
  note: string; source: string; created: string
}

export interface Comment {
  schema: number; id: string; version: number; t: number; end: number | null
  tag: Tag; text: string; author: string; created: string
}

export interface CommentWithStatus extends Comment {
  status: CommentStatus
  fixedIn: number | null
  replyCount: number
}

export interface Reply {
  schema: number; id: string; commentId: string; author: string; text: string
  status?: CommentStatus; fixedIn?: number; created: string
}

export interface Request {
  schema: number; id: string; type: RequestType; version: number
  commentIds: string[] | null; agent: string; message: string; created: string
}

export interface ProgressEvent {
  schema: number; id: string; requestId: string; state: ProgressState
  message: string; agent: string; created: string
}

/** 요청의 현재 상태: 가장 최근 이벤트의 state, 없으면 'pending'(대기) */
export type RequestState = ProgressState | 'pending'
export interface RequestWithState extends Request { state: RequestState }
