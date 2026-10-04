/**
 * LIVE BUG 6 (0.2.1): the agent/pre-step lint-rules reminder must inject AT MOST
 * ONCE PER PHASE. ReminderOnceGate keys by (root, runId, phase) so each new run
 * or phase transition gets its own single injection while re-arming steps in the
 * SAME phase stay silent.
 */
import { describe, it, expect } from 'vitest'
import { ReminderOnceGate } from '../src/phase-rules.ts'

describe('ReminderOnceGate — once per (root, runId, phase)', () => {
  it('injects once, then stays silent for the same key', () => {
    const gate = new ReminderOnceGate()
    expect(gate.shouldInject('/repo', 'run-09', '03-implementation-summary.md')).toBe(true)
    expect(gate.shouldInject('/repo', 'run-09', '03-implementation-summary.md')).toBe(false)
    expect(gate.shouldInject('/repo', 'run-09', '03-implementation-summary.md')).toBe(false)
  })

  it('a phase transition gets its own single injection (same run)', () => {
    const gate = new ReminderOnceGate()
    gate.shouldInject('/repo', 'run-09', '03-implementation-summary.md')
    expect(gate.shouldInject('/repo', 'run-09', '04-test-summary.md')).toBe(true)
    expect(gate.shouldInject('/repo', 'run-09', '04-test-summary.md')).toBe(false)
  })

  it('a different runId gets its own injection', () => {
    const gate = new ReminderOnceGate()
    gate.shouldInject('/repo', 'run-08', '03-implementation-summary.md')
    expect(gate.shouldInject('/repo', 'run-09', '03-implementation-summary.md')).toBe(true)
  })

  it('a different root gets its own injection', () => {
    const gate = new ReminderOnceGate()
    gate.shouldInject('/repo-a', 'run-09', '03-implementation-summary.md')
    expect(gate.shouldInject('/repo-b', 'run-09', '03-implementation-summary.md')).toBe(true)
  })
})
