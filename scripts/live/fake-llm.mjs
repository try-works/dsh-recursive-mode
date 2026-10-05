/**
 * FU-10 — a SCRIPTED LLM for the live-session harness.
 *
 * WHY THIS EXISTS. A real session needs a model, and a real model would make the verification
 * non-deterministic and cost money. The harness's own e2e does exactly this: it registers a keyless
 * `LlmAdapter` on the default provider route and scripts the tool calls it wants to see. The shape below
 * is copied from `apps/cli/tests/profiles/headless/tests/fixtures/team-llm.mjs` — a class extending
 * `LlmAdapter` whose `stream()` yields chunk objects, registered through `ctx.llm.registerAdapter`.
 *
 * WHAT IT SCRIPTS: the smallest sequence that reaches the delegated review path in a REAL session —
 * `recursive_init`, then `recursive_review`, then a plain-text answer. Everything else about the session
 * (the Agent, the tool runtime, the plugin, the enforcement) is the real thing; only the model is fake.
 */
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ⚠ FU-9 — THE ADAPTER PLAYS THE CHILD TOO.
 *
 * The parent leg alone could never exercise the repair: the review parks waiting for its child's reply, so
 * a REVISE verdict is what makes the plugin send a `followup` to the SAME child. This adapter therefore
 * also answers the child's brief, and it flips its verdict on the SECOND round so the loop closes:
 *
 *   round 1 (the brief)      → write a REVISE verdict to the reply file the brief names
 *   round 2 (after REPAIR)   → write an APPROVE verdict to that SAME file
 *
 * The reply format is measured from `parseReplyVerdict` (`src/delegation.ts`): a JSON object with a
 * `verdict` field, fenced or bare. Anything else and the runtime would fail closed — which is correct
 * behaviour and would prove nothing about the repair.
 */
const repliesWritten = new Map()

const REVISE_REPLY = [
  '# Review reply',
  '',
  '```json',
  '{"verdict":"REVISE","findings":[{"title":"the lock chain permits an out-of-order transition"}]}',
  '```',
  '',
].join('\n')

const APPROVE_REPLY = [
  '# Review reply (after repair)',
  '',
  '```json',
  '{"verdict":"APPROVE","findings":[]}',
  '```',
  '',
].join('\n')

/** The text a turn was handed, from the user and system messages. */
function inputText(messages) {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'system')
    .flatMap((message) => (message.content ?? []).filter((block) => block.type === 'text').map((block) => block.text))
    .join('\n')
}

/** Every tool call this session has already made, read back from the conversation. */
function calledTools(messages) {
  return messages.flatMap((message) => message.role === 'assistant'
    ? message.content.filter((block) => block.type === 'tool-call').map((block) => block.name)
    : [])
}

function toolCallChunks(specs, counter) {
  const chunks = []
  for (const [index, spec] of specs.entries()) {
    const id = ToolCallId(`live-fixture-${counter.n++}`)
    const args = JSON.stringify(spec.args)
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name: spec.name, argumentsDelta: args },
      { type: 'block-end', index, block: { type: 'tool-call', id, name: spec.name, arguments: args } },
    )
  }
  chunks.push(
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

const RUN_ID = 'live-run'

class LiveFixtureAdapter extends LlmAdapter {
  counter = { n: 0 }

  async * stream(options) {
    const messages = options.messages ?? []
    const called = calledTools(messages)

    // THE CHILD'S TURN — the brief names the reply file, so this turn belongs to the delegated reviewer.
    // First time: REVISE (which is what makes the plugin send a repair to this SAME child). Second time:
    // APPROVE, closing the loop.
    const reply = inputText(messages).match(/Reply file:\s*(\S+)/i)
    if (reply) {
      const replyPath = reply[1]
      const already = repliesWritten.get(replyPath) === true
      writeFileSync(join(process.cwd(), replyPath), already ? APPROVE_REPLY : REVISE_REPLY, 'utf8')
      repliesWritten.set(replyPath, true)
      yield* textChunks(already
        ? 'APPROVE written to ' + replyPath + ' after the repair.'
        : 'REVISE written to ' + replyPath + '.')
      return
    }

    // 1. Scaffold the run.
    if (!called.includes('recursive_init')) {
      yield* toolCallChunks([{ name: 'recursive_init', args: { runId: RUN_ID } }], this.counter)
      return
    }
    // 2. Ask for a review of phase 03 — the delegated path FU-9 is about.
    //
    // ⚠ ASKED REPEATEDLY, ON PURPOSE, because the review is TURN-SHAPED: the first call PARKS waiting for
    // the child, and it is a LATER turn that resumes the SAME child (T36: "park, resume the SAME child").
    // A script that asked once left the child with no turn at all — proven by a run whose reply.md was
    // never written. Each further call drives one more round, which is what lets a REVISE verdict produce a
    // repair and then an APPROVE.
    const reviewCalls = called.filter((name) => name === 'recursive_review').length
    if (reviewCalls < 4) {
      yield* toolCallChunks([{ name: 'recursive_review', args: { runId: RUN_ID, phase: '03', role: 'code-reviewer' } }], this.counter)
      return
    }
    // 3. Report and stop. The marker is what the harness greps for in the session log.
    yield* textChunks('LIVE_SESSION_REACHED_REVIEW')
  }
}

/** Cordis plugin name. */
export const name = 'live-fixture-llm'
/** The LLM registry this adapter registers into. */
export const inject = ['llm']

/** Register the keyless adapter on the shipped default provider route. */
export function apply(ctx) {
  ctx.llm.registerAdapter(['deepseek-official'], new LiveFixtureAdapter())
}
