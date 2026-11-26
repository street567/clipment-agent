// 비밀 가리기(SPEC §1). 도구 출력은 애초에 쓰지 않고, 쓰는 모든 글(제목·요약·보고·코멘트)을 여기를 거친다.
const MASK = '•••'

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, MASK],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bAKIA[0-9A-Z]{12,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, MASK],
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}/g, MASK], // 텔레그램 봇 토큰
  [/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, `Bearer ${MASK}`],
  [/\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, `$1=${MASK}`],
  [/\b(password|passwd|pwd|secret|token|api[-_ ]?key|apikey)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, `$1=${MASK}`],
]

// 두 마디 이상의 절대 경로는 마지막 이름만 남긴다 ("전체 경로를 클라우드에 쓰지 않는다").
// 앞 글자가 단어·':'·'/'·'.' 이면 URL 이나 상대 경로이므로 건드리지 않는다.
const PATH_RE = /(?<![\w:/.~-])~?(?:\/[\w.@+%=,-]+){2,}\/?/g

export function stripControl(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, '')
}

export function redact(s: string): string {
  let out = s
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep)
  out = out.replace(PATH_RE, (m) => {
    const parts = m.split('/').filter(Boolean)
    return `…/${parts[parts.length - 1]}`
  })
  return out
}

/** 글자(코드포인트) 단위로 자르고 넘치면 … */
export function clip(s: string, max: number): string {
  const cps = Array.from(s)
  if (cps.length <= max) return s
  return cps.slice(0, Math.max(0, max - 1)).join('') + '…'
}

/** 제어문자 제거 → 비밀·경로 가리기 → 길이 제한 (자르기 전에 가려야 잘린 비밀이 안 남는다) */
export function clean(s: unknown, max: number): string {
  if (typeof s !== 'string') return ''
  return clip(redact(stripControl(s)), max)
}

export function oneLine(s: string, max: number): string {
  return clip(s.replace(/\s+/g, ' ').trim(), max)
}
