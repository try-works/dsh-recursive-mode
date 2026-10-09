/**
 * PHASE 0 — STARTING A RUN IS A HUMAN DECISION, NOT A SIDE EFFECT OF SCAFFOLDING.
 *
 * THE DEFECT THIS CLOSES. `recursive_init` scaffolded a run and the plugin then CREATED AND ARMED a
 * goal for it in the same breath (`syncRunGoal`'s "no current goal -> create and arm" branch). A goal
 * is not a label: `goals.create` returns an ARMED view, and the harness immediately begins driving
 * autonomous goal rounds for the session. So asking for a run spec was enough to start an unattended
 * run — the owner's rule is the opposite: *"creating a spec before a run exists should not create a
 * goal. Phase 0 requires explicit approval to start a run and goal."*
 *
 * WHAT "APPROVAL" IS, EXACTLY. The approving label of the `run-start` gate of `recursive_ask`
 * (`Start run`, as opposed to `Hold`), recorded here as a durable `- Run Start: Start run` line in the
 * run's Phase 0 requirements artifact. Three things make that an explicit human act rather than an
 * inference:
 *
 *   1. NO DEFAULT, AND THE VALUE IS THE DECISION. The line is written by the gate itself into the Phase 0
 *      requirements document, and the gate REFUSES an answer that is not one of the labels it offered.
 *      An unoffered answer is a transcription error wearing the shape of a decision, and a `Hold` is not
 *      an approval in any spelling — see {@link readRunStartApproval}, which matches the approving VALUE
 *      and nothing else, so the presence of a `Run Start` line is never on its own consent.
 *   2. IT IS ASKED, NOT ASSUMED. When the composition mounts `ctx.userQuestions` — the harness's own
 *      blocking human channel, the same one plan-mode's exit uses — the question is PUT TO THE PERSON and
 *      only their selection is recorded; a caller-supplied answer cannot stand in for it. A channel that
 *      RESOLVES with an answer the gate does not recognise is a person's decision the gate cannot record
 *      and it ends the call (RM5504). A channel that FAILS ends the call too (RM5503), naming the cause the
 *      channel threw — and there the caller may take the relayed route deliberately, with `relay=true`,
 *      which the result reports as `source: "relayed"` rather than as a person's own selection, so a
 *      composition whose channel cannot deliver the question can still start a run. A failure that means
 *      the question was cancelled, aborted, or timed out is never relayable. Only a composition with no
 *      channel at all falls back to the relayed answer unconditionally, which is the contract the other
 *      three gates have.
 *   3. THE GOAL CANNOT BE CREATED WITHOUT IT. `syncRunGoal` refuses to create a goal for a run whose
 *      approval record is absent, in EVERY branch that would create one — not only the "no goal yet"
 *      branch. That is the property `tests/run-start-approval.spec.ts` asserts, because a single
 *      unguarded branch is exactly how this defect existed in the first place.
 *
 * A SPEC MAY EXIST BEFORE A RUN EXISTS, and this module does not forbid that: the scaffold, the Phase
 * 0 artifacts and every later phase document are all created by `recursive_init` as before. What is
 * withheld is the GOAL — the object that makes the harness drive rounds. A run that is scaffolded and
 * never approved is a spec: readable, editable, lockable, and inert.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMdFieldValue } from './status.ts'

/** The gate id `recursive_ask` answers for a run start. Deliberately NOT in ASK_GATE_IDS. */
export const RUN_START_GATE_ID = 'run-start'

/** The Phase 0 artifact the approval is recorded in. */
export const RUN_START_ARTIFACT = '00-requirements.md'

/** The artifact field the approval reads back from. */
export const RUN_START_MARKER = 'Run Start'

/** The approving label. The ONLY label that starts a run. */
export const RUN_START_APPROVE = 'Start run'

/** The withholding label: the spec stays a spec. */
export const RUN_START_HOLD = 'Hold'

/**
 * WHY THIS GATE IS NOT IN `ASK_GATE_IDS`. Those three are the WORKFLOW's gates — phase-3 test
 * evidence, phase-5 sign-off, resolving a gate block — and their membership is asserted as exactly
 * three. Starting a run is a different kind of decision: it is the one that decides whether there is
 * a run at all. It lives here, with its own contract, so widening the workflow's gate list cannot
 * quietly widen what may start a run.
 */
export const RUN_START_GATE = {
  id: RUN_START_GATE_ID,
  header: 'Start run',
  question: 'Approve phase 0 and start this run? Approving creates an armed goal the harness will keep driving.',
  options: [
    { label: RUN_START_APPROVE, description: 'Record the approval and arm the run goal.' },
    { label: RUN_START_HOLD, description: 'Leave the spec inert: no run goal, no autonomous rounds.' },
  ],
  marker: RUN_START_MARKER,
} as const

/** The durable line an approval writes. */
export function runStartApprovalLine(): string {
  return '- ' + RUN_START_MARKER + ': ' + RUN_START_APPROVE
}

/** Is a `run-start` answer the approving one? */
export function isRunStartApproval(answer: string): boolean {
  return answer.trim() === RUN_START_APPROVE
}

/** Where the Phase 0 requirements artifact lives for a run rooted at `root`. */
export function runStartArtifactPath(root: string, runId: string): string {
  return join(root, '.recursive', 'run', runId, RUN_START_ARTIFACT)
}

/** The artifact text, or null when the file is absent (a read failure is not an approval). */
export function readRunStartArtifact(root: string, runId: string): string | null {
  try {
    return readFileSync(runStartArtifactPath(root, runId), 'utf8')
  } catch {
    return null
  }
}

/**
 * The approval state of a run, read from its Phase 0 artifact.
 *
 * ⚠ MATCHED ON THE VALUE, NOT ON THE LINE'S PRESENCE. `getMdFieldValue` returns the field's VALUE, so
 * a recorded `- Run Start: Hold` is refused here — a check for "is there a Run Start line?" would read
 * a refusal as consent, which is the one mistake this whole module exists to prevent.
 */
export function readRunStartApproval(root: string, runId: string): { approved: boolean; artifact: string; reason: string } {
  const content = readRunStartArtifact(root, runId)
  if (content === null) {
    return { approved: false, artifact: RUN_START_ARTIFACT, reason: 'the Phase 0 requirements artifact does not exist yet' }
  }
  const value = getMdFieldValue(content, RUN_START_MARKER)
  if (value === null) {
    return { approved: false, artifact: RUN_START_ARTIFACT, reason: 'no ' + RUN_START_MARKER + ' decision has been recorded' }
  }
  if (!isRunStartApproval(value)) {
    return { approved: false, artifact: RUN_START_ARTIFACT, reason: RUN_START_MARKER + ' is ' + JSON.stringify(value) + ', which does not start a run' }
  }
  return { approved: true, artifact: RUN_START_ARTIFACT, reason: '' }
}

/**
 * The ONE refusal reason the projection returns before approval, exported so every caller branches on
 * the same string instead of re-typing it (a re-typed reason is a caller that silently stops matching).
 */
export const RUN_START_NOT_APPROVED = 'run not started: phase 0 approval has not been granted'
