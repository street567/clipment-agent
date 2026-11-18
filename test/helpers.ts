import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'cliprev-test-'))
  process.env.CLIPREV_ROOT = d
  return d
}

/** 앱이 하듯 파일을 직접 쓴다 */
export function appWrite(root: string, slug: string, rel: string, obj: unknown) {
  const p = join(root, slug, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify(obj))
  return p
}

export const uid = () => randomUUID()
export const iso = (offsetSec = 0) => new Date(Date.now() + offsetSec * 1000).toISOString()
