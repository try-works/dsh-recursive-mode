/**
 * T2 — fan the audit out through the native workflow engine's contract.
 *
 * WHY. A phase-3.5 audit over several reviewers is a natural fan-out, and the plugin reimplements
 * that loop by hand. The engine already owns the shape: `phase(title)` to group work, `agent(prompt,
 * opts)` to run one child, and `parallel(thunks)` to fan out and await all of them. Adopting it means
 * one orchestration model instead of two that drift.
 *
 * ⚠ THE HOOK SHAPE IS A STRUCTURAL SEAM, not an import, because the engine runs against a live host
 * context (the item calls it integration-grade). Modelling the three hooks this adapter uses keeps
 * the CONTRACT testable without a host — and the contract is where the risk lives, not the plumbing.
 *
 * ⚠⚠ THE PROPERTY THIS ITEM'S OWN RESCOPE NAMED, and the reason the mapping is pure: **no
 * cross-item null-dropping.** The engine's `agent()` and `parallel()` resolve `null` for a child
 * that FAILED, and the obvious implementation — `results.filter(Boolean)` — silently turns a
 * failed reviewer into a fan-out that simply looks smaller. An audit that dropped its dissenting
 * reviewer would report a clean pass, which is the worst outcome this plugin can produce. So the
 * result carries an entry for EVERY planned item, with `ok: false` where a child produced nothing,
 * and `describeAuditFanOut` says how many failed.
 */

/** One reviewer's assignment inside the fan-out. */
export interface AuditFanOutItem {
  /** Stable label: what the board and the engine's progress show. */
  label: string
  /** The reviewer role, for traceability back to the router. */
  role: string
  prompt: string
}

/** One phase of the fan-out: a titled group of items run in parallel. */
export interface AuditFanOutPhase {
  title: string
  items: AuditFanOutItem[]
}

export interface AuditFanOutPlan {
  runId: string
  phases: AuditFanOutPhase[]
}

/** One item's outcome, PRESENT whether or not the child produced anything. */
export interface AuditFanOutEntry {
  label: string
  role: string
  /** False when the child failed or returned nothing — never inferred from a missing entry. */
  ok: boolean
  value?: unknown
  /** Why it failed, when it did. */
  reason?: string
}

export interface AuditFanOutResult {
  entries: AuditFanOutEntry[]
  /** How many planned items produced nothing. Stated, so a partial audit cannot read as complete. */
  failed: number
}

/**
 * The three hooks this adapter uses.
 *
 * `agent` and `parallel` resolve `null` rather than rejecting when a child fails — that is the
 * engine's documented behaviour and the reason this module handles null explicitly instead of
 * treating a resolved promise as success.
 */
export interface WorkflowHooksLike {
  phase(title: string): void
  agent(prompt: string, options?: { label?: string; phase?: string }): Promise<unknown>
  parallel(thunks: ReadonlyArray<() => Promise<unknown>>): Promise<unknown[]>
  log?(message: string): void
}

/** The reviewers a plan is built from — the plugin's own audit inputs, not an engine concept. */
export interface AuditReviewerSpec {
  role: string
  /** Extra instructions for this reviewer; the plan adds the contract around it. */
  focus?: string
}

export interface AuditPlanInput {
  runId: string
  artifact: string
  phase: string
  reviewers: readonly AuditReviewerSpec[]
  /** Questions every reviewer must answer, so the plan carries them rather than each caller. */
  auditQuestions?: readonly string[]
}

/**
 * Build the fan-out plan. PURE: same inputs, same plan — which is what makes the orchestration
 * testable without a host and comparable between runs.
 *
 * One phase per ROLE, with one item per reviewer of that role, so the engine's progress reads as
 * "audit phase X, reviewer Y" rather than a flat list of anonymous children.
 */
export function buildAuditFanOutPlan(input: AuditPlanInput): AuditFanOutPlan {
  const phases: AuditFanOutPhase[] = []
  for (const reviewer of input.reviewers) {
    const role = reviewer.role.trim()
    if (role === '') continue
    const title = input.phase + ' audit: ' + role
    let phase = phases.find((candidate) => candidate.title === title)
    if (phase === undefined) {
      phase = { title, items: [] }
      phases.push(phase)
    }
    phase.items.push({
      label: input.runId + '/' + role + '/' + (phase.items.length + 1),
      role,
      prompt: [
        'Review ' + input.artifact + ' as the ' + role + '.',
        ...(reviewer.focus === undefined || reviewer.focus.trim() === '' ? [] : [reviewer.focus.trim()]),
        ...(input.auditQuestions === undefined || input.auditQuestions.length === 0
          ? []
          : ['Answer explicitly: ' + input.auditQuestions.join(' | ')]),
      ].join('\n'),
    })
  }
  return { runId: input.runId, phases }
}

/**
 * Run a plan through the engine's hooks.
 *
 * ⚠ EVERY planned item yields an entry, whether or not its child produced a value. A missing entry
 * and a failed child are different facts, and conflating them is how an audit reports a pass it did
 * not earn: this returns `ok: false` with a reason instead of dropping the row.
 */
export async function orchestrateAudit(hooks: WorkflowHooksLike, plan: AuditFanOutPlan): Promise<AuditFanOutResult> {
  const entries: AuditFanOutEntry[] = []
  for (const phase of plan.phases) {
    hooks.phase(phase.title)
    const values = await hooks.parallel(phase.items.map((item) => () =>
      hooks.agent(item.prompt, { label: item.label, phase: phase.title })))
    for (const [index, item] of phase.items.entries()) {
      const value = values[index]
      if (value === null || value === undefined) {
        entries.push({ label: item.label, role: item.role, ok: false, reason: 'the reviewer child produced no result' })
        continue
      }
      entries.push({ label: item.label, role: item.role, ok: true, value })
    }
  }
  const failed = entries.filter((entry) => !entry.ok).length
  return { entries, failed }
}

/**
 * A board-facing summary that STATES the failures.
 *
 * The count is explicit because an audit with three of five reviewers failed is not a smaller
 * audit — it is an incomplete one, and a summary that only reported the successes would be the
 * silent-drop defect wearing a friendlier face.
 */
export function describeAuditFanOut(result: AuditFanOutResult): string {
  const total = result.entries.length
  if (total === 0) return 'audit fan-out planned no reviewers'
  if (result.failed === 0) return 'audit fan-out: ' + total + ' reviewer(s), all produced a result'
  const names = result.entries.filter((entry) => !entry.ok).map((entry) => entry.label)
  return 'audit fan-out: ' + total + ' reviewer(s), ' + result.failed + ' FAILED ('
    + names.join(', ') + ') — the audit is INCOMPLETE, not smaller'
}

/**
 * T2 — the canonical script the ENGINE runs, and the request that starts it.
 *
 * ⚠⚠ MEASURED, AND IT CHANGES WHERE THE HOOKS LIVE. The engine is a service —
 * `WorkflowEngine.start(request): WorkflowRun`, *"Parse and execute a workflow script"*, with the
 * request carrying **the script, its `args`, the parent agent and an optional cancel signal** — and
 * its `workflow/*` lifecycle events are documented as **"observe-only … never expose run control"**.
 * So `phase()` / `agent()` / `parallel()` are hooks available to a SCRIPT, not functions the plugin
 * may call directly: the plugin's job is to hand the engine a script plus the plan, and to read the
 * frames afterwards. {@link orchestrateAudit} is therefore the shape a script (or a test double)
 * drives, and this is the shape the plugin submits.
 *
 * ⚠ THE PLUGIN DOES NOT SHIP A GENERATED SCRIPT. A script built by string concatenation from a plan
 * would put reviewer prompts into a program's source, where a stray quote becomes a syntax error in
 * the orchestration layer — the worst place for one. The script is a CONSTANT that reads the plan
 * from `args`, which also keeps the orchestration auditable: one script, reviewed once.
 */
export const AUDIT_FANOUT_SCRIPT = [
  'const plan = args.plan',
  'for (const phase of plan.phases) {',
  '  phase(phase.title)',
  '  await parallel(phase.items.map((item) => () => agent(item.prompt, { label: item.label, phase: phase.title })))',
  '}',
  'return args.plan.runId',
].join('\n')

/** What the engine needs to start an audit fan-out. Mirrors `WorkflowStartRequest` structurally. */
export interface AuditWorkflowRequest {
  script: string
  args: { plan: AuditFanOutPlan }
  parent: unknown
  signal?: unknown
}

/**
 * Build the engine request for a plan.
 *
 * `parent` is the exact live Agent, as the engine requires for child authority; it passes through
 * untouched rather than reshaped, because the engine authenticates by object identity.
 */
export function auditWorkflowRequest(
  plan: AuditFanOutPlan,
  options: { parent: unknown; signal?: unknown },
): AuditWorkflowRequest {
  return {
    script: AUDIT_FANOUT_SCRIPT,
    args: { plan },
    parent: options.parent,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
}
