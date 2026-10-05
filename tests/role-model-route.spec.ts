/**
 * T9 — the per-role model decision, and the honest statement of where the choice is made.
 *
 * The properties under test are the ones that keep a role mapping from becoming a guess: an
 * unknown role is FLAGGED rather than assumed, an unset model is reported as UNSET rather than
 * defaulted to something plausible, and the review/repair split is stated as being IN EFFECT or
 * NOT rather than left for a reader to infer.
 */
import { describe, it, expect } from 'vitest'
import { roleKindOf, routeForRole, modelForRole } from '../src/role-route.ts'
import type { RouterPolicy } from '../src/router.ts'

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
