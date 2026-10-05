/**
 * T17 — the phase dependency as a GRAPH, not a flat sequence.
 *
 * WHY. Three core queries in this plugin are graph operations being run over a linear array:
 * `getStaleDownstreamPhases` is a REACHABILITY query, `getPrerequisites` is an IN-EDGE query, and
 * `getNextLegalPhase` is a topological walk. An array can answer all three only while the dependency
 * happens to be linear — and the moment an artifact depends on something LATER than itself (an
 * addendum written to close an upstream gap), the array model answers *wrongly* rather than not at
 * all. That is the case this module exists to get right.
 *
 * ⚠ A HAND-ROLLED GRAPH, DELIBERATELY. The item's note is explicit: Effect ships a stable,
 * runtime-free `Graph` doing exactly this, and adopting it would trade this plugin's zero-dependency
 * posture and its parity goldens for a few hundred lines it does not need. The queries below are
 * small because the graph is small.
 *
 * ⚠ BACK-EDGES ARE FIRST-CLASS, NOT AN ERROR. An `upstream-gap` addendum legitimately points at a
 * LATER artifact: the gap was discovered downstream and must be closed upstream. A depth-first walk
 * with a VISITED set answers reachability over such a graph; a walk without one loops forever, and an
 * array cannot express the edge at all.
 */

/** One node: an artifact on disk, or one being asked about before it exists. */
export interface PhaseNode {
  /** Artifact file name, the node's identity. */
  id: string
  /** Position in the canonical sequence — used for ordering, NOT as the dependency model. */
  index: number
  /** Whether the artifact is on disk. A queried, absent node emits no prerequisite edge. */
  present?: boolean
  /** Whether the artifact is locked, when the caller knows. */
  locked?: boolean
}

/** One directed edge: `to` depends on `from`. */
export interface PhaseEdge {
  from: string
  to: string
  /** `prerequisite` — an earlier artifact that must be locked first. `addendum` — a cited dependency. */
  kind: 'prerequisite' | 'addendum'
}

export interface PhaseGraph {
  nodes: PhaseNode[]
  edges: PhaseEdge[]
}

/**
 * Build the graph for one run.
 *
 * `sequence` is the canonical phase order; `present` is what exists on disk, so a phase that was
 * never created is not a node and cannot be waited on forever. `addenda` are the cited dependencies a
 * document declares — including ones pointing FORWARD, which is what makes the graph a graph.
 */
export function buildPhaseGraph(input: {
  sequence: readonly string[]
  present: readonly string[]
  locked?: readonly string[]
  /** Declared dependencies: `from` must be settled before `to`. Order is irrelevant. */
  citations?: ReadonlyArray<{ from: string; to: string }>
  /**
   * Artifacts to answer ABOUT, whether or not they exist yet.
   *
   * ⚠ THIS EXISTS BECAUSE OF A MEASURED PARITY FAILURE, and it is the item's central modelling gap:
   * with nodes limited to what is present, a query about an artifact **that does not exist yet**
   * found no in-edges and answered `[]` — but checking prerequisites **before creating** the artifact
   * is the NORMAL case, so that made every pre-write check silently vacuous. A queried node is
   * therefore a node for EDGE TARGETS ONLY: it emits no outgoing prerequisite edge, because an
   * artifact that does not exist cannot block anything.
   */
  queried?: readonly string[]
}): PhaseGraph {
  const presentSet = new Set(input.present)
  const lockedSet = new Set(input.locked ?? [])
  const queriedSet = new Set(input.queried ?? [])
  const nodes: PhaseNode[] = input.sequence
    .map((id, index) => ({ id, index }))
    .filter((node) => presentSet.has(node.id) || queriedSet.has(node.id))
    .map((node) => ({
      ...node,
      // `present` is what makes the source rule below possible: a queried-but-absent node is a
      // question, not a dependency.
      present: presentSet.has(node.id),
      locked: lockedSet.has(node.id),
    }))

  const indexOf = new Map(input.sequence.map((id, index) => [id, index]))
  const ids = new Set(nodes.filter((node) => node.present === true).map((node) => node.id))
  const edges: PhaseEdge[] = []

  // PREREQUISITE edges: every earlier PRESENT artifact blocks this one. Restricted to what exists so a
  // missing phase cannot hold a run hostage, and emitted only FROM present nodes so a queried one
  // cannot appear as anybody's prerequisite.
  for (const node of nodes) {
    for (const other of nodes) {
      if (other.present !== true) continue
      if (other.index < node.index) edges.push({ from: other.id, to: node.id, kind: 'prerequisite' })
    }
  }

  // ADDENDUM edges: the declared citations, in either direction. Deduplicated so a citation that
  // coincides with a prerequisite is ONE edge, not two.
  const seen = new Set(edges.map((edge) => edge.from + '\u0000' + edge.to))
  for (const citation of input.citations ?? []) {
    if (!ids.has(citation.from) || !ids.has(citation.to)) continue
    const key = citation.from + '\u0000' + citation.to
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ from: citation.from, to: citation.to, kind: 'addendum' })
  }

  return { nodes, edges }
}

/** The nodes that must be settled before `id` — the IN-EDGE query. */
export function prerequisitesOf(graph: PhaseGraph, id: string): string[] {
  return graph.edges.filter((edge) => edge.to === id).map((edge) => edge.from)
}

/** The artifacts that depend, directly, on `id` — the OUT-EDGE query. */
export function dependentsOf(graph: PhaseGraph, id: string): string[] {
  return graph.edges.filter((edge) => edge.from === id).map((edge) => edge.to)
}

/**
 * Everything reachable downstream of `id` — the REACHABILITY query behind `getStaleDownstreamPhases`.
 *
 * ⚠ The VISITED set is load-bearing, not defensive: a back-edge makes the graph cyclic, and a walk
 * without a visited set recurses forever on exactly the input this item exists to support.
 */
export function reachableFrom(graph: PhaseGraph, id: string): string[] {
  const seen = new Set<string>()
  const queue = [id]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const next of dependentsOf(graph, current)) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  seen.delete(id)
  return graph.nodes.map((node) => node.id).filter((nodeId) => seen.has(nodeId))
}

/**
 * The next phase a run may work on.
 *
 * ⚠ THIS MODELS THE SHIPPED RULES EXACTLY, because `lock.ts` delegates to it and `lock.parity.spec.ts`
 * is the proof. Three of them are easy to miss and are asserted in the spec:
 *   1. a LOCKED node is skipped;
 *   2. a node that is **absent and declared OPTIONAL** is skipped — an optional phase nobody created
 *      must not stop the run;
 *   3. if the first node that survives 1 and 2 has a prerequisite that is not LOCKED, the answer is
 *      **`null`, NOT the next node** — the run is BLOCKED, and returning the node after it would
 *      silently skip a dependency.
 *
 * ⚠ RULE 3 IS WHERE A GRAPH EARNS ITS KEEP, and it is invisible in a linear array: with a back-edge
 * (an `upstream-gap` addendum citing a LATER artifact), an EARLY unlocked node can be blocked by a
 * LATER one — so "continue to the next node" and "blocked, report null" give different answers, and
 * only the second is correct.
 *
 * Nodes must cover the whole sequence for this query (an absent, required phase is a legitimate
 * answer); `queried` is how the caller supplies them.
 */
export function nextLegalPhase(
  graph: PhaseGraph,
  options: { optional?: ReadonlySet<string> } = {},
): string | null {
  const optional = options.optional ?? new Set<string>()
  const locked = new Set(graph.nodes.filter((node) => node.locked === true).map((node) => node.id))
  const ordered = [...graph.nodes].sort((a, b) => a.index - b.index)
  for (const node of ordered) {
    if (locked.has(node.id)) continue
    if (node.present !== true && optional.has(node.id)) continue
    const blocked = prerequisitesOf(graph, node.id).some((from) => !locked.has(from))
    if (blocked) return null
    return node.id
  }
  return null
}

/**
 * Whether the graph has a back-edge — an edge pointing at a LATER phase than its source.
 *
 * Reported rather than hidden: a back-edge is legitimate (an upstream gap), and it is exactly the
 * shape a linear model cannot represent. A caller that wants to warn about it should be able to ask.
 */
export function backEdges(graph: PhaseGraph): PhaseEdge[] {
  const indexOf = new Map(graph.nodes.map((node) => [node.id, node.index]))
  return graph.edges.filter((edge) => (indexOf.get(edge.to) ?? 0) < (indexOf.get(edge.from) ?? 0))
}
