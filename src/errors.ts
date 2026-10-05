/**
 * T24 — stable, greppable, self-sufficient tool errors.
 *
 * WHY PROSE AND NOT A JSON ENVELOPE. A structured error envelope reaches the
 * model double-escaped and is materially harder to read than a sentence, and a
 * model that cannot read a refusal cannot correct it. So every error here
 * renders as ONE sentence:
 *
 *     <code> <class>: <problem>[ - <detail>]. Next: <the exact call that resolves it>.
 *
 * The leading `<code> <class>` pair is STABLE and greppable, so a consumer that
 * is not an LLM — a test, a board badge, a log grep — can branch on it without
 * parsing prose. The `Next:` clause names a real tool call, because "invalid
 * input" without a route is a refusal the caller can only guess at.
 *
 * Codes are `RM<group><serial>` where the THIRD character is the class group:
 * 1 input, 2 value, 3 workspace, 4 state, 5 runtime, 6 capability. Because the
 * group is embedded in the code, a log grep for `RM1` finds every input-shaped
 * failure without knowing this registry — and `tests/errors.spec.ts` asserts the
 * third character matches the entry's own class, so the grouping cannot drift.
 */

/** What kind of thing went wrong. Stable vocabulary — consumers branch on it. */
export type ToolErrorClass = 'input' | 'value' | 'workspace' | 'state' | 'runtime' | 'capability'

export interface ToolErrorSpec {
  /** Stable `RM<group><serial>` code. Never reuse one for a different problem. */
  code: string
  klass: ToolErrorClass
  /** The fixed problem statement, no trailing punctuation. */
  problem: string
  /** What resolves it, naming the exact call. No trailing punctuation. */
  next: string
}

/**
 * The registry. Every `recursive_*` tool error must come from here: a tool that
 * invents its own sentence is a tool whose refusals cannot be grepped, and
 * `tests/errors.spec.ts` asserts the codes are unique and well formed so the
 * registry cannot rot into duplicates.
 */
export const TOOL_ERRORS = {
  /* 1xxx — input the caller must supply. */
  BAD_PROBE_ARGUMENTS: {
    code: 'RM1144',
    klass: 'input',
    problem: 'probeArguments is not a JSON object',
    next: 'pass a JSON object such as {"artifact":"01-as-is.md"} so the preview can evaluate the guard against real arguments',
  },
  BAD_ASK_GATE: {
    code: 'RM1141',
    klass: 'input',
    problem: 'the requested human gate is not one of tdd-mode, qa-signoff or gate-block',
    next: 'call recursive_ask with gate: tdd-mode | qa-signoff | gate-block',
  },
  BAD_ASK_ANSWER: {
    code: 'RM1142',
    klass: 'input',
    problem: 'the answer is not one of the labels the gate offered',
    next: 'use one of the labels the ask returned; an unoffered answer reads as a decision while being a transcription error',
  },
  MISSING_ASK_ARTIFACT: {
    code: 'RM1143',
    klass: 'input',
    problem: 'this gate has no default artifact, so one must be named',
    next: 'pass artifact: <file> so the answer has somewhere durable to land',
  },
  MISSING_RUN_ID: {
    code: 'RM1101',
    klass: 'input',
    problem: 'runId is required',
    next: 'call recursive_status with no runId to see the latest run id in this workspace',
  },
  MISSING_ARTIFACT: {
    code: 'RM1102',
    klass: 'input',
    problem: 'artifact is required',
    next: 'call recursive_phase to see which artifact the run is currently on',
  },
  MISSING_PHASE_AND_RUN: {
    code: 'RM1103',
    klass: 'input',
    problem: 'phase and runId are required',
    next: 'call recursive_status to read the run id, then pass phase as 04|05|06|07|08',
  },
  MISSING_SCRATCH_ARGS: {
    code: 'RM1104',
    klass: 'input',
    problem: 'action, runId and target are all required',
    next: 'call recursive_scratch with action=read|write|append, a runId, and target=md|ts',
  },
  MISSING_CREATE_RUN_ID: {
    code: 'RM1105',
    klass: 'input',
    problem: 'runId is required for create',
    next: 'call recursive_init with a runId to scaffold the run first',
  },
  MISSING_PROMOTE_BRANCHES: {
    code: 'RM1106',
    klass: 'input',
    problem: 'fromBranch and toBranch are required for promote',
    next: 'call recursive_worktree with action=promote plus fromBranch and toBranch',
  },

  /* 2xxx — a supplied value is outside its allowed set. */
  BAD_TARGET: {
    code: 'RM2201',
    klass: 'value',
    problem: 'target must be md or ts',
    next: 'pass target=md for /.recursive/run/<id>/scratch/scratch.md or target=ts for scratch.ts',
  },
  BAD_ACTION: {
    code: 'RM2202',
    klass: 'value',
    problem: 'action must be create | promote | status',
    next: 'pass action=create, action=promote or action=status',
  },

  /* 3xxx — the session is not attached to a control plane. */
  NO_WORKSPACE: {
    code: 'RM3301',
    klass: 'workspace',
    problem: 'this session is not attached to a registered workspace',
    next: 'open the session inside a workspace directory; the control-plane root is resolved from the session cwd',
  },

  /* 4xxx — the workspace exists but the state the call needs does not. */
  NO_RUN: {
    code: 'RM4401',
    klass: 'state',
    problem: 'no recursive run exists in this workspace',
    next: 'call recursive_init with a runId to scaffold the first run',
  },
  NO_PHASE: {
    code: 'RM4402',
    klass: 'state',
    problem: 'no current recursive phase could be determined',
    next: 'call recursive_init to scaffold the run, or recursive_status to inspect why every phase is locked',
  },

  PENDING_WORK: {
    code: 'RM4403',
    klass: 'state',
    problem: 'the run has unresolved delegated work, so this phase cannot lock yet',
    next: 'call recursive_status to see the pending delegation, have the child write its reply.md, then lock again',
  },

  /* 5xxx — the runtime refused an operation it understands. */

  RUNTIME_REFUSED: {
    code: 'RM5501',
    klass: 'runtime',
    problem: 'the recursive runtime refused the operation',
    next: 'fix the cause named in the detail and retry; a gate refusal names the artifact and its status',
  },

  /* 6xxx — an optional host service is absent (the plugin degrades, never crashes). */
  TEAM_SERVICE_UNAVAILABLE: {
    code: 'RM6601',
    klass: 'capability',
    problem: 'the agent-teams service is not available in this composition',
    next: 'use recursive_lock and recursive_lint directly, or mount a composition that provides ctx.agentTeams',
  },
} as const satisfies Record<string, ToolErrorSpec>

export type ToolErrorName = keyof typeof TOOL_ERRORS

/**
 * Render one registry entry as the single sentence a tool returns.
 * `detail` carries the run-specific part (a run id, an artifact, a gate).
 */
export function toolError(name: ToolErrorName, detail?: string): string {
  const spec: ToolErrorSpec = TOOL_ERRORS[name]
  const head = spec.code + ' ' + spec.klass + ': ' + spec.problem
  const withDetail = detail && detail.trim() !== '' ? head + ' - ' + detail.trim() : head
  return withDetail + '. Next: ' + spec.next + '.'
}

/** True when a string already carries a registry code — used to avoid double-wrapping. */
export function hasToolErrorCode(message: string): boolean {
  return /^RM\d{4}\b/.test(message.trim())
}

/**
 * Give a thrown runtime message a stable code WITHOUT nesting one that is
 * already there.
 *
 * A refusal the runtime already expressed in this registry's vocabulary (for
 * example `RM4403` pending work) is passed through untouched: wrapping it would
 * bury the real code inside `RM5501`'s detail and make the greppable handle
 * useless, which is the whole reason the registry exists. A bare thrown message
 * has no code to branch on, so it is wrapped and its sentence survives as the
 * detail.
 */
export function codeRuntimeRefusal(message: string): string {
  return hasToolErrorCode(message) ? message : toolError('RUNTIME_REFUSED', message)
}
