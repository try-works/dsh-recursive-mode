/**
 * Board overlay (SP2 R1 + run 08 R3 + run 15/16): kanban over the live
 * host-route projection, class-based grid board with the Paper theme.
 * Pure read-only renderer — no filesystem, no run-file scraping.
 *
 * Run 16 (Paper): data-theme (default light), header theme toggle, workspace
 * path + count chip, solid status pills. useBoardTheme is hoisted ABOVE the
 * early returns (0.1.10 hook invariant).
 */
import { createElement } from 'react'
import type { RecursiveProjection, RecursiveRunCard } from '../types.ts'
import type { LiveProjectionValue } from './contract.ts'
import { cardFacts, columnForRun, KANBAN_LANES, cardPill, PILL_LABELS } from './derive.ts'
import { useBoardTheme, ThemeToggle } from './theme.ts'
import type { BoardSelection } from './open-state.ts'

/** Flatten the worktree-grouped projection into a stable run list. */
export function listRuns(projection: RecursiveProjection | undefined): RecursiveRunCard[] {
  if (projection === undefined) return []
  const runs: RecursiveRunCard[] = []
  for (const worktreeRoot of Object.keys(projection)) {
    for (const runId of Object.keys(projection[worktreeRoot])) {
      runs.push(projection[worktreeRoot][runId])
    }
  }
  return runs
}

export interface BoardProps {
  snapshot: LiveProjectionValue | null
  /** The authoritative current-workspace path (synchronous). snapshot.root is async/stale. */
  workspacePath?: string
  onOpenInspector?: (selection: BoardSelection) => void
  onClose?: () => void
  /**
   * 'overlay' (default) renders the board as a full-viewport fixed overlay
   * (shell.overlay / launcher). 'view' renders it inline, filling its parent
   * (a conversation.view tab), with no close button and no fixed positioning.
   */
  variant?: 'overlay' | 'view'
}

function closeButton(onClose: (() => void) | undefined, variant: 'overlay' | 'view') {
  if (onClose === undefined || variant === 'view') return null
  return createElement('button', { type: 'button', className: 'rec-close', onClick: onClose, title: 'Close', 'aria-label': 'Close' }, '×')
}

/** Case/trailing-separator tolerant workspace-path equality (Windows host). */
function sameWorkspacePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

function solidPill(kind: ReturnType<typeof cardPill>) {
  return createElement('span', { className: 'rec-pill', 'data-pill': kind }, PILL_LABELS[kind])
}

export function Board({ snapshot, workspacePath, onOpenInspector, onClose, variant = 'overlay' }: BoardProps) {
  const { theme, toggle } = useBoardTheme()
  if (snapshot === null || snapshot.root === null) return null
  // Run 16: when the synchronous workspace path differs from the async snapshot
  // root, the projection is stale (from the previously-viewed workspace) — suppress
  // its run cards so a workspace switch can never flash another workspace's runs.
  const stale = workspacePath !== undefined && workspacePath !== '' && !sameWorkspacePath(workspacePath, snapshot.root)
  const runs = stale ? [] : listRuns(snapshot.projection)
  const headerPath = workspacePath ?? snapshot.root
  const open = (run: RecursiveRunCard) => () => onOpenInspector?.({ worktreeRoot: run.worktreeRoot, runId: run.runId })
  const rootCls = variant === 'view' ? 'rec-board rec-board-view' : 'rec-board'
  if (runs.length === 0) {
    return createElement('div', { className: rootCls, 'data-theme': theme, 'data-empty': true },
      createElement('header', { className: 'rec-board-header' },
        createElement('h2', { className: 'rec-board-title' }, 'Recursive runs'),
        createElement('span', { className: 'rec-board-path' }, headerPath),
        createElement('span', { className: 'rec-board-count' }, '0 runs'),
        createElement(ThemeToggle, { theme, toggle }),
        closeButton(onClose, variant),
      ),
      createElement('p', { className: 'rec-board-empty' }, 'No recursive runs in this workspace yet.'),
    )
  }
  return createElement('div', { className: rootCls, 'data-theme': theme },
    createElement('header', { className: 'rec-board-header' },
      createElement('h2', { className: 'rec-board-title' }, 'Recursive runs'),
      createElement('span', { className: 'rec-board-path' }, headerPath),
      createElement('span', { className: 'rec-board-count' }, runs.length + ' runs'),
      createElement(ThemeToggle, { theme, toggle }),
      closeButton(onClose, variant),
    ),
    createElement('div', { className: 'rec-columns' },
      KANBAN_LANES.map((lane) => {
        const laneRuns = runs.filter((r) => columnForRun(r) === lane.id)
        return createElement('section', { key: lane.id, className: 'rec-column' },
          createElement('header', { className: 'rec-column-header' },
            createElement('span', { className: 'rec-status-dot', 'data-status': laneRuns.length > 0 ? laneRuns[laneRuns.length - 1].state : 'new', 'aria-hidden': true }),
            createElement('h3', { className: 'rec-column-title' }, lane.label),
            createElement('span', { className: 'rec-column-count' }, String(laneRuns.length)),
          ),
          createElement('div', { className: 'rec-cards' },
            laneRuns.map((run) => {
              const facts = cardFacts(run)
              const pill = cardPill(run)
              return createElement('article', { key: run.worktreeRoot + '\u0000' + run.runId, className: 'rec-card', 'data-state': run.state, onClick: open(run) },
                createElement('div', { className: 'rec-card-title' }, run.runId),
                createElement('div', { className: 'rec-card-progress' },
                  createElement('div', { className: 'rec-card-progress-fill', style: { width: Math.round(facts.progress * 100) + '%' } }),
                ),
                createElement('div', { className: 'rec-card-meta' },
                  createElement('span', { className: 'rec-card-phase' }, facts.currentPhase ?? 'no phases'),
                  solidPill(pill),
                ),
              )
            }),
            laneRuns.length === 0 && createElement('div', { className: 'rec-column-empty' }, '—'),
          ),
        )
      }),
    ),
  )
}
