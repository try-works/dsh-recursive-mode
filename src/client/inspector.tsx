/**
 * Drill-down inspector (SP2 R1 + run 15/16): centered modal-style detail panel
 * (Paper .detail shape) with back + close, data-theme (default light), theme
 * toggle, and solid status pills. All from the live host-route snapshot.
 * useBoardTheme is hoisted ABOVE the not-found early return.
 */
import { createElement, useState, type ReactNode } from 'react'
import type { LiveProjectionValue } from './contract.ts'
import { cardFacts, expandPhaseRows, cardPill, phaseStatusPill, PILL_LABELS } from './derive.ts'
import { DocViewer } from './doc-viewer.tsx'
import { useBoardTheme, ThemeToggle } from './theme.ts'
import type { BoardTheme } from './theme.ts'

export interface InspectorProps {
  runId: string
  worktreeRoot: string
  snapshot: LiveProjectionValue | null
  onBackToToolDetails: () => void
  onClose?: () => void
}

function closeButton(onClose: (() => void) | undefined) {
  if (onClose === undefined) return null
  return createElement('button', { type: 'button', className: 'rec-close', onClick: onClose, title: 'Close', 'aria-label': 'Close' }, '×')
}

function solidPill(kind: string) {
  return createElement('span', { className: 'rec-pill', 'data-pill': kind }, PILL_LABELS[kind as keyof typeof PILL_LABELS])
}

function detailShell(runId: string, onBackToToolDetails: () => void, onClose: (() => void) | undefined, headerExtra: ReactNode, body: ReactNode, theme: BoardTheme, toggle: () => void) {
  return createElement('div', { className: 'rec-inspector', 'data-theme': theme },
    createElement('div', { className: 'rec-detail' },
      createElement('div', { className: 'rec-detail-header' },
        createElement('button', { type: 'button', className: 'rec-back', onClick: onBackToToolDetails }, '← Back'),
        createElement('h2', { className: 'rec-detail-title' }, runId),
        headerExtra,
        createElement(ThemeToggle, { theme, toggle }),
        closeButton(onClose),
      ),
      createElement('div', { className: 'rec-detail-body' }, body),
    ),
  )
}

export function Inspector({ runId, worktreeRoot, snapshot, onBackToToolDetails, onClose }: InspectorProps) {
  const { theme, toggle } = useBoardTheme()
  const [openFileName, setOpenFileName] = useState<string | null>(null)
  const card = snapshot?.projection?.[worktreeRoot]?.[runId]
  if (card === undefined) {
    return detailShell(runId, onBackToToolDetails, onClose, null,
      createElement('p', { className: 'rec-detail-text' }, 'Run not found: ' + runId),
      theme, toggle,
    )
  }
  const facts = cardFacts(card)
  const rows = expandPhaseRows(card)
  const pill = cardPill(card)
  const headerExtra = solidPill(pill)
  const body = openFileName !== null
    ? createElement(DocViewer, { runId, worktreeRoot, fileName: openFileName, theme, onClose: () => setOpenFileName(null) })
    : createElement('section', { className: 'rec-detail-section' },
    createElement('h3', {}, 'Phases'),
    rows.map((row) => createElement('div', { key: row.phase, className: 'rec-phase-row' },
      createElement('span', { className: 'rec-phase-id' }, row.phase),
      createElement('span', { className: 'rec-phase-name' }, row.fileName ?? '—'),
      solidPill(phaseStatusPill(row.status)),
      row.lockHash !== undefined && createElement('code', { className: 'rec-lockhash' }, '#' + row.lockHash.slice(0, 8)),
      row.present && row.fileName !== null && createElement('button', {
        type: 'button',
        className: 'rec-phase-view',
        onClick: () => setOpenFileName(row.fileName!),
        title: 'View phase doc',
        'aria-label': 'View phase doc',
      }, 'View phase'),
    )),
    facts.gateBlocked && createElement('div', { className: 'rec-detail-section' },
      createElement('h3', {}, 'Gate'),
      createElement('p', { className: 'rec-detail-text' }, 'Blocked (' + (facts.gateKind ?? '') + ')'),
    ),
  )
  return detailShell(runId, onBackToToolDetails, onClose, headerExtra, body, theme, toggle)
}
