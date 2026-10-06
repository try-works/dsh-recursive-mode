/**
 * `recursive_delegate` — FU-17: the reachable caller that lets the main agent hand a phase's ACTUAL WORK to a
 * child, read what came back, and send feedback to the SAME child so it repairs with its working set intact.
 *
 * ⚠ WHY THIS IS NOT `recursive_review`, and the difference is the whole point. A review JUDGES an artifact that
 * exists. Work PRODUCES it. Three consequences follow, and each of them is a defect if ignored:
 *
 *  1. THIS TOOL DOES NOT REQUIRE THE ARTIFACT TO EXIST. Phase 01 as-is is delegated BEFORE its artifact does —
 *     the work is what creates it — so requiring the file would make the tool refuse exactly the case it is for.
 *  2. THE CHILD IS BRIEFED ON THE STANDARD, NOT ON ANTI-PATTERNS. `buildWorkSlice` composes the required
 *     sections from the phase rules, so the child is told what its output will be linted against. A worker that
 *     has never seen the gate cannot meet it.
 *  3. THE CHILD IS GIVEN A WRITE-CAPABLE FILTER. `delegateReview` defaults to
 *     `{ allow: ['fs_read', 'grep', 'glob'] }` — correct for a reviewer, fatal for a worker, and SILENT either
 *     way: a worker with a read-only filter reports a perfectly healthy delegation while being unable to write a
 *     single file. See `WORK_TOOL_FILTER` for why the override is a deny list.
 *
 * ⚠ THE PARENT KEEPS THE DECISION. This tool starts work and reports what came back; it never writes the phase
 * artifact itself and never locks anything. The main agent reads the reply, verifies it, and either accepts it —
 * recording that in `## Subagent Contribution Verification` — or calls this tool again with `feedback`, which
 * goes to the same child. That division is what the phase contract is built on.
 *
 * ⚠ ONE TRANSITION PER CALL, like `recursive_review` and `recursive_audit_team`: the harness has no parent-side
 * await-settlement promise, so this cannot be one call that waits for a deliverable that arrives on a later turn.
 * The durable state carries the child id between calls.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { toLosslessJson } from './json-safe.ts'
import type { RecursiveRuntime } from './runtime.ts'
import { codeRuntimeRefusal, toolError } from './errors.ts'
import { buildWorkSlice } from './handoff.ts'
import { advanceReview } from './review-round.ts'
import { settlementRoundObserver } from './settlement.ts'
import { CURRENT_WORKFLOW_PROFILE, getArtifactRequiredSections } from './phase-rules.ts'
import type { SubagentParentHandle, SubagentsRuntimeLike } from './delegation.ts'
import { readReplyText, toContinuable } from './recursive_review.tool.ts'

/**
 * ⚠ FU-17 — THE WORK TOOL FILTER, AND WHY IT IS A DENY LIST RATHER THAN AN ALLOW LIST.
 *
 * `delegateReview` applies `input.toolFilter ?? defaultReviewToolFilter()` and that default is
 * `{ allow: ['fs_read', 'grep', 'glob'] }`. So a work delegation that passes nothing receives a child that
 * cannot write — and nothing about the outcome would say so.
 *
 * The obvious fix is an allow list of the writing tools, and it is the wrong one: it has to name EVERY tool a
 * worker might need (`bash`, `pwsh`, `str_replace_editor`, `session_search`, `session_event_read`, `skill`,
 * `load_workspace_dependencies`, `present`, …) and it SILENTLY REMOVES capability for each name forgotten.
 * That is the same defect class this project has already fixed ten times: a surface that cannot express what
 * the system can do, failing quietly.
 *
 * `deny` states the actual posture instead: a delegated worker may use everything EXCEPT spawning its own
 * children and driving the team board. That is what the workflow wants — no recursive fan-out from a worker and
 * no contention over the audit board — and it cannot lose a tool by omission. The host accepts `allow` and/or
 * `deny` (`subagent/src/descriptor.ts`), throwing only when neither is declared.
 */
export const WORK_TOOL_FILTER: unknown = {
  deny: ['spawn_teammate', 'team_task_create', 'team_task_update', 'interrupt_agent'],
}

export function createRecursiveDelegateTool(recursive: RecursiveRuntime, subagents?: SubagentsRuntimeLike) {
  return defineTool({
    name: 'recursive_delegate',
    description:
      'Delegate the WORK of a phase to a durable continuable subagent: it produces the content and writes its '
      + 'submission to reply.md, and YOU remain the judge. Unlike recursive_review this does NOT require the '
      + 'artifact to exist — delegating the work for a phase whose artifact is empty or absent is the normal '
      + 'case. It reports `submitted` when the child delivered, `reviewing` while it is still working, and '
      + '`unavailable` when no continuable child could be used. When the work is not good enough, call this tool '
      + 'again with `feedback`: it is delivered to the SAME child, which repairs with its context intact. It '
      + 'never writes the artifact and never locks anything.',
    parameters: {
      runId: { type: 'string', description: 'Optional run id (defaults to the latest run by mtime).' },
      phase: { type: 'string', description: 'Phase key whose work is being delegated (e.g. 03). Defaults to the run\'s current phase.' },
      role: { type: 'string', description: 'Worker role to route (default: analyst). Must be enabled in the router policy, or the router falls back to self-audit and says so.' },
      instruction: { type: 'string', description: 'What the child must produce, in your words. Required to start work; omit it when only resuming or sending feedback.' },
      feedback: { type: 'string', description: 'What is wrong with the submitted work. Delivered to the SAME child, which repairs it.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(
      args: { runId?: string; phase?: string; role?: string; instruction?: string; feedback?: string },
      exec,
    ) {
      try {
        const root = await recursive.resolveWorkspaceRoot(exec.agent)
        if (!root) return { error: toolError('NO_WORKSPACE') } as const

        const status = await recursive.status(args.runId, exec.agent)
        if (!status) return { error: toolError('NO_RUN') } as const
        const runId = status.runId

        const phase = args.phase?.trim() || status.currentPhase?.key || ''
        if (phase === '') return { error: toolError('NO_PHASE') } as const
        const row = status.phases.find((p) => p.key === phase)
        // ⚠ NO `row.exists` CHECK — and that is deliberate, not an omission. A review needs an artifact to judge;
        // work is often what CREATES one. The FILE NAME is what this tool needs, and the status row carries it
        // whether or not the file is on disk yet.
        if (row === undefined) {
          return { error: toolError('NO_PHASE', 'unknown phase ' + phase + ' for this run') } as const
        }

        const running = args.feedback === undefined || args.feedback.trim() === ''
        // ⚠ NO REFUSAL FOR A MISSING INSTRUCTION, and this is a design choice rather than laziness. The brief
        // already carries the real requirement — the phase's required sections, composed from the phase rules —
        // so a caller with nothing extra to say still gets a child that knows what to produce. Inventing a new
        // refusal code would also mean a new registry entry (`TOOL_ERRORS`, whose codes are grouped and asserted
        // unique), for a case that is better served by a default than by an error.
        const instruction = (args.instruction ?? '').trim() !== ''
          ? (args.instruction ?? '').trim()
          : 'Produce the content this phase\'s artifact requires, following the required sections in your brief.'
        void running

        const role = args.role?.trim() || 'analyst'
        const delegationId = phase + '-work'
        const runDir = join(root, '.recursive', 'run', runId)
        const artifactPath = join(runDir, row.file)
        const parent = exec.agent as unknown as SubagentParentHandle

        const outcome = await advanceReview({
          runDir,
          delegationId,
          phase,
          role,
          // ⚠ FU-17 — THE KIND IS WHAT SEPARATES A DELIVERABLE FROM A VERDICT. A work round must not have an
          // APPROVE read out of prose that was never a verdict.
          kind: 'work',
          // The main agent's feedback, when it has any: delivered to the SAME child by the driver.
          ...(args.feedback === undefined ? {} : { instruction: args.feedback }),
          delegate: async ({ resumeChild }) => {
            // A resumed round keeps the child it was given; a fresh round reserves an id up front so the
            // brief/prompt paths and the session agree from the first call (`ctx.agents.create` accepts a
            // reserved id).
            const childId = resumeChild ?? randomUUID()
            const work = await recursive.delegateReview({
              root,
              runId,
              phase,
              role,
              delegationId,
              childId,
              artifactPath,
              upstreamArtifacts: [],
              auditQuestions: [],
              requiredOutput: 'Write your submission to reply.md, then call the report tool citing reply.md.',
              // ⚠ THE BRIEF IS THE PHASE STANDARD, composed from the same source the linter reads. Building a
              // second copy here is how a brief and a linter drift apart. On a RESUME the child already has its
              // brief, so the slice is omitted rather than rewritten.
              ...(resumeChild === undefined
                ? {
                  slice: buildWorkSlice({
                    instruction,
                    artifactFile: row.file,
                    phase,
                    requiredSections: getArtifactRequiredSections(row.file, CURRENT_WORKFLOW_PROFILE),
                  }),
                }
                : {}),
              // ⚠ AND THE CHILD MAY WRITE. Without this the worker is a reviewer with a read-only filter.
              toolFilter: WORK_TOOL_FILTER,
              subagents,
              parent,
              mode: 'continuable',
              kind: 'work',
              awaitRoundResult: settlementRoundObserver(runDir),
            })
            return toContinuable(work)
          },
          readReply: (childId) => readReplyText(root, runId, delegationId, childId),
          sendRepair: async (childId, repair) => {
            const followup = subagents?.followup
            if (followup === undefined) throw new Error('no continuable followup seam')
            await followup(parent, childId, [{ type: 'text', text: repair }], {
              source: { kind: 'coordinator', form: 'relay', senderSessionId: parent?.id ?? '' },
            })
          },
        })
        const projected = toLosslessJson(outcome)
        return (projected ?? { error: codeRuntimeRefusal('the delegation produced no JSON-representable result') }) as JsonValue
      } catch (err) {
        return { error: codeRuntimeRefusal(err instanceof Error ? err.message : String(err)) } as const
      }
    },
  })
}
