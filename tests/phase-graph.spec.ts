/**
 * T17 — the phase graph.
 *
 * The three RED clauses, plus the case the array model gets WRONG: a back-edge (an `upstream-gap`
 * addendum pointing at a later phase). A linear model cannot express such an edge, so it answers
 * wrongly rather than not at all — and `reachableFrom` must not loop on it, which is why the visited
 * set is asserted with a graph that would recurse forever without one.
 */
import { describe, it, expect } from 'vitest'
import {
  buildPhaseGraph, prerequisitesOf, dependentsOf, reachableFrom, nextLegalPhase, backEdges,
} from '../src/phase-graph.ts'

const SEQUENCE = ['00-requirements.md', '00-worktree.md', '01-as-is.md', '02-to-be-plan.md', '03-implementation-summary.md']

function linear(present = SEQUENCE, locked: string[] = []) {
  return buildPhaseGraph({ sequence: SEQUENCE, present, locked })
}

describe('T17 — a linear run behaves exactly as the array did', () => {
  it('starts at the first present, unlocked artifact', () => {
    expect(nextLegalPhase(linear())).toBe('00-requirements.md')
  })

  it('walks the sequence as locks accumulate', () => {
    expect(nextLegalPhase(linear(SEQUENCE, ['00-requirements.md']))).toBe('00-worktree.md')
    expect(nextLegalPhase(linear(SEQUENCE, ['00-requirements.md', '00-worktree.md']))).toBe('01-as-is.md')
  })

  it('answers with NULL when everything present is locked, rather than inventing a phase', () => {
    // Inventing one would make "done" indistinguishable from "stuck".
    expect(nextLegalPhase(linear(SEQUENCE, [...SEQUENCE]))).toBeNull()
  })

  it('does not wait on a phase that was never created', () => {
    // `00-worktree.md` is absent, so it is not a node and cannot block anything forever.
    const graph = buildPhaseGraph({ sequence: SEQUENCE, present: ['00-requirements.md', '01-as-is.md'] })
    expect(nextLegalPhase(graph)).toBe('00-requirements.md')
    expect(nextLegalPhase(buildPhaseGraph({
      sequence: SEQUENCE, present: ['00-requirements.md', '01-as-is.md'], locked: ['00-requirements.md'],
    }))).toBe('01-as-is.md')
  })

  it('answers the in-edge and out-edge queries', () => {
    const graph = linear()
    expect(prerequisitesOf(graph, '02-to-be-plan.md')).toEqual(['00-requirements.md', '00-worktree.md', '01-as-is.md'])
    expect(dependentsOf(graph, '01-as-is.md')).toEqual(['02-to-be-plan.md', '03-implementation-summary.md'])
    expect(prerequisitesOf(graph, '00-requirements.md')).toEqual([])
  })
})

describe('T17 — reachability, and the back-edge the ARRAY MODEL gets wrong', () => {
  it('reaches every downstream artifact in a linear run', () => {
    const graph = linear()
    expect(reachableFrom(graph, '01-as-is.md')).toEqual(['02-to-be-plan.md', '03-implementation-summary.md'])
    expect(reachableFrom(graph, '03-implementation-summary.md')).toEqual([])
  })

  it('GETS THE BACK-EDGE RIGHT: an upstream-gap addendum points at a LATER phase', () => {
    // `02-to-be-plan.md` cites `03-implementation-summary.md` — the gap was found downstream and must
    // be closed upstream. A linear model cannot express this edge at all.
    const graph = buildPhaseGraph({
      sequence: SEQUENCE,
      present: SEQUENCE,
      citations: [{ from: '03-implementation-summary.md', to: '02-to-be-plan.md' }],
    })
    const back = backEdges(graph)
    expect(back.length).toBe(1)
    expect(back[0]).toEqual({ from: '03-implementation-summary.md', to: '02-to-be-plan.md', kind: 'addendum' })
    // And the earlier phase now waits on the later one, which is the whole point of the edge.
    expect(prerequisitesOf(graph, '02-to-be-plan.md')).toContain('03-implementation-summary.md')
  })

  it('does NOT loop forever on a back-edge — the visited set is load-bearing', () => {
    // Without a visited set this walk recurses on 02 -> 03 -> 02 until the stack dies.
    const graph = buildPhaseGraph({
      sequence: SEQUENCE,
      present: SEQUENCE,
      citations: [
        { from: '03-implementation-summary.md', to: '02-to-be-plan.md' },
        { from: '02-to-be-plan.md', to: '01-as-is.md' },
      ],
    })
    const reached = reachableFrom(graph, '01-as-is.md')
    expect(reached).toContain('02-to-be-plan.md')
    expect(reached).toContain('03-implementation-summary.md')
    // The source is never its own dependent.
    expect(reached).not.toContain('01-as-is.md')
  })

  it('deduplicates a citation that coincides with a prerequisite', () => {
    // One dependency, one edge: two would double-count in every reachability answer.
    const graph = buildPhaseGraph({
      sequence: SEQUENCE,
      present: SEQUENCE,
      citations: [{ from: '01-as-is.md', to: '02-to-be-plan.md' }],
    })
    const edges = graph.edges.filter((edge) => edge.from === '01-as-is.md' && edge.to === '02-to-be-plan.md')
    expect(edges.length).toBe(1)
  })

  it('ignores a citation naming an artifact that is not present', () => {
    // An edge to a non-node would make an absent phase block work forever.
    const graph = buildPhaseGraph({
      sequence: SEQUENCE,
      present: ['00-requirements.md', '01-as-is.md'],
      citations: [{ from: '03-implementation-summary.md', to: '01-as-is.md' }],
    })
    expect(prerequisitesOf(graph, '01-as-is.md')).toEqual(['00-requirements.md'])
  })

  it('reports NO back-edges for a linear run, so the query is not merely always-on', () => {
    expect(backEdges(linear())).toEqual([])
  })
})

/**
 * T17 — answering about an artifact that does NOT exist yet.
 *
 * ⚠ THIS CASE COMES FROM A MEASURED PARITY FAILURE, not from imagination: delegating
 * `getPrerequisites` to this graph made `lock.parity.spec.ts` fail, because nodes limited to what is
 * present cannot answer for a file about to be created — and checking prerequisites BEFORE creating
 * it is the normal case. A queried node is a node for edge TARGETS only.
 */
describe('T17 — the graph can be asked about an artifact that is not on disk', () => {
  it('answers the in-edge query for a file that does not exist yet', () => {
    const graph = buildPhaseGraph({
      sequence: SEQUENCE,
      present: ['00-requirements.md', '01-as-is.md'],
      queried: ['02-to-be-plan.md'],
    })
    // Exactly what the shipped `getPrerequisites` answers, which is the point of the whole case.
    expect(prerequisitesOf(graph, '02-to-be-plan.md')).toEqual(['00-requirements.md', '01-as-is.md'])
  })

  it('does NOT let a queried, absent node become anybody’s prerequisite', () => {
    // An artifact that does not exist cannot block anything: it is a question, not a dependency.
    const graph = buildPhaseGraph({
      sequence: SEQUENCE,
      present: ['00-requirements.md', '01-as-is.md'],
      queried: ['02-to-be-plan.md'],
    })
    expect(dependentsOf(graph, '02-to-be-plan.md')).toEqual([])
    for (const id of ['00-requirements.md', '01-as-is.md']) {
      expect(prerequisitesOf(graph, id)).not.toContain('02-to-be-plan.md')
    }
  })

  it('still ignores a citation naming an absent artifact even when it is queried', () => {
    const graph = buildPhaseGraph({
      sequence: SEQUENCE,
      present: ['00-requirements.md'],
      queried: ['02-to-be-plan.md'],
      citations: [{ from: '03-implementation-summary.md', to: '02-to-be-plan.md' }],
    })
    expect(prerequisitesOf(graph, '02-to-be-plan.md')).toEqual(['00-requirements.md'])
  })
})

/**
 * T17 — the three shipped rules `nextLegalPhase` must reproduce, because `lock.ts` delegates to it.
 *
 * Rule 3 is the one a graph earns its keep on, and it is invisible in a linear array.
 */
describe('T17 — the next-legal-phase rules, including the one only a GRAPH can get right', () => {
  it('skips an ABSENT OPTIONAL phase rather than stopping the run', () => {
    const graph = buildPhaseGraph({ sequence: SEQUENCE, present: ['00-requirements.md'], queried: SEQUENCE, locked: ['00-requirements.md'] })
    // `00-worktree.md` is optional and was never created, so the run moves past it.
    expect(nextLegalPhase(graph, { optional: new Set(['00-worktree.md']) })).toBe('01-as-is.md')
    // Without the optional marking it is a required phase and IS the answer.
    expect(nextLegalPhase(graph)).toBe('00-worktree.md')
  })

  it('answers NULL — not the next node — when the first unlocked node is BLOCKED', () => {
    // ⚠ THE BACK-EDGE CASE. `00-requirements.md` is unlocked and first, but an addendum makes it
    // depend on a LATER artifact that is not locked. "Continue to the next node" would answer
    // `01-as-is.md` and silently skip the dependency; the shipped rule reports BLOCKED.
    //
    // The citation's SOURCE must be PRESENT — a citation comes FROM an artifact that exists, and the
    // builder drops edges from absent nodes. My first fixture got that wrong and the test failed on
    // its own premise rather than on the rule.
    const graph = buildPhaseGraph({
      sequence: SEQUENCE,
      present: ['00-requirements.md', '01-as-is.md', '03-implementation-summary.md'],
      citations: [{ from: '03-implementation-summary.md', to: '00-requirements.md' }],
    })
    expect(backEdges(graph).length).toBe(1)
    expect(nextLegalPhase(graph)).toBeNull()
  })

  it('still returns a node whose prerequisites are all LOCKED', () => {
    const graph = buildPhaseGraph({ sequence: SEQUENCE, present: ['00-requirements.md', '01-as-is.md'], locked: ['00-requirements.md'] })
    expect(nextLegalPhase(graph)).toBe('01-as-is.md')
  })
})
