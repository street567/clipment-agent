import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { derive } from '../../src/kanban/core/derive.ts'
import { actorLine, boardState, cardView, delegatedMembers, memberForSession, mergeOps, validBoardKey, validCardKey } from '../../src/kanban/core/team.ts'
import { SPEC } from './helpers.ts'

const cases: any[] = JSON.parse(readFileSync(join(SPEC, 'fixtures/team.json'), 'utf8'))

function run(c: any) {
  const board = boardState(c.boardOps ?? [])
  return cardView({ card: c.card, session: c.session, ops: c.ops ?? [], events: c.events ?? [], actions: c.actions ?? [], board })
}

describe('team.json (계약 1.1 담당·리스트·순서)', () => {
  test('43개', () => expect(cases.length).toBe(43))
  for (const c of cases) {
    test(c.name, () => {
      const v = run(c)
      const x = c.expect
      const got: Record<string, unknown> = {
        base: v.base,
        listId: v.listId,
        assignees: v.assignees,
        actors: v.actors,
        nature: v.nature,
        title: v.title,
        due: v.due,
        archived: v.archived,
        labels: v.labels,
        checks: v.checks.map((k) => [k.id, k.text, k.done]),
        rank: v.rank,
      }
      for (const k of Object.keys(x)) expect(got[k]).toEqual(x[k])
    })
  }
})

describe('derive.json 은 그대로', () => {
  const d: any[] = JSON.parse(readFileSync(join(SPEC, 'fixtures/derive.json'), 'utf8'))
  for (const c of d) test(c.name, () => expect(derive(c.events, c.actions).list).toBe(c.list))
})

describe('team 보조', () => {
  test('mergeOps: 같은 시각이면 id, 열쇠 수 0·201 인 op 는 무시', () => {
    const big: Record<string, unknown> = {}
    for (let i = 0; i < 201; i++) big[`assignee.a${i}`] = true
    const m = mergeOps(
      [
        { id: 'b', created: '2026-01-01T00:00:00.000Z', set: { due: '2026-01-02' } },
        { id: 'a', created: '2026-01-01T00:00:00.000Z', set: { due: '2026-01-03' } },
        { id: 'c', created: '2026-01-02T00:00:00.000Z', set: big },
        { id: 'd', created: '2026-01-03T00:00:00.000Z', set: {} },
      ],
      validCardKey,
    )
    expect(m.values.get('due')).toBe('2026-01-02')
    expect(m.values.size).toBe(1)
  })
  test('열쇠 검증', () => {
    expect(validCardKey('title', '')).toBe(false)
    expect(validCardKey('titlex', null)).toBe(false)
    expect(validCardKey('assignee.A', true)).toBe(false)
    expect(validCardKey('check.c1', { text: 'a', done: false, rank: 1 })).toBe(true)
    expect(validCardKey('check.c1', { text: 'a', done: 'no', rank: 1 })).toBe(false)
    expect(validBoardKey('member.x', { name: 'a'.repeat(21), kind: 'human' })).toBe(false)
    expect(validBoardKey('list.mine', { title: '이름', base: 'mine', rank: 0 })).toBe(true)
    expect(validBoardKey('rank.../x', 1)).toBe(false)
  })
  test('기본 리스트는 base 를 못 바꾸고 이름·rank 만', () => {
    const b = boardState([{ id: 'x', created: '2026-01-01T00:00:00.000Z', set: { 'list.mine': { title: '사람 차례', base: 'done', rank: 9 } } }])
    expect(b.lists.get('mine')).toEqual({ id: 'mine', title: '사람 차례', base: 'mine', rank: 9 })
  })
  test('memberForSession · actorLine · delegatedMembers', () => {
    const b = boardState([
      { id: '1', created: '2026-01-01T00:00:00.000Z', set: { 'member.alpha': { name: '알파', kind: 'llm', agent: 'claude', project: 'alpha' }, 'member.u-a': { name: '민수', kind: 'human' } } },
    ])
    expect(memberForSession(b, { name: 'alpha', agent: 'claude' }).id).toBe('alpha')
    expect(memberForSession(b, { name: 'alpha', agent: 'gemini' }).id).toBe('llm-gemini')
    expect(memberForSession(b, null).id).toBe('llm-claude')
    expect(actorLine(b, ['u-a', 'u-gone'])).toBe('담당: 민수')
    expect(actorLine(b, [])).toBe('담당: 미정')
    const card = { id: 'c', kind: 'manual', created: '2026-01-01T00:00:00.000Z', title: 't', by: { author: 'user' as const, name: '민수' } }
    const mk = (by: any, cardBy: any = card.by) => {
      const c = { ...card, by: cardBy }
      const v = cardView({ card: c, ops: [{ id: 'o', created: '2026-01-02T00:00:00.000Z', by, set: { 'assignee.alpha': true } }], events: [], actions: [], board: b })
      return { c, v }
    }
    let { c, v } = mk({ author: 'user', name: '민수' })
    expect(delegatedMembers(c, v, b)).toEqual(['alpha'])
    expect(delegatedMembers(c, v, b, ['민수'])).toEqual(['alpha'])
    expect(delegatedMembers(c, v, b, ['지연'])).toEqual([])
    ;({ c, v } = mk({ author: 'user', name: '낯선이' }))
    expect(delegatedMembers(c, v, b, ['민수'])).toEqual([])
    ;({ c, v } = mk({ author: 'agent', name: 'Claude' }))
    expect(delegatedMembers(c, v, b)).toEqual([])
    ;({ c, v } = mk({ author: 'user', name: '민수' }, { author: 'agent' as const, name: 'Claude' }))
    expect(delegatedMembers(c, v, b)).toEqual([])
  })
})
