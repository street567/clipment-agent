#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { writeFile } from 'node:fs/promises'
import {
  addProgress, addReply, agentName, COMMENT_STATUSES, extractFrame, getThread, getVersion, initProject,
  listComments, listProjects, listReplies, listRequests, listVersions, PROGRESS_STATES,
  publishVersion, rootDir, sleep, ValidationError,
  type CommentStatus, type ProgressState,
} from './core/index.ts'

const HELP = `cliprev — Clip Review 맥 CLI  (루트: CLIPREV_ROOT 또는 iCloud ClipReview)

  init <project> [--title T]
  projects [--json]
  publish <project> <video> [--note N]
  versions <project> [--json]
  comments <project> [--version N] [--status open|doing|done|question|wontfix] [--json]
  thread <project> <commentId> [--json]
  reply <project> <commentId> <text> [--status S] [--fixed-in N] [--author A]
  requests <project> [--pending] [--json]
  progress <project> <requestId> <state> [message] [--agent A]
  frame <project> <commentId> [--out file.jpg]
  watch [project] [--all]      2초 폴링, 새 코멘트/사용자 답글/요청을 JSON 한 줄씩 출력
`

const fmt = (t: number) => {
  const m = Math.floor(t / 60)
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`
}
const json = (v: unknown) => console.log(JSON.stringify(v, null, 2))
const need = (v: string | undefined, name: string): string => {
  if (!v) throw new ValidationError(`인자 누락: <${name}>\n\n${HELP}`)
  return v
}
const intOpt = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n)) throw new ValidationError(`--${name} 는 정수여야 합니다: ${v}`)
  return n
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') return void console.log(HELP)

  const { values: o, positionals: p } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' }, title: { type: 'string' }, note: { type: 'string' },
      version: { type: 'string' }, status: { type: 'string' }, 'fixed-in': { type: 'string' },
      author: { type: 'string' }, agent: { type: 'string' }, pending: { type: 'boolean' },
      out: { type: 'string' }, all: { type: 'boolean' },
    },
  })

  switch (cmd) {
    case 'init': {
      const proj = await initProject(need(p[0], 'project'), o.title)
      return o.json ? json(proj) : console.log(`프로젝트 준비됨: ${proj.id} (${proj.title}) — ${rootDir()}`)
    }
    case 'projects': {
      const ps = await listProjects()
      return o.json ? json(ps) : ps.forEach(x => console.log(`${x.id}\t${x.title}`))
    }
    case 'publish': {
      const meta = await publishVersion(need(p[0], 'project'), need(p[1], 'video'), { note: o.note })
      return json(meta)
    }
    case 'versions': {
      const vs = await listVersions(need(p[0], 'project'))
      if (o.json) return json(vs)
      for (const v of vs) console.log(`${v.label}  ${v.width}x${v.height} ${v.fps}fps ${v.duration}s  ${v.note}`)
      return
    }
    case 'comments': {
      const status = o.status as CommentStatus | undefined
      if (status && !(COMMENT_STATUSES as readonly string[]).includes(status)) throw new ValidationError(`잘못된 --status: ${status}`)
      const cs = await listComments(need(p[0], 'project'), { version: intOpt(o.version, 'version'), status })
      if (o.json) return json(cs)
      for (const c of cs)
        console.log(`[${c.status}] v${c.version} ${fmt(c.t)} (${c.tag}) ${c.text}  — ${c.id}`)
      return
    }
    case 'thread': {
      const th = await getThread(need(p[0], 'project'), need(p[1], 'commentId'))
      if (o.json) return json(th)
      const c = th.comment
      console.log(`[${th.status}] v${c.version} ${fmt(c.t)} (${c.tag}) ${c.author}: ${c.text}`)
      for (const r of th.replies) console.log(`  ↳ ${r.author}${r.status ? ` [${r.status}]` : ''}${r.fixedIn ? ` fixedIn v${r.fixedIn}` : ''}: ${r.text}`)
      return
    }
    case 'reply': {
      const r = await addReply(need(p[0], 'project'), need(p[1], 'commentId'), {
        text: need(p.slice(2).join(' ') || undefined, 'text'),
        author: o.author ?? agentName(),
        status: o.status as CommentStatus | undefined,
        fixedIn: intOpt(o['fixed-in'], 'fixed-in'),
      })
      return json(r)
    }
    case 'requests': {
      const rs = await listRequests(need(p[0], 'project'), { pendingOnly: o.pending })
      if (o.json) return json(rs)
      for (const r of rs) console.log(`[${r.state}] ${r.type} v${r.version} agent=${r.agent || '-'} ${r.message}  — ${r.id}`)
      return
    }
    case 'progress': {
      const state = need(p[2], 'state') as ProgressState
      if (!(PROGRESS_STATES as readonly string[]).includes(state)) throw new ValidationError(`잘못된 state: ${state} (${PROGRESS_STATES.join('|')})`)
      const e = await addProgress(need(p[0], 'project'), need(p[1], 'requestId'), state, p.slice(3).join(' '), o.agent ?? agentName())
      return json(e)
    }
    case 'frame': {
      const project = need(p[0], 'project')
      const th = await getThread(project, need(p[1], 'commentId'))
      if (th.comment.version < 1) throw new ValidationError('영상 전체 코멘트(version 0)는 프레임이 없습니다')
      const jpg = await extractFrame(project, th.comment.version, th.comment.t)
      const out = o.out ?? `${p[1]}.jpg`
      await writeFile(out, jpg)
      return o.json ? json({ path: out, version: th.comment.version, t: th.comment.t }) : console.log(out)
    }
    case 'watch':
      return watch(p[0], !!o.all)
    default:
      throw new ValidationError(`알 수 없는 명령: ${cmd}\n\n${HELP}`)
  }
}

async function watch(project: string | undefined, includeExisting: boolean) {
  const seen = new Set<string>()
  let first = true
  const emit = (o: unknown, key: string) => {
    if (seen.has(key)) return
    seen.add(key)
    if (!first || includeExisting) console.log(JSON.stringify(o))
  }
  for (;;) {
    const slugs = project ? [project] : (await listProjects()).map(x => x.id)
    for (const slug of slugs) {
      for (const c of await listComments(slug)) {
        emit({ kind: 'comment', project: slug, ...c }, 'c:' + c.id)
        for (const r of await listReplies(slug, c.id))
          if (r.author === 'user') emit({ kind: 'user_reply', project: slug, ...r }, 'r:' + r.id)
      }
      for (const r of await listRequests(slug)) emit({ kind: 'request', project: slug, ...r }, 'q:' + r.id)
    }
    first = false
    await sleep(2000)
  }
}

main().catch(e => {
  console.error(e instanceof ValidationError ? `오류: ${e.message}` : `오류: ${e?.message ?? e}`)
  process.exit(1)
})
