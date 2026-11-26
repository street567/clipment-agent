import { spawnSync } from 'node:child_process'
import { ValidationError } from './core/paths.ts'
import { LEGACY_MARKETPLACE, LEGACY_PLUGIN_ID, MARKETPLACE, PLUGIN_ID, REPO } from './names.ts'

/** "12.5" | "1:05" | "1:05.5" | "0:01:05" → 초. 음수·잘못된 값은 ValidationError */
export function parseSeconds(v: string, name: string): number {
  const bad = () => new ValidationError(`--${name} 는 초(12.5) 또는 m:ss(.s) 여야 합니다: ${v}`)
  const parts = v.trim().split(':')
  if (parts.length > 3 || parts.some(x => !/^\d+(\.\d+)?$/.test(x))) throw bad()
  const n = parts.reduce((acc, x) => acc * 60 + Number(x), 0)
  if (!Number.isFinite(n)) throw bad()
  return n
}

/** ISO(UTC) 시각 → 로컬 "2026-11-25 03:16:12 (5초 전)". state.json 은 UTC 라 그대로 보이면 9시간 전처럼 보인다 */
export function localTime(iso: unknown, now = Date.now()): string {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return '?'
  const d = new Date(t), z = (n: number) => String(n).padStart(2, '0')
  const ago = Math.max(0, Math.round((now - t) / 1000))
  const rel = ago < 90 ? `${ago}초 전` : ago < 5400 ? `${Math.round(ago / 60)}분 전` : ago < 129600 ? `${Math.round(ago / 3600)}시간 전` : `${Math.round(ago / 86400)}일 전`
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())} (${rel})`
}

/** claude 가 PATH 에 있고 PLUGIN_ID(client-ai-bridge@street567)가 설치돼 있으면 마켓플레이스 → 플러그인 순으로 갱신. 실패해도 업데이트 전체는 성공으로 둔다. 예전 플러그인(clipment@clipment-agent)만 있으면 이전 방법을 안내한다. */
export function updateClaudePlugin(env: NodeJS.ProcessEnv = process.env): 'skipped' | 'no-claude' | 'not-installed' | 'updated' | 'failed' {
  if (env.CLIPMENT_SKIP_PLUGIN_UPDATE === '1') return 'skipped'
  const list = spawnSync('claude', ['plugin', 'list', '--json'], { encoding: 'utf8', timeout: 60_000, env })
  if (list.error || list.status === null) return 'no-claude'
  const text = `${list.stdout}${list.stderr}`
  if (!text.includes(PLUGIN_ID) && !(list.status === 0 && hasPlugin(list.stdout, PLUGIN_ID))) {
    if (text.includes(LEGACY_PLUGIN_ID) || (list.status === 0 && hasPlugin(list.stdout, LEGACY_PLUGIN_ID))) {
      console.log(`예전 Claude 플러그인(${LEGACY_PLUGIN_ID})이 설치돼 있어요. 새 이름으로 옮기세요:`)
      console.log(`  claude plugin uninstall ${LEGACY_PLUGIN_ID} && claude plugin marketplace remove ${LEGACY_MARKETPLACE}`)
      console.log(`  claude plugin marketplace add ${REPO} && claude plugin install ${PLUGIN_ID}`)
    } else console.log(`Claude 플러그인(${PLUGIN_ID})이 설치돼 있지 않아 건너뜁니다.`)
    return 'not-installed'
  }
  let ok = true
  for (const args of [['plugin', 'marketplace', 'update', MARKETPLACE], ['plugin', 'update', PLUGIN_ID]]) {
    const r = spawnSync('claude', args, { stdio: 'inherit', timeout: 180_000, env })
    if (r.status !== 0) { ok = false; console.error(`경고: claude ${args.join(' ')} 실패 (무시하고 계속)`) }
  }
  if (ok) console.log('Claude 플러그인 갱신 완료 (적용은 새 세션부터 — 열린 세션은 자동 업데이트를 켜 두면 그대로 새 서버로 바뀝니다)')
  return ok ? 'updated' : 'failed'
}
function hasPlugin(out: string, id: string): boolean {
  const [name, marketplace] = id.split('@')
  try {
    const walk = (v: any): boolean => typeof v === 'string' ? v === id : Array.isArray(v) ? v.some(walk) : v && typeof v === 'object' ? (v.name === name && v.marketplace === marketplace) || Object.values(v).some(walk) : false
    return walk(JSON.parse(out))
  } catch { return false }
}

