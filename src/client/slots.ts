/**
 * Slot registrations (SP2 R1 + run 08 R1/R3/R4): the sidebar launcher, the
 * shell.overlay board, the conversation.input.dock status strip, and the
 * settings.section page.
 *
 * Run 08: the launcher now OPENS the shared board store (onClick), and the
 * shell.overlay entry renders the board gated on that store + the recursive
 * preset, swapping to the drill-down inspector when a run is selected.
 *
 * Run 10 (LIVE BUG FIX): useSessions is a SnapshotSelectorHook (NOT a zero-arg
 * thunk) — it is called WITH a selector, e.g. useSessions((s) => s) for the
 * full SessionListStateLike. The old code called useSessions() with NO selector
 * and wrapped the garbage in a fake {list:{getSnapshot}} — so the preset gate
 * never saw the recursive preset and the board never mounted (launcher click
 * did nothing). The board/strip now consume the SessionListStateLike directly.
 *
 * READ-ONLY (R9): the client only GETs the live host route; no mutation.
 */
import { createElement, type ReactNode } from 'react'
import type { ClientContext, SessionListStateLike, SnapshotSelectorHook, WorkspaceListStateLike } from './contract.ts'
import { isRecursivePreset, currentWorkspacePath } from './contract.ts'
import { Board } from './board.tsx'
import { Inspector } from './inspector.tsx'
import { RecursiveSettings, RecursiveSettingsLive, type RecursiveSettingsSeatProps } from './settings.tsx'
import { useLiveProjection } from './use-live.ts'
import { boardState, useBoardState } from './open-state.ts'
import { injectBoardStyles } from './styles.ts'

/** Structural standard-prop face for the root scope (useSessions/useWorkspaces). */
interface RootSlotProps {
  useSessions?: SnapshotSelectorHook<SessionListStateLike>
  useWorkspaces?: SnapshotSelectorHook<WorkspaceListStateLike>
}

export type OverlayContent = 'hidden' | 'board' | 'inspector'

/** Gate: hidden unless open AND recursive preset; inspector when a run is selected. */
export function overlayContent(state: { open: boolean; selection: unknown }, sessions: SessionListStateLike): OverlayContent {
  if (!state.open) return 'hidden'
  if (!isRecursivePreset(sessions)) return 'hidden'
  if (state.selection !== null) return 'inspector'
  return 'board'
}

/**
 * THE FIX (run 10): useSessions is a SELECTOR hook — always call it WITH a
 * selector. The identity selector `(s) => s` yields the full SessionListStateLike.
 * Exported so the spec can assert the selector is actually passed.
 */
export function useRecursiveSessions(useSessions: SnapshotSelectorHook<SessionListStateLike>): SessionListStateLike {
  return useSessions((s) => s)
}

/**
 * Run 11 (UX gate): the ⧉ launcher renders ONLY in recursive sessions. The seat
 * is root-scoped (the icon shows in every session otherwise), while the board it
 * opens is recursive-preset-gated — in a code/other session the click was a dead
 * no-op. Gating the launcher itself removes the trap: the icon appears exactly
 * where clicking it opens the board.
 */
export function RecursiveLauncherGate({ useSessions }: { useSessions: SnapshotSelectorHook<SessionListStateLike> }): ReactNode {
  const list = useRecursiveSessions(useSessions)
  if (!isRecursivePreset(list)) return null
  return createElement('button', { className: 'rec-launcher', title: 'Recursive runs', onClick: () => boardState.openBoard() }, '⧉')
}

/**
 * RecursiveView: the conversation.view tab body. Renders the run board INLINE
 * (fills the view area) keyed on the CURRENT workspace, and swaps to the
 * inspector modal when a run is opened. Read-only (R9): uses the live host
 * route. No preset gate — the tab is discoverable in any session.
 */
export function RecursiveView({ useSessions, useWorkspaces }: { useSessions: SnapshotSelectorHook<SessionListStateLike>; useWorkspaces: SnapshotSelectorHook<WorkspaceListStateLike> }): ReactNode {
  const board = useBoardState()
  const sessions = useRecursiveSessions(useSessions)
  const workspaces: WorkspaceListStateLike = useWorkspaces((s) => s) ?? { items: [], recentWorkspaceId: undefined }
  const wsPath = currentWorkspacePath(workspaces, sessions)
  const scope = { cwd: wsPath }
  const snapshot = useLiveProjection(scope)
  // Inspector drill-down (modal over the inline board) when a run is selected.
  if (board.selection !== null) {
    return createElement(Inspector, {
      runId: board.selection.runId,
      worktreeRoot: board.selection.worktreeRoot,
      snapshot,
      onBackToToolDetails: () => boardState.backToBoard(),
      onClose: () => boardState.close(),
    })
  }
  return createElement(Board, { snapshot, workspacePath: wsPath, variant: 'view', onOpenInspector: (sel) => boardState.openInspector(sel) })
}

export function registerSlots(ctx: ClientContext): () => void {
  const disposers: (() => void)[] = []
  // Run 15: inject the one-shot theme-token stylesheet once per document (idempotent).
  disposers.push(injectBoardStyles())

  // Conversation view tab (Chat | Trajectory | Recursive): the recursive run
  // board as a first-class tab in the conversation header, rendered INLINE in
  // the view area (not a fixed overlay). Order 20 places it to the RIGHT of
  // Trajectory (order 10). Always present — no recursive-preset gate, so the
  // entry point is discoverable in any session.
  disposers.push(ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'recursive',
    order: 20,
    label: 'Recursive',
  }, (props: RootSlotProps) => {
    const useSessions = props?.useSessions
    const useWorkspaces = props?.useWorkspaces
    if (useSessions === undefined || useWorkspaces === undefined) return null
    return createElement(RecursiveView, { useSessions, useWorkspaces })
  })))

  // Board launcher in the sidebar footer action list — OPENS the shared board store (run 08 R1).
  // Run 11 (UX gate): the seat is root-scoped (visible in every session), but the board it
  // opens is recursive-preset-gated. In a code/other session the icon was a dead click — a
  // trap. The launcher itself now renders ONLY in recursive sessions, where it works.
  disposers.push(ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'recursive',
    order: 50,
    label: 'Recursive runs',
  }, (props: RootSlotProps) => {
    const useSessions = props?.useSessions
    if (useSessions === undefined) return null
    return createElement(RecursiveLauncherGate, { useSessions })
  })))

  // Board panel overlay (root scope, cross-session read) — gated on the recursive preset + shared store.
  disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'recursive-board',
    order: 10,
  }, (props: RootSlotProps) => {
    const useSessions = props?.useSessions
    if (useSessions === undefined) return null
    return createElement(RecursiveBoardOverlay, { useSessions, useWorkspaces: props?.useWorkspaces })
  })))

  // Settings section (root scope, always present; no gate — configuration is always available).
  // The seat receives the shell's `close` PLUS the root standard kit (useSessions/useWorkspaces,
  // scoped-slots standardProps), so the panel can subscribe to the SAME live route the board
  // reads and report the projection. Without the kit the panel still renders — with every value
  // reported as absent (never guessed), which is the honest degradation.
  disposers.push(ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'recursive',
    order: 90,
    label: 'Recursive',
  }, (props: RecursiveSettingsSeatProps) => {
    if (props.useSessions === undefined || props.useWorkspaces === undefined) {
      return createElement(RecursiveSettings, { close: props.close })
    }
    return createElement(RecursiveSettingsLive, {
      close: props.close,
      useSessions: props.useSessions,
      useWorkspaces: props.useWorkspaces,
    })
  })))

  return () => { for (const d of disposers) d() }
}

/**
 * Board overlay: subscribes to the shared board store, gates on open + recursive
 * preset, and swaps board <-> inspector (run 08 R1/R3).
 *
 * Run 10: consumes the full SessionListStateLike through the identity selector
 * (useSessions((s) => s)); no fake {list:{getSnapshot}} wrapper.
 */
export function RecursiveBoardOverlay({ useSessions, useWorkspaces }: { useSessions: SnapshotSelectorHook<SessionListStateLike>; useWorkspaces?: SnapshotSelectorHook<WorkspaceListStateLike> }): ReactNode {
  const board = useBoardState()
  const sessions = useRecursiveSessions(useSessions)
  // Run 14 (USER-DIRECTED): the board keys on the WORKSPACE, not the session —
  // the workspace owns the .recursive/ run-layer history. Hoist ALL hooks first.
  const workspaces: WorkspaceListStateLike = useWorkspaces !== undefined
    ? useWorkspaces((s) => s)
    : { items: [], recentWorkspaceId: undefined }
  const content = overlayContent(board, sessions)
  const wsPath = currentWorkspacePath(workspaces, sessions)
  const scope = { cwd: wsPath }
  // Run 13 (LIVE BUG): ALWAYS call useLiveProjection — a conditional hook (after the
  // hidden early return) changed the hook count across renders and threw
  // 'Rendered more hooks than during the previous render'.
  const snapshot = useLiveProjection(scope)
  if (content === 'hidden') return null
  if (content === 'inspector' && board.selection !== null) {
    return createElement(Inspector, {
      runId: board.selection.runId,
      worktreeRoot: board.selection.worktreeRoot,
      snapshot,
      onBackToToolDetails: () => boardState.backToBoard(),
      onClose: () => boardState.close(),
    })
  }
  return createElement(Board, { snapshot, workspacePath: wsPath, onOpenInspector: (sel) => boardState.openInspector(sel), onClose: () => boardState.close() })
}

/** Export the gate helpers for tests. */
export { isRecursivePreset }
