/**
 * T12 — phase rules as catalogue skills.
 *
 * The properties pinned here are the ones that make the contribution USEFUL rather than merely
 * present: the name is stable and kebab-case (a rule nobody can name is not discoverable), the
 * body actually carries the rules (a catalogue entry that restates the filename would be worse
 * than the grep it replaces), and an absent registry says so instead of silently doing nothing.
 */
import { describe, it, expect } from 'vitest'
import {
  phaseSkillName, phaseSkillRegistration, registerPhaseSkills, describePhaseSkills,
  PHASE_SKILL_PREFIX, type PhaseSkillRegistration,
} from '../src/skills-phase.ts'
import { phaseRulesFor } from '../src/phase-rules.ts'

/** A registry that records what it was handed; register() returns a disposer like the real one. */
function fakeSkills() {
  const seen: PhaseSkillRegistration[] = []
  let disposed = 0
  return {
    seen,
    get disposed() { return disposed },
    registry: {
      register(registration: PhaseSkillRegistration) {
        seen.push(registration)
        return () => { disposed += 1 }
      },
    },
  }
}

describe('T12 — a phase has a stable, addressable skill name', () => {
  it('names the skill after the phase, kebab-case and prefixed', () => {
    expect(phaseSkillName('03-implementation-summary.md')).toBe(PHASE_SKILL_PREFIX + '-03-implementation-summary')
    expect(phaseSkillName('00-requirements.md')).toBe(PHASE_SKILL_PREFIX + '-00-requirements')
  })

  it('keeps a SUB-PHASE distinct instead of colliding it with a whole phase', () => {
    // The dot cannot survive kebab-casing; dropping the number would make 01.5 collide with 01.
    expect(phaseSkillName('01.5-root-cause.md')).toBe(PHASE_SKILL_PREFIX + '-01-5-root-cause')
    expect(phaseSkillName('01.5-root-cause.md')).not.toBe(phaseSkillName('01-as-is.md'))
  })

  it('is STABLE — the same phase always yields the same name', () => {
    // A discoverable rule nobody can name twice is not discoverable.
    expect(phaseSkillName('04-test-summary.md')).toBe(phaseSkillName('04-test-summary.md'))
  })

  it('is kebab-case, which is what the registry addresses skills by', () => {
    expect(phaseSkillName('02-to-be-plan.md')).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })
})

describe('T12 — the skill BODY carries the rules, not a pointer to them', () => {
  it('lists the phase’s required sections and its gates', () => {
    const rules = phaseRulesFor('03-implementation-summary.md')
    const registration = phaseSkillRegistration(rules)
    for (const section of rules.requiredSections) {
      expect(registration.content).toContain(section)
    }
    expect(registration.content).toContain('03-implementation-summary.md')
    // A catalogue entry that only restated the filename would be worse than the grep it replaces.
    expect(registration.content.length).toBeGreaterThan(100)
  })

  it('declares the RUNTIME source, so the registry can tell it from a filesystem skill', () => {
    expect(phaseSkillRegistration(phaseRulesFor('00-requirements.md')).source).toBe('runtime')
  })

  it('describes itself for discovery consumers, naming the gates where there are any', () => {
    const registration = phaseSkillRegistration(phaseRulesFor('03-implementation-summary.md'))
    expect(registration.description).toContain('03-implementation-summary.md')
    expect(registration.whenToUse).toContain('03-implementation-summary.md')
  })

  it('says so when a phase declares no sections rather than emitting an empty list', () => {
    const registration = phaseSkillRegistration({ fileName: 'x.md', label: 'x', requiredSections: [], audited: false, tdd: false, qa: false })
    expect(registration.content).toContain('(none declared for this phase)')
    expect(registration.whenToUse).not.toContain('gate(s)')
  })
})

describe('T12 — registration is wired, and an absent catalogue is not a failure', () => {
  it('registers one skill per phase and hands back its disposers', () => {
    const fake = fakeSkills()
    const result = registerPhaseSkills(fake.registry, ['00-requirements.md', '03-implementation-summary.md'])
    expect(result.skipped).toBe(false)
    expect(result.registered).toEqual([
      PHASE_SKILL_PREFIX + '-00-requirements',
      PHASE_SKILL_PREFIX + '-03-implementation-summary',
    ])
    expect(fake.seen.length).toBe(2)
    // Withdrawable, so a caller can tie the contribution to its own effects.
    expect(result.disposers.length).toBe(2)
    for (const dispose of result.disposers) dispose()
    expect(fake.disposed).toBe(2)
  })

  it('SKIPS cleanly with no registry, and the description says so out loud', () => {
    for (const absent of [null, undefined]) {
      const result = registerPhaseSkills(absent, ['00-requirements.md'])
      expect(result.skipped).toBe(true)
      expect(result.registered).toEqual([])
      expect(describePhaseSkills(result)).toContain('NOT registered')
    }
  })

  it('does not claim success for an empty phase list', () => {
    const fake = fakeSkills()
    const result = registerPhaseSkills(fake.registry, [])
    expect(result.registered).toEqual([])
    expect(result.skipped).toBe(false)
    expect(describePhaseSkills(result)).toContain('0 phase rule skill(s)')
  })

  it('takes its rules from phaseRulesFor, so there is no second copy to drift', () => {
    const fake = fakeSkills()
    registerPhaseSkills(fake.registry, ['02-to-be-plan.md'])
    expect(fake.seen[0].content).toContain(phaseRulesFor('02-to-be-plan.md').requiredSections[0] ?? '')
  })
})
