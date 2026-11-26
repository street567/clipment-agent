// 사용자 입력에서 카드 제목 뽑기 (UserPromptSubmit · transcript 꼬리)
import { clean } from './redact.ts'

/** 제목으로 쓸 수 있으면 정리한 첫 줄, 아니면 null (null 이면 기존 제목 유지) */
export function promptTitle(prompt: unknown): string | null {
  if (typeof prompt !== 'string') return null
  let t = prompt.trim()
  if (!t) return null
  if (/^<(task-notification|system-reminder)\b/i.test(t)) return null
  const ch = /<channel\b[^>]*>([\s\S]*?)<\/channel>/i.exec(t)
  if (ch) t = ch[1]
  t = t
    .replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/gi, '') // 붙여넣은 덩어리는 내용까지 버린다
    .replace(/<\/?pasted_content\b[^>]*>/gi, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<\/?channel\b[^>]*>/gi, '')
  const line = t.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0)
  if (!line) return null
  const title = clean(line.replace(/\s+/g, ' '), 60).trim()
  if (Array.from(title).length < 6) return null // "ㅇㅇ" 같은 짧은 답은 제목을 바꾸지 않는다
  return title
}
