import { describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { REPO, tmp } from './relay-helpers.ts'

// install.sh --update 의 git 경로: 릴리스 태그로 이동 / 태그 없으면 main ff / 분리 HEAD / 다운그레이드 금지.
// 원격은 로컬 bare 레포(네트워크 없음). 설치 스크립트는 레포 밖 임시 복사본으로 돌린다 (clipment update 와 같은 방식).

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
function remote(steps: { v: string; tag?: boolean }[]) {
  const base = tmp('clipment-inst-'), dev = join(base, 'dev'), bare = join(base, 'o.git')
  mkdirSync(join(dev, 'src'), { recursive: true })
  git(dev, 'init', '-q', '-b', 'main')
  for (const f of ['cli.ts', 'mcp.ts', 'server.ts']) writeFileSync(join(dev, 'src', f), '// stub\n')
  for (const s of steps) {
    writeFileSync(join(dev, 'package.json'), JSON.stringify({ name: 'clipment-agent', version: s.v }))
    git(dev, 'add', '-A'); git(dev, 'commit', '-q', '-m', `v${s.v}`)
    if (s.tag) git(dev, 'tag', `v${s.v}`)
  }
  git(base, 'init', '-q', '--bare', '-b', 'main', 'o.git')
  git(dev, 'push', '-q', bare, 'main', '--tags')
  return { base, dev, bare }
}
function app(r: ReturnType<typeof remote>, rev: string, detach = false) {
  const dir = join(r.base, 'agent')
  git(r.base, 'clone', '-q', r.bare, dir)
  detach ? git(dir, 'checkout', '-q', '--detach', rev) : git(dir, 'checkout', '-q', '-B', 'main', rev)
  return dir
}
function runUpdate(r: ReturnType<typeof remote>, dir: string, extra: Record<string, string> = {}, args = ['--update']) {
  const home = join(r.base, 'home'), script = join(r.base, 'script', 'install.sh')
  mkdirSync(join(home, '.bun/bin'), { recursive: true }); mkdirSync(join(r.base, 'script'), { recursive: true })
  copyFileSync(join(REPO, 'install.sh'), script)
  // 가짜 bun: install 은 아무것도 안 함(네트워크 없음), 나머지는 진짜 bun
  writeFileSync(join(home, '.bun/bin/bun'), `#!/bin/sh\n[ "$1" = install ] && exit 0\nexec "${process.execPath}" "$@"\n`)
  chmodSync(join(home, '.bun/bin/bun'), 0o755)
  const p = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, CLIPMENT_DIR: dir, CLIPMENT_ASSUME_NO: '1', GIT_TERMINAL_PROMPT: '0', ...extra } })
  return { code: p.status, out: p.stdout + p.stderr }
}
const ver = (dir: string) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
const head = (dir: string) => git(dir, 'rev-parse', 'HEAD')
const isDetached = (dir: string) => spawnSync('git', ['-C', dir, 'symbolic-ref', '-q', 'HEAD']).status !== 0

describe('install.sh --update (git 클론)', () => {
  test('릴리스 태그가 있으면 최신 태그로 (main 이 더 앞서 있어도 태그까지만)', () => {
    const r = remote([{ v: '0.3.0', tag: true }, { v: '0.4.0', tag: true }, { v: '0.5.0-dev'.replace('-dev', '') }])
    const dir = app(r, 'v0.3.0')
    const res = runUpdate(r, dir)
    expect(res.code).toBe(0); expect(res.out).toContain('릴리스 v0.4.0 로 이동')
    expect(ver(dir)).toBe('0.4.0'); expect(isDetached(dir)).toBe(true)
    expect(git(dir, 'describe', '--tags', '--exact-match')).toBe('v0.4.0')
  })
  test('분리 HEAD(옛 태그)에서도 새 태그로 이동, 이미 최신이면 그대로', () => {
    const r = remote([{ v: '0.3.0', tag: true }, { v: '0.4.0', tag: true }])
    const dir = app(r, 'v0.3.0', true)
    expect(runUpdate(r, dir).code).toBe(0); expect(ver(dir)).toBe('0.4.0')
    const again = runUpdate(r, dir)
    expect(again.code).toBe(0); expect(again.out).toContain('이미 최신 릴리스'); expect(ver(dir)).toBe('0.4.0')
  })
  test('현재 버전이 최신 릴리스보다 높으면 건드리지 않고 알린다 (다운그레이드 금지)', () => {
    const r = remote([{ v: '0.3.0', tag: true }, { v: '0.4.0', tag: true }, { v: '0.6.0' }])
    const dir = app(r, 'main'); const before = head(dir)
    const res = runUpdate(r, dir)
    expect(res.code).toBe(0); expect(res.out).toContain('다운그레이드 안 함')
    expect(head(dir)).toBe(before); expect(ver(dir)).toBe('0.6.0'); expect(isDetached(dir)).toBe(false)
  })
  test('릴리스 태그가 없으면 main 을 ff-only 로 (브랜치에서)', () => {
    const r = remote([{ v: '0.3.0' }, { v: '0.4.0' }])
    const dir = app(r, 'HEAD~1')
    const res = runUpdate(r, dir)
    expect(res.code).toBe(0); expect(res.out).toContain('릴리스가 없어 main'); expect(ver(dir)).toBe('0.4.0'); expect(isDetached(dir)).toBe(false)
  })
  test('릴리스 태그가 없고 분리 HEAD 여도 main 으로 돌아와 갱신', () => {
    const r = remote([{ v: '0.3.0' }, { v: '0.4.0' }])
    const dir = app(r, 'HEAD~1', true)
    const res = runUpdate(r, dir)
    expect(res.code).toBe(0); expect(ver(dir)).toBe('0.4.0'); expect(isDetached(dir)).toBe(false)
  })
  test('태그 형식이 아닌 태그(v1.2, rc)는 릴리스로 보지 않음', () => {
    const r = remote([{ v: '0.3.0' }, { v: '0.4.0' }])
    git(r.dev, 'tag', 'v9.9'); git(r.dev, 'tag', 'v9.9.9-rc1'); git(r.dev, 'push', '-q', r.bare, '--tags')
    const dir = app(r, 'HEAD~1')
    expect(runUpdate(r, dir).out).toContain('릴리스가 없어 main'); expect(ver(dir)).toBe('0.4.0')
  })
  test('CLIPMENT_VERSION 으로 특정 태그 고정도 분리 HEAD 에서 동작', () => {
    const r = remote([{ v: '0.3.0', tag: true }, { v: '0.4.0', tag: true }])
    const dir = app(r, 'v0.4.0', true)
    expect(runUpdate(r, dir, { CLIPMENT_VERSION: 'v0.3.0' }).code).toBe(0); expect(ver(dir)).toBe('0.3.0')
  })
})

describe('install.sh 질문', () => {
  test('--help 에 새 환경변수 설명, CLIPMENT_ASSUME_NO 설치 흐름은 자동 업데이트를 끈 채 둔다', () => {
    const help = spawnSync('bash', [join(REPO, 'install.sh'), '--help'], { encoding: 'utf8' }).stdout
    expect(help).toContain('CLIPMENT_LATEST_TAG')
    // 소스 체크: 질문 문구/기본값
    const src = readFileSync(join(REPO, 'install.sh'), 'utf8')
    expect(src).toContain('자동 업데이트를 켤까요?'); expect(src).toContain('(기본 N)'); expect(src).toContain('릴리스 코드가 확인 없이')
  })
  test('전체 설치 흐름(CLIPMENT_ASSUME_NO)과 --yes 는 자동 업데이트를 켜지 않는다', () => {
    const r = remote([{ v: '0.4.0', tag: true }])
    const dir = app(r, 'v0.4.0')
    const home = join(r.base, 'home')
    const no = runUpdate(r, dir, {}, [])
    expect(no.out).toContain('자동 업데이트는 꺼 둡니다(off)')
    expect(spawnSync('test', ['-e', join(home, '.config/clipment/daemon.json')]).status).not.toBe(0)
  })
})
