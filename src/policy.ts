/**
 * recursive:policy prompt-section renderer (Phase C R5, PROPOSAL 8.4 Layer 3).
 * Renders the CURRENT phase's contract from folded state + enforcement config:
 * what must exist before advancing, which tools are denied/asked this phase,
 * the strict/pragmatic TDD mode, the QA mode, the lock chain, and (R5) the
 * current phase's required sections + gate checklist — the same rules the
 * machine gates enforce (no prompt/gate contradiction).
 */
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { PHASE_SEQUENCE, getLockStatus } from './lock.ts'
import { foldRun } from './status.ts'
import type { RecursivePhaseState } from './lifecycle.ts'
import type { EnforcementConfig } from './enforcement.ts'
import { DEFAULT_ENFORCEMENT } from './enforcement.ts'
import { getArtifactRequiredSections, AUDITED_PHASE_FILES, CURRENT_WORKFLOW_PROFILE } from './phase-rules.ts'

export interface PolicyContext {
  worktreeRoot: string
  runId: string
  folded?: RecursivePhaseState | null
  config?: EnforcementConfig
}

/**
 * Render the current-phase contract. Empty string when no run is active.
 */
export function renderRecursivePolicy(context: PolicyContext | null): string {
  if (!context || !context.runId) return ''
  const runDir = join(context.worktreeRoot, '.recursive', 'run', context.runId)
  const folded = context.folded ?? null
  const config = context.config ?? DEFAULT_ENFORCEMENT

  // Derive the current phase from files (never trust an unchecked fold).
  let currentPhase = folded?.phase ?? ''
  let nextRequired = ''
  let currentFile = ''
  const status = existsSync(runDir) ? foldRun(runDir, context.runId) : null
  if (status?.currentPhase) {
    currentPhase = status.currentPhase.label + ' (' + status.currentPhase.status + ')'
    nextRequired = status.currentPhase.phaseName + ' (' + status.currentPhase.key + ')'
    currentFile = status.currentPhase.phaseName
  }

  const strictness = (gate: EnforcementConfig[keyof EnforcementConfig]) => gate
  // T22 — THE STABLE PREFIX COMES FIRST, then the per-phase tail.
  //
  // ⚠ The four lines that used to open this array were the phase-independent contract, rendered
  // inline; they now come from `renderStableContract`, so the contract has ONE definition and the
  // prefix is byte-identical for the whole run — which is the precondition for any provider-side
  // caching, whatever the provider does with it. The current phase and its next artifact move to
  // `renderPhaseTail`, because they are precisely what changes between phases; a prefix that carried
  // them would be stable in name only.
  const lines = [
    renderStableContract(config),
    renderPhaseTail(status?.currentPhase ?? null),
    '- A transition that fails its gates is BLOCKED (strict) or warns (advisory); no rejected transition advances state.',
    '- Writes to a Status: LOCKED phase doc are denied/asked; reopen explicitly to edit.',
    '- Phase 3 lock requires TDD evidence (strict) or rationale (pragmatic); Phase 5 requires QA sign-off for human/hybrid modes.',
    '- The control-plane root is resolved STRICTLY from this session workspace (never scan other workspaces).',
    '- Scratch is disposable, git-ignored, and never citable as an Input.',
    '- The workflow spec lives at /.recursive/RECURSIVE.md; bootstrap it when missing.',
    '- Call recursive_phase when entering a new phase; the same rules are auto-injected once per phase transition.',
  ];

  // R5: surface the current phase's required sections + gate checklist.
  if (currentFile) {
    const sections = getArtifactRequiredSections(currentFile, CURRENT_WORKFLOW_PROFILE)
    lines.push('');
    lines.push('## This phase (' + currentFile + ') required sections (canonical lint):');
    lines.push('- ' + sections.join(' | '));
    lines.push('## This phase gate checklist:');
    lines.push('- Coverage: FAIL until every checklist item is done; Approval: FAIL until sign-off; lock only via recursive_lock (monotonic).');
    if (AUDITED_PHASE_FILES.has(currentFile)) {
      lines.push('- Audited phase: end with Audit: PASS before setting Coverage/Approval PASS; record Audit Context + Audit Verdict.');
    }
    if (currentFile === '03-implementation-summary.md') {
      lines.push('- TDD Mode: strict|pragmatic; strict requires RED + GREEN evidence paths.');
    }
    if (currentFile === '05-manual-qa.md') {
      lines.push('- QA Execution Mode: human|agent-operated|hybrid; human/hybrid require user sign-off.');
    }
  }

  return lines.join('\n')
}

/**
 * T22 — the STABLE contract: the part of the policy section that does not depend on the phase.
 *
 * WHY A SPLIT AT ALL, given the item's own premise check: the mechanism this was modelled on
 * (iii's `system_sections` + `cache_boundary` + `cache_intent.surface_digest`) does **not** exist in
 * DSH as a plugin-visible seam — the harness's only cache concepts live in the provider layer
 * (`llm-pi-ai` accepts prompt-cache MARKERS and a retention preference), and whether any provider
 * caches the prefix is **provider-side and unverified**. The item **withdrew its "largest cost
 * lever" label for exactly that reason**, and this module keeps only what survives the check:
 * **a byte-identical prefix is a PRECONDITION for any provider-side caching**, whatever the provider
 * does with it — and a stable prefix costs nothing to produce.
 *
 * ⚠ THE CONTRACT DEPENDS ON THE CONFIG, NOT ON THE PHASE, and that distinction is the whole point:
 * the enforcement modes and the lock rules are fixed for a RUN, so they belong in the prefix; the
 * current phase, its required sections and its gate checklist change per phase and belong in the
 * tail. A prefix that varied with the phase would be stable in name only.
 */
export function renderStableContract(config: EnforcementConfig = DEFAULT_ENFORCEMENT): string {
  return [
    'You are in a recursive-mode session (enforcement active).',
    '- Lock chain: phases lock monotonically (' + PHASE_SEQUENCE.join(' -> ') + ').',
    '- Gates in force: pre-step ' + config.preStep + ', tool guards ' + config.toolGuards
      + ', tamper detection ' + config.tamper + '.',
    '- A transition that fails its gates is BLOCKED (strict) or warns (advisory); no rejected transition proceeds silently.',
    '- Writes to a Status: LOCKED phase doc are denied/asked; reopen explicitly to edit.',
    '- Phase order binds WRITES as well as locks: only the ACTIVE phase (the lowest-numbered artifact not yet LOCKED) may be written; a write to a LATER phase artifact is denied/asked. Run support files (evidence/, scratch/, addenda/, subagents/, operations/) are not phases.',
    '- Phase 3 lock requires TDD evidence (strict) or rationale (pragmatic); Phase 5 requires QA evidence.',
    '- The control-plane root is resolved STRICTLY from this session workspace (never scanned from another).',
    // ⚠ THE CONTRACT NOW SAYS MEMORY IS READ, AND IT HAS TO SAY IT HERE RATHER THAN IN THE TAIL.
    //
    // MEASURED BEFORE THIS LINE EXISTED: `grep -E 'memor|shard|learn' src/policy.ts` returned ZERO hits, so
    // the model-facing contract — the text the agent reads on every turn — never mentioned that prior-run
    // memory is read at phase entry, never said what an empty plane means, and never said to cite what it
    // relies on. The read itself was not missing (`runtime.phaseRules` calls `selectMemory` and returns the
    // section); it was INVISIBLE, which is the same class of defect that produced three live runs with zero
    // locks: a mechanism nothing announces is a mechanism the model has no reason to use.
    //
    // It belongs in the STABLE prefix, not the per-phase tail, because it is true of every phase — the tail
    // is precisely what changes between them. It carries NO selection (no shard, no count, no match), so the
    // prefix stays byte-identical for the whole run, which is the split's only precondition.
    '- Memory is READ AT PHASE ENTRY by recursive_phase: it returns what the memory plane holds for this run'
      + ' and phase (the selected shards, or `memoryReason` saying why nothing was injected). Read it when'
      + ' entering a phase, rely on what it gives you, and cite a shard by title wherever you act on it. An'
      + ' EMPTY plane is a normal result, not a failure: "the memory plane is empty, so nothing is injected"'
      + ' is an answer, and the phase proceeds with what the run itself knows.',
  ].join('\n')
}

/**
 * T22 — a LOCAL identifier for the contract, not a cache directive.
 *
 * The item's rescope is explicit that the digest is worth computing as a **local identifier**: it is
 * stable within a run and changes when the contract changes, which is what makes "did the contract
 * change under me?" answerable from the prompt alone. It claims **nothing** about provider caching —
 * a digest that implied one would be the withdrawn label wearing a hash.
 */
export function contractDigest(config: EnforcementConfig = DEFAULT_ENFORCEMENT): string {
  return createHash('sha256').update(renderStableContract(config), 'utf8').digest('hex').slice(0, 16)
}

/**
 * T22 — the per-phase TAIL: everything that legitimately changes between phases.
 *
 * Kept as its own name so the split is a fact in the code rather than a convention: a caller that
 * wants a cacheable prefix takes {@link renderStableContract} and puts this after it.
 */
export function renderPhaseTail(
  phase: { label: string; phaseName: string; status: string; key?: string } | null,
): string {
  if (phase === null) return '- Current phase: unknown\n- Next required artifact: none - run complete'
  // The key is part of the original wording (`phaseName (key)`), so it is carried when present
  // rather than dropped — a recomposition must not quietly lose information a reader had.
  const next = phase.key === undefined ? phase.phaseName : phase.phaseName + ' (' + phase.key + ')'
  return '- Current phase: ' + phase.label + ' (' + phase.status + ')\n'
    + '- Next required artifact: ' + next
}