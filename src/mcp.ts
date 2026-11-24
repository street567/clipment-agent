#!/usr/bin/env bun
// 얇은 stdio 릴레이. 실제 MCP 서버는 src/server.ts (자식 프로세스). 자동 업데이트가 켜져 있으면 세션을 끊지 않고 자식만 새 버전으로 바꾼다.
// .mcp.json · Codex · 데스크톱 설정이 가리키는 경로(src/mcp.ts)는 그대로 유지된다. mcpb 번들은 릴레이 없이 server.ts 를 직접 쓴다.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRelay } from './relay/relay.ts'

startRelay({ bundledDir: resolve(dirname(fileURLToPath(import.meta.url)), '..') })
