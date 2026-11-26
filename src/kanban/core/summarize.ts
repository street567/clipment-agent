// SPEC §4 도구 요약. 정해진 필드 외 입력값은 쓰지 않고 도구 출력은 절대 쓰지 않는다.
import { basename } from 'node:path'
import { clean, oneLine } from './redact.ts'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function fileName(input: any): string {
  const p = str(input?.file_path) || str(input?.notebook_path) || str(input?.path)
  return p ? basename(p.replace(/\/+$/, '')) : ''
}

function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

export function summarizeTool(name: string, input: any): string {
  const n = name || ''
  let s: string
  switch (n) {
    case 'Bash':
    case 'PowerShell':
      s = oneLine(str(input?.description), 120) || '명령 실행'
      break
    case 'Read': {
      const f = fileName(input)
      s = f ? `파일 읽는 중: ${f}` : '파일 읽는 중'
      break
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const f = fileName(input)
      s = f ? `파일 고치는 중: ${f}` : '파일 고치는 중'
      break
    }
    case 'Grep':
    case 'Glob':
      s = '검색'
      break
    case 'WebFetch': {
      const h = host(str(input?.url))
      s = h ? `웹 가져오는 중: ${h}` : '웹 가져오는 중'
      break
    }
    case 'WebSearch':
      s = '웹 검색'
      break
    case 'Agent':
    case 'Task': {
      const d = oneLine(str(input?.description), 100)
      s = d ? `보조 에이전트: ${d}` : '보조 에이전트'
      break
    }
    default:
      if (n.startsWith('mcp__')) {
        const [, server, ...rest] = n.split('__')
        s = `${server ?? 'mcp'} · ${rest.join('__') || '도구'}`
      } else s = n || '도구'
  }
  return clean(s, 200)
}
