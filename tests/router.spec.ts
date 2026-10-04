import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadRouterPolicy, routerPolicyPath, resolveRole, probeCapabilities, capabilityProbe, delegationDecisionBasis } from '../src/router.ts'

const policy = {
  version: 1,
  defaults: {
    when_role_unconfigured: 'ask',
    when_cli_unavailable: 'fallback-local',
    when_model_unknown: 'ask',
    allow_auto_assign_if_single_cli: false,
    probe_timeout_ms: 50000,
    invoke_timeout_ms: 180000,
  },
  role_routes: {
    'code-reviewer': { enabled: true, mode: 'external-cli', cli: null, model: null, fallback: 'self-audit' },
    'orchestrator': { enabled: true, mode: 'local-only', cli: null, model: null, fallback: 'local-controller' },
  },
  cli_overrides: {},
  custom_clis: [],
}

describe('router.ts — native provider resolution (R3)', () => {
  it('loads a router policy from disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-router-'))
    const cfg = join(root, '.recursive', 'config')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, 'recursive-router.json'), JSON.stringify(policy), 'utf8')
    const parsed = loadRouterPolicy(routerPolicyPath(root))
    expect(parsed.role_routes['code-reviewer']?.fallback).toBe('self-audit')
  })

  it('returns a default policy on missing/invalid path (never throws)', () => {
    expect(loadRouterPolicy(undefined).version).toBe(1)
    expect(loadRouterPolicy('D:/does/not/exist.json').role_routes).toEqual({})
  })

  it('resolves native provider first', () => {
    const d = resolveRole('code-reviewer', policy, { spawn: { name: 'spawn', capabilities: { outputSchema: true } } })
    expect(d.tier).toBe('native')
    expect(d.provider).toBe('spawn')
  })

  it('resolves external-cli when a cli provider row exists', () => {
    const p2 = { ...policy, role_routes: { ...policy.role_routes, 'code-reviewer': { enabled: true, mode: 'external-cli', cli: 'codex', model: null, fallback: 'self-audit' } } }
    const d = resolveRole('code-reviewer', p2, { codex: { name: 'codex' } })
    expect(d.tier).toBe('external-cli')
    expect(d.provider).toBe('codex')
  })

  it('falls back to self-audit when no provider exists', () => {
    const d = resolveRole('code-reviewer', policy, {})
    expect(d.tier).toBe('self-audit')
  })

  it('falls back to local-controller for orchestrator', () => {
    const d = resolveRole('orchestrator', policy, {})
    expect(d.tier).toBe('local-controller')
  })

  it('probeCapabilities reports advertised caps', () => {
    const probe = probeCapabilities({ name: 'spawn', capabilities: { outputSchema: true, depthLimit: true, toolFilter: false, persona: false } })
    expect(probe.available).toBe(true)
    expect(probe.capabilities?.outputSchema).toBe(true)
    expect(probe.capabilities?.toolFilter).toBe(false)
  })

  it('capabilityProbe returns available:false when no provider', () => {
    const probe = capabilityProbe({ providers: {}, role: 'code-reviewer', policy })
    expect(probe.available).toBe(false)
    expect(probe.reason.length).toBeGreaterThan(0)
  })

  it('delegationDecisionBasis renders concrete prose', () => {
    const basis = delegationDecisionBasis({ role: 'code-reviewer', available: false, fallback: 'self-audit' })
    expect(basis).toContain('self-audit')
    const avail = delegationDecisionBasis({ role: 'code-reviewer', available: true, provider: 'spawn', fallback: 'self-audit' })
    expect(avail).toContain('spawn')
  })
})
