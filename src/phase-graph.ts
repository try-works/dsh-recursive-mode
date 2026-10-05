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

/** One node: an artifact present on disk. */
export interface PhaseNode {
  /** Artifact file name, the node's identity. */
  id: string
  /** Position in the canonical sequence — used for ordering, NOT as the dependency model. */
  index: number
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
}): PhaseGraph {
  const presentSet = new Set(input.present)
  const lockedSet = new Set(input.locked ?? [])
  const nodes: PhaseNode[] = input.sequence
    .map((id, index) => ({ id, index }))
    .filter((node) => presentSet.has(node.id))
    .map((node) => ({ ...node, locked: lockedSet.has(node.id) }))

  const indexOf = new Map(input.sequence.map((id, index) => [id, index]))
  const ids = new Set(nodes.map((node) => node.id))
  const edges: PhaseEdge[] = []

  // PREREQUISITE edges: every EARLIER PRESENT artifact blocks this one. Restricted to what exists so a
  // missing phase cannot hold a run hostage.
  for (const node of nodes) {
    for (const other of nodes) {
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
 * The next phase a run may work on: the first PRESENT, UNLOCKED node whose prerequisites are locked.
 *
 * A node with no prerequisites is legal by definition, which is what makes a fresh run start rather
 * than deadlock. `null` means nothing is pending — stated rather than approximated, because inventing
 * a phase would make "done" indistinguishable from "stuck".
 */
export function nextLegalPhase(graph: PhaseGraph): string | null {
  const locked = new Set(graph.nodes.filter((node) => node.locked === true).map((node) => node.id))
  for (const node of graph.nodes) {
    if (locked.has(node.id)) continue
    const blocked = prerequisitesOf(graph, node.id).some((from) => !locked.has(from))
    if (!blocked) return node.id
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
