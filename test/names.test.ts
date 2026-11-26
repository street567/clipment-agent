import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PKG_NAMES as RELAY_PKG_NAMES } from '../src/relay/lib.ts'
import { EXPECTED_ORIGINS, LEGACY_MARKETPLACE, LEGACY_PLUGIN_ID, MARKETPLACE, OWNER, PKG_NAMES, PLUGIN, PLUGIN_ID, REPO } from '../src/names.ts'
import { REPO as UPDATER_REPO } from '../src/daemon/updater.ts'

const root = join(import.meta.dir, '..')
const json = (f: string) => JSON.parse(readFileSync(join(root, f), 'utf8'))

describe('이름 일관성 (이름을 바꿀 때 한 번에 어긋남을 잡는다)', () => {
  test('매니페스트·package.json·updater 가 names.ts 와 같다', () => {
    const mp = json('.claude-plugin/marketplace.json'), pl = json('.claude-plugin/plugin.json'), pkg = json('package.json')
    expect(mp.name).toBe(MARKETPLACE)
    expect(mp.plugins[0].name).toBe(PLUGIN)
    expect(pl.name).toBe(PLUGIN)
    expect([mp.plugins[0].version, pl.version]).toEqual([pkg.version, pkg.version])
    expect(PKG_NAMES).toContain(pkg.name)
    expect(RELAY_PKG_NAMES).toEqual(PKG_NAMES)
    expect(UPDATER_REPO).toBe(REPO)
    expect(REPO).toBe(`${OWNER}/${PLUGIN}`)
    expect(PLUGIN_ID).toBe(`${PLUGIN}@${MARKETPLACE}`)
  })
  test('install.sh NAMES 블록이 names.ts 와 같다', () => {
    const sh = readFileSync(join(root, 'install.sh'), 'utf8')
    const v = (k: string) => sh.match(new RegExp(`^${k}="([^"]*)"`, 'm'))?.[1]
    expect(v('DEFAULT_REPO')).toBe(REPO)
    expect(v('MARKETPLACE_NAME')).toBe(MARKETPLACE)
    expect(v('PLUGIN_NAME')).toBe(PLUGIN)
    expect(v('LEGACY_PLUGIN_ID')).toBe(LEGACY_PLUGIN_ID)
    expect(v('LEGACY_MARKETPLACE')).toBe(LEGACY_MARKETPLACE)
    expect(v('PKG_NAME')).toBe(PKG_NAMES[0])
  })
  test('origin 허용 목록에 새 이름과 옛 이름(https/ssh)이 모두 있다', () => {
    for (const r of [REPO, 'street567/clipment-agent']) {
      for (const u of [`https://github.com/${r}.git`, `https://github.com/${r}`, `git@github.com:${r}.git`, `ssh://git@github.com/${r}.git`]) expect(EXPECTED_ORIGINS).toContain(u)
    }
  })
})
