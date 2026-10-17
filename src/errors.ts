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
  /**
   * THE PER-GATE ASK SWITCHES' PARSE-TIME REFUSAL, AND WHY IT CARRIES A REGISTRY CODE.
   *
   * `gates.<gate>.default` is the label `recursive_ask` writes INTO AN ARTIFACT when that gate's ask is
   * disabled, so a value that is not one of the gate's own labels would record a decision nobody offered —
   * and a later phase locking against it would read a transcription error as a fact. "Never silently fall
   * back" is the requirement: falling back to the nearest offered label would be the plugin inventing the
   * answer, and ignoring the field would leave `ask: false` with nothing to record. So the config is refused
   * before the plugin mounts.
   *
   * The detail names the exact field path, the offending value and the allowed set
   * (`gates.tddMode.default is "banana", which is not one of strict | pragmatic`), because those are the three
   * facts a person editing the settings form needs. The code is registered HERE rather than thrown as a bare
   * `Error` so the refusal carries the same stable, greppable handle as every other refusal this plugin makes.
   */
  BAD_GATE_DEFAULT: {
    code: 'RM1145',
    klass: 'input',
    problem: 'a gates entry names a default that is not one of the labels that same gate offers',
    next: 'fix gates.<gate>.default to one of that gate\'s own labels (tddMode: strict | pragmatic, qaSignoff: human | agent-operated | hybrid), or set gates.<gate>.ask: true and let a person choose',
  },
  /**
   * ⚠ A SWITCH THAT IS TYPE-VALID AND CAN NEVER SUCCEED, REFUSED WHERE THE CONFIG IS ACCEPTED.
   *
   * `gates.runStart.ask: false` parses, appears in the settings form, and then fails on first use: run-start is
   * the approval that ARMS the run, so the tool refuses it unconditionally and no `default` is permitted for it.
   * Discovered only at ask time, that would be a saved configuration whose first effect is a dead end. It has its
   * OWN code rather than reusing the contradiction's, because the contradiction's text names
   * `qa.humanReview`/`qaSignoff` — asserting a cause this refusal did not establish, which is the defect class
   * this project keeps removing.
   */
  RUN_START_ASK_REQUIRED: {
    code: 'RM1146',
    klass: 'input',
    problem: 'gates.runStart.ask is false, but the run-start gate is the approval that arms the run and cannot be disabled',
    next: 'fix the workspace config — remove gates.runStart.ask (or set it true) — then call recursive_ask with gate run-start so a person approves the run before it begins',
  },
  /**
   * THE WORKSPACE GATES FILE'S OWN REFUSAL, covering the three ways it can be unusable: not JSON, not
   * an object, or naming a field the schema does not declare. All three are the same class of failure
   * — the file cannot be interpreted — and all three must be LOUD: a malformed
   * `.recursive/config/recursive-gates.json` that silently fell back to the plugin Config would make
   * the settings the user can see in the workspace disagree with the settings the run obeys.
   *
   * The detail names the unknown key and lists the keys that ARE allowed, so the refusal is actionable
   * without opening this source. Type and label refusals use the codes that already exist (RM1145 for a
   * `default` outside its gate's labels, RM1146 for a disabled run-start ask); this entry is only for
   * "this file is not the shape".
   */
  GATES_CONFIG_INVALID: {
    code: 'RM1147',
    klass: 'input',
    problem: 'the workspace gates file cannot be read as the gates schema: it is malformed, or it names a field the schema does not declare',
    next: 'fix .recursive/config/recursive-gates.json (valid JSON, only qa.humanReview, gates.<runStart|tddMode|qaSignoff|gateBlock>.{ask,default}, and teammate.primitiveRoles) or delete it to fall back to the plugin configuration',
  },
  /**
   * ⚠ THIS SENTENCE USED TO BE FALSE, and the falseness is the point of the entry.
   *
   * It said relay "applies only to the run-start gate, which is the only gate that asks the user-questions
   * channel". The first clause is still true and the second is not: `recursive_ask` now puts EVERY gate's
   * question to the mounted channel (see `askGateDirectly` in `recursive_ask.tool.ts`) — the owner's report
   * was exactly that the three workflow gates asked nobody and merely wrote their question into the chat.
   * What is still run-start only is the RELAY: the fallback that records a person's explicit approval when
   * the channel cannot deliver the question. A workflow gate has no relay because its answer is a mode, not
   * consent to start a run, and refusing it keeps the result from claiming a fallback that never happened.
   */
  RELAY_ONLY_FOR_RUN_START: {
    code: 'RM1150',
    klass: 'input',
    problem: 'relay applies only to the run-start gate, because only starting a run has a relayed-approval fallback (every gate still asks the user-questions channel directly when one is mounted)',
    next: 'drop relay for this gate and let the mounted user-questions channel put the question to the person, or call recursive_ask with gate: run-start when the decision is whether to start the run',
  },
  MISSING_RUN_ID: {
    code: 'RM1101',
    klass: 'input',
    problem: 'runId is required',
    next: 'call recursive_status with no runId to see the latest run id in this workspace',
  },
  /**
   * A run id is the NAME of the run directory and is joined onto the run layer
   * as one path segment, so a path-shaped id is refused before any directory is
   * created. See `run-id.ts` for the rule and for why it is not the runtime that
   * learns to accept a path.
   */
  BAD_RUN_ID: {
    code: 'RM1107',
    klass: 'input',
    problem: 'runId is not a single directory name',
    next: 'pass the run directory name such as 03-something, then call recursive_init again',
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

  /**
   * ⚠ THE `qa.humanReview` CONTRADICTION, AS A CODE RATHER THAN A THROWN SENTENCE.
   *
   * `qa.humanReview: true` exists for exactly one purpose: a PERSON signs phase-5 manual QA off, which the
   * linter enforces by failing an `agent-operated` mode (see `lintPhaseSpecificRules`). `gates.qaSignoff.ask:
   * false` removes the only question that can obtain that person's label. A config holding both is not a
   * preference to be resolved — honouring either one silently would be the plugin choosing which of the
   * workspace's two instructions to ignore, and the run would then carry a QA phase whose sign-off nobody can
   * point at. So the mount fails closed, and the refusal names BOTH fields and both ways out.
   *
   * This is a `value` class error: the configuration's values are individually valid and jointly
   * contradictory, which is a different failure from a value outside its set (RM1xxx) or a runtime refusal.
   */
  QA_HUMAN_REVIEW_CONTRADICTION: {
    code: 'RM2203',
    klass: 'value',
    problem: 'the config is contradictory: qa.humanReview is true while gates.qaSignoff.ask is false',
    next: 'set gates.qaSignoff.ask: true so the sign-off question qa.humanReview depends on is actually put to a person, or set qa.humanReview: false and let an agent record the QA mode — mount the plugin with one of the two, never both',
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
  /**
   * THE ORDERING DEFECT, AS A CODE. `recursive_ask gate=run-start` used to raise "start this run or hold?"
   * over a Phase 0 document that was still the scaffold `recursive_init` wrote — placeholder requirements,
   * unchecked lists, `FAIL` gates — and nothing put that document in front of the person either. The owner:
   * *"i was never shown the spec before that so how could i approve if i havent seen it"*. Approving an
   * unfilled template is not a decision about a spec, so the gate refuses to be raised until there is one.
   */
  RUN_START_SPEC_UNFILLED: {
    code: 'RM4404',
    klass: 'state',
    problem: 'the Phase 0 requirements document is still the unfilled template, so there is no run spec for a person to approve',
    next: 'fill the requirements document in (define the requirement ids and their acceptance criteria, and complete the TODO list) and then call recursive_ask with gate: run-start again',
  },

  /* 5xxx — the runtime refused an operation it understands. */

  RUN_START_NO_CHANNEL: {
    code: 'RM5502',
    klass: 'runtime',
    problem: 'the run-start gate needs an answer, and this composition mounts no user-questions channel to ask one directly',
    next: 'call recursive_ask with gate: run-start and no answer to surface the question, then retry with answer: ' + '"Start run"',
  },
  /**
   * ⚠ RM5503 USED TO LIE. Its text asserted "so no person was asked" for EVERY cause, because the caller
   * that produced it had already thrown the cause away — and a live session showed the cost: the gate
   * failed 22.9 s into the call with a reason nobody could see, and its `Next:` clause prescribed the very
   * call that had just failed, so no route to start a run remained. The problem statement now claims only
   * what the gate knows (no decision came back), and the cause travels in the `detail` the caller
   * supplies. `RUN_START_ANSWER_UNUSABLE` carries the one case this entry must NOT cover: a person was
   * reached and their answer was not an approval.
   */
  RUN_START_UNANSWERED: {
    code: 'RM5503',
    klass: 'runtime',
    problem: 'the run-start question reached no decision: the mounted user-questions channel failed before a person answered it',
    next: 'read the cause named in the detail, fix it and call recursive_ask again, or - when this composition cannot deliver the question at all - call recursive_ask with answer: ' + '"Start run"' + ' and relay=true to record the person\'s explicit approval as a relayed one',
  },
  RUN_START_ANSWER_UNUSABLE: {
    code: 'RM5504',
    klass: 'runtime',
    problem: 'a person was asked to start this run and their answer was not one of the labels the run-start gate offered',
    next: 'call recursive_ask again and have the person choose exactly "Start run" or "Hold"; a skipped or custom answer is not an approval, and no relayed answer can replace a decision the person made',
  },
  /**
   * THE WORKFLOW GATES' HALF OF RM5504 — and the code that did not exist, which is why the live run's
   * `qa-signoff` gate could ask three times and record an `agent-operated` mode the person never chose.
   *
   * A person WAS reached (the channel resolved) and their answer is not a label the gate offered: a skip, a
   * custom value, several labels at once. That is a decision this gate cannot record, so the refusal quotes
   * the detail and NOTHING is written. The marker is not written from the caller's argument either — the
   * whole point is that the person's non-answer cannot be replaced by the model's preferred one.
   */
  GATE_ANSWER_UNUSABLE: {
    code: 'RM5505',
    klass: 'runtime',
    problem: 'a person was shown this human gate and their answer was not one of the labels the gate offered',
    next: 'call recursive_ask again and have the person choose exactly one of the gate\'s own labels; nothing is recorded until they do, and the question stays unanswered in the artifact',
  },
  /**
   * THE OTHER HALF: the question was PUT to a mounted channel and reached no decision — the channel threw,
   * the card was dismissed, the turn was cancelled, or a deadline ended. There is no relay for a workflow
   * gate (see RM1150), so the only honest outcome is a refusal that NAMES the cause; recording the caller's
   * answer here is how a gate records a decision the person never made.
   */
  GATE_QUESTION_UNANSWERED: {
    code: 'RM5506',
    klass: 'runtime',
    problem: 'the human-gate question reached no decision: the mounted user-questions channel failed or was settled from outside before a person answered it',
    next: 'read the cause named in the detail, fix the channel and call recursive_ask again with the same gate; an unanswered gate records nothing, so nothing has to be undone',
  },
  /**
   * ⚠ A GATE ASK THAT CANNOT HONESTLY PROCEED WITH THE PERSON SILENTED.
   *
   * Three configurations reach this: the `run-start` ask disabled (it is the approval that arms the run, so
   * silencing it would start a run nobody approved), a gate with no configured default (`gate-block`, where
   * fix/reopen/abandon are the person's call and inventing one would have the plugin abandon a phase on
   * their behalf), and `qa.humanReview: true` beside `gates.qaSignoff.ask: false` (refused at mount, whose
   * message is its own).
   */
  GATE_ASK_DISABLED: {
    code: 'RM5507',
    klass: 'runtime',
    problem: 'this human gate is configured with its ask disabled and has no decision it can honestly record in the person\'s place',
    next: 'call recursive_ask with an explicit answer for gate-block, or set gates.<gate>.ask: true so the question is put to the person; the run-start ask cannot be disabled at all; nothing has been written',
  },
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
