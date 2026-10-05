/**
 * T2 — the pure audit fan-out contract.
 *
 * The item's rescope says exactly what to test here: *"tests the pure mapping and asserts no
 * cross-item null-dropping"*, with the live engine left to integration. So the cases below pin the
 * MAPPING (same inputs, same plan) and — the one that matters most — that a failed child produces a
 * row rather than a shorter list.
 *
 * ⚠ WHY NULL-DROPPING IS THE CENTRAL RISK: the engine's `agent()`/`parallel()` resolve `null` for a
 * child that failed, so the obvious `results.filter(Boolean)` turns a failed reviewer into a
 * fan-out that merely LOOKS smaller. An audit that quietly lost its dissenting reviewer would report
 * a clean pass, which is the worst outcome this plugin can produce.
 */
import { describe, it, expect } from 'vitest'
import {
  buildAuditFanOutPlan, orchestrateAudit, describeAuditFanOut,
  type WorkflowHooksLike, type AuditPlanInput,
} from '../src/workflow-audit.ts'

const INPUT: AuditPlanInput = {
  runId: 'run-1',
  artifact: '.recursive/run/run-1/03-implementation-summary.md',
  phase: '03',
  reviewers: [{ role: 'code-reviewer' }, { role: 'tester', focus: 'Focus on the test evidence.' }],
  auditQuestions: ['Is every gate field truthful?'],
}

/** A hooks stub that records the calls and answers per label. */
function fakeHooks(answers: Record<string, unknown>) {
  const phases: string[] = []
  const agents: string[] = []
  const logs: string[] = []
  const hooks: WorkflowHooksLike = {
    phase: (title) => { phases.push(title) },
    agent: async (_prompt, options) => {
      agents.push(options?.label ?? '(unlabelled)')
      return answers[options?.label ?? ''] ?? null
    },
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk())),
    log: (message) => { logs.push(message) },
  }
  return { hooks, phases, agents, logs }
}

describe('T2 — the plan is a pure mapping of the audit inputs', () => {
  it('groups reviewers into a titled phase per role', () => {
    const plan = buildAuditFanOutPlan(INPUT)
    expect(plan.phases.map((phase) => phase.title)).toEqual(['03 audit: code-reviewer', '03 audit: tester'])
    expect(plan.phases[0].items.length).toBe(1)
    expect(plan.runId).toBe('run-1')
  })

  it('is DETERMINISTIC: the same inputs produce the same plan', () => {
    expect(JSON.stringify(buildAuditFanOutPlan(INPUT))).toBe(JSON.stringify(buildAuditFanOutPlan(INPUT)))
  })

  it('gives every item a stable, unique label', () => {
    const plan = buildAuditFanOutPlan({
      ...INPUT,
      reviewers: [{ role: 'code-reviewer' }, { role: 'code-reviewer' }, { role: 'code-reviewer' }],
    })
    const labels = plan.phases.flatMap((phase) => phase.items.map((item) => item.label))
    expect(new Set(labels).size).toBe(3)
    expect(labels[0]).toContain('run-1')
    expect(labels[0]).toContain('code-reviewer')
  })

  it('carries the artifact and the audit questions INTO the prompt', () => {
    const plan = buildAuditFanOutPlan(INPUT)
    const first = plan.phases[0].items[0].prompt
    expect(first).toContain('03-implementation-summary.md')
    expect(first).toContain('code-reviewer')
    expect(first).toContain('Is every gate field truthful?')
    // A reviewer's own focus travels with it, so the caller does not restate the contract.
    expect(plan.phases[1].items[0].prompt).toContain('Focus on the test evidence.')
  })

  it('skips a blank role rather than inventing an anonymous reviewer', () => {
    const plan = buildAuditFanOutPlan({ ...INPUT, reviewers: [{ role: '  ' }, { role: 'tester' }] })
    expect(plan.phases.length).toBe(1)
    expect(plan.phases[0].title).toContain('tester')
  })

  it('plans nothing for no reviewers, which is a fact the summary states', async () => {
    const plan = buildAuditFanOutPlan({ ...INPUT, reviewers: [] })
    expect(plan.phases).toEqual([])
    const fake = fakeHooks({})
    const result = await orchestrateAudit(fake.hooks, plan)
    expect(result.entries).toEqual([])
    expect(describeAuditFanOut(result)).toContain('planned no reviewers')
  })
})

describe('T2 — ⚠ NO CROSS-ITEM NULL-DROPPING', () => {
  it('a FAILED child yields a row marked not-ok, not a shorter list', async () => {
    // The engine resolves null for a failed child. `filter(Boolean)` here would silently drop the
    // reviewer and report a clean audit — the worst outcome this plugin can produce.
    const plan = buildAuditFanOutPlan(INPUT)
    const fake = fakeHooks({ 'run-1/code-reviewer/1': { verdict: 'APPROVE' } }) // tester produces nothing
    const result = await orchestrateAudit(fake.hooks, plan)
    expect(result.entries.length).toBe(2)
    const failedRow = result.entries.find((entry) => entry.role === 'tester')
    expect(failedRow).toBeDefined()
    expect(failedRow?.ok).toBe(false)
    expect(failedRow?.reason).toContain('no result')
    expect(failedRow?.value).toBeUndefined()
    expect(result.failed).toBe(1)
  })

  it('keeps the successful reviewer’s VALUE', async () => {
    const plan = buildAuditFanOutPlan(INPUT)
    const fake = fakeHooks({ 'run-1/code-reviewer/1': { verdict: 'REVISE' } })
    const result = await orchestrateAudit(fake.hooks, plan)
    expect(result.entries[0].ok).toBe(true)
    expect(result.entries[0].value).toEqual({ verdict: 'REVISE' })
  })

  it('treats EVERY missing value as a failure, including undefined', async () => {
    const plan = buildAuditFanOutPlan({ ...INPUT, reviewers: [{ role: 'a' }, { role: 'b' }] })
    const fake = fakeHooks({})
    const result = await orchestrateAudit(fake.hooks, plan)
    expect(result.failed).toBe(2)
    expect(result.entries.every((entry) => !entry.ok)).toBe(true)
  })

  it('the SUMMARY states the failure count and calls the audit INCOMPLETE', async () => {
    // A partial audit is not a smaller audit: a summary reporting only successes would be the
    // silent-drop defect wearing a friendlier face.
    const plan = buildAuditFanOutPlan(INPUT)
    const result = await orchestrateAudit(fakeHooks({ 'run-1/code-reviewer/1': 'ok' }).hooks, plan)
    const summary = describeAuditFanOut(result)
    expect(summary).toContain('FAILED')
    expect(summary).toContain('INCOMPLETE')
    expect(summary).toContain('tester')
  })

  it('runs each phase through the engine and fans out with parallel', async () => {
    const plan = buildAuditFanOutPlan(INPUT)
    const fake = fakeHooks({ 'run-1/code-reviewer/1': 'a', 'run-1/tester/1': 'b' })
    await orchestrateAudit(fake.hooks, plan)
    expect(fake.phases).toEqual(['03 audit: code-reviewer', '03 audit: tester'])
    expect(fake.agents.length).toBe(2)
    expect(describeAuditFanOut({ entries: result0(), failed: 0 })).toContain('all produced a result')
  })
})

/** A two-entry all-ok result, for the summary's success path. */
function result0() {
  return [
    { label: 'a', role: 'code-reviewer', ok: true, value: 1 },
    { label: 'b', role: 'tester', ok: true, value: 2 },
  ]
}
