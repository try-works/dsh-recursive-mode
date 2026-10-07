/**
 * Client entry (SP2 R1): the browser half of dsh-recursive-mode. Receives the
 * client root context from the DSH loader and registers the board, inspector,
 * status strip, and settings page. The board/strip read the LIVE host route
 * (per-workspace filesystem fold) — not a session projection — and render ONLY
 * for the recursive preset (acceptance #3). READ-ONLY (R9): the client never
 * mutates the host.
 *
 * The apply(ctx) surface mirrors the shipped dsh-client-ui-* packages; the
 * dsh.client.inject list in package.json names the host packages the loader
 * must provide (they are injected at compose time, never installed here).
 * The apply-guard prevents a stale+rebuilt bundle from double-mounting.
 */
import type { ClientContext } from './contract.ts'
import { registerSlots } from './slots.ts'
import { claimClientApply, releaseClientApply } from './apply-guard.ts'

export { Board, listRuns } from './board.tsx'
export { Inspector } from './inspector.tsx'
export { DocViewer, parseDoc, parseInline } from './doc-viewer.tsx'
export { RecursiveView } from './slots.ts'
export { RecursiveSettings, RecursiveSettingsLive } from './settings.tsx'
export { settingsView } from './settings-view.ts'
export type { SettingsView, SettingsRunView, SettingsRow } from './settings-view.ts'
export { useLiveProjection } from './use-live.ts'
export type { LiveProjectionSnapshot } from './use-live.ts'
export { fetchLiveState, subscribeLiveEvents } from './host-api.ts'
export type { LiveRecursiveState, LiveRecursiveFrame, LiveScope } from './host-api.ts'
export { isRecursivePreset, currentSessionCwd, currentWorkspacePath } from './contract.ts'
export type { SessionSummaryRow, SessionListStateLike, SnapshotSelectorHook, WorkspaceViewLike, WorkspaceListStateLike, ClientContext } from './contract.ts'

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'sessions', 'workspaces', 'connection']

/** Browser-half plugin entry (R4 + SP2 R1). */
export function apply(ctx: ClientContext): void {
  // First application wins; a duplicated client injection would mount a second
  // board/strip. Release on unload so a hot-reloaded bundle can claim again.
  if (!claimClientApply()) return
  ctx.effect(() => releaseClientApply, 'recursive: client apply claim')
  registerSlots(ctx)
}
