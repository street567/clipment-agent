// 릴레이 테스트용 가짜 MCP 서버 (SDK 없음). 이 파일이 <agent>/src/server.ts 로 복사된다.
// 동작은 <agent>/package.json 의 "fake" 필드와 FAKE_LOG 환경변수로 제어한다.
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
const fake = pkg.fake ?? {}
const V: string = pkg.version
const log = (s: string) => { if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${s}\n`) }
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
log(`start v${V} pid=${process.pid} session=${process.env.CLIPMENT_SESSION_PID}/${process.env.CLIPMENT_SESSION_VERSION}`)

process.on('SIGUSR2', () => { log(`sigusr2 v${V}`); process.exit(0) })
process.stdin.on('end', () => { log(`eof v${V}`); process.exit(0) })

let buf = ''
process.stdin.on('data', async d => {
  buf += d
  let i: number
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    log(`msg v${V} ${m.method ?? 'response'}`)
    if (m.method === 'initialize') {
      if (fake.failInit) return out({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: 'boom' } })
      if (fake.hangInit) return
      if (fake.initDelayMs) await new Promise(r => setTimeout(r, fake.initDelayMs))
      out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: fake.protocolVersion ?? m.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake', version: V } } })
    } else if (m.method === 'notifications/initialized') {
      if (fake.dieAfterInitMs) setTimeout(() => process.exit(3), fake.dieAfterInitMs)
    } else if (m.method === 'tools/list') {
      out({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }, { name: `tool_v${V}`, inputSchema: { type: 'object' } }] } })
    } else if (m.method === 'tools/call') {
      const a = m.params?.arguments ?? {}
      if (m.params.name === 'crash') process.exit(3)
      if (a.sleepMs) await new Promise(r => setTimeout(r, a.sleepMs))
      out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `v${V} pid=${process.pid} ${m.params.name}` }] } })
    } else if (m.method === 'ping') out({ jsonrpc: '2.0', id: m.id, result: {} })
  }
})
