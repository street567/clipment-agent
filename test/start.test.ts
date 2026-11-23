import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { join } from 'node:path'
import { tempRoot } from './helpers.ts'

// .mcp.json 과 같은 방식(bun run --cwd <root> start)으로 기동해도 stdout 이 오염되지 않는지
test('plugin start script speaks clean MCP over stdout', async () => {
  const root = tempRoot()
  const client = new Client({ name: 't', version: '0' }, { capabilities: {} })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['run', '--cwd', join(import.meta.dir, '..'), '--shell=bun', '--silent', 'start'],
    env: { ...(process.env as Record<string, string>), CLIPREV_ROOT: root },
  }))
  try {
    expect((await client.listTools()).tools.length).toBe(17)
  } finally {
    await client.close()
  }
}, 30000)
