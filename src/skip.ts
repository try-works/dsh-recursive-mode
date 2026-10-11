/**
 * skip.ts — THE LEGITIMATE SKIP: a phase that does not apply is recorded IN its artifact.
 *
 * THE DEFECT THIS EXISTS FOR, measured live. `status.ts` declared phase 1.5 "optional", an agent read
 * that as "this phase may be skipped", found phase 1.5 blocking a greenfield build that had no defect
 * to investigate, and removed the artifact (`git rm .recursive/run/<id>/01.5-root-cause.md`). The fold
 * then failed the turn with "a run artifact is evidence and the chain should only grow" — an entirely
 * correct refusal. Both halves were right and there was no way to act on either: the plugin told the
 * agent a phase could be absent, refused the removal, and offered no way to say *"this phase was
 * considered and does not apply"*. Removal looked like the only mechanism, so the agent used it.
 *
 * THE PRINCIPLE, AND WHY THE OTHER ONE LOST. Removal is NEVER legitimate:
 *   - a run artifact is EVIDENCE. The lock chain's receipts cite artifact hashes, so a vanished
 *     artifact invalidates every later citation and makes the fold unable to tell "was never needed"
 *     from "was deleted to get past it";
 *   - the alternative reading — "`optional` means the phase may be absent, so the fold must accept a
 *     missing optional artifact" — loses because it makes the evidence rule depend on a flag whose
 *     membership is a judgement call (7 phases here, 2 there, and no two readers agree), so the ONE
 *     invariant worth keeping would have an exception per phase. A rule with an exception list is not
 *     the rule; and the absence it would bless is indistinguishable from the tampering it refuses.
 * So the fix is not a weaker fold: it is a stronger vocabulary. Two words, named apart:
 *
 *   MAY BE ABSENT (chain) — `MAY_BE_ABSENT_PHASES` in `lock.ts`. An artifact that was NEVER CREATED
 *     does not stop `nextLegalPhase`. Never a licence to delete, never a statement about work.
 *   SKIPPED (work) — THIS FILE. The phase was CONSIDERED and does not apply, and the artifact says so
 *     in its own fields. The file stays, so the chain only grows and the record shows a decision
 *     rather than a hole.
 *
 * WHAT A SKIP WRITES, and every part of it is deliberate:
 *   `Status: SKIPPED`   — the marker the fold, the selector and the guard all read (`getLockStatus`).
 *   `SkippedAt: <iso>`  — when, so a later reader can order the decision against the run's other facts.
 *   `SkipReason: <why>` — the reason, REQUIRED (a bare marker is not a record). This is the field the
 *                         agent's own reasoning becomes part of the run's evidence.
 *   a lock RECEIPT     — written through the same `writeReceipt` the lock path uses, so the skip is
 *                         pinned into the chain by hash and any later edit to it shows up as a stale
 *                         downstream receipt. Without it, a later phase's receipt (which cites this
 *                         artifact's bytes as a settled prerequisite) would cite a prerequisite that
 *                         has no receipt at all, and `validateReceiptChain` would report a gap.
 *
 * WHAT IT REFUSES, so the mechanism cannot be used as a deletion with extra steps:
 *   - an artifact that does not exist (there is nothing to record IN — an absent phase is the OTHER
 *     word's case, and a required one is simply outstanding);
 *   - an already-LOCKED artifact (the work is done and hashed; reopen it explicitly first);
 *   - an artifact already recorded as SKIPPED (the first record stands — reopen and skip again if the
 *     reason genuinely changed);
 *   - a phase whose earlier phases are not settled (no working ahead: the same monotonic rule a lock
 *     obeys, from the same function).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getLockStatus,
  getPrerequisiteBlockers,
  isSkippedStatus,
  writeReceipt,
  type LockReceipt,
} from './lock.ts'

/** The exact word the marker uses. Read by `getLockStatus`; never inferred. */
export const SKIP_STATUS = 'SKIPPED'

/** The field carrying the reason. Required: a skip without one is a hole with a label. */
export const SKIP_REASON_FIELD = 'SkipReason'

/** The field carrying when the decision was recorded. */
export const SKIPPED_AT_FIELD = 'SkippedAt'

/** One recorded skip, as the tool returns it. */
export interface SkipResult {
  artifact: string
  runId: string
  status: typeof SKIP_STATUS
  skippedAt: string
  reason: string
  /** The receipt that pins the record into the chain (same shape the lock path writes). */
  receipt?: LockReceipt | unknown
  blockers: string[]
}

/**
 * Whether an artifact present on disk records a deliberate skip.
 *
 * Total and never throwing: a missing or unreadable file is `false` — "could not read a record" is
 * not "recorded as skipped", which is the same fail-closed direction `getLockStatus` takes.
 */
export function isSkippedArtifact(artifactPath: string): boolean {
  return isSkippedStatus(getLockStatus(artifactPath))
}

/**
 * The reason recorded in an artifact, or null when there is none.
 *
 * Exported because a reader (a page, a report, the fold's consumers) should be able to show WHY a
 * phase was skipped without re-parsing the marker's fields itself.
 */
export function skipReasonOf(content: string): string | null {
  const match = new RegExp('^[ \\t]*(?:[-*][ \\t]+)?' + SKIP_REASON_FIELD + ':[ \\t]*(.+?)\\s*$', 'm').exec(content)
  if (!match) return null
  return match[1].replace(/^[`"']|[`"']$/g, '').trim() || null
}

/**
 * Record a deliberate skip in an EXISTING artifact, and pin it into the lock chain.
 *
 * Pure with respect to policy (it decides nothing about who may skip — the tool and the guard do
 * that) and total with respect to failure (every refusal is a plain `Error` carrying the remedy).
 * `runDir` is the run's directory; `artifactFile` is a name in `PHASE_SEQUENCE`.
 */
export function skipPhaseArtifact(
  runDir: string,
  runId: string,
  artifactFile: string,
  reason: string,
  now: Date = new Date(),
): SkipResult {
  const trimmedReason = reason.trim()
  if (trimmedReason === '') {
    // FAIL CLOSED ON THE REASON. `Status: SKIPPED` with nothing behind it is exactly the shape this
    // whole mechanism replaces: a phase dropped with no record of why. The refusal says what to send.
    throw new Error(
      'a skip must carry a reason: call recursive_lock with { artifact: "' + artifactFile +
      '", skip: "<why this phase does not apply to this run>" }. A skip with no reason would be a' +
      ' deletion with a label - the record is the point.',
    )
  }
  const artifactPath = join(runDir, artifactFile)
  if (!existsSync(artifactPath)) {
    throw new Error(
      'cannot skip ' + artifactFile + ': no artifact exists, and a skip is a record written IN the artifact.' +
      ' A phase whose artifact was never created is a different case with a different answer - it is either' +
      ' outstanding work (author it) or a phase the run does not require, which the fold already reports as' +
      ' SKIPPED (not needed) without a file. There is nothing to delete here, so nothing to skip either.',
    )
  }

  const status = getLockStatus(artifactPath)
  if (status === 'LOCKED') {
    throw new Error(
      'refusing to skip ' + artifactFile + ': it is LOCKED, so its work is done and its lock is evidence.' +
      ' Reopen it first (recursive_lock with { artifact: "' + artifactFile + '", reopen: true }) if it genuinely' +
      ' must be re-done, then skip it - a skip overwrites the record of work that was accepted, which is not a' +
      ' decision this tool may take on its own.',
    )
  }
  if (isSkippedStatus(status)) {
    const existing = skipReasonOf(readFileSync(artifactPath, 'utf8')) ?? 'no reason recorded'
    throw new Error(
      'refusing to skip ' + artifactFile + ' twice: it is already recorded as SKIPPED (' + existing + ').' +
      ' The first record stands - if the phase must be worked on after all, reopen it, and a later skip records' +
      ' the new reason.',
    )
  }

  // THE MONOTONIC RULE, from the same function the lock path uses, so a skip cannot be used to work
  // ahead of the run. Same 'Prerequisite blockers: ' prefix as `lockArtifact` deliberately: it is the
  // same ordering refusal, and the lock tool's own branch renders the same recovery options for it.
  const blockers = getPrerequisiteBlockers(runDir, artifactFile)
  if (blockers.length > 0) {
    throw new Error('Prerequisite blockers: ' + blockers.map((b) => b.artifact + ' (' + b.status + ')').join(', '))
  }

  const skippedAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const original = readFileSync(artifactPath, 'utf8')
  const marked = markSkipped(original, trimmedReason, skippedAt)
  // A SKIP IS NOT A LOSS OF CONTENT: every byte that was there stays, minus the Status line it
  // replaces. Asserted rather than assumed, because this function is the one place allowed to write
  // an artifact outside the lock path, and a marker that ate a section would be the defect it fixes.
  if (!marked.includes(SKIP_STATUS) || !marked.includes(SKIP_REASON_FIELD)) {
    throw new Error('internal: the skip marker was not written to ' + artifactFile)
  }
  writeFileSync(artifactPath, marked, 'utf8')

  // Fail loud rather than report a skip the rest of the plugin will not see: every consumer reads
  // this file's Status through `getLockStatus`, so a marker it cannot classify is a silent no-op.
  if (getLockStatus(artifactPath) !== SKIP_STATUS) {
    throw new Error('internal: ' + artifactFile + ' was marked SKIPPED but reads as ' + getLockStatus(artifactPath))
  }

  // The receipt PINS the record: same writer, same JSON, same hash chain as a lock.
  const receipt = writeReceipt(runDir, artifactFile, artifactPath)

  return { artifact: artifactFile, runId, status: SKIP_STATUS, skippedAt, reason: trimmedReason, receipt, blockers: [] }
}

/**
 * Replace the artifact's `Status:` line with the marker and ensure `SkippedAt`/`SkipReason` exist.
 *
 * Kept local to the marker rather than shared with `setOrInsertField` in `runtime.ts` because the
 * fields belong together: the three lines are ONE record, and a caller that could set any one of them
 * alone could produce half a skip. Line endings are normalized the way the rest of the plugin
 * normalizes them (LF), so a marker written here hashes the same way a lock hash of the same content
 * would — which is what lets the receipt's `artifact_hash` be recomputed by a verifier later.
 */
function markSkipped(content: string, reason: string, skippedAt: string): string {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  const statusIndex = lines.findIndex((line) => /^[ \t]*(?:[-*][ \t]+)?Status:[ \t]*/.test(line))
  const statusLine = 'Status: `' + SKIP_STATUS + '`'
  if (statusIndex >= 0) lines[statusIndex] = statusLine
  else lines.unshift(statusLine)

  // The skip fields go directly after Status, replacing any stale ones (a reopen strips them, but a
  // hand-edited artifact may still carry them and two SkippedAt lines would be an ambiguous record).
  const withoutStale = lines.filter(
    (line) => !new RegExp('^[ \\t]*(?:[-*][ \\t]+)?(' + SKIPPED_AT_FIELD + '|' + SKIP_REASON_FIELD + '):').test(line),
  )
  const anchor = withoutStale.findIndex((line) => /^[ \t]*(?:[-*][ \t]+)?Status:[ \t]*/.test(line))
  const insertAt = (anchor >= 0 ? anchor : 0) + 1
  withoutStale.splice(insertAt, 0, SKIPPED_AT_FIELD + ': `' + skippedAt + '`', SKIP_REASON_FIELD + ': `' + reason + '`')
  return withoutStale.join('\n')
}
