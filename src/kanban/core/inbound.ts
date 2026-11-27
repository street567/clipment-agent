// 이 맥에만 있는 "들어온 일" 표시 (클라우드에 올리지 않음): 감시가 적고 hook·board_inbox 가 읽는다 (SPEC 1.3 §17).
//  - req-<requestId>.json : 이 세션이 맡은(.taken 을 만든) 반영 요청. 감시가 만들고, 끝나면(done) 지운다.
//  - adopt.json           : 이 세션이 이어받을 주인 없는 카드 id 들. 감시만 쓴다.
// 내장 모듈만 사용(hook·monitor 가 node_modules 없이 돌아야 함).
import { readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeReplace } from './fs.ts'
import { assertSessionId, isId } from './ids.ts'
import { stateDir } from './localstate.ts'

export interface ReqMarker {
  v: 1
  id: string
  cardIds: string[] // 맡을 때 정한 대상 카드(cardIds 가 비어 있던 요청은 그때의 "미전달 의견이 있는 카드")
  delivered: string[] // 의견을 전달한 카드
  created: string
}

const dir = (sid: string) => join(stateDir(), 'inbound', assertSessionId(sid))
const markerFile = (sid: string, id: string) => join(dir(sid), `req-${id}.json`)

export function writeMarker(sid: string, m: ReqMarker) {
  writeReplace(markerFile(sid, m.id), m)
}
export function removeMarker(sid: string, id: string) {
  try {
    unlinkSync(markerFile(sid, id))
  } catch {}
}
export function readMarkers(sid: string): ReqMarker[] {
  let names: string[] = []
  try {
    names = readdirSync(dir(sid))
  } catch {
    return []
  }
  const out: ReqMarker[] = []
  for (const n of names) {
    const m = /^req-([0-9a-f-]{8,64})\.json$/.exec(n)
    if (!m) continue
    const r = readJson<ReqMarker>(join(dir(sid), n))
    if (r && r.id === m[1] && Array.isArray(r.cardIds)) out.push({ ...r, cardIds: r.cardIds.filter(isId), delivered: Array.isArray(r.delivered) ? r.delivered.filter(isId) : [] })
  }
  return out.sort((a, b) => (a.created < b.created ? -1 : 1))
}

export function writeAdopt(sid: string, cardIds: string[]) {
  writeReplace(join(dir(sid), 'adopt.json'), { v: 1, cards: cardIds, at: new Date().toISOString() })
}
export function readAdopt(sid: string): string[] {
  const r = readJson<{ cards?: unknown }>(join(dir(sid), 'adopt.json'))
  return r && Array.isArray(r.cards) ? r.cards.filter(isId) : []
}
