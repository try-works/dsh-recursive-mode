/**
 * Cross-module-instance apply guard for the recursive client bundle (mirrors
 * the dsh-task-board apply-guard). The client factory can run more than once in
 * a single page lifetime (a stale bundle mixed with a rebuilt one); without a
 * guard every factory run mounts its own board/strip. First claim wins; later
 * claims no-op until the claim is released (fiber unload / hot-reload).
 */
declare global {
  // eslint-disable-next-line no-var
  var __dshRecursiveModeClientApplied: boolean | undefined
}

/** Claims the client apply slot. Returns true when this call won the slot. */
export function claimClientApply(): boolean {
  if (globalThis.__dshRecursiveModeClientApplied === true) return false
  globalThis.__dshRecursiveModeClientApplied = true
  return true
}

/** Releases the claim (called from the client fiber cleanup on unload/hot-reload). */
export function releaseClientApply(): void {
  globalThis.__dshRecursiveModeClientApplied = undefined
}
