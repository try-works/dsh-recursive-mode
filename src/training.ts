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
import { spawnSync } from 'node:child_process'
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
    /**
     * The registry read seam. WITHOUT IT THE REGISTRY IS NOT REFRESHED and the result SAYS SO, because
     * a silent half-write would leave `MEMORY.md` describing a plane that has changed underneath it.
     */
    readText?: (relativePath: string) => string | null
    /**
     * FU-5: THE PRODUCTION SPAWN, injected. When the caller supplies no `items`, the trigger RUNS the
     * extractor through this runner — which is the link that was missing entirely: `extractAndGroup` was
     * referenced only by its own definition, so the round trip existed and nothing invoked it.
     */
    runner?: (cmd: string) => ExtractorRun
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
  //
  // ⚠ THE FLAG FALLS BACK TO THE ENVIRONMENT, because defaulting to "not available" while
  // `RECURSIVE_TRAINING_EXTRACTOR_CMD` IS set is a footgun the e2e run walked straight into: the command
  // was configured, the spawn was wired, and the trigger still reported no extractor. An explicit
  // `false` is still honoured (it is how a test forces the failure), so the fallback only fills a gap.
  if ((options.extractorAvailable ?? resolveExtractor(process.env) !== null) !== true) {
    return {
      code: 'EXTRACTOR_UNAVAILABLE',
      exit: TRAINING_EXIT.EXTRACTOR_UNAVAILABLE,
      reason: 'no extractor is available; set RECURSIVE_TRAINING_EXTRACTOR_CMD or pass a response file. Do not claim memory updates',
      writes: [],
    }
  }

  // ⚠ THE EXTRACTOR IS FINALLY INVOKED HERE — this is the link that was missing: `extractAndGroup` was
  // referenced only by its own definition, so the whole round trip existed and nothing called it.
  // Its failures keep their own meaning: a broken transport or malformed output is exit 2 (returned
  // here), while an answer with nothing usable in it falls through to the empty-items path and becomes
  // exit 3 — the distinction the round trip was built around.
  let items: TrainingItem[]
  if (options.items !== undefined) items = [...options.items]
  else if (options.runner === undefined) {
    // A configured command with no runner is reported rather than silently treated as "no items":
    // the two look identical downstream, and only one of them is a misconfiguration.
    return {
      code: 'EXTRACTOR_UNAVAILABLE',
      exit: TRAINING_EXIT.EXTRACTOR_UNAVAILABLE,
      reason: 'an extractor is configured but no runner was supplied, so it was NOT invoked. Do not claim memory updates',
      writes: [],
    }
  } else {
    const round = extractAndGroup(options.runner, process.env, options.isWinner === undefined ? {} : { isWinner: options.isWinner })
    if (!round.outcome.ok) {
      return {
        code: 'EXTRACTOR_UNAVAILABLE',
        exit: TRAINING_EXIT.EXTRACTOR_UNAVAILABLE,
        reason: round.outcome.reason,
        writes: [],
      }
    }
    items = round.items
  }
  const groups = groupLearnings(items, options.isWinner ?? (() => true))
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
  // One TRAINING shard per mode, and the registry refreshed to match what was just written.
  const byMode = new Map<TrainingGroup['mode'], TrainingGroup[]>()
  for (const group of groups) {
    const bucket = byMode.get(group.mode)
    if (bucket === undefined) byMode.set(group.mode, [group])
    else bucket.push(group)
  }
  const registryEntries: Array<{ path: string; taskType: string }> = []
  for (const [mode, modeGroups] of byMode) {
    const path = taskTypeShardPath(mode)
    writes.push(options.write(path, renderTaskTypeShard(modeGroups)))
    registryEntries.push({ path, taskType: mode })
  }
  for (const group of groups) {
    registryEntries.push({ path: 'memory/domains/' + group.subsystem + '.md', taskType: group.mode })
  }
  if (options.readText !== undefined) {
    const existing = options.readText('memory/MEMORY.md') ?? ''
    writes.push(options.write('memory/MEMORY.md', updateMemoryRegistry(existing, registryEntries)))
  }
  return {
    code: 'OK',
    exit: 0,
    reason: 'extracted ' + groups.length + ' group(s): ' + summary
      + (options.readText === undefined ? ' — the registry was NOT refreshed (no reader supplied)' : ''),
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

/**
 * FU-5 — the RESPONSE FILE, which is what makes the spawn possible in a confined sandbox.
 *
 * ⚠ WHY A FILE AND NOT A PIPE. This harness's sandbox denies a child process the piped stdio a capture
 * needs, so a spawn that read the extractor's stdout would fail with EPERM **in the environment it runs
 * in**. The parent's own interface already solves this: it delegates through `--response-file`, i.e. the
 * extractor WRITES ITS ANSWER TO A PATH. The plugin spawns with `stdio: 'ignore'` (which the sandbox
 * allows), hands the path over in an environment variable, and reads the file afterwards.
 */
export const TRAINING_RESPONSE_FILE_ENV = 'RECURSIVE_TRAINING_RESPONSE_FILE'

/**
 * Build the production runner: spawn the command, then read the file it was asked to write.
 *
 * ⚠ IT NEVER THROWS. A missing binary, a non-zero exit and a missing response file all come back as a
 * non-zero `status` with an explanatory `stdout`, so `runExtractor` maps them to a TYPED failure — the
 * closeout must not die because an extractor is misconfigured.
 */
export function spawnExtractorRunner(options: {
  cwd: string
  responseFile: string
  /** Injected for tests; defaults to `node:child_process.spawnSync`. */
  spawn?: (cmd: string, args: string[], opts: Record<string, unknown>) => { status: number | null; error?: Error }
}): (cmd: string) => ExtractorRun {
  return (cmd: string): ExtractorRun => {
    const spawn = options.spawn ?? ((c, a, o) => {
      const result = spawnSync(c, a, o as never)
      return { status: result.status, ...(result.error === undefined ? {} : { error: result.error }) }
    })
    let outcome: { status: number | null; error?: Error }
    try {
      outcome = spawn(cmd, [], {
        cwd: options.cwd,
        // ⚠ `ignore`, NOT `pipe`: the sandbox permits the first and denies the second.
        stdio: 'ignore',
        // The command is a shell line (the env var is documented as a COMMAND), so it needs a shell —
        // the same reason `pnpm.cmd` needed one in the harness runner.
        shell: true,
        env: { ...process.env, [TRAINING_RESPONSE_FILE_ENV]: options.responseFile },
      })
    } catch (err) {
      return { status: 1, stdout: 'spawn failed: ' + (err instanceof Error ? err.message : String(err)) }
    }
    if (outcome.error !== undefined) {
      return { status: typeof outcome.status === 'number' ? outcome.status : 1, stdout: 'spawn error: ' + outcome.error.message }
    }
    try {
      return { status: outcome.status ?? 1, stdout: readFileSync(options.responseFile, 'utf8') }
    } catch {
      // A successful exit with no file is reported as a FAILURE with the reason, never as an empty answer:
      // "the extractor produced nothing" and "the extractor never wrote anything" are different facts.
      return {
        status: 1,
        stdout: 'the extractor exited ' + String(outcome.status) + ' without writing ' + options.responseFile,
      }
    }
  }
}

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
 * T30 — the registry line for a shard, and the registry update.
 *
 * ⚠ THE REGISTRY IS REFRESHED BY REPLACING A SHARD'S LINE, NOT BY APPENDING. Two lines for one shard
 * would make `MEMORY.md` claim the plane holds something twice, and the loader reads the registry
 * first — so a duplicated marker is not cosmetic, it is a wrong answer about what exists.
 *
 * ⚠ AND A SHARD IS NEVER REMOVED HERE. Per the memory-worker discipline this borrows: **supersede,
 * never delete.** A shard that stops being written keeps its line and its history; removing it is a
 * tombstone decision, not a side effect of training.
 */
export function registryLine(shardPath: string, taskType: string): string {
  return '- `' + shardPath + '` — task type: ' + taskType
}

export function updateMemoryRegistry(existing: string, entries: ReadonlyArray<{ path: string; taskType: string }>): string {
  const lines = existing === '' ? [] : existing.replace(/\n$/, '').split('\n')
  for (const entry of entries) {
    const marker = '- `' + entry.path + '`'
    const at = lines.findIndex((line) => line.startsWith(marker))
    const line = registryLine(entry.path, entry.taskType)
    if (at >= 0) lines[at] = line
    else lines.push(line)
  }
  return lines.join('\n') + '\n'
}

/**
 * T30 — the task-type shard.
 *
 * ⚠ `task-type` IS READ FROM THE GROUP'S MODE, and that is an INTERPRETATION rather than a measured
 * fact: the parent writes `memory/training/<task-type>.md` without defining the key in the material I
 * have, so the mode a group was extracted under (`contrastive` / `winner-only`) is what distinguishes
 * one training shard from another here. Named so a reader can disagree with it instead of discovering it.
 */
export function taskTypeShardPath(mode: TrainingGroup['mode']): string {
  return 'memory/training/' + mode + '.md'
}

export function renderTaskTypeShard(groups: readonly TrainingGroup[]): string {
  const lines = [
    '# Training shards: ' + groups[0].mode,
    '',
    'Groups extracted under this mode, one section each. Learning happens through files, not model mutation.',
    '',
  ]
  for (const group of groups) {
    lines.push('## ' + group.subsystem, '')
    lines.push('- Runs: ' + group.runs + ' (' + [...new Set(group.items.map((item) => item.runId))].join(', ') + ')')
    for (const item of group.items) lines.push('- [' + item.runId + '] ' + item.text)
    lines.push('')
  }
  return lines.join('\n') + '\n'
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
