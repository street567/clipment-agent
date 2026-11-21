import { join } from 'node:path'
import { readJson } from './fsutil.ts'
import { ValidationError } from './paths.ts'

/** 이 구현이 지원하는 계약 major.minor. spec/contract.json 과 어긋나면 테스트가 실패한다. */
export const SUPPORTED = { major: 1, minor: 6 } as const
/** 데이터에 찍는 값 ("1.6") */
export const CONTRACT_STAMP = `${SUPPORTED.major}.${SUPPORTED.minor}`

export interface ContractVersion { major: number; minor: number }
export type Compat = 'ok' | 'newer-minor' | 'newer-major'

/** "1.6" / "1.6.0" → {1,6}. 없거나 해석 못 하면 1.0 */
export function parseContract(v: unknown): ContractVersion {
  if (typeof v === 'string') {
    const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(v.trim())
    if (m) return { major: Number(m[1]), minor: Number(m[2]) }
  }
  return { major: 1, minor: 0 }
}

export const formatContract = (c: ContractVersion) => `${c.major}.${c.minor}`

/** major 가 더 크면 읽기 전용(newer-major), 같은 major 에 minor 가 크면 정상(newer-minor) */
export function compat(found: ContractVersion, supported: ContractVersion = SUPPORTED): Compat {
  if (found.major > supported.major) return 'newer-major'
  if (found.major === supported.major && found.minor > supported.minor) return 'newer-minor'
  return 'ok'
}

export const isReadOnly = (c: Compat) => c === 'newer-major'

export function newerContractMessage(c: ContractVersion): string {
  return `이 워크스페이스는 더 새 계약(${formatContract(c)})이에요 · clipment update 필요`
}

export interface WorkspaceContract { version: ContractVersion; compat: Compat; readOnly: boolean }

/** 워크스페이스 폴더의 workspace.json 에서 계약 버전을 읽는다 (없으면 1.0) */
export async function readWorkspaceContract(wsPath: string): Promise<WorkspaceContract> {
  const j = await readJson(join(wsPath, 'workspace.json'))
  const version = parseContract(j?.contract)
  const c = compat(version)
  return { version, compat: c, readOnly: isReadOnly(c) }
}

/** 쓰기 작업 전 호출. 더 새 major 면 거부 (force 로도 우회 불가) */
export async function assertWorkspaceWritable(wsPath: string): Promise<void> {
  const c = await readWorkspaceContract(wsPath)
  if (c.readOnly) throw new ValidationError(newerContractMessage(c.version))
}
