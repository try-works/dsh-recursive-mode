/**
 * T13 — planMode for the discovery phases, and the gate out of them.
 *
 * WHY. Requirements / AS-IS / TO-BE-Plan are NON-MUTATING discovery. Running them under the
 * harness's planMode enforces "plan before implement" at the harness level instead of by
 * convention: a phase that cannot write cannot quietly start implementing while it is still
 * deciding what to implement. Convention is what fails at 2am; a mode is what holds.
 *
 * ⚠ THE PHASE-FORM TRAP, which is why this module exists rather than a one-line comparison.
 * This codebase names a phase THREE ways — `'2'`, `'02'`, and the artifact filename
 * `'02-to-be-plan.md'` — and a mapping that understood only one of them would return `false`
 * for the others. That failure is SILENT and in the dangerous direction: it turns the
 * non-mutating guarantee OFF for exactly the phases that need it. So the index is parsed from
 * the leading numeric run, and every form lands on the same answer.
 *
 * ⚠ AN UNRECOGNISED PHASE ANSWERS `false`, deliberately. Claiming plan mode for a phase we
 * cannot identify would be guessing about the one property this module exists to guarantee;
 * the safe reading of "I do not know what this is" is "do not assert a mode about it". The
 * caller that needs certainty has {@link phaseIndexOf} and can refuse instead.
 */

/**
 * The numeric index of a phase, from any of the forms this codebase uses, or `null` when the
 * input names no phase at all.
 *
 * Takes the leading numeric run, so `'2'`, `'02'`, `' 2 '` and `'02-to-be-plan.md'` all give
 * `2`, and `'01.5-root-cause.md'` gives `1.5` — the fractional sub-phase keeps its position
 * between 01 and 02, which is what makes `phaseUsesPlanMode` include it.
 */
export function phaseIndexOf(phase: string): number | null {
  if (typeof phase !== 'string') return null
  const match = /^\s*(\d+(?:\.\d+)?)/.exec(phase)
  if (match === null) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/**
 * The exclusive upper bound of the discovery block: phases below this are non-mutating.
 *
 * 3 = implementation. Everything strictly below it (0 requirements, 1 AS-IS, 1.5 root cause,
 * 2 TO-BE plan) is discovery, which is the item's "00-02" plus the sub-phase that sits inside
 * that range.
 */
export const IMPLEMENTATION_PHASE_INDEX = 3

/** True when the phase is discovery and must run non-mutating. */
export function phaseUsesPlanMode(phase: string): boolean {
  const index = phaseIndexOf(phase)
  if (index === null) return false
  return index >= 0 && index < IMPLEMENTATION_PHASE_INDEX
}

/**
 * True when a transition LEAVES the discovery block — the plan gate.
 *
 * The gate is on the DESTINATION, not the distance: `02 -> 03` and `02 -> 04` both need an
 * approved plan, because skipping ahead does not make the plan less necessary. A transition
 * that stays inside discovery (0 -> 1) is not gated, and one that starts after the boundary
 * (3 -> 4) is not either — the plan was already required to get there.
 */
export function planGateRequired(from: string, to: string): boolean {
  const target = phaseIndexOf(to)
  const source = phaseIndexOf(from)
  if (target === null) return false
  if (target < IMPLEMENTATION_PHASE_INDEX) return false
  // From inside discovery (or from an unknown point) out to implementation or beyond.
  return source === null || source < IMPLEMENTATION_PHASE_INDEX
}

/** A one-line, board-facing statement of what the phase owes, for a phase rules section. */
export function describePlanMode(phase: string): string {
  if (phaseUsesPlanMode(phase)) {
    return 'phase ' + phase + ' runs NON-MUTATING (planMode): discovery must not write, and the plan gate out of discovery is 02 -> 03.'
  }
  const index = phaseIndexOf(phase)
  if (index === null) return 'phase ' + phase + ' is not a recognised phase, so no plan-mode claim is made for it.'
  return 'phase ' + phase + ' is past discovery, so it may write and is no longer plan-gated.'
}

/**
 * T13 — should `exit_plan_mode` be allowed, given the phase the run is WAITING on?
 *
 * The run's "next legal phase" is exactly the right input: while it is still a discovery
 * phase, the plan is not finished and leaving plan mode would start implementing on an
 * unfinished plan; once it is an implementation phase, discovery is done and the gate is
 * open. So the gate needs no separate state — it reads the state the run already keeps, and
 * that is why it cannot drift from the workflow.
 *
 * ⚠ A NULL next phase means "nothing is pending", which is NOT the same as "discovery is
 * done". It allows the exit, because refusing forever on a completed or unrecognised run
 * would make plan mode a trap rather than a gate — and the reason is stated so a reader can
 * tell the two cases apart.
 */
export function planGateForExit(nextPhase: string | null): { allow: boolean; reason: string } {
  if (nextPhase === null) {
    return { allow: true, reason: 'no phase is pending, so nothing is held back by the plan gate.' }
  }
  if (phaseUsesPlanMode(nextPhase)) {
    return {
      allow: false,
      reason: 'plan gate: phase ' + nextPhase + ' is still discovery, so the plan is not finished. '
        + 'Complete it (and lock its artifact) before leaving plan mode; the gate opens at 02 -> 03.',
    }
  }
  const index = phaseIndexOf(nextPhase)
  if (index === null) {
    return { allow: true, reason: 'phase ' + nextPhase + ' is not a recognised phase, so the plan gate makes no claim about it.' }
  }
  return { allow: true, reason: 'discovery is complete (next phase is ' + nextPhase + '), so the plan gate is open.' }
}
