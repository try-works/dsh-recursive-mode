import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadRouterPolicy, routerPolicyPath, resolveRole, probeCapabilities, capabilityProbe, delegationDecisionBasis, type RouterPolicy } from '../src/router.ts'

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

/**
 * ⚠ FU-20 — THE DIRECTIVE: *"subagents should not use cli, they should use models configured in dsh, and the user
 * should be able to configure subagent per phase or role. if no subagents are configured, use default session
 * model."*
 *
 * THE FAILURE THAT PROMPTED IT, quoted from a live run's own log: "Router policy read: `code-reviewer` is
 * `external-cli` with no CLI configured → fallback is self-audit; I'll attempt the canonical review path after
 * authoring and record the outcome." A delegated review became the authoring agent's review of its own work, and
 * the router's own prose read as a policy note rather than as the loss of the independence the delegation existed
 * to provide.
 *
 * The policy below is byte-for-byte the shape `bootstrap.ts` scaffolds into a workspace — `mode: 'external-cli'`
 * with `cli: null` — because THAT, and not an exotic configuration, is what every run starts from.
 */
const SCAFFOLDED: RouterPolicy = {
  ...policy,
  role_routes: {
    'code-reviewer': { enabled: true, mode: 'external-cli', cli: null, model: null, fallback: 'self-audit' },
  },
}

const SESSION = {
  available: true,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  source: 'request-header' as const,
  note: 'read from the parent session\'s request header config',
}

describe('FU-20 — a role routes to a DSH MODEL by default, never to a CLI and never to a silent self-review', () => {
  it('NOTHING CONFIGURED: the scaffolded `external-cli` route with NO cli is a MODEL route', () => {
    // ⚠ THE ASSERTION THAT WOULD HAVE CAUGHT THE LIVE DEFECT. A route that names no CLI has not asked for a CLI,
    // so the tier must not be `external-cli` and the posture must be the model default.
    const d = resolveRole('code-reviewer', SCAFFOLDED, { spawn: { name: 'spawn' } })
    expect(d.tier).toBe('native')
    expect(d.posture).toBe('model')
    expect(d.tier, 'a CLI route is not what an unconfigured CLI means').not.toBe('external-cli')
    expect(d.posture).not.toBe('cli')
  })

  it('NOTHING CONFIGURED: the child inherits the SESSION model, and the record says what that costs', () => {
    const d = resolveRole('code-reviewer', SCAFFOLDED, { spawn: { name: 'spawn' } }, { session: SESSION })
    expect(d.model, 'null means INHERIT — no agentOptions.model is sent at all').toBeNull()
    expect(d.independence).toBe('same-model')
    expect(d.reason).toContain('deepseek-flash')
    expect(d.independenceNote).toContain('NOT')
    expect(d.independenceNote).toContain('a second opinion from a different model')
  })

  it('NOTHING CONFIGURED, and no provider to create a child: the self-audit is LOUD', () => {
    // The physical outcome cannot change — a child needs a provider — but the REPORT must, because the live
    // defect was the report: "no native or external provider available; policy fallback self-audit" reads as a
    // routing preference. It now opens with the loss.
    const d = resolveRole('code-reviewer', SCAFFOLDED, {})
    expect(d.tier).toBe('self-audit')
    expect(d.independence).toBe('self-audit')
    expect(d.reason).toContain('INDEPENDENCE LOST')
    expect(d.reason).toContain('SELF-AUDIT')
    expect(d.independenceNote).toContain('must not be recorded, described or reported as an independent review')
    expect(d.independenceNote, 'the reader is told how to restore independence').toContain('configure a DSH model')
  })

  it('an EXPLICITLY configured CLI is still honoured — CLI routing stays available, it just is not the default', () => {
    const explicit = {
      ...SCAFFOLDED,
      role_routes: { 'code-reviewer': { enabled: true, mode: 'external-cli', cli: 'codex', model: null, fallback: 'self-audit' } },
    }
    const d = resolveRole('code-reviewer', explicit, { codex: { name: 'codex' }, spawn: { name: 'spawn' } })
    expect(d.tier).toBe('external-cli')
    expect(d.posture).toBe('cli')
    expect(d.provider).toBe('codex')
    // ⚠ And the model is NOT claimed: an external program runs on its own model, not on the harness's in-process
    // parent-model inheritance. Claiming otherwise would be the same class of overstatement as a false
    // independence claim.
    expect(d.independence).toBe('unverified-model')
    expect(d.independenceNote).toContain('no claim is made')
  })

  it('when_cli_unavailable: `ask` REFUSES — it does not quietly become a self-review', () => {
    const asking: RouterPolicy = { ...SCAFFOLDED, defaults: { ...SCAFFOLDED.defaults, when_cli_unavailable: 'ask' } }
    const explicit = {
      ...asking,
      role_routes: { 'code-reviewer': { enabled: true, mode: 'external-cli', cli: 'codex', model: null, fallback: 'self-audit' } },
    }
    const d = resolveRole('code-reviewer', explicit, { spawn: { name: 'spawn' } })
    expect(d.refused).toBe(true)
    expect(d.independence).toBe('refused')
    expect(d.independenceNote).toContain('NOTHING WAS SUBSTITUTED')
    // ⚠ The tier stays `self-audit` because that IS the physical outcome (no child is started) — but the
    // independence verdict is `refused`, so no caller can read it as a decided fallback.
    expect(d.independence).not.toBe('self-audit')
  })

  it('when_cli_unavailable: `fallback-local` routes to the LOCAL MODEL — a real child, never a self-review', () => {
    // The declared default, and the reason it needed restating: "local" now means the local MODEL, not "the
    // local agent reviewing itself".
    const explicit: RouterPolicy = {
      ...SCAFFOLDED,
      role_routes: { 'code-reviewer': { enabled: true, mode: 'external-cli', cli: 'codex', model: null, fallback: 'self-audit' } },
    }
    const d = resolveRole('code-reviewer', explicit, { spawn: { name: 'spawn' } })
    expect(d.tier).toBe('native')
    expect(d.posture).toBe('model')
    expect(d.reason).toContain('LOCAL MODEL')
    expect(d.reason).toContain('not a self-review')
  })

  it('when_role_unconfigured: `ask` invents no route, and says so instead of degrading silently', () => {
    const d = resolveRole('analyst', policy, { spawn: { name: 'spawn' } })
    expect(d.tier).toBe('self-audit')
    expect(d.refused).toBe(true)
    expect(d.reason).toContain('unconfigured')
    expect(d.reason).toContain('no route was invented')
  })

  it('when_role_unconfigured: `fallback-local` runs it on the local session model through a native provider', () => {
    const local: RouterPolicy = { ...policy, defaults: { ...policy.defaults, when_role_unconfigured: 'fallback-local' } }
    const d = resolveRole('analyst', local, { spawn: { name: 'spawn' } })
    expect(d.tier).toBe('native')
    expect(d.posture).toBe('model')
    expect(d.independence).toBe('same-model')
  })

  it('a configured role model is named, and its provenance is reported', () => {
    const withModel: RouterPolicy = {
      ...SCAFFOLDED,
      role_routes: { 'code-reviewer': { enabled: true, mode: 'native', cli: null, model: 'deepseek-pro', fallback: 'self-audit' } },
    }
    const d = resolveRole('code-reviewer', withModel, { spawn: { name: 'spawn' } }, { session: SESSION })
    expect(d.model).toBe('deepseek-pro')
    expect(d.chosen?.model).toBe('role')
    expect(d.independence, 'the configured model differs from the read session model').toBe('independent')
    expect(d.independenceNote).toContain('DIFFERENT')
  })

  it('a configured model with NO session reading is UNVERIFIED — a model difference is not claimed', () => {
    const withModel: RouterPolicy = {
      ...SCAFFOLDED,
      role_routes: { 'code-reviewer': { enabled: true, mode: 'native', cli: null, model: 'deepseek-pro', fallback: 'self-audit' } },
    }
    const d = resolveRole('code-reviewer', withModel, { spawn: { name: 'spawn' } })
    expect(d.independence).toBe('unverified-model')
    expect(d.independenceNote).toContain('is not claimed')
  })

  it('declares the model-unknown posture on every decision, so a caller with an inventory can honour it', () => {
    expect(resolveRole('code-reviewer', SCAFFOLDED, {}).whenModelUnknown).toBe('ask')
    expect(resolveRole('code-reviewer', SCAFFOLDED, { spawn: { name: 'spawn' } }).whenModelUnknown).toBe('ask')
  })
})

describe('FU-20 — the settings namespace reaches the policy WITHOUT editing the file or index.ts', () => {
  it('applies a per-ROLE model over the file, leaving the file’s other fields intact', () => {
    const overridden = loadRouterPolicy(undefined, {
      roles: { 'code-reviewer': { model: 'deepseek-pro' } },
    })
    expect(overridden.role_routes['code-reviewer']?.model).toBe('deepseek-pro')
  })

  it('applies a per-PHASE override, and a phase can name the role it wants', () => {
    const overridden = loadRouterPolicy(undefined, {
      phases: { '3.5': { role: 'memory-auditor', model: 'deepseek-pro' } },
    })
    expect(overridden.phase_routes?.['3.5']?.role).toBe('memory-auditor')
    expect(overridden.phase_routes?.['3.5']?.model).toBe('deepseek-pro')
  })

  it('applies the GENERAL subagent route onto `defaults.subagent`', () => {
    const overridden = loadRouterPolicy(undefined, { subagent: { provider: 'spawn', model: 'deepseek-flash' } })
    expect(overridden.defaults.subagent).toEqual({ provider: 'spawn', model: 'deepseek-flash' })
  })

  it('an EMPTY settings section is not a value: it cannot shadow the file', () => {
    // ⚠ The settings form projects an untouched object as `{}`. Merging that literally would overwrite the
    // file's entry with nothing — the silent shadowing `settings-config.spec.ts` pins. This is the same property
    // one level down, at the new fields.
    const dir = mkdtempSync(join(tmpdir(), 'rm-fu20-'))
    try {
      const file = join(dir, 'recursive-router.json')
      writeFileSync(file, JSON.stringify({
        defaults: { subagent: { provider: 'fork', model: 'cheap' } },
        role_routes: { 'code-reviewer': { enabled: true, mode: 'native', cli: null, model: 'keep-me', fallback: 'self-audit' } },
        phase_routes: { '08': { model: 'strong' } },
      }), 'utf8')
      const untouched = loadRouterPolicy(file, { roles: {}, phases: {}, subagent: {}, defaults: {} })
      expect(untouched.defaults.subagent).toEqual({ provider: 'fork', model: 'cheap' })
      expect(untouched.role_routes['code-reviewer']?.model).toBe('keep-me')
      expect(untouched.phase_routes?.['08']?.model).toBe('strong')
      // And a one-field override merges rather than replacing the whole entry.
      const partial = loadRouterPolicy(file, { roles: { 'code-reviewer': { model: 'new' } } })
      expect(partial.role_routes['code-reviewer']?.model).toBe('new')
      expect(partial.role_routes['code-reviewer']?.fallback, 'the file kept every field the override did not name').toBe('self-audit')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('FU-20 — the Delegation Decision Basis states independence on BOTH paths', () => {
  it('says INDEPENDENCE LOST when no child can be created, instead of reading as a routing preference', () => {
    const basis = delegationDecisionBasis({ role: 'code-reviewer', available: false, fallback: 'self-audit' })
    expect(basis).toContain('INDEPENDENCE LOST')
    expect(basis).toContain('SELF-AUDIT')
    expect(basis).toContain('AUTHORING agent')
  })

  it('names the SESSION model when the child inherits it, and says the independence is not of model', () => {
    const basis = delegationDecisionBasis({
      role: 'code-reviewer',
      available: true,
      provider: 'spawn',
      fallback: 'self-audit',
      independence: 'same-model',
      model: null,
      sessionModel: SESSION,
    })
    expect(basis).toContain('spawn')
    expect(basis).toContain('deepseek-flash')
    expect(basis).toContain('SAME model as this session')
    expect(basis).toContain('not of MODEL')
  })
})

