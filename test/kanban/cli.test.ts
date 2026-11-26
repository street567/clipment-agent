import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cardId } from '../../src/kanban/core/ids.ts'
import { base, boardDir, cards, PLUGIN, runHook, SID, setup, sleep, type Env } from './helpers.ts'

process.env.AGENT_KANBAN_NO_DOWNLOAD = '1'
const H = (e: Env, ev: string, extra: Record<string, any> = {}) => runHook(e, { ...base(), hook_event_name: ev, ...extra })
async function cli(e: Env, ...args: string[]) {
  const p = Bun.spawn([process.execPath, join(PLUGIN, 'src/kanban/cli.ts'), ...args], { env: e.env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { stdout, stderr, code }
}

describe('kanban CLI', () => {
  test('--help 는 아무것도 실행하지 않는다 (init --help 가 설정을 만들면 안 됨)', async () => {
    const e = setup(null as any)
    for (const h of ['--help', '-h']) {
      const r = await cli(e, 'init', '--root', join(e.dir, 'H'), h)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('사용법')
    }
    expect(existsSync(e.cfgPath)).toBe(false)
    expect(existsSync(join(e.dir, 'H'))).toBe(false)
  })
  test('init: 설정·폴더 생성, 덮어쓰지 않음', async () => {
    const e = setup(null as any)
    const root = join(e.dir, 'Agent Kanban')
    const r = await cli(e, 'init', '--root', root)
    expect(r.code).toBe(0)
    const c = JSON.parse(readFileSync(e.cfgPath, 'utf8'))
    expect(c).toMatchObject({ enabled: true, root, board: 'main', includeHeadless: false, monitor: { intervalSec: 5, busyDelaySec: 30 }, telegram: { enabled: false, tokenEnv: 'AGENT_KANBAN_TELEGRAM_TOKEN' } })
    expect(existsSync(join(root, 'kanban.json'))).toBe(true)
    expect(existsSync(join(root, 'boards/main/board.json'))).toBe(true)
    writeFileSync(e.cfgPath, JSON.stringify({ ...c, board: 'custom1', marker: 1 }))
    const r2 = await cli(e, 'init', '--root', join(e.dir, 'elsewhere'))
    expect(r2.stdout).toContain('덮어쓰지 않음')
    expect(JSON.parse(readFileSync(e.cfgPath, 'utf8')).marker).toBe(1)
    // init 은 토큰 파일을 읽거나 설정에 토큰을 쓰지 않는다
    expect(readFileSync(e.cfgPath, 'utf8')).not.toMatch(/[0-9]{8,}:[A-Za-z0-9_-]{30,}/)
  })

  test('status · board · doctor', async () => {
    const e = setup({})
    await H(e, 'SessionStart', { source: 'startup' })
    await H(e, 'UserPromptSubmit', { prompt_id: 'p', prompt: '로그인 화면 고쳐 줘' })
    await H(e, 'TaskCreated', { task_id: '1', task_subject: '대기 작업' })
    await H(e, 'PermissionRequest', { tool_name: 'Bash', tool_input: { description: '배포' } })
    const st = await cli(e, 'status')
    expect(st.stdout).toContain('켜짐')
    expect(st.stdout).toContain('proj')
    const b = await cli(e, 'board')
    expect(b.stdout).toContain('== 사람 차례 (1) ==')
    expect(b.stdout).toContain('권한 확인: 배포')
    expect(b.stdout).toContain('== 대기 (1) ==')
    expect(b.stdout).toContain('대기 작업')
    const d = await cli(e, 'doctor')
    expect(d.stdout).toContain('OK   enabled=true')
    expect(d.stdout).toContain('bun ')
    expect(d.stdout).toContain('root 쓰기 가능')
    // hook 오류가 로그에 있으면 doctor 가 보여 준다
    mkdirSync(e.log, { recursive: true })
    writeFileSync(join(e.log, 'hook.log'), '2026-11-25T00:00:00.000Z ERROR Stop Error: boom\n')
    expect((await cli(e, 'doctor')).stdout).toContain('boom')
    // 설정 없음
    const e2 = setup(null as any)
    expect((await cli(e2, 'doctor')).stdout).toContain('설정 파일이 없거나')
    expect((await cli(e2, 'board')).code).toBe(1)
  })

  test('probe: 앱이 echo 를 쓰면 p50/p90/max 를 출력하고 자기 파일을 정리한다', async () => {
    const e = setup({})
    const dir = join(e.root, 'probes')
    let stop = false
    const app = (async () => {
      while (!stop) {
        try {
          for (const n of readdirSync(dir)) {
            if (n.endsWith('.echo.json') || n.startsWith('.')) continue
            const id = n.slice(0, -5)
            const echo = join(dir, `${id}.echo.json`)
            if (!existsSync(echo)) writeFileSync(echo, JSON.stringify({ schema: 1, id, seenAt: new Date().toISOString() }))
          }
        } catch {}
        await sleep(30)
      }
    })()
    const r = await cli(e, 'probe', '-n', '5')
    stop = true
    await app
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('성공 5/5')
    expect(r.stdout).toMatch(/p50=\d+ p90=\d+ max=\d+/)
    expect(readdirSync(dir)).toEqual([])
  })
  test('probe: 응답이 없으면 시간 초과로 실패하고 파일은 정리', async () => {
    const e = setup({})
    const r = await cli(e, 'probe', '-n', '2', '--timeout', '0.4')
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('성공 0/2')
    expect(readdirSync(join(e.root, 'probes'))).toEqual([])
  })
  test('upload-probe: iCloud 폴더가 아니면 알려 주고 끝낸다', async () => {
    const e = setup({})
    const r = await cli(e, 'upload-probe', '--timeout', '8')
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/알 수 없어요|업로드 완료|시간 초과/)
    expect(readdirSync(join(e.root, 'probes'))).toEqual([])
  })

  test('prune: 기본 미리보기, --apply 는 완료 카드를 archive/ 로 옮김(삭제 없음), 진행 중·최근 카드는 그대로', async () => {
    const e = setup({})
    // 오래된 완료 카드 (직접 작성)
    const old = '0aaaaaaa-0000-4000-8000-000000000001'
    const mk = (id: string, types: string[], created: string) => {
      const d = join(boardDir(e), 'cards', id)
      mkdirSync(join(d, 'events'), { recursive: true })
      writeFileSync(join(d, 'card.json'), JSON.stringify({ schema: 1, id, sessionId: SID, kind: 'task', title: `카드 ${id.slice(-1)}`, created }))
      types.forEach((t, i) => writeFileSync(join(d, 'events', `0000000${i + 1}-0000-4000-8000-000000000000.json`), JSON.stringify({ schema: 1, id: `0000000${i + 1}-0000-4000-8000-000000000000`, cardId: id, sessionId: SID, type: t, created })))
    }
    mk(old, ['created', 'done'], '2026-01-01T00:00:00.000Z')
    mk('0aaaaaaa-0000-4000-8000-000000000002', ['created', 'progress'], '2026-01-01T00:00:00.000Z') // 오래됐지만 진행 중
    await H(e, 'SessionStart', {})
    await H(e, 'UserPromptSubmit', { prompt_id: 'p', prompt: '방금 끝난 일입니다 정말' })
    await H(e, 'Stop', { last_assistant_message: '끝', background_tasks: [] }) // 최근 완료
    const pre = await cli(e, 'prune', '--days', '30')
    expect(pre.stdout).toContain('1개 대상')
    expect(pre.stdout).toContain('--apply')
    expect(existsSync(join(boardDir(e), 'cards', old))).toBe(true)
    expect((await cli(e, 'prune')).code).toBe(2)
    const ap = await cli(e, 'prune', '--days', '30', '--apply')
    expect(ap.stdout).toContain('archive/')
    expect(existsSync(join(boardDir(e), 'cards', old))).toBe(false)
    expect(existsSync(join(boardDir(e), 'archive', old, 'card.json'))).toBe(true)
    expect(existsSync(join(boardDir(e), 'archive', old, 'events'))).toBe(true)
    expect(cards(e).length).toBe(2) // 진행 중 + 최근 완료
    void cardId
  })
})
