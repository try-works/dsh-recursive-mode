/**
 * Workspace-scoped control-plane root resolution (R1, binding invariant).
 *
 * The plugin NEVER scans `workspaceRegistry.list()` to find "the" workspace and
 * NEVER reads another open workspace's `.recursive/` tree. The ONLY root-resolution
 * path is: session canonical cwd (`agent.session.header.cwd`) -> 
 * `workspaceRegistry.resolveByPath(cwd)` -> the owning workspace's canonical `path`,
 * which IS the control-plane root.
 */

export interface WorkspaceLike {
  readonly path: string
  readonly id: string
}

export interface WorkspaceRegistryLike {
  /** Resolve by canonical directory path without creating or mutating. */
  resolveByPath(path: string): Promise<WorkspaceLike | undefined> | WorkspaceLike | undefined
  /** MUST NOT be used by this plugin (workspace-scoping invariant). */
  list?(): unknown
}

export interface WorkspaceResolver {
  (cwd: string): Promise<string | null>
}

/**
 * Build a resolver bound to a workspace registry. Returns the canonical workspace
 * path for the given cwd, or `null` when the cwd is not a registered workspace
 * (no repo -> defer, never fail hard).
 */
export function makeWorkspaceResolver(registry: WorkspaceRegistryLike): WorkspaceResolver {
  return async (cwd: string): Promise<string | null> => {
    if (!cwd) return null
    const workspace = await registry.resolveByPath(cwd)
    return workspace?.path ?? null
  }
}

/**
 * Resolve the control-plane root for an agent-like object with a session header
 * carrying a canonical `cwd`. Degrades to `null` when the registry or cwd is
 * unavailable (callers defer, never fail hard).
 */
export async function resolveControlPlaneRoot(
  agent: { session?: { header?: { cwd?: string } } } | null | undefined,
  registry?: WorkspaceRegistryLike | null,
  cwdFallback?: string,
): Promise<string | null> {
  const cwd = agent?.session?.header?.cwd ?? cwdFallback ?? null
  if (!cwd) return null
  // B4: the session header cwd IS the workspace/control-plane root when the
  // registry is absent (headless/code-mode assemblies do not compose the
  // workspace service). Registry, when present, canonicalizes; otherwise the
  // session cwd is authoritative — never null just because the registry is
  // missing, or scratch/closeout (and every other per-call read) would be
  // permanently dead in headless hosts.
  if (!registry) return cwd
  return makeWorkspaceResolver(registry)(cwd)
}

/**
 * Extract the canonical session cwd (for callers that pass it explicitly).
 */
export function sessionCwd(agent: { session?: { header?: { cwd?: string } } } | null | undefined): string | null {
  return agent?.session?.header?.cwd ?? null
}
