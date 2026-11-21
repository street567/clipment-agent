#!/usr/bin/env bun
// Claude 데스크톱 설정(claude_desktop_config.json)의 mcpServers.<name> 만 추가/제거한다. 다른 서버·키는 보존.
// 사용: bun desktop-config.ts add <config> <name> <command> [args...]
//       bun desktop-config.ts remove <config> <name>
// 수정 전에 <config>.bak-<타임스탬프> 로 백업. 설정 JSON 이 깨져 있으면 아무것도 쓰지 않고 실패.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const [op, file, name, command, ...args] = process.argv.slice(2)
if (!op || !file || !name || (op === 'add' && !command)) {
  console.error('사용법: desktop-config.ts add|remove <config> <name> [command args...]')
  process.exit(2)
}

let cfg: any = {}
if (existsSync(file)) {
  const raw = readFileSync(file, 'utf8')
  if (raw.trim()) {
    try { cfg = JSON.parse(raw) } catch (e) { console.error(`설정 파일 JSON 이 올바르지 않아 건드리지 않습니다: ${file}`); process.exit(1) }
  }
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) { console.error('설정 파일 최상위가 객체가 아닙니다'); process.exit(1) }
}
const servers = cfg.mcpServers
if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) {
  console.error('mcpServers 가 객체가 아니라 건드리지 않습니다'); process.exit(1)
}

if (op === 'remove') {
  if (!servers || !(name in servers)) { console.log(`mcpServers.${name} 없음 — 변경 없음`); process.exit(0) }
  delete servers[name]
} else if (op === 'add') {
  cfg.mcpServers = { ...(servers ?? {}), [name]: { command, args, env: { CLIPREV_AGENT: 'claude' } } }
} else { console.error(`알 수 없는 동작: ${op}`); process.exit(2) }

if (existsSync(file)) {
  const bak = `${file}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
  copyFileSync(file, bak)
  console.log(`백업: ${bak}`)
}
mkdirSync(dirname(file), { recursive: true })
writeFileSync(file + '.tmp', JSON.stringify(cfg, null, 2) + '\n')
renameSync(file + '.tmp', file)
console.log(`${op === 'add' ? '등록' : '제거'}: mcpServers.${name} (${file})`)
