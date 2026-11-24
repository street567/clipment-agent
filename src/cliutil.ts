import { spawnSync } from 'node:child_process'

/** ISO(UTC) 시각 → 로컬 "2026-11-25 03:16:12 (5초 전)". state.json 은 UTC 라 그대로 보이면 9시간 전처럼 보인다 */
export function localTime(iso: unknown, now = Date.now()): string {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return '?'
  const d = new Date(t), z = (n: number) => String(n).padStart(2, '0')
  const ago = Math.max(0, Math.round((now - t) / 1000))
  const rel = ago < 90 ? `${ago}초 전` : ago < 5400 ? `${Math.round(ago / 60)}분 전` : ago < 129600 ? `${Math.round(ago / 3600)}시간 전` : `${Math.round(ago / 86400)}일 전`
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())} (${rel})`
}

/** claude 가 PATH 에 있고 clipment@clipment-agent 가 설치돼 있으면 마켓플레이스 → 플러그인 순으로 갱신. 실패해도 업데이트 전체는 성공으로 둔다. */
export function updateClaudePlugin(env: NodeJS.ProcessEnv = process.env): 'skipped' | 'no-claude' | 'not-installed' | 'updated' | 'failed' {
  if (env.CLIPMENT_SKIP_PLUGIN_UPDATE === '1') return 'skipped'
  const list = spawnSync('claude', ['plugin', 'list', '--json'], { encoding: 'utf8', timeout: 60_000, env })
  if (list.error || list.status === null) return 'no-claude'
  if (!`${list.stdout}${list.stderr}`.includes('clipment@clipment-agent') && !(list.status === 0 && hasPlugin(list.stdout))) {
    console.log('Claude 플러그인(clipment@clipment-agent)이 설치돼 있지 않아 건너뜁니다.')
    return 'not-installed'
  }
  let ok = true
  for (const args of [['plugin', 'marketplace', 'update', 'clipment-agent'], ['plugin', 'update', 'clipment@clipment-agent']]) {
    const r = spawnSync('claude', args, { stdio: 'inherit', timeout: 180_000, env })
    if (r.status !== 0) { ok = false; console.error(`경고: claude ${args.join(' ')} 실패 (무시하고 계속)`) }
  }
  if (ok) console.log('Claude 플러그인 갱신 완료 (적용은 새 세션부터 — 열린 세션은 자동 업데이트를 켜 두면 그대로 새 서버로 바뀝니다)')
  return ok ? 'updated' : 'failed'
}
function hasPlugin(out: string): boolean {
  try {
    const walk = (v: any): boolean => typeof v === 'string' ? v === 'clipment@clipment-agent' : Array.isArray(v) ? v.some(walk) : v && typeof v === 'object' ? (v.name === 'clipment' && v.marketplace === 'clipment-agent') || Object.values(v).some(walk) : false
    return walk(JSON.parse(out))
  } catch { return false }
}

