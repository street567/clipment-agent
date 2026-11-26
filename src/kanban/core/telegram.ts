// 텔레그램 알림 (기본 꺼짐). 토큰은 환경변수에서만. 실패는 조용히 무시, 토큰은 로그·오류에 남기지 않는다.
import { envToken, type Config } from '../config.ts'
import { logLine } from './localstate.ts'
import { clip } from './redact.ts'

export async function sendTelegram(cfg: Config, text: string): Promise<boolean> {
  const t = cfg.telegram
  if (!t.enabled || !t.chatId) return false
  const token = envToken(cfg)
  if (!token) return false
  const timeout = Number(process.env.AGENT_KANBAN_TELEGRAM_TIMEOUT_MS) || 5000
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  try {
    const res = await fetch(`${t.apiBase}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: t.chatId, text: clip(text, 1500), disable_web_page_preview: true }),
      signal: ctl.signal,
    })
    if (!res.ok) logLine('telegram', `HTTP ${res.status}`)
    return res.ok
  } catch (e: any) {
    logLine('telegram', `전송 실패(${e?.name ?? 'error'})`) // 메시지 본문엔 URL(토큰)이 들어갈 수 있어 이름만
    return false
  } finally {
    clearTimeout(timer)
  }
}
