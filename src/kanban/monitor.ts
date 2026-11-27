#!/usr/bin/env bun
// 감시 스크립트(experimental.monitors): 이 세션 카드의 미전달 코멘트·처리를 찾아 한 줄로 출력한다. 출력하면 쉬던 세션이 깨어난다.
// 내장 모듈만 사용. 변경이 없으면 파일 I/O 는 상태 파일 mtime + 카드 폴더 mtime stat 뿐이다.
import { join } from 'node:path'
import { loadAllConfig, loadConfig, type Config } from './config.ts'
import { bumpAlive, newCtx } from './core/board.ts'
import { evalAvailable, loadBoard } from './core/delegate.ts'
import { delegSignalLine, pendingForCard, signalLine, type Pending } from './core/deliver.ts'
import { isSessionId } from './core/ids.ts'
import { mtimeMs, readJson, writeReplace } from './core/fs.ts'
import { getPidMap, loadSession, stateDir, logLine, newSessionState, sessionMtime, withSession, type SessionState } from './core/localstate.ts'
import { checkSuperseded, laneOwner } from './core/lane.ts'
import { Store } from './core/store.ts'
import { memberForSession, signalsCard, type Board } from './core/team.ts'

const MAX_SIGNALS = 3
const RESIGNAL_MS = Number(process.env.AGENT_KANBAN_RESIGNAL_MS) || 10 * 60_000 // 환경변수는 테스트용
const ALIVE_EVERY_MS = Number(process.env.AGENT_KANBAN_ALIVE_MS) || 5 * 60_000 // 환경변수는 테스트용

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
}

async function main() {
  const all0 = loadAllConfig()
  if (!all0) return
  const parent = Number(process.env.CLAUDE_PID) || process.ppid
  // 워크스페이스: ① 세션 로컬 상태에 기록된 root(hook 이 진짜 cwd 로 정함) ② CLAUDE_PROJECT_DIR ③ process.cwd().
  // 세션 상태가 아직 없으면(SessionStart 와의 경주) GRACE 동안은 매 틱 다시 확인하고, 그 뒤에도 없으면 ②③ 으로 정한다.
  const startMs = Date.now()
  const GRACE_MS = Number(process.env.AGENT_KANBAN_MONITOR_GRACE_MS) || 30_000 // 환경변수는 테스트용
  let cfg: Config | null = null
  let store!: Store
  const fallbackCfg = (): Config | null => (process.env.CLAUDE_PROJECT_DIR ? loadConfig(process.env.CLAUDE_PROJECT_DIR) : null) ?? loadConfig(process.cwd())
  const resolveCfg = (s: SessionState | null): Config | null => {
    if (s?.root) {
      const c = loadConfig(undefined, { workspaceRoot: s.root })
      return c && c.root === s.root ? c : null // 워크스페이스가 설정에서 빠졌으면 조용히 대기
    }
    if (s || Date.now() - startMs > GRACE_MS) return fallbackCfg()
    return null
  }
  const sigFile = (sid: string) => join(stateDir(), 'signals', `${sid}.json`)
  let sig: Record<string, { count: number; lastMs: number }> = {}
  let curSid = ''
  let st: SessionState | null = null
  let lastMt: number | null = null
  const seenDir = new Map<string, number | null>()
  const pending = new Map<string, Pending[]>() // cardId → 미전달 항목
  const firstSeen = new Map<string, number>() // 항목 id → 처음 본 시각
  let lastAlive = Date.now()
  let busy = false
  // 맡긴 카드(SPEC §14): 수정 시각이 바뀐 카드만 다시 읽는다
  let board: Board | null = null
  let boardKey = ''
  let cardsMt: number | null | undefined
  let cardIdList: string[] = []
  const deleg = new Map<string, { kind?: string; key: string; avail: boolean }>()
  const delegSeen = new Map<string, number>() // 카드 id → 처음 본 시각

  let delegReady = 0
  /** 신호를 내야 할 맡긴 카드 id (쉬는 세션이면 바로, 일하는 중이면 busyDelaySec 넘게 기다린 것만) */
  function delegatedTick(st: SessionState, sid: string): string[] {
    delegReady = 0
    const session = { name: st.name, agent: st.agent }
    const ops = join(store.boardDir, 'ops')
    const bk = `${mtimeMs(ops)}|${st.name}|${st.agent}`
    if (!board || bk !== boardKey) {
      board = loadBoard(store)
      boardKey = bk
      deleg.clear()
    }
    if (!memberForSession(board, session).project) return [] // 신호는 project 멤버만(공용 담당은 신호 없음)
    const cm = mtimeMs(join(store.boardDir, 'cards'))
    if (cm !== cardsMt) {
      cardsMt = cm
      cardIdList = store.cardIds()
      const present = new Set(cardIdList)
      for (const id of [...deleg.keys()]) if (!present.has(id)) deleg.delete(id)
    }
    for (const id of cardIdList) {
      let e = deleg.get(id)
      if (e?.kind && e.kind !== 'manual') continue
      const dir = store.cardDir(id)
      const key = ['ops', 'events', 'actions'].map((d) => mtimeMs(join(dir, d))).join('|') + '|' + mtimeMs(join(dir, 'takes'))
      if (e && e.key === key) continue
      const card = store.readCard(id)
      if (!card) continue // 아직 내려받는 중일 수 있다 — 다음에 다시
      if (card.kind !== 'manual') {
        deleg.set(id, { kind: card.kind, key, avail: false })
        continue
      }
      const v = evalAvailable(card, store.cardOps(id), store.events(id), store.actions(id), store.takes(id), board, session, cfg!.allowAuthors)
      const avail = !!v && signalsCard(card, v, board, session, cfg!.allowAuthors)
      e = { kind: 'manual', key, avail }
      deleg.set(id, e)
    }
    const now = Date.now()
    const ready: string[] = []
    for (const [id, e] of deleg) {
      if (!e.avail) {
        delegSeen.delete(id)
        continue
      }
      if (!delegSeen.has(id)) delegSeen.set(id, now)
      if (st.now?.state !== 'working' || now - delegSeen.get(id)! >= cfg!.monitor.busyDelaySec * 1000) ready.push(id)
    }
    delegReady = ready.length
    return ready.filter((id) => {
      const s = sig[id]
      return !s || (s.count < MAX_SIGNALS && now - s.lastMs >= RESIGNAL_MS)
    })
  }

  async function tick() {
    if (busy) return
    busy = true
    try {
      if (!alive(parent)) process.exit(0)
      const env = process.env.CLAUDE_CODE_SESSION_ID
      const sid = getPidMap(parent) ?? (isSessionId(env) ? env : null) // 매 폴링 pid 매핑으로 현재 세션 확인(/clear·resume 로 바뀔 수 있음)
      if (!sid) return
      if (sid !== curSid) {
        curSid = sid
        st = null
        lastMt = null
        seenDir.clear()
        pending.clear()
        sig = readJson(sigFile(sid)) ?? {} // 신호 횟수는 로컬에 저장돼 감시가 재시작해도 유지
        firstSeen.clear()
        deleg.clear()
        delegSeen.clear()
        boardKey = ''
        cfg = null // 세션이 바뀌면 워크스페이스도 다시 정한다
      }
      const mt = sessionMtime(sid)
      if (mt !== null && (mt !== lastMt || !st)) {
        st = loadSession(sid)
        lastMt = mt
      }
      if (!cfg) {
        cfg = resolveCfg(mt === null ? null : st)
        if (!cfg) return // 아직 모름 — 다음 틱에 다시
        store = new Store(cfg.root, cfg.board)
        boardKey = ''
        board = null
      }
      if (mt === null || !st) return
      if (st.root && st.root !== cfg.root) { cfg = null; return } // 세션이 다른 워크스페이스로 확정됨 → 다음 틱에 다시 정함
      if (st.boardId !== cfg.board) return

      // 0) 레인: 더 새로운 세션이 이어받았으면(가장 새로운 세션이 이긴다) 이 세션은 레인 카드를 더 받지 않는다. 경고는 한 번
      if (st.lane) {
        const owner = st.lane.superseded ? undefined : laneOwner(st.lane.agentKey)
        const needWarn = !!st.lane.superseded && !st.lane.warned
        if ((owner && owner !== sid) || needWarn) {
          let warn = ''
          await withSession(sid, () => newSessionState(sid, cfg!.board, st!.name), (s) => {
            checkSuperseded(s)
            if (s.lane?.superseded && !s.lane.warned) {
              s.lane.warned = true
              warn = s.lane.name
            }
          })
          st = loadSession(sid)
          lastMt = sessionMtime(sid)
          pending.clear()
          seenDir.clear()
          if (warn) process.stdout.write(`[에이전트 칸반] 같은 컴퓨터·레인(${warn.replace(/[\r\n]+/g, ' ')})에 더 새로운 세션이 이어받았어요. 레인 카드의 의견은 이제 그 세션이 받고, 이 세션은 별도 카드로 기록돼요.\n`)
          if (!st) return
        }
      }

      // 1) 폴더 mtime 이 바뀐 카드만 다시 읽는다
      for (const cid of Object.keys(st.cards)) {
        let changed = false
        for (const sub of ['comments', 'actions', 'receipts']) {
          const k = `${cid}/${sub}`
          const m = mtimeMs(join(store.cardDir(cid), sub))
          if (!seenDir.has(k) || seenDir.get(k) !== m) {
            seenDir.set(k, m)
            changed = true
          }
        }
        if (changed) {
          const items = pendingForCard(store, st, cid, cfg!.allowAuthors)
          if (items.length) pending.set(cid, items)
          else pending.delete(cid)
        }
      }

      // 1b) 맡긴 카드: 이 세션의 멤버에 project 가 있을 때만 신호(공용 llm-<agent> 는 신호 없음)
      const dueCards = delegatedTick(st, sid)

      // 2) 쉬는 세션이면 바로, 일하는 중이면 busyDelaySec 넘게 기다린 것만 신호(본문 없음). receipt 는 board_inbox 가 만든다.
      const now = Date.now()
      const all = [...pending.values()].flat()
      for (const it of all) if (!firstSeen.has(it.id)) firstSeen.set(it.id, now)
      const idle = st.now?.state !== 'working'
      const ready = all.filter((it) => idle || now - (firstSeen.get(it.id) ?? now) >= cfg!.monitor.busyDelaySec * 1000)
      const due = ready.filter((it) => {
        const s = sig[it.id]
        return !s || (s.count < MAX_SIGNALS && now - s.lastMs >= RESIGNAL_MS)
      })
      if (due.length) {
        for (const it of due) sig[it.id] = { count: (sig[it.id]?.count ?? 0) + 1, lastMs: now }
        for (const k of Object.keys(sig)) if (now - sig[k].lastMs > 86400_000) delete sig[k]
        writeReplace(sigFile(sid), sig)
        process.stdout.write(signalLine(ready.length) + '\n')
      }

      if (dueCards.length) {
        for (const id of dueCards) sig[id] = { count: (sig[id]?.count ?? 0) + 1, lastMs: now }
        writeReplace(sigFile(sid), sig)
        process.stdout.write(delegSignalLine(delegReady) + '\n')
      }

      // 3) aliveAt 은 5분마다
      if (now - lastAlive >= ALIVE_EVERY_MS) {
        lastAlive = now
        await withSession(sid, () => newSessionState(sid, cfg!.board, st!.name), (s) => {
          bumpAlive(newCtx(cfg!, store, s))
        })
      }
    } catch (e: any) {
      logLine('ERROR monitor', String(e?.stack ?? e))
    } finally {
      busy = false
      if (process.env.AGENT_KANBAN_DEBUG_SCANS) process.stderr.write(`tick scans=${Store.cardScans} reads=${Store.cardReads}\n`)
    }
  }

  setInterval(tick, Math.round(all0.monitor.intervalSec * 1000))
  await tick()
}

if (import.meta.main) {
  main().catch((e) => {
    logLine('ERROR monitor', String(e?.stack ?? e))
    process.exit(0)
  })
}
