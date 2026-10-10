import { defineTool } from '@deepseek-ai/dsh-tools'
import { toolError } from './errors.ts'
import { RUN_ID_EXAMPLES, RUN_ID_RULE, runIdProblem } from './run-id.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { RecursiveRuntime } from './runtime.ts'

/**
 * recursive_phase (refined LIVE BUG 6): the canonical on-demand home of the
 * current phase's lint rules + instructions. Reads the same structured source
 * (runtime.phaseRules -> phaseRulesFor) as the once-per-phase pre-step
 * reminder, so the agent can re-ask for the rules without re-injecting them on
 * every step. Returns { error } when no active phase is found.
 *
 * ⚠ AND IT IS WHERE PRIOR-RUN MEMORY ARRIVES — say so in the DESCRIPTION, which is the only surface a
 * model reads before choosing a tool. The description used to promise rules and instructions only, so
 * nothing in the tool list gave a caller a reason to expect memory here (the owner's own report: *"the
 * memory must be read before writing requirements.md"*, and *"recursive_phase should also read memories"*).
 * The read WAS already happening — `phaseRules` calls `selectMemory` and returns the section plus its
 * reason — so the defect was that the contract was SILENT about it, not that the mechanism was absent.
 * Every sentence below is a claim about what this call actually returns: the payload's `memory` and
 * `memoryReason` fields come from `selectMemory`, `runId`/`phase` from the resolved run, `requiredSections`
 * / `audited` / `tdd` / `qa` / `memoryWrite` from `phaseRulesFor`, and `ask` from `pendingGateFor`. A
 * description that advertised a field the payload does not carry would be worse than the silence it fixes.
 *
 * ⚠ AND AN EMPTY PLANE IS SAID TO BE NORMAL, because that is the honest reading and the one a model needs:
 * `selectMemory` answers *"the memory plane is empty, so nothing is injected"*, which is a RESULT — the
 * plane was read and had nothing to say — not a failure of the call and not a reason to retry it. Without
 * that sentence an agent seeing an empty section could reasonably conclude the read had not happened.
 *
 * A RUN ID IS A NAME, NOT A PATH HERE TOO, INCLUDING WHEN IT IS OMITTED. Omitted and path-shaped are
 * different cases and must stay different: omitted means "the latest run by mtime", which `resolveRunDir`
 * answers by DISCOVERY rather than by joining anything, and that case is untouched below. A path-shaped id,
 * by contrast, is joined by `phaseRules` -> `resolveRunDir` and then read, and `recordInjection` WRITES
 * `memory-injections.json` under whatever directory it resolved to — with no scoping check at all on this
 * path. So the gate fires only on an id that was actually supplied, and `run-id.ts` owns the rule. The
 * refusal is `recursive_init`'s, `BAD_RUN_ID` (RM1107), composed identically.
 */
export function createRecursivePhaseTool(recursive: RecursiveRuntime) {
  return defineTool({
    name: 'recursive_phase',
    description: 'Enter the current recursive-mode phase: returns that phase\'s lint rules and instructions'
      + ' (required sections, gates, TDD/QA notes) AND the prior-run memory selected for this run and phase.'
      + ' `memory` carries the shards to use, each titled so it can be cited, and `memoryReason` says why'
      + ' nothing was injected when it is empty — an EMPTY memory plane is a normal result of a read, never'
      + ' a failure, so do not retry because of it. Nothing from the memory plane reaches a run before this'
      + ' call, so MAKE IT ONCE WHEN ENTERING A PHASE and before authoring that phase\'s artifact'
      + ' (`00-requirements.md` included: a write to it is refused until a read is recorded for the run).'
      + ' The same rules are also auto-injected once per phase transition.',
    parameters: {
      runId: { type: 'string', description: 'Optional run id — the NAME of the run directory under .recursive/run/ (e.g. 03-something), never a path: ' + RUN_ID_RULE + '. Omit it for the latest run by mtime.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { runId?: string }, exec) {
      // ABSENT IS NOT INVALID. No runId at all keeps its documented meaning — the latest run by mtime,
      // resolved by discovery in `resolveRunDir` — so the gate below runs only when a name was supplied,
      // while an EMPTY one is refused rather than silently read as "latest": a caller that passed `""` did
      // not ask for discovery, and `resolveRunDir` would otherwise interpret their mistyped id as one.
      const runId = args.runId?.trim()
      if (runId !== undefined) {
        const problem = runId === '' ? 'runId is empty' : runIdProblem(runId)
        if (problem !== null) {
          return { error: toolError('BAD_RUN_ID', problem + ' - run ids allow ' + RUN_ID_RULE + ' - e.g. ' + RUN_ID_EXAMPLES) } as const
        }
      }
      const result = await recursive.phaseRules(runId, exec.agent as { session?: { header?: { cwd?: string } } } | null)
      if (!result) return { error: toolError('NO_PHASE') } as const
      return result as unknown as JsonValue
    },
  })
}
