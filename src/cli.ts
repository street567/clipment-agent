#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  readWorkspaceContract, newerContractMessage, addWorkspace, removeWorkspace, indexRoot, rootStatuses, DEFAULT_INDEX_DEPTH, resolveCloudWorkspace, PROVIDER_LABEL, type CloudProvider, workspaceStatuses, currentLock, setLock, forceWarning, listWorkspaceProjects, resolveProject, workspaces,
  addProgress, addReply, agentName, allowedAuthors, isAuthorAllowed, COMMENT_STATUSES, extractFrame, getThread, getVersion, initProject,
  formatRegions, regionLegend, listComments, listProjects, listReplies, listRequests, listVersions, PROGRESS_STATES,
  publishVersion, sleep, ValidationError, readPreferences, setPreferences, initWorkspacePrefs,
  type CommentStatus, type ProgressState,
} from './core/index.ts'

const HELP = `clipment (=cliprev) — Clipment 맥 CLI  (워크스페이스: CLIPREV_ROOT > ~/.config/cliprev/workspaces.json > iCloud ClipReview)
  <project> = <워크스페이스>/<프로젝트> 또는 (유일할 때) <프로젝트>

  workspaces [--json]                         등록된 워크스페이스 (이름/경로/접근 가능/프로젝트 수)
  workspaces add <path> [--name X] [--allow 개미,나]
  workspaces add --google|--dropbox|--onedrive [--account 이메일일부] [--sub ClipReview] [--create] [--name X]
                                              (~/Library/CloudStorage 자동 감지; 폴더가 없으면 --create 로 생성)
  workspaces remove <name>                    설정에서만 제거 (파일은 지우지 않음)
  index <root> [--depth N] [--fix] [--json]   루트 아래 워크스페이스를 찾아 <root>/.clipment/index.json 갱신 (기본 깊이 4).
                                              --fix: workspace.json 없는 워크스페이스에 생성. 폴더를 옮기거나 지우지 않음
  init <project> [--title T]
  projects [--json]
  prefs <project|워크스페이스> [--json]        작업 지침 보기 (프로젝트면 프로젝트+워크스페이스, SPEC §11)
  prefs init <워크스페이스>|--all              워크스페이스 지침 초안 생성 (이미 있으면 그대로 둠)
  prefs set <project|워크스페이스> --file F [--force]   지침 전체 교체 (F 가 - 면 표준 입력)
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
  daemon run                   백그라운드 감시 데몬 (알림·인덱스 갱신·선택적 자동 처리). 중복 실행은 즉시 종료
  daemon install|uninstall|stop|restart|status [--json] [--kill-orphans]   launchd LaunchAgent 관리 (sudo 불필요)
  daemon logs [--lines N] [--follow]
  daemon config [--auto-run off|claude|codex] [--job-timeout 분]   ~/.config/clipment/daemon.json
  update                       최신 릴리스로 업데이트하고 데몬을 재시작
  --version                    버전
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
  if (cmd === '--version' || cmd === '-V' || cmd === 'version') return void console.log(appVersion())
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') return void console.log(HELP)

  const { values: o, positionals: p } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' }, title: { type: 'string' }, note: { type: 'string' },
      version: { type: 'string' }, status: { type: 'string' }, 'fixed-in': { type: 'string' },
      author: { type: 'string' }, agent: { type: 'string' }, pending: { type: 'boolean' },
      'author-name': { type: 'string' }, force: { type: 'boolean' }, name: { type: 'string' }, google: { type: 'boolean' }, dropbox: { type: 'boolean' }, onedrive: { type: 'boolean' }, account: { type: 'string' }, sub: { type: 'string' }, create: { type: 'boolean' }, allow: { type: 'string' }, depth: { type: 'string' }, fix: { type: 'boolean' },  'no-regions': { type: 'boolean' }, 'kill-orphans': { type: 'boolean' }, 'auto-run': { type: 'string' }, 'job-timeout': { type: 'string' }, lines: { type: 'string' }, file: { type: 'string' }, follow: { type: 'boolean' }, yes: { type: 'boolean' }, lite: { type: 'boolean' }, out: { type: 'string' }, all: { type: 'boolean' },
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
      for (const r of await rootStatuses())
        console.log(`[루트] ${r.path}\t${r.reachable ? '접근 가능' : '접근 불가'}\t${r.indexUpdated ? `인덱스 ${r.indexUpdated}, 워크스페이스 ${r.workspaces}개` : '인덱스 없음'}`)
      for (const w of ws) console.log(`${w.name}\t${w.path}\t${w.reachable ? '접근 가능' : '접근 불가'}\t프로젝트 ${w.projects}개${w.allowAuthors ? `\t허용: ${w.allowAuthors.join(',')}` : ''}`)
      return
    }
    case 'index': {
      const depth = intOpt(o.depth, 'depth') ?? DEFAULT_INDEX_DEPTH
      if (depth < 0 || depth > 20) throw new ValidationError(`--depth 는 0~20: ${depth}`)
      const r = await indexRoot(need(p[0], 'root'), { depth, fix: o.fix })
      if (o.json) return json(r.index)
      console.log(`루트: ${r.root}${r.registered ? ' (설정에 등록됨)' : ''}\n인덱스: ${r.file}\n워크스페이스 ${r.index.workspaces.length}개`)
      for (const w of r.index.workspaces) console.log(`  ${w.path}\t${w.name}\t프로젝트 ${w.projects}개${r.created.includes(w.path) ? '\t(workspace.json 생성)' : ''}`)
      return
    }
    case 'init': {
      const proj = await initProject(need(p[0], 'project'), o.title)
      const r = resolveProject(p[0]!)
      return o.json ? json({ ...proj, workspace: r.workspace.name, ref: `${r.workspace.name}/${proj.id}` })
        : console.log(`프로젝트 준비됨: ${r.workspace.name}/${proj.id} (${proj.title}) — ${r.workspace.path}`)
    }
    case 'prefs': {
      if (p[0] === 'init') {
        const names = o.all ? workspaces().map(w => w.name) : [need(p[1], '워크스페이스')]
        for (const n of names) {
          const r = await initWorkspacePrefs(n)
          console.log(`${n}\t${r.created ? '초안 생성' : '이미 있음(그대로 둠)'}\t${r.file}`)
        }
        return
      }
      if (p[0] === 'set') {
        const ref = need(p[1], 'project|워크스페이스')
        const src = need(o.file, 'file')
        const text = src === '-' ? await new Response(Bun.stdin.stream()).text() : readFileSync(src, 'utf8')
        return void console.log(`저장: ${await setPreferences(ref, text, { force: o.force })}`)
      }
      const r = await readPreferences(need(p[0], 'project|워크스페이스'))
      if (o.json) return json(r)
      return void console.log(r.combined ?? `작업 지침 없음 (${r.projectFile ?? r.workspaceFile})`)
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
      const rw = resolveProject(project).workspace
      const wc = await readWorkspaceContract(rw.path)
      if (wc.readOnly) {
        console.error(newerContractMessage(wc.version))
        return o.json ? json([]) : undefined
      }
      const allow = allowedAuthors(rw)
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
    case 'daemon':
      return daemonCmd(p[0], o)
    case 'update':
      return update()
    default:
      throw new ValidationError(`알 수 없는 명령: ${cmd}\n\n${HELP}`)
  }
}

const APP_DIR = resolve(import.meta.dir, '..')
function appVersion(): string {
  try { return JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')).version } catch { return 'unknown' }
}

async function confirm(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try { return /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim()) } finally { rl.close() }
}

async function daemonCmd(sub: string | undefined, o: Record<string, any>) {
  const { runDaemon } = await import('./daemon/daemon.ts')
  const L = await import('./daemon/launchd.ts')
  const { loadDaemonConfig, saveDaemonConfig } = await import('./daemon/config.ts')
  const { AUTO_RUNS } = await import('./daemon/autorun.ts')
  const { logPath } = await import('./daemon/util.ts')
  const cli = join(APP_DIR, 'src/cli.ts')
  const reportOrphans = async (orphans: number[]) => {
    if (!orphans.length) return
    console.log(`고아 daemon 프로세스: ${orphans.join(', ')}`)
    if (o.yes || await confirm('종료할까요?')) for (const pid of orphans) console.log(`  ${pid}: ${L.killPid(pid) ? '종료함' : '종료 실패'}`)
    else console.log('  종료하려면: clipment daemon stop --kill-orphans')
  }
  switch (sub) {
    case 'run': process.exitCode = await runDaemon(); return
    case 'install': {
      const r = L.installDaemon({ bun: process.execPath, cli, killOrphans: !!o['kill-orphans'] })
      console.log(`plist: ${r.plist}\n${r.loaded ? 'LaunchAgent 로드됨' : `로드 실패: ${r.error}`}`)
      if (r.report.killed.length) console.log(`이전 인스턴스 종료: ${r.report.killed.join(', ')}`)
      await reportOrphans(r.report.orphans)
      if (!r.loaded) process.exitCode = 1
      return
    }
    case 'uninstall': {
      const r = L.uninstallDaemon({ killOrphans: !!o['kill-orphans'] })
      console.log(r.removed ? `제거됨: ${L.plistPath()}` : 'LaunchAgent 가 설치돼 있지 않았습니다')
      await reportOrphans(r.report.orphans)
      return
    }
    case 'stop': {
      const r = L.stopDaemon({ killOrphans: !!o['kill-orphans'] })
      console.log(`${r.booted ? 'launchd 에서 내림. ' : ''}종료한 pid: ${r.killed.join(', ') || '없음'}`)
      await reportOrphans(r.orphans)
      return
    }
    case 'restart': { const r = L.restartDaemon(); console.log(r.message); if (!r.ok) process.exitCode = 1; return }
    case 'status': {
      const s = L.daemonStatus()
      if (o.json) return json(s)
      console.log(`설치됨: ${s.installed ? '예' : '아니오'}  launchd 로드: ${s.loaded ? '예' : '아니오'}  실행 pid: ${s.lockAlive ? s.lockPid : '없음'}`)
      if (s.duplicates.length) console.log(`경고: 중복/고아 프로세스 ${s.duplicates.join(', ')} — clipment daemon stop --kill-orphans`)
      const st: any = s.state
      if (st) console.log(`대기 요청 ${st.pendingTotal}개, 폴링 ${st.pollMs}ms, RSS ${st.rssMB}MB, 자동 처리 ${st.autoRun}, 갱신 ${st.updated}`)
      return
    }
    case 'logs': {
      const f = logPath()
      if (!existsSync(f)) return void console.log(`로그 없음: ${f}`)
      const n = intOpt(o.lines, 'lines') ?? 50
      spawnSync('tail', ['-n', String(n), f], { stdio: 'inherit' })
      if (o.follow) spawnSync('tail', ['-f', f], { stdio: 'inherit' })
      return
    }
    case 'config': {
      if (o['auto-run'] !== undefined) {
        if (!(AUTO_RUNS as readonly string[]).includes(o['auto-run'])) throw new ValidationError(`--auto-run 은 ${AUTO_RUNS.join('|')}`)
        saveDaemonConfig({ autoRun: o['auto-run'] })
      }
      const t = intOpt(o['job-timeout'], 'job-timeout')
      if (t !== undefined) saveDaemonConfig({ jobTimeoutMin: t })
      return json(loadDaemonConfig())
    }
    default: throw new ValidationError(`daemon 하위 명령: run|install|uninstall|stop|restart|status|logs|config\n\n${HELP}`)
  }
}

/** 설치 스크립트를 임시 복사본으로 실행(자기 자신이 교체되는 것 방지) → 데몬 재시작. 실행 중인 세션은 그대로. */
async function update() {
  const src = join(APP_DIR, 'install.sh')
  if (!existsSync(src)) throw new ValidationError(`install.sh 를 찾지 못했습니다: ${src}`)
  const tmp = join(process.env.TMPDIR ?? '/tmp', `clipment-install-${process.pid}.sh`)
  writeFileSync(tmp, readFileSync(src))
  const before = appVersion()
  const r = spawnSync('bash', [tmp, '--update'], { stdio: 'inherit', env: { ...process.env, CLIPMENT_DIR: process.env.CLIPMENT_DIR ?? APP_DIR } })
  try { unlinkSync(tmp) } catch {}
  if (r.status !== 0) { process.exitCode = r.status ?? 1; return }
  const L = await import('./daemon/launchd.ts')
  const after = spawnSync(process.execPath, [join(APP_DIR, 'src/cli.ts'), '--version'], { encoding: 'utf8' }).stdout.trim()
  console.log(`버전: ${before} -> ${after || '?'}`)
  if (existsSync(L.plistPath())) { const d = L.restartDaemon(); console.log(`데몬: ${d.message}`) }
}

async function watch(project: string | undefined, includeExisting: boolean) {
  const seen = new Set<string>()
  const warnedWs = new Set<string>()
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
      const wsObj = workspaces().find(w => w.name === workspace)
      const wc = wsObj ? await readWorkspaceContract(wsObj.path) : null
      if (wc?.readOnly) {
        if (!warnedWs.has(workspace)) { warnedWs.add(workspace); console.error(`[${workspace}] ${newerContractMessage(wc.version)}`) }
        continue
      }
      const allow = allowedAuthors(wsObj)
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
