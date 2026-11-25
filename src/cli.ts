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
  addProgress, addReply, addComment, authorAllowWarning, agentName, allowedAuthors, isAuthorAllowed, COMMENT_STATUSES, extractFrame, getThread, getVersion, initProject,
  formatRegions, regionLegend, listComments, listProjects, listReplies, listRequests, listVersions, PROGRESS_STATES,
  publishVersion, getEffectiveQuality, setProjectQuality, clearProjectQuality, getWorkspaceQualityInfo, setWorkspaceQuality, assertQuality, QUALITY_SOURCE_LABEL, QUALITIES, getUploadInfo, setUploadVersion, clearUploadVersion, sleep, ValidationError, readPreferences, setPreferences, initWorkspacePrefs,
  describeScript, generateVoices, buildNarration, createTtsEngine,
  type CommentStatus, type ProgressState,
} from './core/index.ts'
import { localTime, parseSeconds, updateClaudePlugin } from './cliutil.ts'

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
  publish <project> <video> [--note N] [--quality 360p|540p|720p|1080p] [--lite] [--no-original] [--upload] [--force]
                                              기본: 소스 원본(original.<ext>)을 미리보기 옆에 복사 (--no-original 로 생략),
                                              --upload: 이 새 버전을 업로드용으로 지정
                                              화질 순서: --quality > 프로젝트 지정 > 워크스페이스 기본 > 720p  (--lite = 540p)
  quality <project> [360p|540p|720p|1080p|--clear] [--json]   프로젝트 작업용 화질 보기·지정·해제 (SPEC §13; 값 없이 쓰면 적용 화질과 출처)
  quality --workspace <ws> [값|--clear] [--json]               워크스페이스 기본 작업용 화질 (workspace.json previewQuality)
  upload-version <project> [N|--clear] [--json]   업로드용 버전 보기·지정·해제 (SPEC §12; 지정이 없으면 원본 있는 최신 → 최신)
  script <project> [--json]                   대본 보기 (SPEC §14: 줄·시각·음성 종류·AI 음성 상태 fresh/stale/missing)
  voice <project> [--all] [--force] [--json]  AI 음성 만들기: 없거나 오래된 줄만(--all 은 전부), script.json 에 aiTextHash 기록.
                                              엔진: CLIPMENT_TTS_ENGINE > daemon.json ttsEngine > say (en Samantha, ko Yuna). 잠긴 프로젝트는 --force 없이 거부
  narration <project> --out <file.m4a> [--duration 초] [--json]
                                              줄마다 선택한 음성(내 녹음 또는 최신 AI 음성)을 start 에 놓은 나레이션 트랙 m4a (읽기 전용·결정적).
                                              --duration 생략 시 마지막 음성 끝 + 0.5초
  versions <project> [--json]
  comments <project> [--version N | --ids a,b] [--status open|doing|done|question|wontfix] [--json]
                                              --ids: 여러 버전의 코멘트를 id 로 (version 필터 무시)
  thread <project> <commentId> [--json]
  reply <project> <commentId> <text> [--status S] [--fixed-in N] [--fixed-at <초|m:ss(.s)>] [--author A] [--author-name 표시이름] [--force]
                                              --fixed-at: 새 버전(fixed-in) 영상에서 바뀐 곳의 시작 시각 (fixed-in 과 함께만)
  comment <project> <text> [--version N] [--at <초|m:ss(.s)>] [--end 초] [--tag T] [--force]
                                              사람이 채널·터미널에서 한 수정 요청을 대신 기록 (author=user, via=channel; 이름은 CLIPREV_USER_NAME).
                                              version 기본 0(영상 전체), at 기본 0
  requests <project> [--pending] [--json]
  progress <project> <requestId> <state> [message] [--agent A]
  frame <project> <commentId> [--out file.jpg] [--no-regions]   기본: 현재 영역을 사각형으로 그려 저장
  watch [project] [--all]      2초 폴링, 새 코멘트/사용자 답글/요청을 JSON 한 줄씩 출력
  daemon run                   백그라운드 감시 데몬 (알림·인덱스 갱신·선택적 자동 처리). 중복 실행은 즉시 종료
  daemon install|uninstall|stop|restart|status [--json] [--kill-orphans]   launchd LaunchAgent 관리 (sudo 불필요)
  daemon logs [--lines N] [--follow]
  daemon config [--auto-run off|claude|codex] [--job-timeout 분] [--tts-engine say|openai|elevenlabs]   ~/.config/clipment/daemon.json
  health [--json]              데몬/채널 세션/미처리 요청/요청 없는 코멘트 점검 (확인 필요하면 종료 코드 1)
  update                       최신 릴리스로 업데이트하고 데몬을 재시작 (+ claude 플러그인 갱신, CLIPMENT_SKIP_PLUGIN_UPDATE=1 이면 생략)
  update --check               새 릴리스가 있는지만 확인 (아무것도 바꾸지 않음)
  update --rollback            마지막 자동 적용 전 버전으로 되돌리고 그 버전을 나쁜 버전으로 기록
  autoupdate on|off|status     자동 업데이트(daemon.json autoUpdate, 기본 꺼짐). 켜면 릴리스 코드가 자동으로 실행·적용됨
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
      version: { type: 'string' }, status: { type: 'string' }, 'fixed-in': { type: 'string' }, 'fixed-at': { type: 'string' }, ids: { type: 'string' }, at: { type: 'string' }, end: { type: 'string' }, tag: { type: 'string' },
      author: { type: 'string' }, agent: { type: 'string' }, pending: { type: 'boolean' },
      'author-name': { type: 'string' }, force: { type: 'boolean' }, name: { type: 'string' }, google: { type: 'boolean' }, dropbox: { type: 'boolean' }, onedrive: { type: 'boolean' }, account: { type: 'string' }, sub: { type: 'string' }, create: { type: 'boolean' }, allow: { type: 'string' }, depth: { type: 'string' }, fix: { type: 'boolean' },  'no-regions': { type: 'boolean' }, 'kill-orphans': { type: 'boolean' }, 'auto-run': { type: 'string' }, 'job-timeout': { type: 'string' }, 'tts-engine': { type: 'string' }, duration: { type: 'string' }, lines: { type: 'string' }, file: { type: 'string' }, follow: { type: 'boolean' }, yes: { type: 'boolean' }, lite: { type: 'boolean' }, quality: { type: 'string' }, workspace: { type: 'string' }, 'no-original': { type: 'boolean' }, upload: { type: 'boolean' }, clear: { type: 'boolean' }, out: { type: 'string' }, all: { type: 'boolean' }, check: { type: 'boolean' }, rollback: { type: 'boolean' },
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
      const meta = await publishVersion(project, need(p[1], 'video'), { note: o.note, lite: o.lite, quality: o.quality ? assertQuality(o.quality) : undefined, force: o.force, noOriginal: o['no-original'], upload: o.upload })
      if (warn) console.error(warn)
      return json(meta)
    }
    case 'quality': {
      if (o.workspace) {
        const ws = o.workspace
        if (o.clear && p[0] !== undefined) throw new ValidationError('값과 --clear 는 함께 쓸 수 없습니다')
        if (o.clear) await setWorkspaceQuality(ws, null)
        else if (p[0] !== undefined) await setWorkspaceQuality(ws, assertQuality(p[0]))
        const wi = await getWorkspaceQualityInfo(ws)
        if (o.json) return json(wi)
        return void console.log(`${wi.workspace} 기본 작업용 화질: ${wi.quality}  [${QUALITY_SOURCE_LABEL[wi.source]}]`)
      }
      const project = need(p[0], 'project')
      if (o.clear && p[1] !== undefined) throw new ValidationError('값과 --clear 는 함께 쓸 수 없습니다')
      const warn = o.force && (o.clear || p[1] !== undefined) ? await forceWarning(project) : null
      if (o.clear) {
        const had = await clearProjectQuality(project, { force: o.force })
        if (warn) console.error(warn)
        if (!o.json) console.log(had ? '프로젝트 화질 지정을 해제했습니다 (워크스페이스 기본을 따름)' : '프로젝트 지정이 없습니다')
      } else if (p[1] !== undefined) {
        await setProjectQuality(project, assertQuality(p[1]), { author: o.author ?? agentName(), authorName: o['author-name'] ?? process.env.CLIPREV_AGENT_NAME, force: o.force })
        if (warn) console.error(warn)
      }
      const e = await getEffectiveQuality(project)
      if (o.json) return json(e)
      const d = e.project
      console.log(`작업용 화질: ${e.quality}  [${QUALITY_SOURCE_LABEL[e.source]}${e.source === 'project' && d ? `: ${d.authorName ?? d.author}/${d.via}` : ''}]  (${QUALITIES.join('|')} · 다음 게시부터 적용)`)
      return
    }
    case 'upload-version': {
      const project = need(p[0], 'project')
      if (o.clear && p[1] !== undefined) throw new ValidationError('N 과 --clear 는 함께 쓸 수 없습니다')
      const warn = o.force ? await forceWarning(project) : null
      if (o.clear) {
        const had = await clearUploadVersion(project, { force: o.force })
        if (warn) console.error(warn)
        console.log(had ? '업로드용 지정을 해제했습니다 (기본 규칙: 원본 있는 최신 → 최신)' : '지정이 없습니다')
      } else if (p[1] !== undefined) {
        const n = intOpt(p[1], 'N')!
        const d = await setUploadVersion(project, n, { author: o.author ?? agentName(), authorName: o['author-name'] ?? process.env.CLIPREV_AGENT_NAME, force: o.force })
        if (warn) console.error(warn)
        if (o.json) return json(d)
        console.log(`업로드용 = v${String(n).padStart(3, '0')}`)
      }
      const info = await getUploadInfo(project)
      if (o.json) return json(info)
      if (!info) return void console.log('버전이 없습니다')
      const m = info.meta
      const spec = info.hasOriginal ? `원본 ${m.original!.width ?? '?'}x${m.original!.height ?? '?'} ${(m.original!.bytes / 1e6).toFixed(1)}MB` : '미리보기 화질 (원본 없음)'
      console.log(`업로드용: ${m.label}  ${spec}  [${info.designated ? `지정: ${info.designation!.authorName ?? info.designation!.author}/${info.designation!.via}` : '기본 규칙'}]`)
      if (info.newer) console.log(`  ※ v${String(info.newer).padStart(3, '0')} 이(가) 더 최신입니다. 최종본이면: clipment upload-version ${project} ${info.newer}`)
      return
    }
    case 'script': {
      const v = await describeScript(need(p[0], 'project'))
      if (o.json) return json(v)
      if (!v.exists) return void console.log(`대본 없음: ${v.file}`)
      console.log(`${v.project}  language=${v.language}  줄 ${v.lines.length}개${v.updated ? `  (${v.updated})` : ''}`)
      for (const l of v.lines)
        console.log(`${String(l.order).padStart(2)}. ${l.start.toFixed(1)}–${l.captionEnd.toFixed(1)}s [${l.voice}${l.voice === 'mine' && !l.mine ? '(녹음 없음)' : ''}] AI음성:${l.ai}${l.author ? ` ${l.author}` : ''}  ${l.text}  — ${l.id}`)
      return
    }
    case 'voice': {
      const project = need(p[0], 'project')
      const { configuredTtsEngine } = await import('./daemon/config.ts')
      const warn = o.force ? await forceWarning(project) : null
      const r = await generateVoices(project, {
        engine: createTtsEngine(configuredTtsEngine()), all: o.all, force: o.force,
        onLine: o.json ? undefined : (l, i, n) => console.error(`[${i + 1}/${n}] ${l.text.slice(0, 40)}`),
      })
      if (warn) console.error(warn)
      if (r.failed.length) process.exitCode = 1
      if (o.json) return json(r)
      console.log(`AI 음성 (${r.engine}, ${r.language}): 만듦 ${r.generated.length}, 실패 ${r.failed.length}, 건너뜀 ${r.skipped.length}${r.removed.length ? `, 정리 ${r.removed.length}` : ''}`)
      for (const f of r.failed) console.log(`  실패 ${f.id}: ${f.error}`)
      return
    }
    case 'narration': {
      const project = need(p[0], 'project')
      const dur = o.duration === undefined ? undefined : Number(o.duration)
      if (dur !== undefined && !(Number.isFinite(dur) && dur > 0)) throw new ValidationError(`--duration 은 0 보다 큰 초: ${o.duration}`)
      const r = await buildNarration(project, { out: need(o.out, 'out (--out file.m4a)'), duration: dur })
      for (const w of r.warnings) console.error(`경고: ${w}`)
      if (o.json) return json(r)
      console.log(`${r.out}\n길이 ${r.duration.toFixed(2)}s, 배치 ${r.placed.length}줄 (내 녹음 ${r.placed.filter(x => x.source === 'mine').length}, AI ${r.placed.filter(x => x.source === 'ai').length}), 건너뜀 ${r.skipped.length}`)
      return
    }
    case 'versions': {
      const vs = await listVersions(need(p[0], 'project'))
      if (o.json) return json(vs)
      for (const v of vs) console.log(`${v.label}  ${v.width}x${v.height} ${v.fps}fps ${v.duration}s  ${v.original ? `[원본 ${(v.original.bytes / 1e6).toFixed(1)}MB] ` : ''}${v.note}`)
      return
    }
    case 'comments': {
      const status = o.status as CommentStatus | undefined
      if (status && !(COMMENT_STATUSES as readonly string[]).includes(status)) throw new ValidationError(`잘못된 --status: ${status}`)
      const ids = o.ids === undefined ? undefined : o.ids.split(',').map(x => x.trim()).filter(Boolean)
      const cs = await listComments(need(p[0], 'project'), { version: intOpt(o.version, 'version'), status, ids })
      if (o.json) return json(cs)
      for (const c of cs)
        console.log(`[${c.status}${c.approved ? '·확인됨' : ''}] v${c.version} ${range(c)} (${c.tag}) ${c.authorName ?? c.author}${c.via === 'channel' ? ' (채널에서)' : ''}: ${c.text}  — ${c.id}`
          + (c.currentRegions.length ? `\n    ${formatRegions(c.currentRegions)}` : ''))
      return
    }
    case 'thread': {
      const th = await getThread(need(p[0], 'project'), need(p[1], 'commentId'))
      if (o.json) return json(th)
      const c = th.comment
      console.log(`[${th.status}${th.approved ? '·확인됨' : ''}] v${c.version} ${range(c)} (${c.tag}) ${c.authorName ?? c.author}${c.via === 'channel' ? ' (채널에서)' : ''}: ${c.text}`)
      if (th.currentRegions.length) console.log(`  ${formatRegions(th.currentRegions)}`)
      for (const r of th.replies)
        console.log(`  ↳ ${r.authorName ?? r.author}${r.status ? ` [${r.status}]` : ''}${r.fixedIn ? ` fixedIn v${r.fixedIn}${r.fixedAt !== undefined ? ` @${fmt(r.fixedAt)}` : ''}` : ''}${r.kind === 'review' && r.review ? ` (확인:${r.review === 'approved' ? '확인함' : '취소'})` : ''}: ${r.kind === 'regions' && !r.text ? '(영역을 수정했습니다)' : r.text}`)
      return
    }
    case 'reply': {
      const warn = o.force ? await forceWarning(need(p[0], 'project')) : null
      const r = await addReply(need(p[0], 'project'), need(p[1], 'commentId'), {
        text: need(p.slice(2).join(' ') || undefined, 'text'),
        author: o.author ?? agentName(),
        authorName: o['author-name'] ?? process.env.CLIPREV_AGENT_NAME,
        status: o.status as CommentStatus | undefined,
        fixedIn: intOpt(o['fixed-in'], 'fixed-in'),
        fixedAt: o['fixed-at'] === undefined ? undefined : parseSeconds(o['fixed-at'], 'fixed-at'),
        force: o.force,
      })
      if (warn) console.error(warn)
      return json(r)
    }
    case 'comment': {
      const project = need(p[0], 'project')
      const warn = o.force ? await forceWarning(project) : null
      const c = await addComment(project, {
        text: need(p.slice(1).join(' ') || undefined, 'text'),
        version: intOpt(o.version, 'version'),
        t: o.at === undefined ? undefined : parseSeconds(o.at, 'at'),
        end: o.end === undefined ? undefined : parseSeconds(o.end, 'end'),
        tag: o.tag, force: o.force, authorName: process.env.CLIPREV_USER_NAME,
      })
      if (warn) console.error(warn)
      const aw = authorAllowWarning(resolveProject(project).workspace, c.authorName)
      if (aw) console.error(aw)
      return json(c)
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
      for (const r of rs) console.log(`[${r.state}] ${r.type}${r.type === 'apply_script' ? (r.draft ? '(draft)' : '') : ''} v${r.version} agent=${r.agent || '-'}${r.authorName ? ` from=${r.authorName}` : ''} ${r.message}  — ${r.id}`)
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
    case 'health': {
      const H = await import('./daemon/health.ts')
      const { loadDaemonConfig } = await import('./daemon/config.ts')
      const r = await H.buildHealthReport({ cfg: loadDaemonConfig() })
      if (o.json) json(r); else console.log(H.formatHealth(r))
      if (!r.ok) process.exitCode = 1
      return
    }
    case 'update':
      return o.check ? updateCheck() : o.rollback ? updateRollback() : update()
    case 'autoupdate':
      return autoUpdateCmd(p[0])
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
      if (st) console.log(`대기 요청 ${st.pendingTotal}개, 폴링 ${Number.isFinite(st.pollMs) ? `${st.pollMs}ms` : '?'}, RSS ${st.rssMB ?? '?'}MB, 자동 처리 ${st.autoRun}, 버전 ${st.version ?? '?'}, 갱신 ${localTime(st.updated)}`)
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
      if (o['tts-engine'] !== undefined) {
        const { TTS_ENGINES } = await import('./core/index.ts')
        if (!(TTS_ENGINES as readonly string[]).includes(o['tts-engine'])) throw new ValidationError(`--tts-engine 은 ${TTS_ENGINES.join('|')}`)
        saveDaemonConfig({ ttsEngine: o['tts-engine'] })
      }
      const t = intOpt(o['job-timeout'], 'job-timeout')
      if (t !== undefined) saveDaemonConfig({ jobTimeoutMin: t })
      return json(loadDaemonConfig())
    }
    default: throw new ValidationError(`daemon 하위 명령: run|install|uninstall|stop|restart|status|logs|config\n\n${HELP}`)
  }
}

/** 설치 스크립트를 임시 복사본으로 실행(자기 자신이 교체되는 것 방지) → 데몬 재시작 → claude 플러그인 갱신. 실행 중인 세션은 그대로. */
async function update() {
  const src = join(APP_DIR, 'install.sh')
  if (!existsSync(src)) throw new ValidationError(`install.sh 를 찾지 못했습니다: ${src}`)
  const { acquireUpdateLock } = await import('./relay/lib.ts')
  const release = acquireUpdateLock() // 릴레이가 갱신 도중의 반쯤 바뀐 폴더를 고르지 않도록
  if (!release) throw new ValidationError('다른 업데이트가 진행 중입니다 (잠시 뒤 다시 시도)')
  try {
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
  } finally { release() }
  updateClaudePlugin()
}

async function updateCheck() {
  const { fetchLatestRelease } = await import('./daemon/updater.ts')
  const { cmpVersion, majorOf, isBad } = await import('./relay/lib.ts')
  const { loadDaemonConfig } = await import('./daemon/config.ts')
  const cur = appVersion()
  const on = loadDaemonConfig().autoUpdate
  try {
    const rel = await fetchLatestRelease()
    const c = cmpVersion(rel.version, cur)
    const verdict = c === null ? '비교 불가' : c > 0 ? `새 버전 있음${(majorOf(rel.version) ?? 0) > (majorOf(cur) ?? 0) ? ' (메이저 — 자동 적용 안 함)' : ''}${isBad(rel.version) ? ' (나쁜 버전으로 기록됨)' : ''}` : c === 0 ? '최신입니다' : '현재가 더 높습니다 (다운그레이드 안 함)'
    console.log(`현재 v${cur} · 최신 릴리스 ${rel.tag} — ${verdict}\n자동 업데이트: ${on ? '켜짐' : '꺼짐'}${c !== null && c > 0 ? '\n업데이트: clipment update' : ''}`)
  } catch (e: any) {
    console.error(`확인 실패: ${e?.message ?? e}`)
    process.exitCode = 1
  }
}

async function updateRollback() {
  const { rollback } = await import('./daemon/updater.ts')
  const { makeRunner, ChildTracker } = await import('./daemon/runner.ts')
  const r = await rollback({ run: makeRunner(new ChildTracker()), appDir: APP_DIR, bun: process.execPath })
  console.log(r.message)
  if (!r.ok) { process.exitCode = 1; return }
  const L = await import('./daemon/launchd.ts')
  if (existsSync(L.plistPath())) { const d = L.restartDaemon(); console.log(`데몬: ${d.message}`) }
}

async function autoUpdateCmd(sub: string | undefined) {
  const { loadDaemonConfig, saveDaemonConfig } = await import('./daemon/config.ts')
  const { readBadList, managedDir } = await import('./relay/lib.ts')
  if (sub === 'on' || sub === 'off') {
    saveDaemonConfig({ autoUpdate: sub === 'on' })
    console.log(sub === 'on'
      ? '자동 업데이트 켬: 새 릴리스 코드가 자동으로 내려받아져 실행됩니다 (열려 있는 세션도 새 서버로 바뀜). 끄려면: clipment autoupdate off'
      : '자동 업데이트 끔: 새 세션부터 플러그인에 들어 있는 버전만 씁니다. 새 버전이 나오면 알림만 합니다.')
  } else if (sub !== undefined && sub !== 'status') throw new ValidationError(`autoupdate 하위 명령: on|off|status\n\n${HELP}`)
  const on = loadDaemonConfig().autoUpdate
  const bad = Object.keys(readBadList())
  console.log(`자동 업데이트: ${on ? '켜짐' : '꺼짐'}  (현재 v${appVersion()}, 관리형 설치 ${managedDir()}${existsSync(join(managedDir(), '.git')) ? ' [git 클론]' : ' [git 아님: 데몬은 알림만, 서버 교체는 가능]'})`)
  if (bad.length) console.log(`나쁜 버전(건너뜀): ${bad.map(v => `v${v}`).join(', ')}`)
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
          if (r.author === 'user' && r.kind !== 'review') emit({ kind: 'user_reply', workspace, project: ref, ...r }, 'r:' + ref + r.id)
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
