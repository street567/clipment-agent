#!/usr/bin/env bun
// kanban CLI: init · status · board · member · label · agent · doctor · probe · upload-probe · prune
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configPath, DEFAULT_ROOT, expandHome, loadConfig, type Config } from './config.ts'
import { resolveAgent } from './core/agent.ts'
import { loadBoard } from './core/delegate.ts'
import { derive, type List } from './core/derive.ts'
import { iso, readJson, writeNew } from './core/fs.ts'
import { newId } from './core/ids.ts'
import { SELF_ACTIONS, SelfError, selfReport, type SelfAction } from './core/self.ts'
import { allMembers, cardView, findLabel, findMember, getMember, type Board, type CardView } from './core/team.ts'
import { clean } from './core/redact.ts'
import { createHash } from 'node:crypto'
import { logDir, stateDir, type SessionState } from './core/localstate.ts'
import { Store } from './core/store.ts'
import { kanbanStatus, removeWorkspace, setupKanban } from './setup.ts'
import { oneLine } from './core/redact.ts'
import { resolve } from 'node:path'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const out = (s = '') => process.stdout.write(s + '\n')

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (args: string[], name: string) => args.includes(name)

function needConfig(): Config {
  const c = loadConfig()
  if (!c) {
    out(`설정이 없거나 꺼져 있어요 (${configPath()}). 먼저 \`kanban init\` 을 실행하세요.`)
    process.exit(1)
  }
  return c
}

function cmdInit(args: string[]) {
  const path = configPath()
  const rootArg = flag(args, '--root')
  const root = resolve(expandHome(rootArg ?? process.env.AGENT_KANBAN_ROOT ?? DEFAULT_ROOT))
  if (existsSync(path)) out(`설정이 이미 있어요(덮어쓰지 않음): ${path}`)
  else {
    const cfg = {
      enabled: true,
      root,
      board: 'main',
      includePaths: [],
      excludePaths: [],
      includeHeadless: false,
      monitor: { intervalSec: 5, busyDelaySec: 30 },
      telegram: { enabled: false, chatId: '', tokenEnv: 'AGENT_KANBAN_TELEGRAM_TOKEN', apiBase: 'https://api.telegram.org' },
    }
    mkdirSync(dirname(path), { recursive: true })
    if (!writeNew(path, cfg)) out(`설정이 이미 있어요(덮어쓰지 않음): ${path}`)
    else out(`설정을 만들었어요: ${path}`)
  }
  const cfg = loadConfig()
  const r = cfg?.root ?? root
  new Store(r, cfg?.board ?? 'main').init()
  out(`보드 폴더 준비됨: ${r}`)
  if (!cfg) out('(설정의 enabled 가 true 가 아니라 hooks 는 아직 꺼져 있어요)')
}

function flags(args: string[], name: string): string[] {
  const r: string[] = []
  args.forEach((a, i) => { if (a === name && args[i + 1] && !args[i + 1].startsWith('--')) r.push(args[i + 1]) })
  return r
}

function cmdSetup(args: string[]) {
  const root = flag(args, '--root') ?? args.find((a) => !a.startsWith('--'))
  if (!root) {
    out('사용법: kanban setup --root <보드 폴더> [--name 이름] [--include <프로젝트 폴더>]... [--create] [--confirm-replace]')
    process.exit(2)
  }
  const inc = flags(args, '--include')
  const r = setupKanban({ root, name: flag(args, '--name'), ...(inc.length ? { includePaths: inc } : {}), confirmReplace: has(args, '--confirm-replace'), create: has(args, '--create') })
  out(r.message)
  if (r.result === 'needsScope') {
    for (const w of r.existingWorkspaces ?? []) out(` - ${w.name ?? '(이름 없음)'}  ${w.root}  ${w.includePaths.length ? 'include: ' + w.includePaths.join(', ') : '(기본)'}`)
    process.exit(3)
  }
  if (!r.ok) process.exit(1)
}

function cmdRemove(args: string[]) {
  const root = flag(args, '--root') ?? args.find((a) => !a.startsWith('--'))
  if (!root) {
    out('사용법: kanban remove --root <보드 폴더> [--confirm]  (설정에서만 뺍니다. 폴더는 지우지 않아요)')
    process.exit(2)
  }
  const r = removeWorkspace({ root, confirm: has(args, '--confirm') })
  out(r.message)
  if (!r.ok) process.exit(1)
}

function cmdStatusJson() {
  out(JSON.stringify(kanbanStatus(), null, 1))
}

function sessionStates(): SessionState[] {
  const dir = join(stateDir(), 'sessions')
  const res: SessionState[] = []
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue
      const s = readJson<SessionState>(join(dir, f))
      if (s && s.v === 1) res.push(s)
    }
  } catch {}
  return res
}

function cmdStatus() {
  const st = kanbanStatus()
  out(`설정: ${configPath()} → ${st.configured ? '켜짐' : '꺼짐/없음'}`)
  if (!st.configured) out('칸반이 아직 설정되지 않았어요(not set up). kanban setup --root <폴더>')
  const cfg = loadConfig()
  if (st.configured) {
    for (const w of st.workspaces ?? []) out(` - ${w.name ?? '(이름 없음)'}  ${w.root}  board=${w.board}  ${w.reachable ? '닿음' : '닿지 않음'}  ${w.hasKanbanJson ? 'kanban.json 있음' : 'kanban.json 없음'}  ${w.includePaths.length ? 'include: ' + w.includePaths.join(', ') : '(기본)'}`)
    out(`현재 폴더: ${st.current?.tracked ? '→ ' + (st.current.workspace?.name ?? st.current.workspace?.root) : '추적 안 함'} (${st.current?.reason})`)
    for (const w of st.warnings ?? []) out(`경고: ${w}`)
    if (cfg) out(`텔레그램: ${cfg.telegram.enabled ? '켜짐' : '꺼짐'}`)
  }
  const ss = sessionStates().sort((a, b) => b.updatedMs - a.updatedMs)
  out(`세션 ${ss.length}개`)
  for (const s of ss.slice(0, 20)) {
    const ago = Math.round((Date.now() - s.updatedMs) / 60000)
    out(` - ${s.name} [${s.now?.state ?? '-'}] ${ago}분 전 · 카드 ${Object.keys(s.cards).length}개${s.openInfos.length ? ` · 열린 확인 ${s.openInfos.length}` : ''}`)
  }
}

const LIST_LABEL: Record<List, string> = { mine: '사람 차례', working: '진행 중', waiting: '대기', done: '완료' }

interface Row {
  id: string
  title: string
  session: string
  list: List
  last: string
  detail: string
  view: CardView
}
function collectRows(store: Store, board: Board): Row[] {
  const rows: Row[] = []
  for (const id of store.cardIds()) {
    const card = store.readCard(id)
    if (!card) continue
    const events = store.events(id)
    const sess = card.sessionId ? store.readSession(card.sessionId) : null
    const view = cardView({ card, session: sess, ops: store.cardOps(id), events, actions: store.actions(id), board })
    let detail = ''
    if (view.list === 'mine') detail = view.open[0]?.summary ?? events.filter((e) => e.type === 'failed').pop()?.summary ?? ''
    else if (view.list === 'working') {
      const now = card.sessionId ? store.readNow(card.sessionId) : null
      detail = now?.cardId === id && now.summary ? now.summary : events.filter((e) => e.type === 'progress' && e.summary).pop()?.summary ?? ''
    } else if (view.list === 'done') detail = view.lastReport ?? ''
    rows.push({ id, title: view.title, session: card.kind === 'manual' ? (sess?.name ?? '카드') : sess?.name ?? '?', list: view.list, last: events.at(-1)?.created ?? card.created, detail, view })
  }
  return rows
}

const who = (board: Board, id: string) => {
  const m = getMember(board, id)
  return m ? `${m.kind === 'human' ? '[사람]' : '[LLM]'} ${m.name}` : '지운 멤버'
}

function cmdBoard(args: string[]) {
  const cfg = needConfig()
  const store = new Store(cfg.root, cfg.board)
  const board = loadBoard(store)
  const archivedView = has(args, '--archived')
  const rows = collectRows(store, board).filter((r) => r.view.archived === archivedView)
  const order: List[] = ['mine', 'working', 'waiting', 'done']
  const extra = (r: Row) => {
    const parts = [
      r.view.actors.length ? `담당: ${r.view.actors.map((m) => who(board, m)).join(', ')}` : '담당 미정',
      ...(r.view.labels.length ? [r.view.labels.map((l) => `#${board.labels.get(l)?.name ?? l}`).join(' ')] : []),
      ...(r.view.due ? [`기한 ${r.view.due}`] : []),
    ]
    return ` ｜ ${parts.join(' ｜ ')}`
  }
  if (archivedView) {
    out(`== 보관함 (${rows.length}) ==`)
    for (const r of rows) out(` • [${r.session}] ${r.title}${r.detail ? ' — ' + oneLine(r.detail, 80) : ''}${extra(r)}`)
    return
  }
  for (const l of order) {
    const g = rows.filter((r) => r.list === l).sort((a, b) => (l === 'waiting' ? (a.last < b.last ? -1 : 1) : a.last < b.last ? 1 : -1))
    out(`== ${LIST_LABEL[l]} (${g.length}) ==`)
    for (const r of g) out(` • [${r.session}] ${r.title}${r.detail ? ' — ' + oneLine(r.detail, 80) : ''}${extra(r)}`)
  }
}

// ── 팀 설정 (사람이 터미널에서): member · label
const VALUE_FLAGS = ['--kind', '--agent', '--project', '--color', '--rank', '--id', '--as', '--assignees', '--root']
function positional(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.includes(args[i])) i++
    else if (!args[i].startsWith('--')) out.push(args[i])
  }
  return out
}
function slug(name: string, prefix: string, taken: (id: string) => boolean): string {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20)
  if (!base) base = createHash('sha1').update(name).digest('hex').slice(0, 6)
  let id = `${prefix}${base}`
  for (let n = 2; taken(id); n++) id = `${prefix}${base}-${n}`
  return id
}
function actor(store: Store, board: Board, args: string[]) {
  const name = clean(flag(args, '--as') ?? '나', 40) || '나'
  const m = [...board.members.values()].find((x) => x.kind === 'human' && x.name === name)
  return { author: 'user' as const, name, ...(m ? { member: m.id } : {}) }
}
const intFlag = (args: string[], name: string, lo: number, hi: number): number | undefined => {
  const v = flag(args, name)
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name} 은 ${lo}~${hi} 의 정수여야 해요.`)
  return n
}
const numFlag = (args: string[], name: string): number | undefined => {
  const v = flag(args, name)
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${name} 은 숫자여야 해요.`)
  return n
}

function cmdMember(args: string[]) {
  const [sub, ...rest] = args
  const cfg = needConfig()
  const store = new Store(cfg.root, cfg.board)
  store.init()
  const board = loadBoard(store)
  const agents = store.sessions().map((s) => s.agent ?? 'claude')
  const by = () => actor(store, board, rest)
  switch (sub) {
    case 'list': {
      const ms = allMembers(board, agents)
      out(`== 멤버 (${ms.length}) ==`)
      for (const m of ms) {
        const extra = [m.kind === 'llm' && m.agent ? m.agent : '', m.project ? `프로젝트 ${m.project}` : '', board.defaultHuman === m.id ? '기본 담당' : '', !board.members.has(m.id) ? '자동' : ''].filter(Boolean)
        out(` • ${m.kind === 'human' ? '[사람]' : '[LLM]'} ${m.name} (${m.id})${extra.length ? ' — ' + extra.join(' · ') : ''}`)
      }
      return
    }
    case 'add': {
      const name = clean(positional(rest)[0] ?? '', 20).trim()
      if (!name) throw new Error('사용법: kanban member add <이름> [--kind human|llm] [--agent claude] [--project 폴더] [--color 0-9] [--rank N] [--id ID] [--default] [--as 이름]')
      const agent = flag(rest, '--agent')
      if (agent !== undefined && !/^[a-z0-9-]{1,20}$/.test(agent)) throw new Error('--agent 는 소문자·숫자·-(20자 이하)여야 해요.')
      const kind = flag(rest, '--kind') ?? (agent ? 'llm' : 'human')
      if (kind !== 'human' && kind !== 'llm') throw new Error('--kind 는 human 또는 llm 이에요.')
      const project = flag(rest, '--project')
      const color = intFlag(rest, '--color', 0, 9)
      const rank = numFlag(rest, '--rank') ?? Math.max(-1, ...[...board.members.values()].map((m) => m.rank ?? 0)) + 1
      const given = flag(rest, '--id')
      if (given !== undefined && !/^[a-z0-9-]{1,64}$/.test(given)) throw new Error('--id 는 소문자·숫자·-(64자 이하)여야 해요.')
      const id = given ?? slug(name, kind === 'llm' ? 'llm-' : 'u-', (x) => board.members.has(x))
      const set: Record<string, unknown> = {
        [`member.${id}`]: { name, kind, ...(kind === 'llm' ? { agent: agent ?? 'claude' } : {}), ...(project ? { project: clean(project, 60) } : {}), ...(color !== undefined ? { color } : {}), rank },
      }
      if (has(rest, '--default')) {
        if (kind !== 'human') throw new Error('기본 담당은 사람 멤버만 될 수 있어요.')
        set.defaultHuman = id
      }
      store.writeBoardOp(set, by())
      out(`멤버를 추가했어요: ${name} (${id})`)
      return
    }
    case 'remove': {
      const key = positional(rest)[0]
      const m = key ? findMember(board, key, agents) : undefined
      if (!m) throw new Error(`멤버를 찾지 못했어요. 멤버: ${allMembers(board, agents).map((x) => `${x.name}(${x.id})`).join(', ') || '(없음)'}`)
      const set: Record<string, unknown> = { [`member.${m.id}`]: null }
      if (board.defaultHuman === m.id) set.defaultHuman = null
      store.writeBoardOp(set, by())
      out(`멤버를 지웠어요: ${m.name} (${m.id}) — 담당으로 남은 카드에는 "지운 멤버"로 보여요.`)
      return
    }
    default:
      throw new Error('사용법: kanban member <add|list|remove>')
  }
}

function cmdLabel(args: string[]) {
  const [sub, ...rest] = args
  const cfg = needConfig()
  const store = new Store(cfg.root, cfg.board)
  store.init()
  const board = loadBoard(store)
  const agents = store.sessions().map((s) => s.agent ?? 'claude')
  switch (sub) {
    case 'list': {
      const ls = [...board.labels.values()].sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1))
      out(`== 카테고리 (${ls.length}) ==`)
      for (const l of ls) out(` • ${l.name} (${l.id}) 색 ${l.color}${l.assignees?.length ? ' — 기본 담당: ' + l.assignees.map((m) => getMember(board, m)?.name ?? m).join(', ') : ''}`)
      return
    }
    case 'add': {
      const name = clean(positional(rest)[0] ?? '', 20).trim()
      if (!name) throw new Error('사용법: kanban label add <이름> [--color 0-9] [--rank N] [--assignees 민수,지연] [--id ID] [--as 이름]')
      const color = intFlag(rest, '--color', 0, 9) ?? board.labels.size % 10
      const rank = numFlag(rest, '--rank') ?? Math.max(-1, ...[...board.labels.values()].map((l) => l.rank)) + 1
      const given = flag(rest, '--id')
      if (given !== undefined && !/^[a-z0-9-]{1,64}$/.test(given)) throw new Error('--id 는 소문자·숫자·-(64자 이하)여야 해요.')
      const id = given ?? slug(name, 'l-', (x) => board.labels.has(x))
      const assignees: string[] = []
      for (const k of (flag(rest, '--assignees') ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
        const m = findMember(board, k, agents)
        if (!m) throw new Error(`"${clean(k, 30)}" 멤버를 찾지 못했어요. 멤버: ${allMembers(board, agents).map((x) => `${x.name}(${x.id})`).join(', ') || '(없음)'}`)
        if (!assignees.includes(m.id)) assignees.push(m.id)
      }
      if (assignees.length > 8) throw new Error('기본 담당은 8명까지예요.')
      store.writeBoardOp({ [`label.${id}`]: { name, color, rank, ...(assignees.length ? { assignees } : {}) } }, actor(store, board, rest))
      out(`카테고리를 추가했어요: ${name} (${id})`)
      return
    }
    case 'remove': {
      const key = positional(rest)[0]
      const l = key ? findLabel(board, key) : undefined
      if (!l) throw new Error(`카테고리를 찾지 못했어요. 카테고리: ${[...board.labels.values()].map((x) => `${x.name}(${x.id})`).join(', ') || '(없음)'}`)
      store.writeBoardOp({ [`label.${l.id}`]: null }, actor(store, board, rest))
      out(`카테고리를 지웠어요: ${l.name} (${l.id}) — 카드에 붙어 있던 것은 보이지 않아요.`)
      return
    }
    default:
      throw new Error('사용법: kanban label <add|list|remove>')
  }
}

/** hooks 를 붙이지 못한 LLM 이 스스로 남긴다 (SPEC §15, via:"self") */
async function cmdAgent(args: string[]) {
  const [action, ...rest] = args
  if (!SELF_ACTIONS.includes(action as SelfAction)) throw new Error('사용법: kanban agent <start|progress|ask|report|done|fail> --session ID [--agent 이름] [--name 폴더] [--text 글] [--kind approve|decide|do] [--options a,b] [--to 멤버]')
  const cfg = needConfig()
  const session = flag(rest, '--session') ?? process.env.AGENT_KANBAN_SESSION
  if (!session) throw new Error('--session 이 필요해요(LLM 의 세션 id).')
  try {
    out(
      await selfReport(cfg, {
        agent: resolveAgent(rest),
        session,
        name: flag(rest, '--name'),
        action: action as SelfAction,
        text: flag(rest, '--text'),
        kind: flag(rest, '--kind'),
        options: flag(rest, '--options')?.split(',').map((x) => x.trim()).filter(Boolean),
        to: flag(rest, '--to')?.split(',').map((x) => x.trim()).filter(Boolean),
      }),
    )
  } catch (e) {
    if (e instanceof SelfError) throw new Error(e.message)
    throw e
  }
}

function cmdDoctor() {
  const ok = (m: string) => out(`  OK   ${m}`)
  const bad = (m: string) => out(`  문제 ${m}`)
  out(`설정 파일: ${configPath()}`)
  let raw: any = null
  try {
    raw = JSON.parse(readFileSync(configPath(), 'utf8'))
    ok('설정 파일을 읽었어요')
  } catch {
    bad('설정 파일이 없거나 JSON 이 깨졌어요 → `kanban init`')
  }
  const cfg = loadConfig()
  if (raw) cfg ? ok('enabled=true') : bad('enabled 가 true 가 아니거나 root 가 없어요(hooks 꺼짐)')
  const root = cfg?.root ?? (typeof raw?.root === 'string' ? resolve(expandHome(raw.root)) : undefined)
  if (root) {
    if (existsSync(root)) {
      ok(`root 있음: ${root}`)
      try {
        accessSync(root, constants.W_OK)
        ok('root 쓰기 가능')
      } catch {
        bad('root 에 쓸 수 없어요')
      }
      existsSync(join(root, 'kanban.json')) ? ok('kanban.json 있음') : bad('kanban.json 없음 → `kanban init`')
      if (root.includes('com~apple~CloudDocs')) {
        let placeholders = 0
        const scan = (d: string, depth: number) => {
          if (depth > 6) return
          try {
            for (const e of readdirSync(d, { withFileTypes: true })) {
              if (e.name.startsWith('.') && e.name.endsWith('.icloud')) placeholders++
              else if (e.isDirectory() && !e.name.startsWith('.')) scan(join(d, e.name), depth + 1)
            }
          } catch {}
        }
        scan(root, 0)
        placeholders ? bad(`iCloud 자리표시자(내려받는 중) ${placeholders}개`) : ok('iCloud 자리표시자 없음')
      } else out('  참고 iCloud Drive 폴더가 아니에요(다른 클라우드 폴더일 수 있음)')
    } else bad(`root 폴더가 없어요: ${root}`)
  }
  const b = spawnSync('bun', ['--version'], { encoding: 'utf8' })
  b.status === 0 ? ok(`bun ${b.stdout.trim()}`) : bad('bun 을 찾을 수 없어요')
  if (cfg?.telegram.enabled) process.env[cfg.telegram.tokenEnv] ? ok(`텔레그램 토큰 환경변수(${cfg.telegram.tokenEnv}) 있음`) : bad(`텔레그램이 켜졌는데 ${cfg.telegram.tokenEnv} 환경변수가 비었어요`)
  const log = join(logDir(), 'hook.log')
  if (existsSync(log)) {
    const errs = readFileSync(log, 'utf8').split('\n').filter((l) => l.includes(' ERROR ')).slice(-5)
    errs.length ? (bad(`hook 로그의 최근 오류 ${errs.length}건 (${log})`), errs.forEach((l) => out('       ' + l.slice(0, 200)))) : ok('hook 로그에 오류 없음')
  } else ok('hook 로그 없음(오류 없음)')
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return NaN
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}

async function cmdProbe(args: string[]) {
  const cfg = needConfig()
  const n = Math.max(1, Number(flag(args, '-n')) || 30)
  const timeoutMs = (Number(flag(args, '--timeout')) || 30) * 1000
  const dir = join(cfg.root, 'probes')
  mkdirSync(dir, { recursive: true })
  const rtts: number[] = []
  let lost = 0
  const made: string[] = []
  out(`왕복 측정 ${n}회 (앱의 측정 화면을 열어 두세요, 한 번당 최대 ${timeoutMs / 1000}초)`)
  for (let i = 1; i <= n; i++) {
    const id = newId()
    const f = join(dir, `${id}.json`)
    const echo = join(dir, `${id}.echo.json`)
    made.push(f, echo)
    const t0 = performance.now()
    writeNew(f, { schema: 1, id, n: i, sentAt: iso() })
    let got = false
    while (performance.now() - t0 < timeoutMs) {
      if (readJson(echo)) {
        got = true
        break
      }
      await sleep(50)
    }
    if (got) rtts.push(performance.now() - t0)
    else lost++
    await sleep(150)
  }
  for (const f of made) try { unlinkSync(f) } catch {}
  const s = [...rtts].sort((a, b) => a - b)
  out(`성공 ${rtts.length}/${n}, 실패(시간 초과) ${lost}`)
  if (s.length) out(`왕복 ms: p50=${Math.round(pct(s, 50))} p90=${Math.round(pct(s, 90))} max=${Math.round(s[s.length - 1])}`)
  process.exit(lost === n ? 1 : 0)
}

/** 맥에서 쓴 파일이 iCloud 에 올라갈 때까지(mdls kMDItemIsUploaded). iCloud Drive 폴더가 아니면 값이 없어 측정하지 못한다. */
async function cmdUploadProbe(args: string[]) {
  const cfg = needConfig()
  const timeoutMs = (Number(flag(args, '--timeout')) || 120) * 1000
  const dir = join(cfg.root, 'probes')
  mkdirSync(dir, { recursive: true })
  const id = newId()
  const f = join(dir, `${id}.json`)
  const t0 = performance.now()
  writeNew(f, { schema: 1, id, n: 0, sentAt: iso() })
  let res = ''
  while (performance.now() - t0 < timeoutMs) {
    const r = spawnSync('mdls', ['-raw', '-name', 'kMDItemIsUploaded', f], { encoding: 'utf8', timeout: 5000 })
    const v = (r.stdout || '').trim()
    if (v === '1') {
      res = `업로드 완료까지 ${Math.round(performance.now() - t0)}ms`
      break
    }
    if (v === '(null)' && performance.now() - t0 > 3000) {
      res = '업로드 상태를 알 수 없어요(iCloud Drive 폴더가 아니거나 Spotlight 가 모름)'
      break
    }
    await sleep(250)
  }
  try { unlinkSync(f) } catch {}
  out(res || `시간 초과(${timeoutMs / 1000}초)`)
}

function cmdPrune(args: string[]) {
  const cfg = needConfig()
  const days = Number(flag(args, '--days'))
  if (!isFinite(days) || days < 0 || !flag(args, '--days')) {
    out('사용법: kanban prune --days N [--apply]  (기본은 미리보기, 삭제 없이 archive/ 로 옮김)')
    process.exit(2)
  }
  const apply = has(args, '--apply')
  const store = new Store(cfg.root, cfg.board)
  const cutoff = Date.now() - days * 86400_000
  let n = 0
  for (const id of store.cardIds()) {
    const d = derive(store.events(id), store.actions(id))
    if (d.list !== 'done') continue
    const times = [...store.events(id), ...store.comments(id), ...store.actions(id)].map((x) => Date.parse(x.created)).filter((t) => isFinite(t))
    const latest = Math.max(0, ...times)
    if (latest >= cutoff) continue
    n++
    const title = store.readCard(id)?.title ?? id
    out(`${apply ? '이동' : '대상'}: ${oneLine(title, 60)} (${id}, 마지막 ${iso(latest).slice(0, 10)})`)
    if (apply) {
      const dest = join(store.boardDir, 'archive')
      mkdirSync(dest, { recursive: true })
      if (!existsSync(join(dest, id))) renameSync(store.cardDir(id), join(dest, id))
    }
  }
  out(apply ? `${n}개를 archive/ 로 옮겼어요(삭제 없음).` : `${n}개 대상. 실제로 옮기려면 --apply`)
}

const USAGE =
  '사용법: kanban <init [--root DIR] | setup --root DIR [--name N] [--include DIR]... [--create] [--confirm-replace] | remove --root DIR [--confirm] | status [--json] | board [--archived] | member <add|list|remove> | label <add|list|remove> | agent <start|progress|ask|report|done|fail> | doctor | probe [-n 30] | upload-probe | prune --days N [--apply]>'

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  // --help 는 어떤 명령에서도 실행하지 않고 도움말만 (init --help 가 설정을 만들던 문제)
  if (args.includes('--help') || args.includes('-h')) return out(USAGE)
  switch (cmd) {
    case 'init': return cmdInit(args)
    case 'setup': return cmdSetup(args)
    case 'remove': return cmdRemove(args)
    case 'status': return has(args, '--json') ? cmdStatusJson() : cmdStatus()
    case 'board': return cmdBoard(args)
    case 'member': return cmdMember(args)
    case 'label': return cmdLabel(args)
    case 'agent': return cmdAgent(args)
    case 'doctor': return cmdDoctor()
    case 'probe': return cmdProbe(args)
    case 'upload-probe': return cmdUploadProbe(args)
    case 'prune': return cmdPrune(args)
    default:
      out(USAGE)
      process.exit(cmd ? 2 : 0)
  }
}

if (import.meta.main) {
  main().catch((e) => {
    out(`오류: ${e?.message ?? e}`)
    process.exit(1)
  })
}
