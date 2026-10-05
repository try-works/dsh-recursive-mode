/**
 * T24 — the tool-error registry's own contract.
 *
 * The registry exists so a refusal is a single greppable sentence with a route
 * out. These tests pin the properties that make it usable by something that is
 * NOT an LLM (a test, a board badge, a log grep): the leading code is stable and
 * parseable, the class vocabulary is closed, the codes are unique, and every
 * entry renders a `Next:` clause.
 */
import { describe, it, expect } from 'vitest'
import { TOOL_ERRORS, toolError, hasToolErrorCode, type ToolErrorSpec } from '../src/errors.ts'

const ENTRIES = Object.entries(TOOL_ERRORS) as [string, ToolErrorSpec][]
const CLASSES = ['input', 'value', 'workspace', 'state', 'runtime', 'capability']

describe('T24 — tool-error registry', () => {
  it('is non-empty and every entry is complete', () => {
    expect(ENTRIES.length).toBeGreaterThan(5)
    for (const [name, spec] of ENTRIES) {
      expect(spec.code, name + ' code').toMatch(/^RM\d{4}$/)
      expect(spec.problem.trim(), name + ' problem').not.toBe('')
      expect(spec.next.trim(), name + ' next').not.toBe('')
      expect(CLASSES, name + ' class').toContain(spec.klass)
      // No trailing punctuation: the renderer owns the sentence.
      expect(spec.problem, name + ' problem punctuation').not.toMatch(/[.!]$/)
      expect(spec.next, name + ' next punctuation').not.toMatch(/[.!]$/)
    }
  })

  it('codes are unique and the group digit matches the class', () => {
    const codes = ENTRIES.map(([, spec]) => spec.code)
    expect(new Set(codes).size).toBe(codes.length)
    // RM<group><serial>: 1 input, 2 value, 3 workspace, 4 state, 5 runtime, 6 capability.
    const groupOf: Record<string, string> = { input: '1', value: '2', workspace: '3', state: '4', runtime: '5', capability: '6' }
    for (const [name, spec] of ENTRIES) {
      expect(spec.code[2], name + ' group digit').toBe(groupOf[spec.klass])
    }
  })

  it('renders ONE sentence beginning with the stable code and class', () => {
    const rendered = toolError('MISSING_RUN_ID')
    expect(rendered.startsWith('RM1101 input: ')).toBe(true)
    expect(rendered).toContain('Next: ')
    expect(rendered.endsWith('.')).toBe(true)
    // Exactly one sentence break: the one the renderer inserts before `Next:`.
    // The registry's own problem/next strings are asserted punctuation-free above,
    // so a second `. ` would mean an entry smuggled in a sentence of its own.
    expect(rendered.match(/\. /g) ?? []).toHaveLength(1)
  })

  it('carries the run-specific detail without breaking the shape', () => {
    const rendered = toolError('NO_RUN', 'guard-run')
    expect(rendered.startsWith('RM4401 state: ')).toBe(true)
    expect(rendered).toContain('guard-run')
    expect(rendered).toContain('Next: call recursive_init')
    // An empty or whitespace detail must not leave a dangling separator.
    expect(toolError('NO_RUN', '   ')).not.toContain(' - ')
    expect(toolError('NO_RUN')).toBe(toolError('NO_RUN', ''))
  })

  it('every entry renders a well-formed sentence (nothing manually assembled)', () => {
    for (const [name] of ENTRIES) {
      const rendered = toolError(name as keyof typeof TOOL_ERRORS)
      expect(rendered, name).toMatch(/^RM\d{4} [a-z]+: .+\. Next: .+\.$/)
    }
  })

  it('every Next: clause names a real tool call or an explicit action', () => {
    // A route that names no call is a refusal the caller can only guess at.
    for (const [name, spec] of ENTRIES) {
      const routes = spec.next
      const namesCall = /recursive_[a-z_]+/.test(routes)
      const namesAction = /\b(pass|open|use|mount|fix)\b/.test(routes)
      expect(namesCall || namesAction, name + ' route: ' + routes).toBe(true)
    }
  })

  it('detects an already-coded message so callers never double-wrap', () => {
    expect(hasToolErrorCode(toolError('NO_RUN'))).toBe(true)
    expect(hasToolErrorCode('  RM2201 value: x')).toBe(true)
    expect(hasToolErrorCode('Artifact not found: 02-to-be-plan.md')).toBe(false)
    // A lookalike that is not a code at the start must not be treated as one.
    expect(hasToolErrorCode('see RM1101 for details')).toBe(false)
  })
})
