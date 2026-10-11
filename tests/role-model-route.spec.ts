/**
 * T9 — the per-role model decision, and the honest statement of where the choice is made.
 *
 * The properties under test are the ones that keep a role mapping from becoming a guess: an
 * unknown role is FLAGGED rather than assumed, an unset model is reported as UNSET rather than
 * defaulted to something plausible, and the review/repair split is stated as being IN EFFECT or
 * NOT rather than left for a reader to infer.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecursiveRuntime } from '../src/runtime.ts'
import { roleKindOf, routeForRole, modelForRole, resolveSubagentTarget } from '../src/role-route.ts'
import { resolveRole, loadRouterPolicy, type RouterPolicy } from '../src/router.ts'

function policy(routes: Record<string, { model?: string | null }>): RouterPolicy {
  return {
    version: 1,
    defaults: {
      when_role_unconfigured: 'ask',
      when_cli_unavailable: 'fallback-local',
      when_model_unknown: 'ask',
      allow_auto_assign_if_single_cli: false,
      probe_timeout_ms: 1,
      invoke_timeout_ms: 1,
    },
    role_routes: routes as RouterPolicy['role_routes'],
    cli_overrides: {},
    custom_clis: [],
  }
}

describe('T9 — a role is classified by the JOB it does', () => {
  it('recognises review work and repair work', () => {
    expect(roleKindOf('code-reviewer')).toBe('review')
    expect(roleKindOf('memory-auditor')).toBe('review')
    expect(roleKindOf('implementer')).toBe('repair')
  })

  it('is case- and whitespace-insensitive, because role names arrive as typed', () => {
    expect(roleKindOf('  Code-Reviewer ')).toBe('review')
  })

  it('FLAGS an unknown role instead of assuming it is a reviewer', () => {
    // Assuming would put an unreviewed role on the expensive path, or a reviewer on the cheap
    // one, with no signal anywhere — the quiet mismatch this item exists to remove.
    expect(roleKindOf('dba')).toBe('unknown')
    expect(routeForRole('dba', policy({})).reason).toContain('not a role this plugin classifies')
  })
})

describe('T9 — the model comes from the policy, and an unset one is REPORTED', () => {
  it('resolves the policy’s model for the role', () => {
    const route = routeForRole('code-reviewer', policy({ 'code-reviewer': { model: 'opus-class' } }))
    expect(route.model).toBe('opus-class')
    expect(route.source).toBe('policy')
    expect(route.reason).toContain('opus-class')
  })

  it('reports an UNSET model as unset, and says the split is NOT in effect', () => {
    // The scaffolded policy sets `model: null` on every route, so this is the DEFAULT state —
    // and a caller must be able to tell "no model named" from "a model was chosen".
    const route = routeForRole('implementer', policy({ implementer: { model: null } }))
    expect(route.model).toBeNull()
    expect(route.source).toBe('unset')
    expect(route.reason).toContain('NOT in effect')
  })

  it('treats an empty or non-string model as unset rather than using it', () => {
    expect(modelForRole('implementer', policy({ implementer: { model: '   ' } }))).toBeNull()
    expect(modelForRole('implementer', policy({ implementer: { model: undefined } }))).toBeNull()
  })

  it('handles a role the policy does not mention at all', () => {
    const route = routeForRole('implementer', policy({}))
    expect(route.model).toBeNull()
    expect(route.kind).toBe('repair')
  })

  it('names ONLY the role’s own model — roles do not inherit each other’s', () => {
    // A reviewer's model must not silently become the repairer's, which is the bug a shared
    // lookup would introduce.
    const shared = policy({ 'code-reviewer': { model: 'rigorous' } })
    expect(modelForRole('code-reviewer', shared)).toBe('rigorous')
    expect(modelForRole('implementer', shared)).toBeNull()
  })

  it('never throws, whatever the policy holds', () => {
    const broken = policy({ 'code-reviewer': {} as never })
    expect(() => routeForRole('code-reviewer', broken)).not.toThrow()
    expect(() => routeForRole('', broken)).not.toThrow()
    expect(roleKindOf('')).toBe('unknown')
  })
})

/**
 * T9 — the model reaches the DECISION, on every path.
 *
 * `resolveRoleInner` has six return sites, so the model is attached by a WRAPPER rather than per
 * return: a decision shape that carried it on some paths and not others would be a trap, and this
 * asserts the present-on-every-path property rather than one path's behaviour.
 */
describe('T9 — the route decision carries the role’s model', () => {
  it('attaches the policy’s model whichever tier the decision takes', () => {
    const providers = { spawn: { name: 'spawn' } } as never
    const withModel = resolveRole('code-reviewer', policy({ 'code-reviewer': { model: 'rigorous' } }), providers)
    expect(withModel.model).toBe('rigorous')
    // The tier is whatever the router chose; the model is present regardless of it.
    expect(typeof withModel.tier).toBe('string')

    const unset = resolveRole('code-reviewer', policy({ 'code-reviewer': { model: null } }), providers)
    expect(unset.model).toBeNull()
  })

  it('carries null — not undefined — when the policy names nothing', () => {
    // Null says "the policy names no model"; undefined would say "this field was not set on
    // this path", which is the inconsistency the wrapper exists to prevent.
    const decision = resolveRole('implementer', policy({}), {} as never)
    expect(decision.model).toBeNull()
  })
})

/**
 * T9 part 3 — the model is DECLARED on the request, and only where the provider accepts it.
 *
 * ⚠ The safety property is the second case, not the first: the harness REJECTS a start that
 * sends `agentOptions` to a provider without that capability, so an unconditional pass would
 * take down the delegation the routing was meant to improve.
 */
describe('T9 — the delegation request declares the role’s model', () => {
  const POLICY_WITH_MODEL = {
    version: 1,
    role_routes: {
      'code-reviewer': { enabled: true, mode: 'external-cli', cli: null, model: 'rigorous', fallback: 'self-audit' },
    },
    cli_overrides: {},
    custom_clis: [],
  }

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'rm-t9r-'))
    const runDir = join(root, '.recursive', 'run', 'run-1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, '03-implementation-summary.md'), '# Impl\n\nStatus: `DRAFT`\n\n## TODO\n\n- [x] done\n', 'utf8')
    const cfg = join(root, '.recursive', 'config')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, 'recursive-router.json'), JSON.stringify(POLICY_WITH_MODEL), 'utf8')
    return root
  }

  /** Captures the START REQUEST, which is where the model has to appear. */
  async function startRequestFor(capabilities: Record<string, boolean>) {
    const root = makeRoot()
    const ctx = new Context()
    // ⚠ The spec is `{ provider, label, request }` — the request is NESTED. My first version of
    // this fake read `spec.agentOptions` and so asserted a field that could never be there,
    // which made the wiring look broken when it was the test reading the wrong level.
    const seen: Array<{ agentOptions?: unknown }> = []
    const runtime = new RecursiveRuntime(ctx, { repoRoot: root })
    try {
      const out = await runtime.delegateReview({
        root,
        runId: 'run-1',
        phase: '3',
        role: 'code-reviewer',
        delegationId: 'd1',
        childId: 'c1',
        artifactPath: join(root, '.recursive', 'run', 'run-1', '03-implementation-summary.md'),
        upstreamArtifacts: [],
        auditQuestions: ['does it work?'],
        requiredOutput: 'verdict',
        mode: 'continuable',
        parent: {},
        providers: { spawn: { name: 'spawn', capabilities } },
        subagents: {
          startContinuable: async (spec: { request?: { agentOptions?: unknown } }) => {
            seen.push((spec.request ?? {}) as { agentOptions?: unknown })
            return { childId: 'c1', messageId: 'm1' }
          },
          followup: async () => ({ messageId: 'm2' }),
        },
        awaitRoundResult: async () => null,
      } as never) as { routingNotes?: string[] }
      return { seen, out }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('declares agentOptions.model when the provider says it accepts overrides', async () => {
    const { seen } = await startRequestFor({ outputSchema: true, agentOptions: true })
    expect(seen.length).toBe(1)
    expect(seen[0].agentOptions).toEqual({ model: 'rigorous' })
  })

  it('sends NOTHING the provider would reject, and SAYS the model was not applied', async () => {
    // Without the capability the start must not carry agentOptions at all — and the caller is
    // told the model was dropped rather than left to infer it from a delegation that ran
    // without the routing it asked for.
    const { seen, out } = await startRequestFor({ outputSchema: true })
    expect(seen.length).toBe(1)
    expect(seen[0].agentOptions).toBeUndefined()
    expect((out.routingNotes ?? []).join(' ')).toContain('does not declare the agentOptions capability')
    expect((out.routingNotes ?? []).join(' ')).toContain('rigorous')
  })
})

/**
 * ⚠ FU-20 — THE PRECEDENCE, STATED AS PRECEDENCE RATHER THAN LEFT TO BE READ OFF THE CODE.
 *
 *   per-call override  →  phase route  →  role route  →  general subagent default  →  THE SESSION'S OWN MODEL
 *
 * WHY THIS ORDER. The narrowest statement of intent wins, and "narrowest" is measured in how much the user had to
 * know to make it: naming a phase ("3.5 needs the strong model") is more specific than naming a role
 * ("reviewers need the strong model"), and a per-call override is the caller asking for something for one
 * delegation only. The SESSION's model is the floor and not a competing level: it is what every child already
 * inherits when nobody has said anything, which is exactly why the owner wants it as the default — and why it
 * must never outrank a setting the user actually made.
 *
 * The levels are also resolved PER VALUE, not wholesale: a phase that names only a model keeps the role's
 * provider. That tolerance is what makes "configure a subagent per phase or role" usable, because a user setting
 * one field does not have to restate the level beneath it.
 */
describe('FU-20 — the per-phase and per-role model ladder, and where the session default sits', () => {
  const base = loadRouterPolicy().defaults
  const SESSION = {
    available: true,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    source: 'request-header' as const,
    note: 'read from the parent session\'s request header config',
  }
  const reviewRole = { enabled: true, mode: 'native', cli: null, model: 'role-model', fallback: 'self-audit' }

  it('ROLE level is honoured, and reported as the level that chose it', () => {
    const target = resolveSubagentTarget({
      role: 'code-reviewer',
      phase: '03',
      policy: { ...loadRouterPolicy(), role_routes: { 'code-reviewer': reviewRole } },
      ladderProvider: 'spawn',
      sessionModel: SESSION,
    })
    expect(target.model).toBe('role-model')
    expect(target.chosen.model).toBe('role')
    expect(target.effectiveModel).toBe('role-model')
  })

  it('PHASE OVERRIDES ROLE — the deliberate precedence, asserted as such', () => {
    const target = resolveSubagentTarget({
      role: 'code-reviewer',
      phase: '3.5',
      policy: {
        ...loadRouterPolicy(),
        role_routes: { 'code-reviewer': reviewRole },
        phase_routes: { '3.5': { model: 'phase-model' } },
      },
      ladderProvider: 'spawn',
      sessionModel: SESSION,
    })
    expect(target.model, 'the phase is the narrower statement of intent, so it wins').toBe('phase-model')
    expect(target.chosen.model).toBe('phase')
    expect(target.reason).toContain('the phase 3.5 override')
  })

  it('a phase that names ONLY a model keeps the role’s provider — levels merge per value', () => {
    const target = resolveSubagentTarget({
      role: 'code-reviewer',
      phase: '3.5',
      policy: {
        ...loadRouterPolicy(),
        role_routes: { 'code-reviewer': { ...reviewRole, provider: 'fork' } },
        phase_routes: { '3.5': { model: 'phase-model' } },
      },
      ladderProvider: 'spawn',
      sessionModel: SESSION,
    })
    expect(target.model).toBe('phase-model')
    expect(target.provider, 'the phase named no provider, so the role level still supplies one').toBe('fork')
  })

  it('⚠ a phase may NAME THE ROLE it wants, and that field is now LIVE rather than decorative', () => {
    // `router.ts` documents `phase_routes: { '08': { role: 'memory-auditor' } }` and `provider-model-policy.spec`
    // writes exactly that — while the resolver read only the phase's provider and model, so a user could name
    // the auditor for a phase and silently get the requested role's configuration instead.
    const target = resolveSubagentTarget({
      role: 'code-reviewer',
      phase: '08',
      policy: {
        ...loadRouterPolicy(),
        role_routes: {
          'code-reviewer': reviewRole,
          'memory-auditor': { enabled: true, mode: 'native', cli: null, model: 'auditor-model', fallback: 'self-audit' },
        },
        phase_routes: { '08': { role: 'memory-auditor' } },
      },
      ladderProvider: 'spawn',
    })
    expect(target.role).toBe('memory-auditor')
    expect(target.model).toBe('auditor-model')
    expect(target.chosen.model).toBe('role')
  })

  it('a phase naming a role with NO route falls back to the requested role, rather than to nothing', () => {
    const target = resolveSubagentTarget({
      role: 'code-reviewer',
      phase: '08',
      policy: {
        ...loadRouterPolicy(),
        role_routes: { 'code-reviewer': reviewRole },
        phase_routes: { '08': { role: 'unconfigured-role' } },
      },
      ladderProvider: 'spawn',
    })
    expect(target.model, 'a named-but-unrouted role must not silently erase the configured model').toBe('role-model')
  })

  it('carries the LLM provider that SERVES the model, with its own provenance', () => {
    const target = resolveSubagentTarget({
      role: 'code-reviewer',
      phase: '03',
      policy: {
        ...loadRouterPolicy(),
        role_routes: {
          'code-reviewer': { enabled: true, mode: 'native', cli: null, model: 'role-model', modelProvider: 'deepseek-official', fallback: 'self-audit' },
        },
      },
      ladderProvider: 'spawn',
    })
    expect(target.modelProvider).toBe('deepseek-official')
    expect(target.chosenModelProvider).toBe('role')
    expect(target.reason).toContain('served by deepseek-official')
  })

  it('⚠ THE FLOOR NAMES THE SESSION MODEL instead of saying “the session default” and naming nothing', () => {
    const target = resolveSubagentTarget({
      role: 'analyst',
      phase: '03',
      policy: loadRouterPolicy(),
      ladderProvider: 'spawn',
      sessionModel: SESSION,
    })
    expect(target.model).toBeNull()
    expect(target.effectiveModel).toBe('deepseek-official/deepseek-flash')
    expect(target.reason).toContain('inherits the session default')
    expect(target.reason, 'the inherited model is NAMED when it could be read').toContain('deepseek-flash')
  })

  it('and with NO reading it reports UNKNOWN rather than substituting a plausible model', () => {
    const target = resolveSubagentTarget({ role: 'analyst', policy: loadRouterPolicy(), ladderProvider: 'spawn' })
    expect(target.effectiveModel).toContain('UNKNOWN')
    expect(target.reason).toContain('rather than naming a model it did not read')
  })

  it('the general default still sits BELOW the role and ABOVE the session', () => {
    const target = resolveSubagentTarget({
      role: 'implementer',
      phase: '03',
      policy: { ...loadRouterPolicy(), defaults: { ...base, subagent: { model: 'general-model' } } },
      ladderProvider: 'spawn',
      sessionModel: SESSION,
    })
    expect(target.model).toBe('general-model')
    expect(target.chosen.model).toBe('general')
  })
})

