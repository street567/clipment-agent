import { pickUnclaimed, repushText } from '../src/daemon/health.ts'
import type { PendingRequest } from '../src/core/index.ts'

/** 미처리 요청 재알림 문구 (health) */
export function unclaimedLine(r: PendingRequest): string {
  const u = pickUnclaimed([{ ...r, created: new Date(Date.now() - 3_600_000).toISOString() }], Date.now(), 60_000)
  return repushText(u)
}
