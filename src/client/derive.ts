/**
 * Pure derivation over the projected RecursiveRunCard (Phase D R5/R6/R7):
 * kanban lane mapping, card facts, conversation-node keying, and inspector
 * phase-row expansion. EVERYTHING here is a pure function over the wire card
 * — no React, no fs, no session window, no /.recursive/run/ scraping (the
 * read-only-client + projection-over-files invariant, 00-requirements R9).
 *
 * The card arrives from the 'recursive' session projection (whole value,
 * host-computed); this module only derives presentation from it.
 */
import type { RecursiveRunCard, RecursivePhaseRow, RecursiveRunState } from '../types.ts'

/** The ordered kanban lanes (§11.4): one lane per phase group. */
export interface RecursiveLane {
  /** Stable lane id. */
  id: string
  /** Human label. */
  label: string
  /** Phase-group keys folded into this lane. */
  groups: readonly string[]
}

export const KANBAN_LANES: readonly RecursiveLane[] = [
  { id: '0', label: 'Worktree & Requirements', groups: ['00'] },
  { id: '1/1.5', label: 'Analysis', groups: ['01', '01.5'] },
  { id: '2', label: 'TO-BE Plan', groups: ['02'] },
  { id: '3/3.5', label: 'Implementation + Code Review', groups: ['03', '03.5'] },
  { id: '4', label: 'Tests', groups: ['04'] },
  { id: '5', label: 'Manual QA', groups: ['05'] },
  { id: '6-8', label: 'Closeout', groups: ['06', '07', '08'] },
]

const GROUP_ORDER: readonly string[] = ['00', '01', '01.5', '02', '03', '03.5', '04', '05', '06', '07', '08']

/** Mandatory phase groups: a run is only 'locked'-valid when every one of these is present and LOCKED (01.5 is optional). */
const MANDATORY_GROUPS: readonly string[] = ['00', '01', '02', '03', '03.5', '04', '05', '06', '07', '08']

/** Map a group id to its ordinal for stable ordering. */
const GROUP_INDEX = new Map(GROUP_ORDER.map((g, i) => [g, i]))

/** Group id for a phase filename (e.g. '03.5-code-review.md' -> '03.5'); null for non-phase names. */
export function phaseGroupOf(phase: string): string | null {
  const m = /^(\d{2}(?:\.\d)?)(?:-|$)/.exec(phase)
  if (m === null) return null
  const g = m[1]
  return GROUP_INDEX.has(g) ? g : null
}

/** Kanban lane id for a phase filename. */
export function laneOf(phase: string): string | null {
  const g = phaseGroupOf(phase)
  if (g === null) return null
  for (const lane of KANBAN_LANES) {
    if ((lane.groups as readonly string[]).includes(g)) return lane.id
  }
  return null
}

/**
 * The run's current-phase lane: the highest-ordered phase group present in the
 * card wins (a run is "at" its furthest phase). No phases -> lane 0.
 */
export function columnForRun(card: RecursiveRunCard): string {
  let best: string | null = null
  let bestIndex = -1
  for (const key of Object.keys(card.phases)) {
    const g = phaseGroupOf(key)
    if (g === null) continue
    const idx = GROUP_INDEX.get(g) ?? -1
    if (idx > bestIndex) {
      bestIndex = idx
      best = g
    }
  }
  if (best === null) return '0'
  return laneOf(best + '-x') ?? '0'
}

/** Subagent chip (one per childId, latest status). */
export interface RecursiveSubagentChip {
  childId: string
  role: string
  provider: string
  status: 'running' | 'done' | 'failed'
}

/** Presentation facts derived from one card (§11.4). */
export interface RecursiveCardFacts {
  runId: string
  worktreeRoot: string
  repo?: string
  template?: string
  state: RecursiveRunState
  stateReason?: string
  /** Phases locked so far. */
  lockedCount: number
  /** Distinct phase groups present (progress denominator). */
  totalPhases: number
  /** lockedCount / totalPhases (0 when totalPhases is 0). */
  progress: number
  /** Any tamper fact present. */
  tampered: boolean
  /** Latest gate block present. */
  gateBlocked: boolean
  gateKind?: string
  /** Run was merged to a repo root. */
  merged: boolean
  mergedToRepoRoot?: string
  /** Lock validity: tampered | locked | in-progress. */
  lockValidity: 'tampered' | 'locked' | 'in-progress'
  /** Latest current-phase label (or null). */
  currentPhase: string | null
  /** Subagent chips, latest status per child. */
  subagents: RecursiveSubagentChip[]
}

/** T21: the single derived positions present on a card's rows, in phase order. */
function rowPositions(card: RecursiveRunCard): string[] {
  return Object.values(card.phases)
    .map((row) => row.position)
    .filter((p): p is NonNullable<typeof p> => p !== undefined)
}

/** Derive §11.4 presentation facts from one card (no fs, no session). */
export function cardFacts(card: RecursiveRunCard): RecursiveCardFacts {
  const groups = new Set<string>()
  for (const key of Object.keys(card.phases)) {
    const g = phaseGroupOf(key)
    if (g !== null) groups.add(g)
  }
  const lockedGroups = new Set<string>()
  for (const key of Object.keys(card.phases)) {
    const g = phaseGroupOf(key)
    if (g !== null && card.phases[key].status === 'LOCKED') lockedGroups.add(g)
  }
  const lockedCount = lockedGroups.size
  const totalPhases = groups.size

  const subagents: RecursiveSubagentChip[] = Object.values(card.subagents).map(s => ({
    childId: s.childId,
    role: s.role,
    provider: s.provider,
    status: s.status ?? 'done',
  }))

  let currentPhase: string | null = null
  let currentIdx = -1
  for (const key of Object.keys(card.phases)) {
    const g = phaseGroupOf(key)
    if (g === null) continue
    const idx = GROUP_INDEX.get(g) ?? -1
    if (idx > currentIdx) {
      currentIdx = idx
      currentPhase = key
    }
  }

  const tampered = Object.keys(card.tampers).length > 0 || rowPositions(card).includes('tampered')
  // Lock validity: tampered beats everything; else every MANDATORY phase present
  // and LOCKED -> locked; else still in-progress (01.5 stays optional).
  //
  // T21: when a row carries the server's single derived `position`, USE IT rather
  // than recombining `status` here. Recombining is how this consumer came to call
  // a LOCKED-but-gate-failing phase "locked" while the server's fold called it
  // `invalid-lock` — two consumers, two answers, one phase. The `status` test
  // remains as the fallback for a row produced before `position` existed.
  const allMandatoryLocked = MANDATORY_GROUPS.every((g) => {
    const row = Object.entries(card.phases).find(([key]) => phaseGroupOf(key) === g)
    if (row === undefined) return false
    const phase = row[1]
    if (phase.position !== undefined) return phase.position === 'locked'
    return phase.status === 'LOCKED'
  })
  const lockValidity: RecursiveCardFacts['lockValidity'] = tampered
    ? 'tampered'
    : allMandatoryLocked
      ? 'locked'
      : 'in-progress'

  return {
    runId: card.runId,
    worktreeRoot: card.worktreeRoot,
    repo: card.repo,
    template: card.template,
    state: card.state,
    stateReason: card.stateReason,
    lockedCount,
    totalPhases,
    progress: totalPhases === 0 ? 0 : lockedCount / totalPhases,
    tampered,
    gateBlocked: card.gateBlocked !== undefined,
    gateKind: card.gateBlocked?.kind,
    merged: card.mergedToRepoRoot !== undefined,
    mergedToRepoRoot: card.mergedToRepoRoot,
    lockValidity,
    currentPhase,
    subagents,
  }
}

/**
 * Stable conversation-node business id: runId + worktreeRoot (§11.6). The
 * worktree root is part of the id so two runs with the same runId in
 * different worktrees never collide — never "latest unfinished".
 */
/** Solid status-pill kinds (run 16 / Paper StatusPill). */
export type PillKind = 'locked' | 'in-progress' | 'paused' | 'blocked' | 'tampered' | 'advisory' | 'neutral'

/** Human pill label per kind (neutral renders an empty dash). */
export const PILL_LABELS: Record<PillKind, string> = {
  locked: 'locked',
  'in-progress': 'in progress',
  paused: 'paused',
  blocked: 'blocked',
  tampered: 'tampered',
  advisory: 'advisory',
  neutral: '—',
}

/**
 * Solid-pill kind for a whole run card. Priority: tamper > fully-locked >
 * run-state blocked > run-state paused > still in-progress.
 */
export function cardPill(card: RecursiveRunCard): PillKind {
  const facts = cardFacts(card)
  if (facts.tampered) return 'tampered'
  if (facts.lockValidity === 'locked') return 'locked'
  if (facts.state === 'blocked') return 'blocked'
  if (facts.state === 'paused') return 'paused'
  return 'in-progress'
}

/** Solid-pill kind for a phase row status string (LOCKED / DRAFT / '—'). */
export function phaseStatusPill(status: string): PillKind {
  if (status === 'LOCKED') return 'locked'
  if (status === '' || status === '—') return 'neutral'
  return 'in-progress'
}

export function nodeKeyOf(runId: string, worktreeRoot: string): string {
  return worktreeRoot + '\u0000' + runId
}

/** One expanded inspector phase row (§11.5). */
export interface RecursivePhaseInspectorRow {
  /** Normalized phase key (group only, e.g. '03.5'). */
  phase: string
  /** Full filename if present, else null (a mandatory-empty row). */
  fileName: string | null
  status: string
  lockedAt?: string
  lockHash?: string
  /** Whether the row is present in the card (vs a mandatory-empty slot). */
  present: boolean
}

/**
 * Expand a card's phase chain into full inspector rows: the always-shown
 * '03.5' slot (§11.10 mandatory deviation) plus 01.5 when present, and
 * 06/07/08 as three distinct rows (never one merged lane).
 */
export function expandPhaseRows(card: RecursiveRunCard): RecursivePhaseInspectorRow[] {
  const byGroup = new Map<string, RecursivePhaseRow>()
  for (const [fileName, row] of Object.entries(card.phases)) {
    const g = phaseGroupOf(fileName)
    if (g !== null) byGroup.set(g, row)
  }

  const rows: RecursivePhaseInspectorRow[] = []
  for (const g of GROUP_ORDER) {
    // 01.5 is optional: only emit when present.
    if (g === '01.5' && !byGroup.has(g)) continue
    // 03.5 is always shown (§11.10).
    const row = byGroup.get(g)
    if (row === undefined) {
      if (g === '03.5') {
        rows.push({ phase: g, fileName: null, status: '—', present: false })
      }
      continue
    }
    rows.push({
      phase: g,
      fileName: row.phase,
      status: row.status,
      lockedAt: row.lockedAt,
      lockHash: row.lockHash,
      present: true,
    })
  }
  return rows
}
