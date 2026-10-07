/**
 * Recursive settings page (§11.8): a settings.section list entry that REPORTS the
 * live projection the host route serves — the enforcement-free facts the wire
 * actually carries (run state + lock position, the folded phase chain with its
 * T21 position, tamper/gate/pending facts, subagent role+provider records).
 *
 * WHAT THIS PANEL IS NOT: it is not a config editor and not a second board. The
 * client is read-only (§11.9): it GETs the host route and reads no files. Every
 * value is printed verbatim from the projection; a field the payload does not
 * carry is printed as `not reported`, and the route-level fields the payload can
 * never carry (enforcement modes, router defaults, scratch format) are listed by
 * name at the bottom so a reader is never left guessing what is missing.
 *
 * `RecursiveSettings` is the pure renderer (props in, tree out). The live seat is
 * `RecursiveSettingsLive`, which resolves the workspace scope exactly like the
 * board seats and hands the snapshot down — the same shape board.tsx and
 * inspector.tsx consume.
 */
import { createElement, type ReactElement, type ReactNode } from 'react'
import { RECURSIVE_API_PREFIX } from '../live-route.ts'
import {
  currentSessionCwd,
  currentWorkspacePath,
  type LiveProjectionValue,
  type SessionListStateLike,
  type SnapshotSelectorHook,
  type WorkspaceListStateLike,
} from './contract.ts'
import { PILL_LABELS } from './derive.ts'
import { useLiveProjection } from './use-live.ts'
import {
  settingsView,
  type SettingsPendingRow,
  type SettingsPhaseRow,
  type SettingsRow,
  type SettingsRunView,
  type SettingsStatus,
  type SettingsSubagentRow,
  type SettingsView,
} from './settings-view.ts'

/** Rendered in place of every value the projection did not carry. */
export const ABSENT_LABEL = 'not reported'

export interface RecursiveSettingsProps {
  close: () => void
  /** The live host-route frame, or null while the first fetch is in flight. */
  snapshot?: LiveProjectionValue | null
}

/** The route-answer states, each said plainly instead of implied by an empty panel. */
const STATUS_TEXT: Record<SettingsStatus, string> = {
  'no-frame': 'The host route has not answered for this workspace yet. Every value below is unknown — not a default.',
  'no-root': 'The host route answered, but resolved no recursive root for this workspace (no .recursive/ run layer found).',
  connected: 'Live.',
}

const STATUS_VALUE: Record<SettingsStatus, string> = {
  'no-frame': 'no frame yet',
  'no-root': 'answered · no recursive root',
  connected: 'connected',
}

/** A label/value report block (`dl` — the semantics of a definition list). */
function rows(className: string, items: readonly SettingsRow[]): ReactElement {
  return createElement('dl', { className },
    items.flatMap((row) => [
      createElement('dt', { key: row.id + '-k', className: 'rec-settings-label' }, row.label),
      createElement('dd', {
        key: row.id + '-v',
        className: row.value === null ? 'rec-settings-value rec-settings-absent' : 'rec-settings-value',
      }, row.value ?? ABSENT_LABEL),
    ]),
  )
}

/** The frame's own facts: what the route answered, and how much it carried. */
function sourceRows(view: SettingsView): SettingsRow[] {
  return [
    { id: 'status', label: 'route status', value: STATUS_VALUE[view.status] },
    { id: 'root', label: 'workspace root', value: view.root },
    { id: 'revision', label: 'revision', value: view.revision === null ? null : String(view.revision) },
    { id: 'runs', label: 'runs in the projection', value: view.status === 'no-frame' ? null : String(view.runs.length) },
  ]
}

function phaseNode(row: SettingsPhaseRow): ReactElement {
  const lock: ReactNode[] = []
  if (row.lockedAt !== null) lock.push(createElement('span', { key: 'at' }, 'locked at ' + row.lockedAt))
  if (row.lockHash !== null) lock.push(createElement('code', { key: 'hash', className: 'rec-lockhash' }, '#' + row.lockHash.slice(0, 8)))
  return createElement('div', { key: row.phase, className: 'rec-settings-phase' },
    createElement('span', { className: 'rec-settings-phase-id' }, row.phase),
    createElement('span', { className: 'rec-settings-phase-name' }, row.fileName ?? 'not present in this run'),
    createElement('span', { className: 'rec-settings-phase-status' }, row.status),
    createElement('span', {
      className: row.position === null ? 'rec-settings-phase-pos rec-settings-absent' : 'rec-settings-phase-pos',
    }, row.position ?? ABSENT_LABEL),
    lock.length > 0 && createElement('span', { className: 'rec-settings-phase-lock' }, lock),
  )
}

function subagentNode(s: SettingsSubagentRow): ReactElement {
  return createElement('div', { key: s.childId, className: 'rec-settings-item' },
    createElement('span', { className: 'rec-settings-item-id' }, s.childId),
    createElement('span', { className: 'rec-settings-item-text' },
      'role ' + (s.role ?? ABSENT_LABEL) + ' · provider ' + (s.provider ?? ABSENT_LABEL) + ' · status ' + (s.status ?? ABSENT_LABEL)),
  )
}

function pendingNode(p: SettingsPendingRow): ReactElement {
  return createElement('div', { key: p.kind + '\u0000' + p.delegationId, className: 'rec-settings-item' },
    createElement('span', { className: 'rec-settings-item-id' }, p.kind),
    createElement('span', { className: 'rec-settings-item-text' }, p.delegationId + ' — ' + p.detail),
  )
}

/**
 * A collection field: null = the card carried no such key (not reported),
 * [] = the card carried an empty one (that empty value IS the report).
 */
function collection<T>(items: readonly T[] | null, render: (item: T) => ReactElement, none: string): ReactElement {
  if (items === null) {
    return createElement('p', { className: 'rec-settings-value rec-settings-absent' }, ABSENT_LABEL + ' — the card carries no such field')
  }
  if (items.length === 0) return createElement('p', { className: 'rec-settings-value rec-settings-none' }, none)
  return createElement('div', { className: 'rec-settings-items' }, items.map(render))
}

function runSection(run: SettingsRunView): ReactElement {
  const present = run.phases.filter((p) => p.present).length
  return createElement('section', { key: run.worktreeRoot + '\u0000' + run.runId, className: 'rec-settings-run' },
    createElement('div', { className: 'rec-settings-run-header' },
      createElement('h3', { className: 'rec-settings-run-title' }, run.runId),
      createElement('span', { className: 'rec-settings-pill', 'data-pill': run.pill }, PILL_LABELS[run.pill]),
      createElement('span', { className: 'rec-settings-run-root' }, run.worktreeRoot),
    ),
    rows('rec-settings-rows', run.rows),
    createElement('h4', { className: 'rec-settings-h4' }, 'Phases (' + String(present) + ' present)'),
    createElement('p', { className: 'rec-settings-hint' },
      'status is the folded artifact status; position is the host\'s single derived phase position (T21).'),
    run.phases.length === 0
      ? createElement('p', { className: 'rec-settings-value rec-settings-none' }, 'none — the card carries no phase rows')
      : createElement('div', { className: 'rec-settings-phases' }, run.phases.map(phaseNode)),
    createElement('h4', { className: 'rec-settings-h4' }, 'Subagents (role and provider as the host recorded them)'),
    collection(run.subagents, subagentNode, 'none — the card carries an empty subagent map'),
    createElement('h4', { className: 'rec-settings-h4' }, 'Pending work (unresolved in-flight delegations)'),
    collection(run.pendingWork, pendingNode, 'none — the card carries an empty pending set'),
  )
}

/** The panel: a report of one live frame. Pure — snapshot in, tree out. */
export function RecursiveSettings({ close, snapshot = null }: RecursiveSettingsProps) {
  const view = settingsView(snapshot)
  return createElement('div', { className: 'rec-settings' },
    createElement('header', { className: 'rec-settings-header' },
      createElement('h2', { className: 'rec-settings-title' }, 'Recursive'),
      createElement('span', { className: 'rec-settings-tag' }, 'live projection · read-only'),
      createElement('button', { type: 'button', className: 'rec-settings-close', onClick: close }, 'Close'),
    ),
    createElement('p', { className: 'rec-settings-lede' },
      'Read verbatim from the host route (GET ' + RECURSIVE_API_PREFIX + '/state + GET ' + RECURSIVE_API_PREFIX
      + '/events). This client writes nothing and reads no files; anything the projection does not carry is printed as "'
      + ABSENT_LABEL + '".'),
    rows('rec-settings-source', sourceRows(view)),
    view.status !== 'connected' && createElement('p', { className: 'rec-settings-hint' }, STATUS_TEXT[view.status]),
    view.status === 'connected' && view.runs.length === 0
      && createElement('p', { className: 'rec-settings-value rec-settings-none' }, 'none — the projection carries no runs in this workspace'),
    view.runs.map(runSection),
    createElement('section', { className: 'rec-settings-notcarried' },
      createElement('h3', { className: 'rec-settings-h3' }, 'Not carried by this route'),
      createElement('p', { className: 'rec-settings-hint' },
        'Configured on the host, but the payload carries only {root, projection, revision} — so this panel reports them as unknown rather than guessing.'),
      rows('rec-settings-rows', view.notCarried),
    ),
  )
}

/** The settings seat props: the root standard kit plus the shell's close affordance. */
export interface RecursiveSettingsSeatProps {
  close: () => void
  useSessions?: SnapshotSelectorHook<SessionListStateLike>
  useWorkspaces?: SnapshotSelectorHook<WorkspaceListStateLike>
}

export interface RecursiveSettingsLiveProps {
  close: () => void
  useSessions: SnapshotSelectorHook<SessionListStateLike>
  useWorkspaces: SnapshotSelectorHook<WorkspaceListStateLike>
}

/**
 * The live seat: same scope resolution as the board seats (sessionId PRIMARY,
 * workspace path as the cwd hint, session cwd while workspaces hydrate). Hooks
 * are called unconditionally — the seat only renders this component when both
 * selector hooks are present (slots.ts), so the hook order is fixed.
 */
export function RecursiveSettingsLive({ close, useSessions, useWorkspaces }: RecursiveSettingsLiveProps) {
  const sessions = useSessions((s) => s)
  const workspaces: WorkspaceListStateLike = useWorkspaces((s) => s) ?? { items: [], recentWorkspaceId: undefined }
  const wsPath = currentWorkspacePath(workspaces, sessions)
  const cwd = wsPath !== '' ? wsPath : currentSessionCwd(sessions)
  const snapshot = useLiveProjection({ sessionId: sessions.current, cwd })
  return createElement(RecursiveSettings, { close, snapshot })
}
