/**
 * T30 — extract learnings at RUN CLOSE: the plugin finally WRITES the memory plane.
 *
 * WHY. The plugin built and linted the memory plane and **never wrote it**. Phase 8 scaffolds
 * `08-memory-impact.md` as a receipt stub and nothing promoted its content into cross-run memory, so
 * every run's lessons died with the run.
 *
 * ⚠ HARD RULE, PRESERVED VERBATIM FROM THE PARENT: **no parameter updates.** *"Learning happens
 * through files, not model mutation."* That is what keeps this plugin TS-only and the memory plane
 * reviewable in git.
 *
 * ⚠ FAIL LOUDLY, NEVER CLAIM SUCCESS. The parent's contract is explicit and this module keeps it as
 * TYPED results rather than prose: an extractor that is unavailable and a run with too little
 * evidence are **different failures with different exit codes** (`2` and `3`), and **in both cases the
 * caller must not claim memory updates**. Every failure path below therefore returns an EMPTY `writes`
 * list — "zero writes" is a property the tests assert by listing the tree, not a promise in a comment.
 *
 * ⚠ THE EXTRACTOR IS PLUGGABLE AND NEVER EMBEDDED. The parent never embeds an LLM client; it delegates
 * through a command (`RECURSIVE_TRAINING_EXTRACTOR_CMD`) or a response file. This module does the
 * same, so a missing extractor is an ordinary, expected condition rather than a bug.
 *
 * ⚠ SUPERSEDE, NEVER DELETE. An update appends a revision and a removal appends a tombstone, so the
 * history of a learning stays readable; and a PINNED entry is untouchable by every automatic path.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The artifact whose lock marks a run as complete enough to learn from. */
export const PHASE8_ARTIFACT = '08-memory-impact.md'

/** The parent's exit codes, kept as names so a caller cannot mistake one failure for the other. */
export const TRAINING_EXIT = {
  /** The extractor could not be reached or run. */
  EXTRACTOR_UNAVAILABLE: 2,
  /** There was not enough evidence to extract anything. */
  INSUFFICIENT_EVIDENCE: 3,
} as const

export type TrainingCode = 'OK' | 'EXTRACTOR_UNAVAILABLE' | 'INSUFFICIENT_EVIDENCE'

export interface TrainingResult {
  code: TrainingCode
  /** The parent's exit code: 0 on success, otherwise 2 or 3. Never a silent success. */
  exit: number
  reason: string
  /** Files written. EMPTY on every failure path — asserted, not promised. */
  writes: string[]
}

/** How many runs have a LOCKED phase-8 artifact. The gate's only input. */
export function countPhase8LockedRuns(root: string, readText: (path: string) => string | null = defaultRead): number {
  const runRoot = join(root, '.recursive', 'run')
  if (!existsSync(runRoot)) return 0
  let count = 0
  for (const entry of readdirSync(runRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const artifact = join(runRoot, entry.name, PHASE8_ARTIFACT)
    if (!existsSync(artifact)) continue
    const text = readText(artifact)
    // A lock is a FIELD, not a filename: `Status: \`LOCKED\`` is what the lock chain writes.
    if (text !== null && /Status:\s*`?LOCKED`?/.test(text)) count += 1
  }
  return count
}

function defaultRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * The gate: extraction needs MORE THAN ONE locked run.
 *
 * ⚠ ONE RUN IS NOT EVIDENCE — it is an anecdote, and a memory file written from a single run would
 * teach the next run that one run's accidents are rules. The parent skips with an explanation rather
 * than extracting from what it has, and this returns the explanation as part of the result.
 */
export function trainingGate(lockedRuns: number): TrainingResult {
  if (lockedRuns < 2) {
    return {
      code: 'INSUFFICIENT_EVIDENCE',
      exit: TRAINING_EXIT.INSUFFICIENT_EVIDENCE,
      reason: 'extraction needs at least two phase-8-locked runs and found ' + lockedRuns
        + '; one run is an anecdote, not evidence',
      writes: [],
    }
  }
  return { code: 'OK', exit: 0, reason: lockedRuns + ' locked runs provide enough evidence', writes: [] }
}

/** A learning candidate, before grouping. */
export interface TrainingItem {
  runId: string
  /** Changed paths or cited files — the stronger signal of which subsystem this belongs to. */
  paths: string[]
  text: string
}

/**
 * Infer the subsystem from changed paths.
 *
 * ⚠ PATHS BEAT PROSE. The parent is explicit that changed paths are the stronger signal, so this
 * prefers them and falls back to a stable `unclassified` bucket rather than guessing from wording —
 * a wrong subsystem files a learning where nobody will look for it.
 */
export function inferSubsystem(item: TrainingItem): string {
  for (const path of item.paths) {
    const match = /^(?:src|packages|apps)\/([^/]+)/.exec(path)
    if (match) return match[1].replace(/\.(ts|tsx|js|mjs|md)$/, '')
    const flat = /^([^/]+)\.(ts|tsx|js|mjs)$/.exec(path)
    if (flat) return flat[1]
  }
  return 'unclassified'
}

export interface TrainingGroup {
  subsystem: string
  items: TrainingItem[]
  /** How many DISTINCT runs contributed. A single-run group must not train on its own. */
  runs: number
  mode: 'contrastive' | 'winner-only'
}

/**
 * Group items by subsystem and decide each group's mode.
 *
 * ⚠ REFUSE TO TRAIN ON A SINGLE-RUN GROUP ALONE. Two items from one run are one observation written
 * twice, so such a group is DROPPED rather than trained on — the parent's rule, and the reason a
 * group reports its distinct-run count. Winners and losers in one group support a CONTRASTIVE
 * learning; otherwise the group is winner-only.
 */
export function groupLearnings(items: readonly TrainingItem[], isWinner: (item: TrainingItem) => boolean): TrainingGroup[] {
  const bySubsystem = new Map<string, TrainingItem[]>()
  for (const item of items) {
    const key = inferSubsystem(item)
    const bucket = bySubsystem.get(key)
    if (bucket === undefined) bySubsystem.set(key, [item])
    else bucket.push(item)
  }
  const groups: TrainingGroup[] = []
  for (const [subsystem, bucket] of bySubsystem) {
    const runs = new Set(bucket.map((item) => item.runId)).size
    if (runs < 2) continue
    const winners = bucket.filter(isWinner).length
    groups.push({
      subsystem,
      items: bucket,
      runs,
      mode: winners > 0 && winners < bucket.length ? 'contrastive' : 'winner-only',
    })
  }
  return groups.sort((a, b) => a.subsystem.localeCompare(b.subsystem))
}

/**
 * The trigger, run at the **RE-RUN** of closeout phase 08.
 *
 * ⚠ NOT AT THE FIRST LOCK, deliberately and per the parent: a run that has just locked would be
 * training on itself, and its own conclusions would be promoted to memory before anything else had a
 * chance to contradict them. The caller says `rerun: true` to mean "phase 08 has been through closeout
 * more than once"; the first lock reports `OK` with an empty `writes` and a reason that says why.
 */
export function runPhase8Trigger(
  root: string,
  runId: string,
  options: {
    rerun?: boolean
    extractorAvailable?: boolean
    items?: readonly TrainingItem[]
    isWinner?: (item: TrainingItem) => boolean
    /**
     * The write seam. ABSENT IS NOT SUCCESS: with no writer the groups are planned and reported, and
     * the reason SAYS the writes did not happen — because a result that looked successful while
     * writing nothing is precisely the failure the parent's contract forbids ("do not claim memory
     * updates").
     */
    write?: (relativePath: string, content: string) => string
  } = {},
): TrainingResult {
  const locked = countPhase8LockedRuns(root)
  const gate = trainingGate(locked)
  if (gate.code !== 'OK') return gate

  if (options.rerun !== true) {
    return {
      code: 'OK',
      exit: 0,
      reason: 'phase 08 has not been re-run for ' + runId + ', so nothing is extracted yet (training at the first lock would train the run on itself)',
      writes: [],
    }
  }

  // An unavailable extractor is exit 2, distinct from insufficient evidence — and still zero writes.
  if (options.extractorAvailable !== true) {
    return {
      code: 'EXTRACTOR_UNAVAILABLE',
      exit: TRAINING_EXIT.EXTRACTOR_UNAVAILABLE,
      reason: 'no extractor is available; set RECURSIVE_TRAINING_EXTRACTOR_CMD or pass a response file. Do not claim memory updates',
      writes: [],
    }
  }

  const groups = groupLearnings(options.items ?? [], options.isWinner ?? (() => true))
  if (groups.length === 0) {
    return {
      code: 'INSUFFICIENT_EVIDENCE',
      exit: TRAINING_EXIT.INSUFFICIENT_EVIDENCE,
      reason: 'no subsystem group spans two runs, so there is nothing to learn that one run did not already say. Do not claim memory updates',
      writes: [],
    }
  }

  const summary = groups.map((group) => group.subsystem + ' (' + group.mode + ')').join(', ')
  if (options.write === undefined) {
    // The groups are real and the plan is real; the WRITES are not. Saying so is the whole contract.
    return {
      code: 'OK',
      exit: 0,
      reason: 'planned ' + groups.length + ' group(s) — ' + summary + ' — but NO writer was supplied, so no memory file was written and the plan alone is not a learning',
      writes: [],
    }
  }

  const writes: string[] = []
  for (const group of groups) {
    const body = renderGroupShard(group)
    writes.push(options.write('memory/domains/' + group.subsystem + '.md', body))
  }
  return {
    code: 'OK',
    exit: 0,
    reason: 'extracted ' + groups.length + ' group(s): ' + summary,
    writes,
  }
}

/**
 * Render a group's shard.
 *
 * ⚠ ONE ITEM PER RUN IS NAMED, so a reader can trace a learning back to the run that produced it —
 * and the group is never presented as more evidence than it is.
 */
export function renderGroupShard(group: TrainingGroup): string {
  const lines = [
    '# Learnings: ' + group.subsystem,
    '',
    '- Mode: ' + group.mode,
    '- Runs: ' + group.runs + ' (' + [...new Set(group.items.map((item) => item.runId))].join(', ') + ')',
    '',
  ]
  for (const item of group.items) {
    lines.push('- [' + item.runId + '] ' + item.text)
  }
  return lines.join('\n') + '\n'
}

/**
 * T30 — the extractor, resolved from the environment.
 *
 * ⚠ THE EXTRACTOR IS NEVER EMBEDDED. The parent delegates through a command
 * (`RECURSIVE_TRAINING_EXTRACTOR_CMD`) or a response file rather than shipping an LLM client, and this
 * keeps that: the plugin resolves a command and hands it to a runner it is given.
 *
 * ⚠ WHY THE RUNNER IS INJECTED RATHER THAN SPAWNED HERE. This harness's file sandbox denies a child
 * process the PIPED stdio a capture needs, so a module that spawned directly would be untestable in the
 * environment it runs in — and a rule that cannot be tested is a rule that will rot. The DECISION lives
 * here and is asserted with a fake runner; the SPAWN lives at the caller.
 */
export const TRAINING_EXTRACTOR_ENV = 'RECURSIVE_TRAINING_EXTRACTOR_CMD'

export function resolveExtractor(env: Record<string, string | undefined>): string | null {
  const cmd = env[TRAINING_EXTRACTOR_ENV]
  return cmd === undefined || cmd.trim() === '' ? null : cmd.trim()
}

/** What a runner reports back. `status` is the process exit code; `stdout` its captured output. */
export interface ExtractorRun {
  status: number
  stdout: string
}

export interface ExtractorOutcome {
  ok: boolean
  /** Present only when `ok`; the raw JSON the extractor produced. */
  payload?: unknown
  /** Present only when not `ok` — why, in the parent's terms. */
  failure?: 'EXTRACTOR_UNAVAILABLE' | 'MALFORMED_OUTPUT'
  reason: string
}

/**
 * Run the extractor and interpret its answer.
 *
 * ⚠ A NON-ZERO STATUS AND MALFORMED OUTPUT ARE BOTH FAILURES, and neither is "no items" — a malformed
 * answer is a broken extractor, not a run with nothing to learn, and collapsing the two would report
 * exit 3 (insufficient evidence) for a bug that deserves exit 2.
 */
export function runExtractor(
  runner: (cmd: string) => ExtractorRun,
  cmd: string | null,
): ExtractorOutcome {
  if (cmd === null) {
    return {
      ok: false,
      failure: 'EXTRACTOR_UNAVAILABLE',
      reason: 'no extractor command is set (' + TRAINING_EXTRACTOR_ENV + '); do not claim memory updates',
    }
  }
  let run: ExtractorRun
  try {
    run = runner(cmd)
  } catch (err) {
    return {
      ok: false,
      failure: 'EXTRACTOR_UNAVAILABLE',
      reason: 'the extractor could not be run (' + (err instanceof Error ? err.message : String(err)) + '); do not claim memory updates',
    }
  }
  if (run.status !== 0) {
    return {
      ok: false,
      failure: 'EXTRACTOR_UNAVAILABLE',
      reason: 'the extractor exited ' + run.status + '; do not claim memory updates',
    }
  }
  try {
    return { ok: true, payload: JSON.parse(run.stdout) as unknown, reason: 'the extractor returned a parseable answer' }
  } catch {
    return {
      ok: false,
      failure: 'MALFORMED_OUTPUT',
      reason: 'the extractor exited 0 but its output is not JSON, which is a BROKEN EXTRACTOR rather than a run with nothing to learn',
    }
  }
}

/**
 * T30 — turn the extractor's payload into items the grouping can use.
 *
 * ⚠ A MALFORMED PAYLOAD IS NOT A BROKEN EXTRACTOR. By the time this runs the extractor has exited 0 and
 * produced parseable JSON, so the transport is fine; a payload carrying no items is an extractor that
 * found nothing, which is **exit 3, not exit 2**. Keeping those apart is why `runExtractor` answers
 * first and this second.
 *
 * ⚠ A PARTIAL ANSWER NEITHER LOSES THE BATCH NOR INVENTS EVIDENCE: an entry missing its text is
 * SKIPPED rather than defaulted, because an item with invented text would be taught as a learning
 * nobody extracted. An entry with no `runId` is skipped too — the grouping counts DISTINCT runs, so an
 * unattributed observation would be pooled into a run it did not come from.
 */
export function parseExtractorItems(payload: unknown): TrainingItem[] {
  const container = payload as { items?: unknown } | null
  const raw = Array.isArray(payload) ? payload : (container === null ? null : container.items ?? null)
  if (!Array.isArray(raw)) return []
  const items: TrainingItem[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const candidate = entry as { runId?: unknown; paths?: unknown; text?: unknown }
    if (typeof candidate.text !== 'string' || candidate.text.trim() === '') continue
    if (typeof candidate.runId !== 'string' || candidate.runId.trim() === '') continue
    const paths = Array.isArray(candidate.paths)
      ? candidate.paths.filter((path): path is string => typeof path === 'string')
      : []
    items.push({ runId: candidate.runId, paths, text: candidate.text })
  }
  return items
}

/**
 * T30 — the whole round trip, in the order the failure codes demand: resolve the command, run it,
 * parse the payload, then group. Each stage keeps its own meaning — no command or a non-zero exit is
 * **exit 2**; a payload with nothing usable in it is **exit 3**.
 */
export function extractAndGroup(
  runner: (cmd: string) => ExtractorRun,
  env: Record<string, string | undefined>,
  options: { isWinner?: (item: TrainingItem) => boolean } = {},
): { outcome: ExtractorOutcome; items: TrainingItem[]; groups: TrainingGroup[] } {
  const outcome = runExtractor(runner, resolveExtractor(env))
  if (!outcome.ok) return { outcome, items: [], groups: [] }
  const items = parseExtractorItems(outcome.payload)
  return { outcome, items, groups: groupLearnings(items, options.isWinner ?? (() => true)) }
}
