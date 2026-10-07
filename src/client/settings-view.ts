/**
 * Pure display model for the Recursive settings panel (read-only report).
 *
 * WHY THIS MODULE EXISTS. The old panel rendered one sentence and no values — it
 * claimed to report the host's configuration while reporting nothing. The data
 * was already arriving: `host-api.ts` serves {root, projection, revision} on
 * every fs change plus a 15s heartbeat, and `derive.ts` already derives board
 * facts from the same projection. This module adds no data path; it is the same
 * projection read for a different surface, and it is PURE (no React, no fs, no
 * session window — the read-only-client + projection-over-files invariant, §11.9).
 *
 * THE ABSENCE RULE (`text()` + `SettingsRow.value === null`): a value is printed
 * only when the projection carried it. A missing/blank value renders as
 * `not reported` — never an empty row and never a plausible default. Note that
 * `derive.cardFacts()` deliberately defaults a subagent's absent `status` to
 * 'done'; this model does NOT, because a report that invents "done" is a report
 * that lies. Required collection fields (`tampers`, `subagents`) that are present
 * but empty print `none` — that IS their value; fields the card omits print
 * `not reported`.
 */
import type { PhasePosition, RecursiveRunCard } from '../types.ts'
import type { LiveProjectionValue } from './contract.ts'
import { listRuns } from './board.tsx'
import { cardFacts, cardPill, expandPhaseRows, phaseStatusPill, type PillKind } from './derive.ts'

/** A label/value line. `value === null` means the projection carried NO value. */
export interface SettingsRow {
  id: string
  label: string
  value: string | null
}

/** One folded phase row, with the T21 single derived position printed verbatim. */
export interface SettingsPhaseRow {
  phase: string
  /** The phase doc filename, or null for a slot this run does not have (03.5). */
  fileName: string | null
  /** The raw folded status ('LOCKED' / 'DRAFT' / '—'). */
  status: string
  /** T21 single derived position; null when the producer carried none. */
  position: PhasePosition | null
  lockedAt: string | null
  lockHash: string | null
  present: boolean
  pill: PillKind
}

/** One subagent record: role/provider exactly as the host fold recorded them. */
export interface SettingsSubagentRow {
  childId: string
  role: string | null
  provider: string | null
  status: string | null
}

/** One unresolved in-flight work item (T18). */
export interface SettingsPendingRow {
  kind: string
  delegationId: string
  detail: string
}

/** One run's report. */
export interface SettingsRunView {
  runId: string
  worktreeRoot: string
  state: string
  pill: PillKind
  /** Scalar facts; a null value means the card did not carry that field. */
  rows: SettingsRow[]
  phases: SettingsPhaseRow[]
  /** null when the card carried no `subagents` key; [] when it carried an empty one. */
  subagents: SettingsSubagentRow[] | null
  /** null when the card carried no `pendingWork` key; [] when it carried an empty one. */
  pendingWork: SettingsPendingRow[] | null
}

/** Whether the route has answered, and whether it resolved a recursive root. */
export type SettingsStatus = 'no-frame' | 'no-root' | 'connected'

/** The whole panel model. */
export interface SettingsView {
  status: SettingsStatus
  root: string | null
  revision: number | null
  runs: SettingsRunView[]
  /**
   * Route-level facts the payload does not carry AT ALL — the panel names them
   * so a reader is never left to assume the client is hiding them.
   */
  notCarried: SettingsRow[]
}

/**
 * The `/state` payload is {root, projection, revision} (host-api.ts /
 * live-route.ts, both typed by LiveProjectionValue). Nothing else rides it, so
 * anything else is reported as not carried rather than guessed.
 */
export const NOT_CARRIED: readonly SettingsRow[] = [
  { id: 'enforcement', label: 'Enforcement modes (preStep / toolGuards / tamper)', value: null },
  { id: 'router-defaults', label: 'Router defaults (defaults.subagent) and per-role routes', value: null },
  { id: 'scratch-format', label: 'Scratch format', value: null },
]

/** A carried string, or null when the producer carried nothing to print. */
function text(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null
  return value.trim() === '' ? null : value
}

/**
 * Read a field the WIRE may omit even where the type calls it required (an
 * older or partial producer). The comparison itself has to happen here: with
 * `strict`, `card.subagents === undefined` is a no-overlap error at the call
 * site, but a missing field must still read as "not reported", not crash.
 */
function carried<T>(value: T | undefined): T | undefined {
  return value
}

/** `none` for a present-but-empty map, null for a map the card did not carry. */
function tamperValue(card: RecursiveRunCard): string | null {
  const tampers = carried(card.tampers)
  if (tampers === undefined) return null
  const facts = Object.values(tampers)
  if (facts.length === 0) return 'none'
  return facts.map((f) => (text(f.path) ?? '') + ': ' + (text(f.reason) ?? 'no reason carried')).join(' · ')
}

/** Scalar facts for one run, in a fixed order. */
function runRows(card: RecursiveRunCard): SettingsRow[] {
  const facts = cardFacts(card)
  const gate = card.gateBlocked
  return [
    { id: 'state', label: 'run state', value: text(card.state) },
    { id: 'state-reason', label: 'state reason', value: text(card.stateReason) },
    { id: 'lock', label: 'lock position', value: facts.lockValidity },
    { id: 'locked', label: 'locked phase groups', value: String(facts.lockedCount) + ' of ' + String(facts.totalPhases) + ' present' },
    { id: 'current-phase', label: 'current phase', value: text(facts.currentPhase) },
    {
      id: 'gate',
      label: 'gate block',
      value: gate === undefined
        ? null
        : (text(gate.kind) ?? 'kind not carried') + ': ' + (gate.failures.length === 0 ? 'no failures listed' : gate.failures.join('; ')),
    },
    { id: 'tampers', label: 'tamper facts', value: tamperValue(card) },
    { id: 'repo', label: 'repo', value: text(card.repo) },
    { id: 'template', label: 'template', value: text(card.template) },
    { id: 'merged', label: 'merged to repo root', value: text(card.mergedToRepoRoot) },
  ]
}

/** The folded phase chain, with the card's own `position` read off the wire row. */
function phaseRows(card: RecursiveRunCard): SettingsPhaseRow[] {
  return expandPhaseRows(card).map((row) => {
    const wired = row.fileName === null ? undefined : card.phases[row.fileName]
    return {
      phase: row.phase,
      fileName: row.fileName,
      status: row.status,
      position: wired?.position ?? null,
      lockedAt: text(row.lockedAt),
      lockHash: text(row.lockHash),
      present: row.present,
      pill: phaseStatusPill(row.status),
    }
  })
}

/** One run card -> its report. */
export function settingsRunView(card: RecursiveRunCard): SettingsRunView {
  const subagents = carried(card.subagents)
  const pendingWork = carried(card.pendingWork)
  return {
    runId: card.runId,
    worktreeRoot: card.worktreeRoot,
    state: card.state,
    pill: cardPill(card),
    rows: runRows(card),
    phases: phaseRows(card),
    subagents: subagents === undefined
      ? null
      : Object.values(subagents).map((s) => ({
        childId: s.childId,
        role: text(s.role),
        provider: text(s.provider),
        status: text(s.status),
      })),
    pendingWork: pendingWork === undefined
      ? null
      : pendingWork.map((p) => ({ kind: p.kind, delegationId: p.delegationId, detail: p.detail })),
  }
}

/**
 * The panel model for one live snapshot (null = the route has not answered yet).
 * Every run in the projection is reported; nothing is filtered or defaulted.
 */
export function settingsView(snapshot: LiveProjectionValue | null): SettingsView {
  if (snapshot === null) {
    return { status: 'no-frame', root: null, revision: null, runs: [], notCarried: [...NOT_CARRIED] }
  }
  return {
    status: snapshot.root === null ? 'no-root' : 'connected',
    root: text(snapshot.root),
    revision: typeof snapshot.revision === 'number' ? snapshot.revision : null,
    runs: listRuns(snapshot.projection).map(settingsRunView),
    notCarried: [...NOT_CARRIED],
  }
}
