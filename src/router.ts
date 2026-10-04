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
}

export interface SubagentProviderLike {
  name: string
  capabilities?: {
    outputSchema?: boolean
    depthLimit?: boolean
    toolFilter?: boolean
    persona?: boolean
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

/** Parse recursive-router.json. A missing/invalid file yields a default self-audit policy (never throws). */
export function loadRouterPolicy(path?: string): RouterPolicy {
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
 * Resolve a role to a tier, preferring a native provider whose name maps to
 * the role (e.g. role 'code-reviewer' -> provider 'code-reviewer' or the
 * generic spawn/fork provider). External CLIs ride their provider rows; else
 * the policy fallback.
 */
export function resolveRole(
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
