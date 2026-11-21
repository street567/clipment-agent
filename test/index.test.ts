import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  addConfigRoot, addWorkspace, indexRoot, readConfigRoots, scanRoot, writeConfigWorkspaces, readConfigWorkspaces, rootStatuses,
} from '../src/core/index.ts'

const CLI = join(import.meta.dir, '../src/cli.ts')
let tmp: string, root: string
const saved = { ...process.env }
const proj = (...p: string[]) => { mkdirSync(join(root, ...p), { recursive: true }); writeFileSync(join(root, ...p, 'project.json'), '{}') }
const ws = (name: string, ...p: string[]) => { mkdirSync(join(root, ...p), { recursive: true }); writeFileSync(join(root, ...p, 'workspace.json'), JSON.stringify({ schema: 1, name })) }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cliprev-idx-'))
  root = join(tmp, 'root'); mkdirSync(root)
  delete process.env.CLIPREV_ROOT
  process.env.CLIPREV_CONFIG = join(tmp, 'cfg', 'workspaces.json')
})
afterEach(() => { process.env = { ...saved } })

describe('scanRoot', () => {
  test('workspace.json 또는 하위 프로젝트로 감지, 이름/개수/정렬', async () => {
    ws('내 작업', '영상', 'ClipReview'); proj('영상', 'ClipReview', 'a'); proj('영상', 'ClipReview', 'b')
    mkdirSync(join(root, '공유', '개미'), { recursive: true }); proj('공유', '개미', 'x') // workspace.json 없이 프로젝트만
    mkdirSync(join(root, '빈폴더'))
    const { workspaces } = await scanRoot(root)
    expect(workspaces).toEqual([
      { path: '영상/ClipReview', name: '내 작업', projects: 2 },
      { path: '공유/개미', name: '개미', projects: 1 },
    ].sort((a, b) => (a.path < b.path ? -1 : 1)))
  })
  test('깊이 제한', async () => {
    ws('deep', 'a', 'b', 'c', 'd'); ws('shallow', 'a', 'b')
    expect((await scanRoot(root, { depth: 2 })).workspaces.map(w => w.path)).toEqual(['a/b'])
    expect((await scanRoot(root, { depth: 4 })).workspaces.map(w => w.path)).toEqual(['a/b', 'a/b/c/d'])
  })
  test('숨김·node_modules·프로젝트 내부·워크스페이스의 프로젝트 하위는 건너뜀', async () => {
    ws('hid', '.hidden', 'w'); ws('nm', 'node_modules', 'w')
    ws('real', 'real'); proj('real', 'p1')
    ws('inner', 'real', 'p1', 'inner') // 프로젝트 안
    ws('p2inner', 'proj-only', 'p') ; mkdirSync(join(root, 'proj-only', 'p'), { recursive: true }); writeFileSync(join(root, 'proj-only', 'p', 'project.json'), '{}')
    const paths = (await scanRoot(root)).workspaces.map(w => w.path)
    expect(paths).toContain('real')
    expect(paths).not.toContain('.hidden/w')
    expect(paths).not.toContain('node_modules/w')
    expect(paths).not.toContain('real/p1/inner')
    expect(paths).not.toContain('real/p1')
  })
  test('온라인 전용 자리표시자(.workspace.json.icloud)도 존재로 인정, 이름은 폴더명', async () => {
    mkdirSync(join(root, 'cloud')); writeFileSync(join(root, 'cloud', '.workspace.json.icloud'), '')
    expect((await scanRoot(root)).workspaces).toEqual([{ path: 'cloud', name: 'cloud', projects: 0 }])
  })
  test('--fix 없으면 workspace.json 을 만들지 않고, 있으면 만든다', async () => {
    proj('w', 'p')
    await scanRoot(root)
    expect(existsSync(join(root, 'w', 'workspace.json'))).toBe(false)
    const r = await scanRoot(root, { fix: true })
    expect(r.created).toEqual(['w'])
    expect(JSON.parse(readFileSync(join(root, 'w', 'workspace.json'), 'utf8')).name).toBe('w')
  })
})

describe('indexRoot', () => {
  test('원자적 쓰기: index.json 생성, tmp 파일 남지 않음, 재실행 시 덮어씀', async () => {
    ws('A', 'a'); proj('a', 'p')
    const r = await indexRoot(root)
    const j = JSON.parse(readFileSync(r.file, 'utf8'))
    expect(j.schema).toBe(1)
    expect(Date.parse(j.updated)).toBeGreaterThan(0)
    expect(j.workspaces).toEqual([{ path: 'a', name: 'A', projects: 1 }])
    expect(readdirSync(join(root, '.clipment'))).toEqual(['index.json'])
    ws('B', 'b')
    await indexRoot(root)
    expect(JSON.parse(readFileSync(r.file, 'utf8')).workspaces.map((w: any) => w.path)).toEqual(['a', 'b'])
    expect(readdirSync(join(root, '.clipment'))).toEqual(['index.json'])
  })
  test('없는 루트는 오류', async () => {
    await expect(indexRoot(join(tmp, 'nope'))).rejects.toThrow()
  })
})

describe('root registry', () => {
  test('등록은 idempotent 이고 workspaces 를 보존', async () => {
    writeConfigWorkspaces([{ name: 'x', path: join(tmp, 'x') }])
    await indexRoot(root); await indexRoot(root)
    expect(readConfigRoots()).toEqual([{ path: root }])
    expect(addConfigRoot(root)).toBe(false)
    expect(readConfigWorkspaces().map(w => w.name)).toEqual(['x'])
    writeConfigWorkspaces([]) // roots 보존
    expect(readConfigRoots()).toEqual([{ path: root }])
    expect((await rootStatuses())[0]!.workspaces).toBe(0)
  })
  test('workspaces add → 등록된 루트 아래면 인덱스 재생성', async () => {
    await indexRoot(root)
    expect(JSON.parse(readFileSync(join(root, '.clipment/index.json'), 'utf8')).workspaces).toEqual([])
    await addWorkspace(join(root, 'new', 'ws'), { name: 'newws' })
    const j = JSON.parse(readFileSync(join(root, '.clipment/index.json'), 'utf8'))
    expect(j.workspaces.map((w: any) => w.path)).toEqual(['new/ws'])
  })
  test('루트 밖 workspaces add 는 인덱스를 건드리지 않음', async () => {
    await indexRoot(root)
    await addWorkspace(join(tmp, 'elsewhere'), { name: 'e' })
    expect(JSON.parse(readFileSync(join(root, '.clipment/index.json'), 'utf8')).workspaces).toEqual([])
  })
})

describe('CLI index', () => {
  test('요약 출력 + --json', () => {
    ws('A', 'a'); proj('a', 'p')
    const env = { ...process.env }
    const t = spawnSync('bun', [CLI, 'index', root], { env, encoding: 'utf8' })
    expect(t.status).toBe(0)
    expect(t.stdout).toContain('워크스페이스 1개')
    const j = spawnSync('bun', [CLI, 'index', root, '--depth', '2', '--json'], { env, encoding: 'utf8' })
    expect(JSON.parse(j.stdout).workspaces[0].path).toBe('a')
    const l = spawnSync('bun', [CLI, 'workspaces'], { env, encoding: 'utf8' })
    expect(l.stdout).toContain('[루트]')
  })
})
