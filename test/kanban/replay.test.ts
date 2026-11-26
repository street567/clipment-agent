import { describe, expect, test } from 'bun:test'
import { base, byTitle, cards, loadJsonl, runHook, setup, SID } from './helpers.ts'

describe('실제 hook 입력 재생', () => {
  test('headless fixture: alpha 완료, beta 대기, 세션 카드 완료', async () => {
    const e = setup({ includeHeadless: true })
    for (const inp of loadJsonl('hooks-headless.jsonl')) {
      const r = await runHook(e, inp, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })
      expect(r.code).toBe(0)
      if (inp.hook_event_name === 'SessionStart') expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe('SessionStart')
      else expect(r.stdout).toBe('')
    }
    const cs = cards(e)
    expect(cs.length).toBe(3)
    const alpha = byTitle(cs, 'alpha')!
    const beta = byTitle(cs, 'beta')!
    const sess = cs.find((c) => c.card.kind === 'session')!
    expect(alpha.derived.list).toBe('done')
    expect(beta.derived.list).toBe('waiting')
    expect(sess.derived.list).toBe('done')
    expect(alpha.events.map((x) => x.type)).toEqual(['created', 'progress', 'done'])
    expect(beta.events.map((x) => x.type)).toEqual(['created'])
    expect(sess.events.map((x) => x.type)).toEqual(['created', 'progress', 'report', 'done'])
    expect(sess.events.find((x) => x.type === 'report').summary).toBe('DONE')
    expect(sess.card.title.startsWith('Use TaskCreate to create two tasks')).toBe(true)
  })

  test('headless 는 includeHeadless 가 아니면 아무것도 안 쓴다', async () => {
    const e = setup({})
    for (const inp of loadJsonl('hooks-headless.jsonl')) {
      const r = await runHook(e, inp, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })
      expect(r.code).toBe(0)
      expect(r.stdout).toBe('')
    }
    expect(cards(e).length).toBe(0)
  })

  test('interactive fixture: monitor 가 running 이어도 세션 카드 완료', async () => {
    const e = setup({})
    const inputs = loadJsonl('hooks-interactive.jsonl')
    expect(inputs.at(-1).background_tasks[0].type).toBe('monitor')
    for (const inp of inputs) {
      const r = await runHook(e, inp)
      if (inp.hook_event_name !== 'SessionStart') expect(r.stdout).toBe('')
    }
    const [sess] = cards(e)
    expect(sess.derived.list).toBe('done')
    // task-notification 은 제목으로 쓰지 않는다 → 폴더 이름
    expect(sess.card.title).toBe('x')
    expect(sess.events.map((x) => x.type)).toEqual(['created', 'progress', 'report', 'done'])
    void base
    void SID
  })
})
