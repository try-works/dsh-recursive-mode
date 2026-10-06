import { describe, expect, it } from 'vitest'
import { buildWorkSlice } from '../src/handoff.ts'
import { CURRENT_WORKFLOW_PROFILE, getArtifactRequiredSections } from '../src/phase-rules.ts'

/**
 * FU-17 step 2 — THE WORK BRIEF TELLS THE CHILD THE STANDARD.
 *
 * The failure this prevents is specific and boring: a child is asked to implement a phase and is never told which
 * sections the artifact will be linted for, so it writes something plausible and the phase fails its gate. That
 * is why the slice composes `getArtifactRequiredSections` instead of restating the sections — the tests below
 * assert the COMPOSITION (the same list the linter uses), not a hand-written copy that could drift.
 */
describe('FU-17: the work brief', () => {
  const artifact = '03-implementation-summary.md'

  it('lists the sections the linter will require, taken from the same source', () => {
    const required = getArtifactRequiredSections(artifact, CURRENT_WORKFLOW_PROFILE)
    const slice = buildWorkSlice({
      instruction: 'Implement the plan.',
      artifactFile: artifact,
      phase: '03',
      requiredSections: required,
    })
    expect(required.length).toBeGreaterThan(0)
    for (const section of required) expect(slice, 'missing section: ' + section).toContain('- ' + section)
  })

  it('carries the task verbatim and names the artifact', () => {
    const slice = buildWorkSlice({
      instruction: 'Add the rollback path the plan describes.',
      artifactFile: artifact,
      phase: '03',
      requiredSections: ['Sub-phase'],
    })
    expect(slice).toContain('Add the rollback path the plan describes.')
    expect(slice).toContain(artifact)
    expect(slice).toContain('phase `03`')
  })

  it('says it is WORK, not a review, and says who decides', () => {
    const slice = buildWorkSlice({ instruction: 'x', artifactFile: artifact, phase: '03', requiredSections: [] })
    expect(slice).toContain('not reviewing it')
    expect(slice.toUpperCase()).toContain('MAIN AGENT')
    expect(slice, 'the child must know feedback returns to the same child').toContain('the same child')
  })

  it('degrades honestly when no section map exists, rather than inventing sections', () => {
    const slice = buildWorkSlice({ instruction: 'x', artifactFile: '99-unknown.md', phase: '99', requiredSections: [] })
    expect(slice).toContain('no section map for this artifact')
  })

  it('includes the phase gates when they are supplied, and omits the heading when they are not', () => {
    const withGates = buildWorkSlice({ instruction: 'x', artifactFile: artifact, phase: '03', requiredSections: [], lintNotes: ['Coverage Gate: state it'] })
    expect(withGates).toContain('## Phase Gates')
    expect(withGates).toContain('Coverage Gate: state it')
    const without = buildWorkSlice({ instruction: 'x', artifactFile: artifact, phase: '03', requiredSections: [] })
    expect(without).not.toContain('## Phase Gates')
  })

  it('does NOT carry the reviewer framing — the two briefs are different documents', () => {
    const slice = buildWorkSlice({ instruction: 'x', artifactFile: artifact, phase: '03', requiredSections: [] })
    expect(slice.toLowerCase()).not.toContain('anti-pattern')
    expect(slice.toLowerCase()).not.toContain('verdict:')
  })
})
