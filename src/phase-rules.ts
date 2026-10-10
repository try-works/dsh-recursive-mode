/**
 * Phase rules (R5): canonical parity port of lint-recursive-run.py's
 * get_artifact_required_sections + workflow/audit constants. Single source of
 * truth for per-phase required section headings and audit extras; consumed by
 * initRun templates, renderRecursivePolicy, and the pre-step lint-rules
 * injection. Values are byte-identical to the canonical linter (recursive-
 * mode-audit-v2).
 */
import { join, resolve, sep } from 'node:path'
import {
  tddEvidenceVerdict as tddEvidenceMatch,
  type ToolPolicy, type ToolPolicyRule, type ToolPolicyContext, type Verdict,
} from './policy-globs.ts'

export const CURRENT_WORKFLOW_PROFILE = 'recursive-mode-audit-v2'
export const STRICT_WORKFLOW_PROFILE = 'recursive-mode-audit-v1'
export const COMPAT_WORKFLOW_PROFILE = 'memory-phase8'
export const STRICT_WORKFLOW_PROFILES = new Set([CURRENT_WORKFLOW_PROFILE, STRICT_WORKFLOW_PROFILE])

export const LATE_PHASE_ARTIFACTS = ['06-decisions-update.md', '07-state-update.md', '08-memory-impact.md']

export const AUDITED_PHASE_FILES = new Set([
  '01-as-is.md',
  '01.5-root-cause.md',
  '02-to-be-plan.md',
  '03-implementation-summary.md',
  '03.5-code-review.md',
  '04-test-summary.md',
  '06-decisions-update.md',
  '07-state-update.md',
  '08-memory-impact.md',
])

export const PRIOR_RECURSIVE_EVIDENCE_FILES = new Set([
  '01-as-is.md',
  '02-to-be-plan.md',
  '04-test-summary.md',
  '07-state-update.md',
  '08-memory-impact.md',
])

export const DIFF_AUDITED_FILES = new Set([
  '02-to-be-plan.md',
  '03-implementation-summary.md',
  '03.5-code-review.md',
  '04-test-summary.md',
  '06-decisions-update.md',
  '07-state-update.md',
  '08-memory-impact.md',
])

export const TRACEABILITY_REQUIRED_FILES = new Set([
  '01-as-is.md',
  '01.5-root-cause.md',
  '02-to-be-plan.md',
  '03-implementation-summary.md',
  '03.5-code-review.md',
  '04-test-summary.md',
  '05-manual-qa.md',
  '06-decisions-update.md',
  '07-state-update.md',
  '08-memory-impact.md',
])

export const AUDIT_REQUIRED_HEADINGS = [
  'Audit Context',
  'Effective Inputs Re-read',
  'Earlier Phase Reconciliation',
  'Subagent Contribution Verification',
  'Worktree Diff Audit',
  'Gaps Found',
  'Repair Work Performed',
  'Requirement Completion Status',
  'Audit Verdict',
]

export const DIFF_BASIS_FIELDS = [
  'Baseline type',
  'Baseline reference',
  'Comparison reference',
  'Normalized baseline',
  'Normalized comparison',
  'Normalized diff command',
]

const SECTION_MAP: Record<string, string[]> = {
  '00-worktree.md': [
    'TODO',
    'Directory Selection',
    'Safety Verification',
    'Worktree Creation',
    'Main Branch Protection',
    'Project Setup',
    'Test Baseline Verification',
    'Worktree Context',
    'Diff Basis For Later Audits',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '00-requirements.md': [
    'TODO',
    'Requirements',
    'Out of Scope',
    'Constraints',
    'Coverage Gate',
    'Approval Gate',
  ],
  '01-as-is.md': [
    'TODO',
    'Reproduction Steps (Novice-Runnable)',
    'Current Behavior by Requirement',
    'Source Requirement Inventory',
    'Relevant Code Pointers',
    'Known Unknowns',
    'Evidence',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '01.5-root-cause.md': [
    'TODO',
    'Error Analysis',
    'Reproduction Verification',
    'Recent Changes Analysis',
    'Evidence Gathering (Multi-Layer if applicable)',
    'Data Flow Trace',
    'Pattern Analysis',
    'Hypothesis Testing',
    'Root Cause Summary',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '02-to-be-plan.md': [
    'TODO',
    'Planned Changes by File',
    'Requirement Mapping',
    'Implementation Steps',
    'Testing Strategy',
    'Playwright Plan (if applicable)',
    'Manual QA Scenarios',
    'Idempotence and Recovery',
    'Implementation Sub-phases',
    'Plan Drift Check',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '03-implementation-summary.md': [
    'TODO',
    'Changes Applied',
    'TDD Compliance Log',
    'Plan Deviations',
    'Implementation Evidence',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '03.5-code-review.md': [
    'TODO',
    'Review Scope',
    'Plan Alignment Assessment',
    'Code Quality Assessment',
    'Issues Found',
    'Verdict',
    'Review Metadata',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '04-test-summary.md': [
    'TODO',
    'Pre-Test Implementation Audit',
    'Environment',
    'Execution Mode',
    'Commands Executed (Exact)',
    'Results Summary',
    'Evidence and Artifacts',
    'Failures and Diagnostics (if any)',
    'Flake/Rerun Notes',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '05-manual-qa.md': [
    'TODO',
    'QA Execution Record',
    'QA Scenarios and Results',
    'Evidence and Artifacts',
    'User Sign-Off',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '06-decisions-update.md': [
    'TODO',
    'Decisions Changes Applied',
    'Rationale',
    'Resulting Decision Entry',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '07-state-update.md': [
    'TODO',
    'State Changes Applied',
    'Rationale',
    'Resulting State Summary',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
  '08-memory-impact.md': [
    'TODO',
    'Diff Basis',
    'Changed Paths Review',
    'Affected Memory Docs',
    'Run-Local Skill Usage Capture',
    'Skill Memory Promotion Review',
    'Uncovered Paths',
    'Router and Parent Refresh',
    'Final Status Summary',
    'Traceability',
    'Coverage Gate',
    'Approval Gate',
  ],
}

/* -------------------------------------------------------------------------- */
/* T40 — THE PHASE-8 MEMORY WRITE, AS A RULE                                  */
/* -------------------------------------------------------------------------- */

/**
 * T40 — `.recursive/memory/`, the plane THIS plugin writes, and the phase-8 step that was prose.
 *
 * ⚠ WHY THIS EXISTS, MEASURED. Three completed runs in a live workspace left `.recursive/memory/`
 * exactly as `bootstrap.ts` scaffolded it: `MEMORY.md` and the skill docs were still the
 * bootstrap-created placeholders, while run 03's `08-memory-impact.md` had its
 * "Write the durable ones to memory, with provenance" box TICKED and its `Inputs` line naming
 * ANOTHER plugin's store (`memory_search` / `memory_status` is dsh-memory, not this plugin). So the
 * phase declared its memory step done against a system this plugin does not own, and the plugin's
 * own learning never activated — the owner's words: *"the agent should write to .recursive/memory/
 * in phase 8, that's a hard requirement that needs to be enforced"*.
 *
 * ⚠ THE FIX IS A FACT, NOT A STRONGER SENTENCE. A prose step is ticked by the agent that would have
 * had to do it, which is exactly what happened. What follows is the same requirement in the form the
 * workflow can CHECK: a path under the plane, declared in the artifact, whose own text on disk
 * carries this run's provenance (`Source-Runs`). "The run wrote its durable memory" then stops being
 * a claim about the run's intentions and becomes a claim about files.
 *
 * ⚠ WHY IT IS NOT IN `SECTION_MAP`, deliberately: that map is byte-parity with the canonical
 * linter's `get_artifact_required_sections` (`tests/phase-rules.parity.spec.ts` pins all twelve
 * lists), and a section added there would be a parity break dressed up as a feature. The requirement
 * rides on a section the canonical template ALREADY scaffolds — `## Affected Memory Docs` — plus a
 * field the plane's own linter already requires, so the artifact shape stays canonical.
 */
export const PHASE8_MEMORY_ARTIFACT = '08-memory-impact.md'

/** The plane, repo-relative. The trailing slash is what every guard here tests for. */
export const MEMORY_PLANE_PREFIX = '.recursive/memory/'

/** The canonical section the declaration goes in — present in every scaffolded phase-8 artifact. */
export const PHASE8_MEMORY_SECTION = 'Affected Memory Docs'

/**
 * Where a durable doc may be filed, and the `Type` the memory-plane linter requires for it.
 *
 * ⚠ EVERY `dir` IS THE REAL PLANE, `.recursive/memory/…`, AND NOT A `memory/…` RELATIVE FORM. Measured:
 * `bootstrap.ts` scaffolds the plane under `.recursive/`, `ts-lint.ts` lints it there, and the phase-8
 * artifact cites it there — while the training trigger's own write seam joins its `memory/…` paths onto
 * the workspace root, i.e. `<root>/memory/`, a directory that exists in no real workspace (the reader
 * side of that defect was fixed in `memory.ts`; the writer side is `runtime.ts`'s seam and is reported,
 * not edited). This table names the location a WRITE must land in, so it names the plane.
 *
 * ⚠ `skill` SHARES `pattern`'s Type ON PURPOSE: `/.recursive/memory/skills/patterns/` is where a
 * promoted skill lesson ships (`bootstrap.ts` scaffolds three docs there), and the linter's allowed
 * Types are `index|domain|pattern|incident|episode` — there is no `skill` Type to declare.
 */
export const MEMORY_DOC_LOCATIONS = {
  domain: { dir: '.recursive/memory/domains', type: 'domain' },
  pattern: { dir: '.recursive/memory/patterns', type: 'pattern' },
  incident: { dir: '.recursive/memory/incidents', type: 'incident' },
  episode: { dir: '.recursive/memory/episodes', type: 'episode' },
  skill: { dir: '.recursive/memory/skills/patterns', type: 'pattern' },
} as const

export type MemoryDocKind = keyof typeof MEMORY_DOC_LOCATIONS

/** The field that makes a doc THIS run's. It is the phase-8 gate's entire discriminator. */
export const MEMORY_PROVENANCE_FIELD = 'Source-Runs'

/** Where a run that believes it learned nothing can always record what the run was and what it cost. */
export const MEMORY_ALWAYS_AVAILABLE = '.recursive/memory/episodes/<run-id>.md'

/**
 * The phase-8 obligation, as data — so the pre-step reminder, the `recursive_phase` payload and the
 * lock-time gate all describe ONE rule instead of three paraphrases of it.
 */
export interface Phase8MemoryWriteRule {
  /** The artifact that must declare the write. */
  artifact: string
  /** The plane the write must land in, repo-relative. */
  plane: string
  /** The section the declaration goes in. */
  section: string
  /** The field a doc must carry for the write to count as THIS run's. */
  provenanceField: string
  /** The doc a run with nothing else to record can always write. */
  alwaysAvailable: string
  kinds: readonly MemoryDocKind[]
  /** One sentence per line the pre-step reminder injects. */
  summary: string
  /** The full instruction, for a caller that asks for the phase's rules. */
  instruction: string
}

export const PHASE8_MEMORY_WRITE_RULE: Phase8MemoryWriteRule = {
  artifact: PHASE8_MEMORY_ARTIFACT,
  plane: MEMORY_PLANE_PREFIX,
  section: PHASE8_MEMORY_SECTION,
  provenanceField: MEMORY_PROVENANCE_FIELD,
  alwaysAvailable: MEMORY_ALWAYS_AVAILABLE,
  kinds: Object.keys(MEMORY_DOC_LOCATIONS) as MemoryDocKind[],
  summary: 'HARD: this run must have WRITTEN at least one doc under ' + MEMORY_PLANE_PREFIX
    + ' before ' + PHASE8_MEMORY_ARTIFACT + ' locks — ' + MEMORY_ALWAYS_AVAILABLE + ' is always available — declared by path under `## '
    + PHASE8_MEMORY_SECTION + '` and carrying `' + MEMORY_PROVENANCE_FIELD + ': <this-run-id>`; citing a shard this run did not write does not count.',
  instruction: 'HARD REQUIREMENT, CHECKED AT LOCK: before ' + PHASE8_MEMORY_ARTIFACT + ' locks, this run must have WRITTEN at least one doc under '
    + MEMORY_PLANE_PREFIX + ' and declared that path under `## ' + PHASE8_MEMORY_SECTION + '`. A declared path counts ONLY when the doc on disk carries `'
    + MEMORY_PROVENANCE_FIELD + '` naming THIS run, because that is what separates "the run wrote its memory" from "the run cited someone else\'s".'
    + ' Render the doc with the metadata the memory-plane lint requires (Type, Status, Scope, Owns-Paths, Watch-Paths, ' + MEMORY_PROVENANCE_FIELD
    + ', Validated-At-Commit, Last-Validated, Tags): ' + MEMORY_ALWAYS_AVAILABLE + ' is always available for a run-local lesson, `.recursive/memory/domains/`,'
    + ' `.recursive/memory/patterns/` and `.recursive/memory/incidents/` hold generalized knowledge, and `.recursive/memory/skills/patterns/` is where a promoted skill lesson belongs.'
    + ' A doc missing a required field, or carrying a Type/Status the plane lint rejects, FAILS the memory plane — write it in the canonical shape.'
    + ' The written path enters the run diff under ' + MEMORY_PLANE_PREFIX + ', which phase 8 OWNS in its Worktree Diff Audit and Requirement Completion Status.',
}

/** The memory-write rule for an artifact, or null when that phase owes no memory write. */
export function phase8MemoryWriteRuleFor(fileName: string): Phase8MemoryWriteRule | null {
  return fileName === PHASE8_MEMORY_ARTIFACT ? PHASE8_MEMORY_WRITE_RULE : null
}

/**
 * get_artifact_required_sections(file_name, workflow_profile): canonical-parity
 * required section headings for a phase artifact. Defaults to TODO + Coverage
 * Gate + Approval Gate for unknown files. Audited phases in strict profiles get
 * the audit headings appended (plus Prior Recursive Evidence Reviewed for the
 * prior-evidence file set).
 */
export function getArtifactRequiredSections(fileName: string, workflowProfile: string = CURRENT_WORKFLOW_PROFILE): string[] {
  const headings = [...(SECTION_MAP[fileName] ?? ['TODO', 'Coverage Gate', 'Approval Gate'])]
  if (STRICT_WORKFLOW_PROFILES.has(workflowProfile) && AUDITED_PHASE_FILES.has(fileName)) {
    headings.push(...AUDIT_REQUIRED_HEADINGS)
    if (PRIOR_RECURSIVE_EVIDENCE_FILES.has(fileName)) {
      headings.push('Prior Recursive Evidence Reviewed')
    }
  }
  return headings
}

/**
 * LIVE BUG 6 (0.2.1): dedup gate for the agent/pre-step lint-rules reminder.
 * Keyed by (root, runId, phase) so each new run or phase transition gets its own
 * single injection, while re-arming steps in the SAME phase stay silent. Scoped
 * to the apply() effect/fiber lifetime (one instance per mount), matching the
 * repairedRoots dedup used by the scaffold repair above the injection point.
 */
export class ReminderOnceGate {
  private seen = new Set<string>()

  shouldInject(root: string, runId: string, phase: string): boolean {
    const key = root + '\u0000' + runId + '\u0000' + phase
    if (this.seen.has(key)) return false
    this.seen.add(key)
    return true
  }
}

/**
 * Structured, single-source-of-truth rules for one phase (refined LIVE BUG 6
 * design): consumed by BOTH the recursive_phase tool and the once-per-phase
 * pre-step reminder. Derived from the canonical artifact-template sections.
 */
export interface PhaseRules {
  fileName: string
  label: string
  requiredSections: string[]
  audited: boolean
  tdd: boolean
  qa: boolean
  /**
   * T40 — the memory-write obligation for this phase, or null when it owes none.
   *
   * ⚠ IT IS PART OF THIS STRUCTURE, not a parallel table, because `runtime.phaseRules` spreads this
   * object straight into the `recursive_phase` payload and the pre-step reminder is built from the
   * same source: a rule that lives here is a rule the agent is actually told, in one place.
   */
  memoryWrite: Phase8MemoryWriteRule | null
}

export function phaseRulesFor(fileName: string, workflowProfile: string = CURRENT_WORKFLOW_PROFILE): PhaseRules {
  return {
    fileName,
    label: fileName.replace(/\.md$/, ''),
    requiredSections: getArtifactRequiredSections(fileName, workflowProfile),
    audited: AUDITED_PHASE_FILES.has(fileName),
    tdd: fileName === '03-implementation-summary.md',
    qa: fileName === '05-manual-qa.md',
    memoryWrite: phase8MemoryWriteRuleFor(fileName),
  }
}

/**
 * Compact lint-rules message for the pre-step injection (R5): this phase's
 * required sections + phase-specific gate notes, built from phaseRulesFor
 * (single source of truth with the recursive_phase tool). Output is unchanged
 * from the prior inline build so r5-parity.spec.ts stays green.
 */
export function phaseLintRulesMessage(fileName: string, workflowProfile: string = CURRENT_WORKFLOW_PROFILE): string {
  const rules = phaseRulesFor(fileName, workflowProfile)
  const lines = [
    '<system-reminder>',
    'Recursive-mode phase lint rules for THIS phase (' + fileName + '):',
    'Required sections: ' + rules.requiredSections.join(' | '),
    'Gates: Coverage: FAIL until all checkboxes pass; Approval: FAIL until user sign-off; lock only via recursive_lock (monotonic).',
    'Audited phases: end with Audit: PASS before setting Coverage/Approval PASS; record Audit Context and Audit Verdict.',
    'TDD (phase 3): declare TDD Mode: strict|pragmatic; strict requires RED + GREEN evidence paths.',
    'QA (phase 5): declare QA Execution Mode: human|agent-operated|hybrid; human/hybrid need user sign-off.',
    // T40 — the phase-8 memory write is named HERE, once, where every other phase gate is named.
    // Additive on purpose: the message is only ever asserted with `toContain` (r5-parity.spec.ts),
    // so a new phase's obligation cannot be mistaken for a regression in an existing one.
    ...(rules.memoryWrite === null ? [] : ['Memory write (phase 8, HARD): ' + rules.memoryWrite.summary]),
    '</system-reminder>',
  ]
  return lines.join('\n')
}

/* -------------------------------------------------------------------------- */
/* T16 — per-phase baseline tool policy (NARROWING ONLY)                      */
/* -------------------------------------------------------------------------- */

/**
 * How restrictive a verdict is, lower = stricter. `deny` < `ask` < `allow`.
 * This ordering IS the narrowing rule: a phase baseline may replace a global
 * verdict with a lower-ranked one, and never with a higher-ranked one. It also
 * explains the engine's "deny wins over allow" claim in rank terms — deny is
 * the minimum, so nothing a phase adds can soften it.
 */
const VERDICT_RANK: Record<Verdict, number> = { deny: 0, ask: 1, allow: 2 }

export function policyVerdictRank(verdict: Verdict): number {
  return VERDICT_RANK[verdict]
}

/**
 * The phase number an artifact belongs to: the leading digits of its canonical
 * filename (`03-implementation-summary.md` -> `3`). Returns `''` when the
 * filename carries no phase number, so a caller can skip the baseline rather
 * than guess.
 */
export function phaseNumberForArtifact(fileName: string): string {
  const match = /^(\d+)/.exec(fileName)
  if (!match) return ''
  return String(Number(match[1]))
}

function isUnder(root: string, target: string): boolean {
  const rootAbs = resolve(root)
  const targetAbs = resolve(target)
  const prefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep
  return targetAbs !== rootAbs && targetAbs.startsWith(prefix)
}

/** True when the path is inside the run tree this phase is writing. */
function insideRunTree(path: string, runDir: string | undefined): boolean {
  if (!runDir) return false
  return isUnder(runDir, path)
}

/**
 * The absolute target of a call, or `'unresolvable'` when it cannot be placed.
 * An unresolvable target FAILS CLOSED in every baseline below: "we could not
 * tell where this write lands" is not a reason to allow it. A caller with no
 * worktree root can still place an ABSOLUTE target; a relative one it cannot.
 */
function baselineTarget(args: Record<string, unknown>, ctx: ToolPolicyContext): string | 'unresolvable' {
  const target = policyTargetPath(args)
  if (!target) return 'unresolvable'
  const normalized = target.replace(/\\/g, '/')
  if (!ctx.worktreeRoot && !isAbsolutePath(normalized)) return 'unresolvable'
  const abs = resolveFrom(ctx.worktreeRoot ?? '/', target)
  return abs ?? 'unresolvable'
}

function isAbsolutePath(normalized: string): boolean {
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')
}

/**
 * PER-PHASE BASELINE (plan §4 T16). Additive, phase-scoped rules that can only
 * NARROW the global policy. Three honest limits, stated here rather than hidden:
 *
 *   1. The two structures the plan names — phase 6 "writes only under
 *      `.recursive/DECISIONS.md`" and phase 8 "only under `.recursive/memory/**`"
 *      — as ABSOLUTE path scopes would also forbid the normal artifact edits of
 *      those phases, so they are implemented as the narrower rules that bite
 *      without blocking the phase's own work: no source-tree writes in phases
 *      6-8 (by then the repo changes are done and the run documents its
 *      decisions/state/memory), and the memory planes are read-only in phases
 *      1-2 and 6-7. `deny` on `write` in phase 6 is also deliberately absent,
 *      because phase 6's own artifact is `<run>/06-decisions-update.md` and a
 *      blanket write denial would make the phase uncompletable.
 *   2. Narrowing is enforced MECHANICALLY in withPhaseBaseline, not by trusting
 *      this table: a phase rule whose verdict is ranked above the strictest
 *      global verdict for the same pattern — which would widen `ask` to `allow`,
 *      or soften a global `deny` — is DROPPED before it can be evaluated.
 *   3. No rule below uses the bare catch-all `*`. A phase rule of that shape
 *      would outrank every specific global rule at once (precedence is
 *      specificity-first), including `recursive_lock*`, and would deny the phase
 *      its own tools. The write-tool family is spelled `write*`.
 *
 * Phase 3's TDD-evidence rule is the one the plan states verbatim: a phase-3
 * lock is denied until RED + GREEN evidence exists. It is reached for the phase
 * whose artifact is the current one, i.e. the phase-3 lock itself — before that
 * point the earlier phases are still unlocked, so the global lock-order rule
 * already refuses.
 */
export function phaseBaselineRules(fileName: string): ToolPolicyRule[] {
  const phase = phaseNumberForArtifact(fileName)
  const rules: ToolPolicyRule[] = []

  if (phase === '3') {
    // Narrowing: the global `recursive_lock` rule denies a lock whose
    // prerequisites are unmet. This adds a SECOND, stronger condition on the
    // SAME tool — TDD evidence before the phase-3 lock — which the tool itself
    // does not check.
    rules.push({
      pattern: 'recursive_lock*',
      verdict: 'deny',
      reason: 'TDD Mode: strict requires RED + GREEN evidence before locking Phase 3',
      label: 'tdd-evidence',
      predicate: (_id, args, ctx) => tddEvidenceMatch(String(args.artifact ?? ''), ctx.runDir),
    })
  }

  if (phase === '6' || phase === '7' || phase === '8') {
    // Late phases document, they do not change the implementation. Scope: the
    // write-tool family only (`write*`), so this narrowing cannot touch a
    // read/status/lock tool — and so it outranks a catch-all `allow` in the
    // global policy even when that allow is listed FIRST (T16 precedence is
    // specificity-first).
    rules.push({
      pattern: 'write*',
      verdict: 'deny',
      reason: 'phase ' + phase + ' is a documentation phase: writes outside the run tree are denied (the implementation is frozen)',
      // ⚠ T40 — PHASE 8 CARRIES ONE CARVE-OUT, AND WITHOUT IT THE HARD REQUIREMENT IS UNSATISFIABLE.
      //
      // `.recursive/memory/**` is OUTSIDE `.recursive/run/<runId>/`, so this rule denied the very
      // write phase 8 exists to make: under the shipped strict default an agent authoring its memory
      // doc was refused as if it were editing the implementation. MEASURED, not assumed — the rule's
      // own predicate answers `deny` for `.recursive/memory/...` in the phase whose whole job is that
      // plane. So phase 8, and only phase 8, admits THIS PLUGIN'S OWN plane:
      //   - the source tree stays denied (the implementation is frozen, and that is the rule's point);
      //   - `.recursive/DECISIONS.md` / `.recursive/STATE.md` stay denied here — phases 6 and 7 own
      //     them, and `writesOwnMemoryPlane` is deliberately narrower than `writesMemoryPlane`;
      //   - a target that cannot be placed stays denied, because the carve-out must never fail open.
      // ADVISORY IS UNCHANGED BY THIS: that mode coerces a `deny` into an `ask` and then into an
      // allow-with-warning anyway, so the carve-out only changes what STRICT refuses.
      predicate: (_id, args, ctx) => (
        writesOutsideRunTree(args, ctx) && !(phase === '8' && writesOwnMemoryPlane(args, ctx))
          ? { verdict: 'deny' }
          : null
      ),
    })
  }

  if (phase === '6' || phase === '7') {
    // `06-decisions-update.md` / `07-state-update.md` transcribe decisions and
    // state into their memory planes; phase 8 is where those planes are shaped.
    rules.push({
      pattern: 'write*',
      verdict: 'deny',
      reason: 'phase ' + phase + ' writes no memory plane: .recursive/DECISIONS.md|STATE.md and .recursive/memory/** are written by their own phases',
      predicate: (_id, args, ctx) => (writesMemoryPlane(args, ctx) ? { verdict: 'deny' } : null),
    })
  }

  if (phase === '1' || phase === '2') {
    // Phases 1-2 characterize and plan; they do not write the memory the run
    // only earns later. Scope: the memory planes only, so no other write
    // (including a repo source write a plan legitimately needs) is affected.
    rules.push({
      pattern: 'write*',
      verdict: 'deny',
      reason: 'phase ' + phase + ' writes no memory plane: .recursive/memory/** and .recursive/DECISIONS.md|STATE.md are earned at phases 6-8',
      predicate: (_id, args, ctx) => (writesMemoryPlane(args, ctx) ? { verdict: 'deny' } : null),
    })
  }

  return rules
}

/**
 * True when the call writes OUTSIDE the run tree. A target that cannot be
 * resolved counts as outside: the baseline cannot prove the write lands in the
 * run tree, and "we could not tell" is not a reason to allow it.
 */
function writesOutsideRunTree(args: Record<string, unknown>, ctx: ToolPolicyContext): boolean {
  const abs = baselineTarget(args, ctx)
  if (abs === 'unresolvable') return true
  return !insideRunTree(abs, ctx.runDir)
}

/** True when the call writes one of the run's memory planes. */
function writesMemoryPlane(args: Record<string, unknown>, ctx: ToolPolicyContext): boolean {
  const abs = baselineTarget(args, ctx)
  if (abs === 'unresolvable') return true
  return memoryPlanePath(abs)
}

/** True when the absolute path names one of the run's memory planes. */
function memoryPlanePath(abs: string): boolean {
  const normalized = abs.replace(/\\/g, '/')
  return /\/(decisions|state)\.md$/i.test(normalized) || /\/\.recursive\/memory(\/|$)/.test(normalized)
}

/**
 * True when the call writes `.recursive/memory/**` — THIS PLUGIN'S OWN plane, and nothing else.
 *
 * ⚠ DELIBERATELY NARROWER THAN {@link writesMemoryPlane}, which also matches `DECISIONS.md` and
 * `STATE.md`: phase 8's carve-out (T40) is about durable memory, not about handing phase 8 the two
 * planes phases 6-7 own.
 *
 * ⚠ AND AN UNRESOLVABLE TARGET IS `false` HERE — the OPPOSITE of every other fail-closed answer in
 * this file, because this is the PERMISSIVE branch: `true` means "do not deny", so a path the rules
 * cannot place must not be admitted by it. "We could not tell where this lands" is a reason to
 * refuse, never a reason to allow.
 */
function writesOwnMemoryPlane(args: Record<string, unknown>, ctx: ToolPolicyContext): boolean {
  const abs = baselineTarget(args, ctx)
  if (abs === 'unresolvable') return false
  return /\/\.recursive\/memory(\/|$)/.test(abs.replace(/\\/g, '/'))
}

/**
 * Resolve a tool-target path to an absolute path. Mirrors enforcement.ts's
 * resolution rules: an absolute path stays as it is; a relative path resolves
 * against the worktree root. `null` when the value cannot be a path at all.
 */
export function resolveFrom(worktreeRoot: string, target: string): string | null {
  const normalized = target.replace(/\\/g, '/').trim()
  if (!normalized) return null
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')) return resolve(normalized)
  // ⚠ FIX 2 — THIS USED TO STRIP A LEADING DOT, WHICH IS NOT THE SAME AS STRIPPING `./`.
  //
  // The regex was `/^\.?\/?/`: an optional dot followed by an optional slash. Its intent was plainly to normalise a
  // `./relative` path, but on a DOTFILE path it removed the dot and kept the name — so `.recursive/run/<id>/01.md`
  // resolved to `<root>/recursive/run/<id>/01.md`, OUTSIDE the run tree it names. Under strict enforcement the phase
  // guard denies writes outside the run tree, and a live verification pass recorded five denials out of five while
  // trying to author phase artifacts — the model could not write the very files the workflow is about.
  //
  // Only `./` is a relative-path prefix. A bare leading dot is part of the name.
  return resolve(join(worktreeRoot, normalized.replace(/^\.\//, '')))
}

/** The tool-target path of a call (same key order enforcement.ts uses). */
export function policyTargetPath(args: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'path', 'command', 'target', 'filePath']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/**
 * TDD evidence predicate for a phase-3 lock: `deny` when the artifact declares
 * `TDD Mode: strict` without both RED and GREEN evidence, `null` otherwise
 * (nothing to say — the global rules still apply). Lives in `policy-globs.ts`
 * beside the built-in list, which carries the same `tdd-evidence` guard rule.
 */
export const tddEvidenceVerdict = tddEvidenceMatch

/**
 * Compose the effective policy for a phase: the phase baseline rules FIRST (so
 * a narrowing rule is reached before the global rule it tightens), then the
 * global rules.
 *
 * NARROWING IS MECHANICAL, not a convention this table is trusted to respect. A
 * baseline rule whose verdict is ranked ABOVE the strictest global verdict for
 * the same pattern is DROPPED before it can be evaluated, so no per-phase
 * baseline can turn a global `deny` into an `allow` (or an `ask` into an
 * `allow`). A baseline rule for a pattern the global policy does not mention is
 * always kept: it can only add a restriction.
 */
export function withPhaseBaseline(policy: ToolPolicy, fileName: string, runDir?: string): ToolPolicy {
  const baseline = phaseBaselineRules(fileName)
  if (baseline.length === 0) return policy
  const globalRank = new Map<string, number>()
  for (const rule of policy.rules) {
    const rank = VERDICT_RANK[rule.verdict]
    const known = globalRank.get(rule.pattern)
    if (known === undefined || rank < known) globalRank.set(rule.pattern, rank)
  }
  const kept = baseline.filter((rule) => {
    const rank = VERDICT_RANK[rule.verdict]
    const known = globalRank.get(rule.pattern)
    return known === undefined || rank <= known
  })
  if (kept.length === 0) return policy
  return { ...policy, rules: [...kept, ...policy.rules] }
}
