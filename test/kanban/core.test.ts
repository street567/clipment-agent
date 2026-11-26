import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { derive } from '../../src/kanban/core/derive.ts'
import { listIds, readJson, writeNew, writeReplace } from '../../src/kanban/core/fs.ts'
import { assertId, cardId, isId, isSessionId } from '../../src/kanban/core/ids.ts'
import { clean, clip, redact } from '../../src/kanban/core/redact.ts'
import { summarizeTool } from '../../src/kanban/core/summarize.ts'
import { promptTitle } from '../../src/kanban/core/title.ts'
import { failureText } from '../../src/kanban/hook.ts'
import { SPEC } from './helpers.ts'

process.env.AGENT_KANBAN_NO_DOWNLOAD = '1'

describe('derive (spec/fixtures/derive.json)', () => {
  const cases = JSON.parse(require('node:fs').readFileSync(join(SPEC, 'fixtures/derive.json'), 'utf8'))
  for (const c of cases) test(c.name, () => expect(derive(c.events, c.actions).list).toBe(c.list))
  test('마지막 보고·제목', () => {
    const d = derive([
      { id: 'a', type: 'progress', created: '1', title: '첫' },
      { id: 'b', type: 'report', created: '2', summary: 'r1' },
      { id: 'c', type: 'progress', created: '3', title: '둘째' },
      { id: 'd', type: 'report', created: '4', summary: 'r2' },
    ])
    expect(d.lastReport).toBe('r2')
    expect(d.title).toBe('둘째')
  })
})

describe('ids', () => {
  test('cardId 는 결정적이고 UUID 모양', () => {
    const a = cardId('session', 'abc-12345678', '')
    expect(a).toBe(cardId('session', 'abc-12345678', ''))
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(cardId('task', 'abc-12345678', '1')).not.toBe(a)
    expect(cardId('task', 'abc-12345678', '1')).not.toBe(cardId('task', 'abc-12345678', '2'))
    expect(isId(a)).toBe(true)
  })
  test('검증: 경로 탈출 거부', () => {
    expect(isId('../../etc/passwd')).toBe(false)
    expect(isId('short')).toBe(false)
    expect(isId('ABCDEF12')).toBe(false)
    expect(isSessionId('2bd65158-0726-4cee-bfdc-c38ff9c05a98')).toBe(true)
    expect(isSessionId('a/b/c/d/e/f/g/h')).toBe(false)
    expect(() => assertId('../x')).toThrow()
  })
})

describe('redact', () => {
  const secrets = [
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'AKIAIOSFODNN7EXAMPLE',
    'Bearer abcdef1234567890xyz',
    '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
  ]
  for (const s of secrets) test(`가림: ${s.slice(0, 12)}…`, () => expect(redact(`키는 ${s} 입니다`)).not.toContain(s.slice(6)))
  test('password=…', () => {
    expect(redact('password=hunter2 그리고')).toBe('password=••• 그리고')
    expect(redact('MY_API_TOKEN=abc123xyz')).toContain('•••')
  })
  test('전체 경로는 마지막 이름만, URL·상대경로는 그대로', () => {
    expect(redact('고침 /Users/me/proj/src/a.ts 완료')).toBe('고침 …/a.ts 완료')
    expect(redact('see https://github.com/a/b/c and src/core/x.ts')).toBe('see https://github.com/a/b/c and src/core/x.ts')
    expect(redact('/clear 하세요')).toBe('/clear 하세요')
  })
  test('clip 은 글자 단위, 비밀은 자르기 전에 가림', () => {
    expect(clip('가나다라마', 3)).toBe('가나…')
    expect(clean('a'.repeat(300), 200).length).toBe(200)
    expect(clean('x'.repeat(190) + ' sk-abcdefghijklmnop12345', 200)).not.toContain('sk-')
  })
})

describe('summarize (§4)', () => {
  test('Bash 는 description 만', () => {
    expect(summarizeTool('Bash', { command: 'rm -rf /secret', description: '테스트 실행' })).toBe('테스트 실행')
    expect(summarizeTool('Bash', { command: 'curl -H "Authorization: x" https://a' })).toBe('명령 실행')
  })
  test('파일 도구는 이름만', () => {
    expect(summarizeTool('Edit', { file_path: '/Users/me/proj/Player.swift', old_string: 'secret' })).toBe('파일 고치는 중: Player.swift')
    expect(summarizeTool('Read', { file_path: '/a/b/c.txt' })).toBe('파일 읽는 중: c.txt')
  })
  test('그 밖', () => {
    expect(summarizeTool('Grep', { pattern: 'password' })).toBe('검색')
    expect(summarizeTool('WebFetch', { url: 'https://example.com/a?token=1' })).toBe('웹 가져오는 중: example.com')
    expect(summarizeTool('WebSearch', { query: 'x' })).toBe('웹 검색')
    expect(summarizeTool('Agent', { description: '조사', prompt: '비밀' })).toBe('보조 에이전트: 조사')
    expect(summarizeTool('mcp__github__create_issue', { title: '비밀' })).toBe('github · create_issue')
    expect(summarizeTool('TaskUpdate', { taskId: '1' })).toBe('TaskUpdate')
  })
})

describe('제목 정리 (promptTitle)', () => {
  test('사람 입력의 첫 줄', () => expect(promptTitle('로그인 화면 고쳐 줘\n자세한 설명')).toBe('로그인 화면 고쳐 줘'))
  test('task-notification · system-reminder · 빈 글은 제목이 아님', () => {
    expect(promptTitle('<task-notification>\n<summary>x</summary></task-notification>')).toBeNull()
    expect(promptTitle('<system-reminder>무언가 길게 적힌 알림</system-reminder>')).toBeNull()
    expect(promptTitle('   \n ')).toBeNull()
  })
  test('channel 은 본문만', () => {
    expect(promptTitle('<channel source="telegram" chat_id="1" message_id="2">로그인 버튼 색을 바꿔 줘</channel>')).toBe('로그인 버튼 색을 바꿔 줘')
  })
  test('pasted_content 태그 제거', () => {
    expect(promptTitle('<pasted_content id="1">긴 로그 내용\n둘째 줄</pasted_content>\n이 오류 원인 찾아 줘')).toBe('이 오류 원인 찾아 줘')
    expect(promptTitle('<pasted_content id="1">전부 붙여넣기</pasted_content>')).toBeNull()
  })
  test('6자 미만은 제목 유지(null)', () => {
    expect(promptTitle('ㅇㅇ')).toBeNull()
    expect(promptTitle('네 진행해')).toBeNull() // 5자
    expect(promptTitle('네 진행해줘')).toBe('네 진행해줘')
  })
  test('60자 제한과 비밀 가림', () => {
    expect(Array.from(promptTitle('가'.repeat(300))!).length).toBe(60)
    expect(promptTitle('이 키 sk-abcdefghijklmnopqrstu 로 호출해 줘')).not.toContain('sk-abc')
  })
})

describe('fs', () => {
  const d = mkdtempSync(join(tmpdir(), 'ak-fs-'))
  test('writeNew 는 덮어쓰지 않고 tmp 를 남기지 않음', () => {
    const p = join(d, 'a', 'x.json')
    expect(writeNew(p, { a: 1 })).toBe(true)
    expect(writeNew(p, { a: 2 })).toBe(false)
    expect(readJson(p)).toEqual({ a: 1 })
    expect(readdirSync(join(d, 'a')).filter((n) => n.includes('.tmp'))).toEqual([])
  })
  test('동시 배타 생성은 정확히 하나만 성공', async () => {
    const p = join(d, 'race', '00000001-0000-4000-8000-000000000000.json')
    const r = await Promise.all(Array.from({ length: 30 }, async () => writeNew(p, { x: 1 })))
    expect(r.filter(Boolean).length).toBe(1)
  })
  test('writeReplace 교체', () => {
    const p = join(d, 'now.json')
    writeReplace(p, { n: 1 })
    writeReplace(p, { n: 2 })
    expect(readJson(p)).toEqual({ n: 2 })
  })
  test('listIds: 점 파일·자리표시자·깨진 id 건너뜀, 깨진 JSON 은 null', () => {
    const e = join(d, 'ev')
    mkdirSync(e)
    writeFileSync(join(e, '00000001-0000-4000-8000-000000000000.json'), '{"a":1}')
    writeFileSync(join(e, '00000002-0000-4000-8000-000000000000.json'), '{깨짐')
    writeFileSync(join(e, '.00000003-0000-4000-8000-000000000000.json.icloud'), '')
    writeFileSync(join(e, '.00000004-0000-4000-8000-000000000000.json.tmp'), '{}')
    writeFileSync(join(e, 'NOT-AN-ID.json'), '{}')
    expect(listIds(e)).toEqual(['00000001-0000-4000-8000-000000000000', '00000002-0000-4000-8000-000000000000'])
    expect(readJson(join(e, '00000002-0000-4000-8000-000000000000.json'))).toBeNull()
  })
})

describe('StopFailure 문구', () => {
  test('쉬운 한국어', () => {
    expect(failureText('rate_limit')).toContain('사용량 한도')
    expect(failureText('authentication_failed')).toContain('로그인')
    expect(failureText('some_login_error')).toContain('로그인')
    expect(failureText(undefined)).toContain('알 수 없는')
  })
})
