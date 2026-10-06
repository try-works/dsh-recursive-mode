import { describe, expect, it } from 'vitest'
import { CIRCULAR_MARKER, toLosslessJson } from '../src/json-safe.ts'

/**
 * FU-9 — THE RESULT THAT BROKE THE TOOL CONTRACT.
 *
 * Measured live: the host refused a review result with `invalid output: value is not lossless JSON`
 * (ToolOutputError, INVALID_TOOL_OUTPUT), because the tool returned its service result through a type cast.
 * These tests hold the projection to the two properties that matter: it ALWAYS produces something
 * `JSON.stringify` accepts, and it keeps the data a caller needs rather than dropping the object wholesale.
 */
describe('FU-9: the lossless-JSON projection', () => {
  /** An object shaped like the thing that broke it: data, a method, and a cycle. */
  function agentLike(): Record<string, unknown> {
    const agent: Record<string, unknown> = { id: 'child-42', stopReason: 'completed' }
    agent.self = agent
    agent.run = () => 'not serialisable'
    Object.defineProperty(agent, 'handle', { value: { internal: true }, enumerable: false })
    return agent
  }

  it('survives what broke the tool: a cycle, a function and a class instance', () => {
    const projected = toLosslessJson(agentLike())
    expect(() => JSON.stringify(projected)).not.toThrow()
    const text = JSON.stringify(projected)
    // The DATA is kept…
    expect(text).toContain('child-42')
    expect(text).toContain('completed')
    // …the cycle is a visible marker rather than a crash…
    expect(projected).toMatchObject({ self: CIRCULAR_MARKER })
    // …the method is gone, because a function has no JSON form…
    expect(projected).not.toHaveProperty('run')
    // …and a non-enumerable property was never the projection's business.
    expect(projected).not.toHaveProperty('handle')
  })

  it('projects a real class instance to its own data', () => {
    class Seam {
      readonly name = 'spawn'
      capabilities = { agentOptions: true }
      start(): void { /* a method, not data */ }
    }
    const projected = toLosslessJson(new Seam())
    expect(projected).toEqual({ name: 'spawn', capabilities: { agentOptions: true } })
    expect(JSON.stringify(projected)).not.toContain('start')
  })

  it('keeps the round data a caller reads, which is why the field is projected and not deleted', () => {
    const outcome = {
      status: 'unavailable',
      rounds: [{ text: 'review this', result: agentLike() }],
      message: 'named reason',
    }
    const projected = toLosslessJson(outcome) as Record<string, unknown>
    const text = JSON.stringify(projected)
    expect(text).toContain('unavailable')
    expect(text).toContain('named reason')
    expect(text).toContain('review this')
    expect(text).toContain('child-42')
  })

  it('handles the awkward primitives instead of throwing on them', () => {
    expect(toLosslessJson(undefined)).toBeNull()
    expect(toLosslessJson(() => 1)).toBeNull()
    expect(toLosslessJson(Symbol('x'))).toBeNull()
    expect(toLosslessJson(Number.NaN)).toBe('NaN')
    expect(toLosslessJson(10n)).toBe('10')
    expect(toLosslessJson(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01-01T00:00:00.000Z')
    expect(toLosslessJson(new Error('boom'))).toBe('boom')
    // An array element with no JSON form is DROPPED rather than nulled, because null would claim it existed.
    expect(toLosslessJson([1, () => 1, 'two'])).toEqual([1, 'two'])
  })

  it('never throws on a hostile object, including a getter that does', () => {
    const hostile: Record<string, unknown> = { fine: 1 }
    Object.defineProperty(hostile, 'explodes', { get(): never { throw new Error('no') }, enumerable: true })
    let projected: unknown
    expect(() => { projected = toLosslessJson(hostile) }).not.toThrow()
    expect(projected).toEqual({ fine: 1 })
  })
})
