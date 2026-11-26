// SPEC §15: hooks 를 붙이지 못한 LLM 이 `kanban agent <start|progress|ask|report|done|fail>` 로 스스로 남긴다. 이벤트에 via:"self".
// 그 세션의 로컬 상태(withSession)를 쓰므로 hook 과 같은 규칙(카드 id·시각 단조 증가·알림)을 따른다.
import { basename } from 'node:path'
import { pathAllowed, type Config } from '../config.ts'
import { normalizeSessionId } from './agent.ts'
import { emit, ensureCard, needsHuman, newCtx, queueNotice, setNow, setTitle, touchWorking } from './board.ts'
import { loadBoard } from './delegate.ts'
import { newId } from './ids.ts'
import { newSessionState, withSession } from './localstate.ts'
import { clean } from './redact.ts'
import { Store } from './store.ts'
import { allMembers, findMember } from './team.ts'
import { sendTelegram } from './telegram.ts'

export const SELF_ACTIONS = ['start', 'progress', 'ask', 'report', 'done', 'fail'] as const
export type SelfAction = (typeof SELF_ACTIONS)[number]

export interface SelfArgs {
  agent: string
  session: string
  name?: string
  action: SelfAction
  text?: string
  kind?: string
  options?: string[]
  to?: string[]
}

export class SelfError extends Error {}

export async function selfReport(cfg: Config, a: SelfArgs): Promise<string> {
  const sid = normalizeSessionId(a.agent, a.session)
  if (!sid) throw new SelfError('--session 이 필요해요(LLM 의 세션 id).')
  if (!pathAllowed(cfg, process.cwd())) throw new SelfError('이 폴더는 보드에서 제외돼 있어요(includePaths/excludePaths).')
  const name = clean(a.name || basename(process.cwd()) || '세션', 60) || '세션'
  const text = a.text !== undefined ? clean(a.text.replace(/\s+/g, ' ').trim(), a.action === 'report' ? 4000 : 600) : ''
  if (['ask', 'report'].includes(a.action) && !text) throw new SelfError('--text 가 필요해요.')
  const store = new Store(cfg.root, cfg.board)
  let notices: { text: string }[] = []
  const msg = await withSession(sid, () => newSessionState(sid, cfg.board, name), async (st) => {
    if (st.boardId !== cfg.board) Object.assign(st, newSessionState(sid, cfg.board, st.name))
    st.agent = a.agent
    if (a.name) st.name = name
    const ctx = newCtx(cfg, store, st)
    ctx.via = 'self'
    try {
      if (!st.inited) {
        store.init()
        store.ensureSession(sid, st.name, a.agent)
        st.inited = true
      }
      const sc = ensureCard(ctx, 'session', '', a.action === 'start' && text ? text : st.name)
      switch (a.action) {
        case 'start':
          if (text) setTitle(ctx, sc, text)
          touchWorking(ctx, sc)
          setNow(ctx, { state: 'working', cardId: sc, summary: '시작' })
          return `시작했어요. session=${sid}`
        case 'progress':
          touchWorking(ctx, sc)
          setNow(ctx, { state: 'working', cardId: sc, summary: text || '일하는 중' }, true)
          return '진행을 남겼어요.'
        case 'report':
          emit(ctx, sc, 'report', { summary: text })
          return '보고를 남겼어요.'
        case 'done':
          if (st.cards[sc].status !== 'done') emit(ctx, sc, 'done')
          setNow(ctx, { state: 'idle', cardId: sc }, true)
          return '끝났다고 남겼어요(자기 보고).'
        case 'fail':
          emit(ctx, sc, 'failed', { summary: text || '실패했어요' })
          queueNotice(ctx, sc, '문제', text || '실패했어요')
          setNow(ctx, { state: 'idle', cardId: sc, summary: text || '실패' }, true)
          return '실패를 남겼어요.'
        case 'ask': {
          const kind = a.kind && ['approve', 'decide', 'do'].includes(a.kind) ? a.kind : 'approve'
          if (kind === 'decide' && !(a.options && a.options.length >= 2 && a.options.length <= 6)) throw new SelfError('decide 는 --options 를 쉼표로 2~6개 적어 주세요.')
          const board = loadBoard(store)
          const agents = [a.agent, ...store.sessions().map((s) => s.agent ?? 'claude')]
          const to: string[] = []
          for (const k of a.to ?? []) {
            const m = findMember(board, clean(k, 60), agents)
            if (!m) throw new SelfError(`"${clean(k, 30)}" 멤버를 찾지 못했어요. 멤버: ${allMembers(board, agents).map((x) => x.name).join(', ') || '(없음)'}`)
            if (!to.includes(m.id)) to.push(m.id)
          }
          const cid = ensureCard(ctx, 'ask', newId(), text)
          const options = kind === 'decide' ? a.options!.map((o) => clean(o, 80)).filter(Boolean) : undefined
          const ev = needsHuman(ctx, cid, text, { kind, ...(options ? { options } : {}), ...(to.length ? { to } : {}) })
          return `보드에 올렸어요. card_id=${cid} event_id=${ev.id}`
        }
      }
    } finally {
      notices = ctx.notices
    }
  })
  for (const n of notices) await sendTelegram(cfg, n.text)
  return msg as string
}
