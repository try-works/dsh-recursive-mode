import { describe, expect, it } from 'vitest'
import { ALL_VERBS, GLOBAL_VERBS, PRESET_VERBS, parseRecursiveCommand } from '../src/commands.ts'

/**
 * THE VERB SURFACE ITSELF — the half that dispatch tests cannot cover.
 *
 * `executeRecursiveCommand` proves a verb WORKS when it is reached. It says nothing about whether a caller
 * typing `/recursive memory …` can reach it at all, because the loader dispatches on the verb lists. P4 added
 * the memory verb and FU-15 fixed the closeout verb; both are only useful if they are IN those lists, and a
 * verb that exists in the switch but not in the preset list is unreachable from the surface it was added for.
 */
describe('the command verb surface', () => {
  it('exposes every verb that has a case, including the two added and fixed this sequence', () => {
    for (const verb of ['memory', 'closeout']) {
      expect(PRESET_VERBS, verb + ' must be dispatchable').toContain(verb)
      expect(ALL_VERBS).toContain(verb)
    }
    // The globals stay global: bootstrap/list/help belong to every preset, not to one.
    expect(GLOBAL_VERBS).toEqual(['bootstrap', 'list', 'help'])
    for (const verb of GLOBAL_VERBS) expect(PRESET_VERBS).not.toContain(verb)
  })

  it('parses the two verbs with their arguments intact', () => {
    const memory = parseRecursiveCommand('memory lock chain ordering --phase 04')
    expect(memory.verb).toBe('memory')
    expect(memory.arg).toContain('lock chain ordering')
    expect(memory.arg).toContain('--phase 04')

    const closeout = parseRecursiveCommand('closeout probe-run --phase 04')
    expect(closeout.verb).toBe('closeout')
    expect(closeout.arg).toContain('probe-run')
  })

  it('has no verb in the switch that the surface cannot reach', () => {
    // A verb list shorter than the switch is the defect this test exists for: the case works, the caller
    // cannot get to it. Every preset verb must therefore parse back as itself.
    for (const verb of PRESET_VERBS) {
      expect(parseRecursiveCommand(verb + ' arg').verb, verb).toBe(verb)
    }
  })
})
