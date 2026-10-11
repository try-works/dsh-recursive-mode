import { defineTool } from '@deepseek-ai/dsh-tools'
import { codeRuntimeRefusal, toolError } from './errors.ts'
import { buildGateBlockAsk } from './recursive_ask.tool.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RecursiveRuntime } from './runtime.ts'

export function createRecursiveLockTool(recursive: RecursiveRuntime) {
  return defineTool({
    name: 'recursive_lock',
    description: 'Lock a DRAFT recursive-mode artifact: writes Status: LOCKED, LockedAt, LockHash and validates prerequisites (monotonic phase gating). Delegates to the RecursiveRuntime service.'
      // THE SKIP IS ADVERTISED HERE, because this sentence is what a model reads BEFORE choosing a tool,
      // and the live defect was a model that needed to skip a phase and had no way to discover one. One
      // sentence, stated as the ALTERNATIVE to the act it has to displace: what the flag is for, and the
      // constraint that matters before the call (a run artifact is evidence). The mechanics live on the
      // parameter, and the refusals are left to the call results rather than pre-emptively listed.
      + ' A phase that does not apply is recorded as SKIPPED with `skip` instead of being removed: a run'
      + ' artifact is evidence, so never delete one to get past a phase.'
      // FU-11 — THE GIT PRECONDITION, WHERE THE CALLER DECIDES TO CALL. This is the surface a model reads
      // before choosing the tool, and the requirement was previously discoverable only from a refusal:
      // `lockArtifact` validates the phase standard by linting the run, which resolves the diff basis in
      // `00-worktree.md` against live git, and the lock hash is computed into the artifact. A workspace
      // with no repository therefore refuses EVERY lock, however compliant the artifact — the fix is
      // `git init` plus a commit, not an edit — so the condition is stated here rather than left to be
      // inferred from the FAIL text after an artifact has been written. `recursive_phase` reports the same
      // fact as `gitRequired` before authoring begins.
      + ' REQUIRES A GIT REPOSITORY: the lock hash and the diff basis the lint verifies are git facts, so in a'
      + ' workspace that is not a git repository (or has no commits) every lock is refused, and no edit to the'
      + ' artifact clears it. Call `recursive_phase` first — it returns `gitRequired` when that is the case.',
    parameters: {
      runId: { type: 'string', description: 'Run id. Required.' },
      artifact: { type: 'string', description: 'Artifact file name, e.g. 03-implementation-summary.md. Required.' },
      reopen: { type: 'boolean', description: 'If true, reopen a locked artifact back to DRAFT (invalidates downstream receipts). Also withdraws a previous skip record.' },
      // ⚠ THE SKIP LIVES ON THIS TOOL BECAUSE SETTLEMENT IS THIS TOOL'S SUBJECT. A phase that does not
      // apply has to be recorded IN its artifact (the fold and the guard read that file), and the
      // model's own `write`/`edit` cannot do it: the phase-order guard binds writes to the ACTIVE
      // phase, and a phase being skipped is precisely not the active one — the agent would be refused
      // by our own rule while trying to follow our own advice. This is also the surface the refusal in
      // `foldRun` names, so the way out of a blocked phase is one call away from the message reporting
      // the block. The parameter's own rules (the value, the precondition, the effect) are stated on it.
      skip: { type: 'string', description: 'Why this phase does not apply to this run. Records the skip in the artifact itself - it keeps Status: SKIPPED, SkippedAt and SkipReason, so the phase reads as skipped rather than missing - and settles the phase, so the chain advances past it. The artifact must already exist; to undo a skip, lock the artifact again with reopen: true.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { runId?: string; artifact?: string; reopen?: boolean; skip?: string }, exec) {
      if (!args.runId || args.runId.trim() === '') {
        return { error: toolError('MISSING_RUN_ID') } as const
      }
      if (!args.artifact || args.artifact.trim() === '') {
        return { error: toolError('MISSING_ARTIFACT') } as const
      }
      try {
        // THE LEGITIMATE SKIP, DISPATCHED HERE rather than folded into `lockArtifact`: a skip is not a
        // lock (nothing is hashed into the artifact, nothing becomes LOCKED), and `lockArtifact`'s
        // four-argument contract is driven by existing specs. The two share one surface because they
        // are the two ways a phase stops being outstanding, and a caller reaching for either needs the
        // other one's refusal to be one word away.
        if (args.skip !== undefined) {
          const result = await recursive.skipArtifact(args.runId.trim(), args.artifact.trim(), args.skip, exec.agent as { session?: { header?: { cwd?: string } } } | null)
          return result as unknown as JsonValue
        }
        const result = await recursive.lockArtifact(args.runId.trim(), args.artifact.trim(), args.reopen === true, exec.agent as { session?: { header?: { cwd?: string } } } | null)
        return result as unknown as JsonValue
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const refusal = codeRuntimeRefusal(message)
        // FU-7 — THE GATE-BLOCK CALL POINT, and this is the moment it belongs to: a lock was REFUSED, so
        // the run is blocked and a person has to choose how to unblock it. Returning only the sentence
        // makes the caller parse prose to find the decision; the options are what turn it into a choice.
        //
        // ⚠ IT IS ATTACHED TO THE ORDERING REFUSAL SPECIFICALLY (`Prerequisite blockers:`), because that
        // is the one a human resolves. A missing run id or an already-locked artifact is a caller mistake
        // with a mechanical fix, and offering "reopen / abandon the run" for those would be noise.
        //
        // ⚠ AND THE PAYLOAD COMES FROM `buildGateBlockAsk`, NOT FROM A LITERAL HERE. The GUARD refuses
        // the same ordering violation pre-dispatch (it resolves the same blockers from the same run
        // tree) and attaches this same payload; one builder is what keeps the two refusals offering the
        // same options. This branch still fires whenever the guard ABSTAINS — most visibly when the call
        // names a run other than the active one, because the guard resolves the run from the filesystem.
        if (message.startsWith('Prerequisite blockers:')) {
          return {
            error: refusal,
            ask: buildGateBlockAsk(args.artifact ?? '', message),
          } as unknown as JsonValue
        }
        return { error: refusal } as const
      }
    },
  })
}
