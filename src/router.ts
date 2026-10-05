/**
 * Native router resolution (Phase B R3, PROPOSAL 10.4/10.10): resolves the
 * canonical recursive-router.json policy to a NATIVE DSH subagent provider,
 * keeping the policy file as declarative config and dropping the external-CLI
 * wrappers. Order per role: native provider -> external-CLI route (codex/
 * claude) -> self-audit / local-controller fallback.
 *
 * Workspace-scoped + optionality-preserving: a missing provider, a missing
 * policy, or a failed probe resolves to self-audit, never throws and never
 * scans another workspace.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
// T9: the per-role model lookup, so there is ONE definition of "which model does this role use".
// `role-route.ts` imports only the `RouterPolicy` TYPE from here, which erases at runtime — so
// this is a one-way runtime dependency, not the cycle that bit `policy-globs` earlier.
import { modelForRole } from './role-route.ts'

export interface RouterDefaults {
  when_role_unconfigured: string
  when_cli_unavailable: string
  when_model_unknown: string
  allow_auto_assign_if_single_cli: boolean
  probe_timeout_ms: number
  invoke_timeout_ms: number
}

export interface RoleRoute {
  enabled: boolean
  mode: string
  cli: string | null
  model: string | null
  fallback: string
}

export interface RouterPolicy {
  version: number
  defaults: RouterDefaults
  role_routes: Record<string, RoleRoute>
  cli_overrides: Record<string, unknown>
  custom_clis: unknown[]
}

export type RouteTier = 'native' | 'external-cli' | 'self-audit' | 'local-controller'

export interface RouteDecision {
  tier: RouteTier
  provider?: string
  reason: string
  /**
   * T9: the model the policy names for this role, or null when it names none.
   *
   * Present on EVERY decision because it is attached by the wrapper, never per-return-site.
   * ⚠ The plugin does not apply it to a child — that is the host's
   * `subagent-model-selection` concern — so this is the value a caller can HONOUR, not a
   * promise that the child ran on it.
   */
  model?: string | null
}

export interface SubagentProviderLike {
  name: string
  capabilities?: {
    outputSchema?: boolean
    depthLimit?: boolean
    toolFilter?: boolean
    persona?: boolean
    /**
     * T9: whether this provider accepts `agentOptions` (provider/model/reasoning-effort
     * overrides). The harness REJECTS a start that sends them to a provider without this
     * capability, so the caller must ASK rather than assume — see `delegateReview`.
     */
    agentOptions?: boolean
  }
}

export interface CapabilityProbe {
  available: boolean
  provider?: string
  capabilities?: {
    outputSchema: boolean
    depthLimit: boolean
    toolFilter: boolean
    persona: boolean
  }
  reason: string
}

const DEFAULT_POLICY: RouterPolicy = {
  version: 1,
  defaults: {
    when_role_unconfigured: 'ask',
    when_cli_unavailable: 'fallback-local',
    when_model_unknown: 'ask',
    allow_auto_assign_if_single_cli: false,
    probe_timeout_ms: 50000,
    invoke_timeout_ms: 180000,
  },
  role_routes: {},
  cli_overrides: {},
  custom_clis: [],
}

/**
 * T7 — the settings OVERRIDE layer over the declarative file.
 *
 * ONE PATH, NOT TWO (the item's own interaction note): `recursive-router.json` remains the
 * declarative source, and the settings namespace can OVERRIDE individual fields without
 * restating the file. That is why every field here is optional and why the schema declares
 * NO defaults for them: an absent field means "defer to the file", and a default would make
 * every field present and silently shadow the file forever.
 */
export interface RouterPolicyOverrides {
  defaults?: Partial<RouterPolicy['defaults']>
}

/** Drop keys explicitly set to `undefined`, so "unset" cannot erase a file's value. */
function compact<T extends object>(value: T | undefined): Partial<T> {
  if (value === undefined) return {}
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry
  }
  return out as Partial<T>
}

/** Parse recursive-router.json. A missing/invalid file yields a default self-audit policy (never throws). */
export function loadRouterPolicy(path?: string, overrides?: RouterPolicyOverrides): RouterPolicy {
  const base = readRouterPolicy(path)
  const applied = compact(overrides?.defaults)
  if (Object.keys(applied).length === 0) return base
  return { ...base, defaults: { ...base.defaults, ...applied } }
}

/** The file (or the built-in default) — the declarative source the overrides sit on top of. */
function readRouterPolicy(path?: string): RouterPolicy {
  if (!path || !existsSync(path)) return DEFAULT_POLICY
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RouterPolicy>
    return {
      version: typeof raw.version === 'number' ? raw.version : 1,
      defaults: { ...DEFAULT_POLICY.defaults, ...(raw.defaults ?? {}) },
      role_routes: raw.role_routes ?? {},
      cli_overrides: raw.cli_overrides ?? {},
      custom_clis: raw.custom_clis ?? [],
    }
  } catch {
    return DEFAULT_POLICY
  }
}

/** Default router policy path inside a workspace root. */
export function routerPolicyPath(root: string): string {
  return join(root, '.recursive', 'config', 'recursive-router.json')
}

/**
 * T9 — attach the role's model to the decision.
 *
 * ⚠ WHY A WRAPPER AND NOT SIX EDITS. `resolveRoleInner` has six return sites, and adding the
 * model to each would leave a decision shape that carries it on some paths and not others — a
 * trap for the next reader, and exactly the kind of quiet inconsistency this plan keeps
 * refusing to ship. Attaching it ONCE, at the seam where the decision leaves, makes the field
 * present on EVERY path by construction. The policy lookup itself lives in `role-route.ts`
 * (`routeForRole`), so there is one definition of "which model does this role use", not two.
 */
export function resolveRole(
  role: string,
  policy: RouterPolicy,
  providers: Record<string, SubagentProviderLike>,
): RouteDecision {
  return { ...resolveRoleInner(role, policy, providers), model: modelForRole(role, policy) }
}

/**
 * Resolve a role to a tier, preferring a native provider whose name maps to
 * the role (e.g. role 'code-reviewer' -> provider 'code-reviewer' or the
 * generic spawn/fork provider). External CLIs ride their provider rows; else
 * the policy fallback.
 */
function resolveRoleInner(
  role: string,
  policy: RouterPolicy,
  providers: Record<string, SubagentProviderLike>,
): RouteDecision {
  const route = policy.role_routes[role]
  if (!route || !route.enabled) {
    return { tier: 'self-audit', reason: 'role ' + role + ' is unconfigured or disabled' }
  }

  // 1. Native provider: role-mapped name, then the generic spawn/fork.
  const candidates = [role, 'spawn', 'fork', 'dsh-sdk']
  for (const name of candidates) {
    if (providers[name]) {
      return { tier: 'native', provider: name, reason: 'native provider ' + name + ' is registered' }
    }
  }

  // 2. External-CLI route (codex/claude provider rows).
  if (route.mode === 'external-cli' && route.cli) {
    for (const name of [route.cli, 'codex', 'claude-code']) {
      if (providers[name]) {
        return { tier: 'external-cli', provider: name, reason: 'external CLI ' + route.cli + ' resolves to provider ' + name }
      }
    }
    return { tier: 'self-audit', reason: 'external CLI ' + route.cli + ' has no registered provider; falling back' }
  }

  // 3. Fallback.
  if (route.fallback === 'local-controller') {
    return { tier: 'local-controller', reason: 'policy fallback local-controller' }
  }
  return { tier: 'self-audit', reason: 'no native or external provider available; policy fallback ' + (route.fallback || 'self-audit') }
}

/** Probe a single provider and return its advertised capabilities. */
export function probeCapabilities(provider: SubagentProviderLike | undefined): CapabilityProbe {
  if (!provider) {
    return { available: false, reason: 'no provider registered' }
  }
  const caps = provider.capabilities
  return {
    available: true,
    provider: provider.name,
    capabilities: {
      outputSchema: caps?.outputSchema ?? false,
      depthLimit: caps?.depthLimit ?? false,
      toolFilter: caps?.toolFilter ?? false,
      persona: caps?.persona ?? false,
    },
    reason: 'provider ' + provider.name + ' probed',
  }
}

/**
 * Probe the router-relevant capability for a role. No provider -> available
 * false with a concrete reason (the self-audit fallback trigger).
 */
export function capabilityProbe(input: {
  providers: Record<string, SubagentProviderLike>
  role: string
  policy?: RouterPolicy
}): CapabilityProbe {
  const policy = input.policy ?? DEFAULT_POLICY
  const decision = resolveRole(input.role, policy, input.providers)
  if (decision.tier === 'self-audit' || decision.tier === 'local-controller') {
    return { available: false, reason: decision.reason }
  }
  const provider = input.providers[decision.provider ?? '']
  return probeCapabilities(provider)
}

/** Render the Delegation Decision Basis prose the phase doc records. */
export function delegationDecisionBasis(input: {
  role: string
  available: boolean
  provider?: string
  fallback: string
}): string {
  const { role, available, provider, fallback } = input
  if (available && provider) {
    return 'subagents are available (' + provider + '); ' + role + ' work is delegated by default when the context bundle is complete, with ' + fallback + ' as the guaranteed fallback.'
  }
  return 'no native subagent provider is available for ' + role + ' (probe failed or timed out); the audit is performed as self-audit per the bridge block, never weakening or skipping it.'
}
