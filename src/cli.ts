#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { writeFile } from 'node:fs/promises'
import {
  addWorkspace, removeWorkspace, resolveCloudWorkspace, PROVIDER_LABEL, type CloudProvider, workspaceStatuses, currentLock, setLock, forceWarning, listWorkspaceProjects, resolveProject, workspaces,
  addProgress, addReply, agentName, allowedAuthors, isAuthorAllowed, COMMENT_STATUSES, extractFrame, getThread, getVersion, initProject,
  formatRegions, regionLegend, listComments, listProjects, listReplies, listRequests, listVersions, PROGRESS_STATES,
  publishVersion, sleep, ValidationError,
  type CommentStatus, type ProgressState,
} from './core/index.ts'

const HELP = `clipment (=cliprev) — Clipment 맥 CLI  (워크스페이스: CLIPREV_ROOT > ~/.config/cliprev/workspaces.json > iCloud ClipReview)
  <project> = <워크스페이스>/<프로젝트> 또는 (유일할 때) <프로젝트>

  workspaces [--json]                         등록된 워크스페이스 (이름/경로/접근 가능/프로젝트 수)
  workspaces add <path> [--name X] [--allow 개미,나]
  workspaces add --google|--dropbox|--onedrive [--account 이메일일부] [--sub ClipReview] [--create] [--name X]
                                              (~/Library/CloudStorage 자동 감지; 폴더가 없으면 --create 로 생성)
  workspaces remove <name>                    설정에서만 제거 (파일은 지우지 않음)
  init <project> [--title T]
  projects [--json]
  lock <project> [--note N]                   완료 잠금 (요청 제외, publish/reply 거부)
  unlock <project>
  publish <project> <video> [--note N] [--lite] [--force]
  versions <project> [--json]
  comments <project> [--version N] [--status open|doing|done|question|wontfix] [--json]
  thread <project> <commentId> [--json]
  reply <project> <commentId> <text> [--status S] [--fixed-in N] [--author A] [--author-name 표시이름] [--force]
  requests <project> [--pending] [--json]
  progress <project> <requestId> <state> [message] [--agent A]
  frame <project> <commentId> [--out file.jpg] [--no-regions]   기본: 현재 영역을 사각형으로 그려 저장
  watch [project] [--all]      2초 폴링, 새 코멘트/사용자 답글/요청을 JSON 한 줄씩 출력
`

const fmt = (t: number) => {
  const m = Math.floor(t / 60)
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`
}
const range = (c: { t: number; end: number | null }) =>
  c.end !== null && c.end > c.t ? `${c.t.toFixed(1)}–${c.end.toFixed(1)}s` : fmt(c.t)
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
      'author-name': { type: 'string' }, force: { type: 'boolean' }, name: { type: 'string' }, google: { type: 'boolean' }, dropbox: { type: 'boolean' }, onedrive: { type: 'boolean' }, account: { type: 'string' }, sub: { type: 'string' }, create: { type: 'boolean' }, allow: { type: 'string' },  'no-regions': { type: 'boolean' }, lite: { type: 'boolean' }, out: { type: 'string' }, all: { type: 'boolean' },
    },
  })

  switch (cmd) {
    case 'workspaces': {
      const sub = p[0]
      if (sub === 'add') {
        const prov: CloudProvider | undefined = o.google ? 'google' : o.dropbox ? 'dropbox' : o.onedrive ? 'onedrive' : undefined
        const path = prov ? resolveCloudWorkspace(prov, { account: o.account, sub: o.sub, create: o.create }) : need(p[1], 'path')
        const defName = prov ? { google: '구글', dropbox: 'dropbox', onedrive: 'onedrive' }[prov] : undefined
        const w = await addWorkspace(path, { name: o.name ?? defName, allowAuthors: o.allow?.split(',') })
        if (prov === 'google') console.error('참고: 구글 드라이브 "스트리밍" 모드는 파일이 온라인 전용이라 늦게 내려받아질 수 있습니다. "미러링" 모드를 권장합니다.')
        if (o.json) return json(w)
        console.log(`워크스페이스 추가됨: ${w.name} — ${w.path}${w.allowAuthors ? ` (허용: ${w.allowAuthors.join(',')})` : ''}`)
        if (process.env.CLIPREV_ROOT?.trim()) console.log('참고: CLIPREV_ROOT 가 설정돼 있어 그 폴더만 사용합니다. 설정 파일을 쓰려면 환경변수를 해제하세요.')
        return
      }
      if (sub === 'remove') {
        const w = removeWorkspace(need(p[1], 'name'))
        return o.json ? json(w) : console.log(`워크스페이스 제거됨(설정에서만): ${w.name} — ${w.path} (파일은 그대로)`)
      }
      if (sub !== undefined) throw new ValidationError(`알 수 없는 하위 명령: workspaces ${sub}\n\n${HELP}`)
      const ws = await workspaceStatuses()
      if (o.json) return json(ws)
      for (const w of ws) console.log(`${w.name}\t${w.path}\t${w.reachable ? '접근 가능' : '접근 불가'}\t프로젝트 ${w.projects}개${w.allowAuthors ? `\t허용: ${w.allowAuthors.join(',')}` : ''}`)
      return
    }
    case 'init': {
      const proj = await initProject(need(p[0], 'project'), o.title)
      const r = resolveProject(p[0]!)
      return o.json ? json({ ...proj, workspace: r.workspace.name, ref: `${r.workspace.name}/${proj.id}` })
        : console.log(`프로젝트 준비됨: ${r.workspace.name}/${proj.id} (${proj.title}) — ${r.workspace.path}`)
    }
    case 'projects': {
      const ps = await listProjects()
      return o.json ? json(ps) : ps.forEach(x => console.log(`${x.ref}\t${x.title}${x.locked ? '\t[완료·잠금]' : ''}`))
    }
    case 'lock':
    case 'unlock': {
      const project = need(p[0], 'project')
      await resolveProject(project)
      const e = await setLock(project, cmd === 'lock' ? 'locked' : 'unlocked', {
        author: o.author ?? agentName(), authorName: o['author-name'] ?? process.env.CLIPREV_AGENT_NAME, note: o.note,
      })
      return json(e)
    }
    case 'publish': {
      const project = need(p[0], 'project')
      const warn = o.force ? await forceWarning(project) : null
      const meta = await publishVersion(project, need(p[1], 'video'), { note: o.note, lite: o.lite, force: o.force })
      if (warn) console.error(warn)
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
        console.log(`[${c.status}] v${c.version} ${range(c)} (${c.tag}) ${c.authorName ?? c.author}: ${c.text}  — ${c.id}`
          + (c.currentRegions.length ? `\n    ${formatRegions(c.currentRegions)}` : ''))
      return
    }
    case 'thread': {
      const th = await getThread(need(p[0], 'project'), need(p[1], 'commentId'))
      if (o.json) return json(th)
      const c = th.comment
      console.log(`[${th.status}] v${c.version} ${range(c)} (${c.tag}) ${c.authorName ?? c.author}: ${c.text}`)
      if (th.currentRegions.length) console.log(`  ${formatRegions(th.currentRegions)}`)
      for (const r of th.replies)
        console.log(`  ↳ ${r.authorName ?? r.author}${r.status ? ` [${r.status}]` : ''}${r.fixedIn ? ` fixedIn v${r.fixedIn}` : ''}: ${r.kind === 'regions' && !r.text ? '(영역을 수정했습니다)' : r.text}`)
      return
    }
    case 'reply': {
      const warn = o.force ? await forceWarning(need(p[0], 'project')) : null
      const r = await addReply(need(p[0], 'project'), need(p[1], 'commentId'), {
        text: need(p.slice(2).join(' ') || undefined, 'text'),
        author: o.author ?? agentName(),
        authorName: o['author-name'] ?? process.env.CLIPREV_AGENT_NAME,
        status: o.status as CommentStatus | undefined,
        fixedIn: intOpt(o['fixed-in'], 'fixed-in'), force: o.force,
      })
      if (warn) console.error(warn)
      return json(r)
    }
    case 'requests': {
      const project = need(p[0], 'project')
      const allow = allowedAuthors(resolveProject(project).workspace)
      const locked = !!(await currentLock(project))
      const rs = locked ? [] : (await listRequests(project, { pendingOnly: o.pending })).filter(r => isAuthorAllowed(r, allow))
      if (locked && !o.json) console.error(`잠긴(완료) 프로젝트라 요청을 가져오지 않습니다: ${project}`)
      if (o.json) return json(rs)
      for (const r of rs) console.log(`[${r.state}] ${r.type} v${r.version} agent=${r.agent || '-'}${r.authorName ? ` from=${r.authorName}` : ''} ${r.message}  — ${r.id}`)
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
      const drawn = o['no-regions'] ? [] : th.currentRegions
      const jpg = await extractFrame(project, th.comment.version, th.comment.t, { regions: drawn })
      const out = o.out ?? `${p[1]}.jpg`
      await writeFile(out, jpg)
      if (o.json) return json({ path: out, version: th.comment.version, t: th.comment.t, regions: drawn, legend: regionLegend(drawn) })
      console.log(out)
      if (drawn.length) console.log(`${formatRegions(drawn)}\n${regionLegend(drawn)}`)
      return
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
    const targets: { workspace: string; ref: string }[] = []
    if (project) { const r = resolveProject(project); targets.push({ workspace: r.workspace.name, ref: `${r.workspace.name}/${r.slug}` }) }
    else for (const w of workspaces()) for (const x of await listWorkspaceProjects(w)) targets.push({ workspace: w.name, ref: `${w.name}/${x.id}` })
    for (const { workspace, ref } of targets) {
      for (const c of await listComments(ref)) {
        emit({ kind: 'comment', workspace, project: ref, ...c }, 'c:' + ref + c.id)
        for (const r of await listReplies(ref, c.id))
          if (r.author === 'user') emit({ kind: 'user_reply', workspace, project: ref, ...r }, 'r:' + ref + r.id)
      }
      if (await currentLock(ref)) continue
      const allow = allowedAuthors(workspaces().find(w => w.name === workspace))
      for (const r of await listRequests(ref)) if (isAuthorAllowed(r, allow)) emit({ kind: 'request', workspace, project: ref, ...r }, 'q:' + ref + r.id)
    }
    first = false
    await sleep(2000)
  }
}

main().catch(e => {
  console.error(e instanceof ValidationError ? `오류: ${e.message}` : `오류: ${e?.message ?? e}`)
  process.exit(1)
})
