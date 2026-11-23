import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { assertWorkspaceWritable } from './contract.ts'
import { isId, resolveProject, ValidationError } from './paths.ts'
import { aiTextHash, aiStatus, modifyScript, readScript, removeOrphanAiVoices, voiceFileOf, type ScriptLine } from './script.ts'
import { assertUnlocked } from './store.ts'
import { TtsConfigError, type TtsEngine } from './tts.ts'

export interface VoiceResult {
  project: string; engine: string; language: string
  generated: { id: string; hash: string }[]
  skipped: { id: string; reason: string }[]
  failed: { id: string; error: string }[]
  removed: string[]
}

export interface VoiceOptions {
  engine: TtsEngine
  /** true 면 모든 줄을 다시 만든다 */
  all?: boolean
  force?: boolean
  onLine?: (line: ScriptLine, i: number, total: number) => void
}

/**
 * 오래된·없는 AI 음성을 (all 이면 전부) 만들어 script/ai/<id>.m4a 로 쓰고, script.json 에 aiTextHash 를 써 넣는다 (SPEC §14).
 * 잠긴 프로젝트·더 새 계약 워크스페이스는 거부. 줄 텍스트는 TTS 입력일 뿐 명령으로 쓰지 않는다.
 * 엔진 설정 오류(음성 없음·API 키 없음)면 성공분의 해시를 기록한 뒤 그 오류를 던진다.
 */
export async function generateVoices(ref: string, o: VoiceOptions): Promise<VoiceResult> {
  const r = resolveProject(ref)
  await assertWorkspaceWritable(r.workspace.path)
  if (!o.force) await assertUnlocked(ref)
  const script = await readScript(ref)
  if (!script) throw new ValidationError(`대본이 없습니다(또는 내려받는 중): ${ref}`)
  const res: VoiceResult = { project: `${r.workspace.name}/${r.slug}`, engine: o.engine.name, language: script.language, generated: [], skipped: [], failed: [], removed: [] }
  const todo: ScriptLine[] = []
  for (const l of script.lines) {
    const st = aiStatus(r.dir, l, script.language)
    if (st === 'empty') res.skipped.push({ id: l.id, reason: '텍스트가 비어 있음' })
    else if (o.all || st !== 'fresh') todo.push(l)
  }
  let configError: Error | null = null
  for (const [i, l] of todo.entries()) {
    o.onLine?.(l, i, todo.length)
    const final = voiceFileOf(r.dir, l.id, 'ai')
    const tmp = join(r.dir, 'script', 'ai', `.${l.id}.tmp.m4a`)
    const hash = aiTextHash(script.language, l.text)
    try {
      await mkdir(join(r.dir, 'script', 'ai'), { recursive: true })
      await o.engine.synth(l.text, { language: script.language, out: tmp })
      await rename(tmp, final)
      res.generated.push({ id: l.id, hash })
    } catch (e) {
      await rm(tmp, { force: true })
      res.failed.push({ id: l.id, error: e instanceof Error ? e.message : String(e) })
      if (e instanceof TtsConfigError) { configError = e; break }
    }
  }
  if (res.generated.length) {
    const hashes = new Map(res.generated.map(g => [g.id, g.hash]))
    // 다른 필드는 그대로, 최상위·줄 updated 도 건드리지 않는다. 이미 같은 값이면 쓰지 않는다(불필요한 동기화·감시 루프 방지).
    await modifyScript(ref, raw => {
      let changed = false
      for (const l of raw.lines) {
        const h = l && isId(l.id) ? hashes.get(l.id) : undefined
        if (h && l.aiTextHash !== h) { l.aiTextHash = h; changed = true }
      }
      return changed
    }, { force: o.force, touch: false })
  }
  const ids = new Set<string>(script.lines.map(l => l.id))
  res.removed = await removeOrphanAiVoices(ref, ids)
  if (configError) throw configError
  return res
}
