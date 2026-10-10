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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
// T40: the phase-8 rule lives in the RULES module and the plane's contract lives in the LINTER, so
// neither is restated here. A writer that validated against its own copy of the linter's field list
// would be free to disagree with the linter about what a valid memory doc is.
import {
  MEMORY_ALWAYS_AVAILABLE,
  MEMORY_DOC_LOCATIONS,
  MEMORY_PLANE_PREFIX,
  MEMORY_PROVENANCE_FIELD,
  PHASE8_MEMORY_ARTIFACT,
  PHASE8_MEMORY_SECTION,
  type MemoryDocKind,
} from './phase-rules.ts'
import {
  MEMORY_ALLOWED_STATUSES,
  MEMORY_ALLOWED_TYPES,
  MEMORY_REQUIRED_FIELDS,
  getMdFieldValue,
  hasHeaderField,
} from './ts-lint.ts'

/** The artifact whose lock marks a run as complete enough to learn from. */
export const PHASE8_ARTIFACT = PHASE8_MEMORY_ARTIFACT

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
 *
 * ⚠ T40 — AND IT NOW CARRIES THE PLANE'S METADATA HEADER, which it did not before. `memory/domains/
 * <subsystem>.md` is a doc the memory-plane lint validates like any other, and this renderer wrote a
 * bare `# Learnings:` heading — so the plugin's own cross-run extraction produced a doc its own
 * `lint_memory_plane` FAILS for nine missing fields. The extraction was right and its output shape was
 * wrong, which is exactly the kind of defect a write surface exists to prevent.
 */
export function renderGroupShard(group: TrainingGroup, options: { lastValidated?: string } = {}): string {
  const runs = [...new Set(group.items.map((item) => item.runId))]
  const lines = [
    ...renderMemoryMetadata({
      type: 'domain',
      status: 'CURRENT',
      scope: 'Learnings extracted for subsystem ' + group.subsystem + ' (' + group.mode + ') from ' + runs.length + ' run(s).',
      sourceRuns: runs,
      validatedAtCommit: 'extracted-at-run-close',
      lastValidated: options.lastValidated ?? isoSeconds(),
      tags: [group.subsystem, group.mode],
    }).trimEnd().split('\n'),
    '',
    '# Learnings: ' + group.subsystem,
    '',
    '- Mode: ' + group.mode,
    '- Runs: ' + group.runs + ' (' + runs.join(', ') + ')',
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

/** T40: same metadata-header reason as {@link renderGroupShard} — see the note there. */
export function renderTaskTypeShard(groups: readonly TrainingGroup[], options: { lastValidated?: string } = {}): string {
  const runs = [...new Set(groups.flatMap((group) => group.items.map((item) => item.runId)))]
  const lines = [
    ...renderMemoryMetadata({
      type: 'pattern',
      status: 'CURRENT',
      scope: 'Training shards extracted under mode ' + groups[0].mode + ', one section per subsystem group.',
      sourceRuns: runs,
      validatedAtCommit: 'extracted-at-run-close',
      lastValidated: options.lastValidated ?? isoSeconds(),
      tags: ['training', groups[0].mode],
    }).trimEnd().split('\n'),
    '',
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

/* -------------------------------------------------------------------------- */
/* T40 — THE PHASE-8 WRITE SURFACE, AND THE GATE THAT PROVES IT HAPPENED      */
/* -------------------------------------------------------------------------- */

/**
 * T40 — THE PLUGIN'S OWN WAY TO WRITE `.recursive/memory/`.
 *
 * ⚠ WHY A WRITE SURFACE AND NOT ANOTHER PARAGRAPH OF INSTRUCTIONS. The memory plane's shape is not a
 * convention an author can guess: a durable doc must carry nine metadata fields, its `Type` must be
 * one of five, and the plane's own lint FAILs the whole run when one is missing. Measured against the
 * live workspace, the plane held NOTHING but the bootstrap placeholders — so the practical choice was
 * between an agent hand-rolling a doc that fails the plane lint and no doc at all. This renders the
 * canonical shape, stamps the provenance the phase-8 gate reads back, replaces the shard's line in
 * the registry, and refuses to write a doc its own linter would reject.
 *
 * ⚠ WHAT IS DELIBERATE, DECIDED HERE RATHER THAN LEFT TO A CALLER:
 *
 *   - ATOMIC. `writeFileSync` to a sibling temp name, then a rename over the target. A memory doc is
 *     read by the loader and linted by the plane, and a torn write is worse than a missing one: a
 *     half-written doc is a FAILED lint that names a file nobody wrote, and there is no way to tell it
 *     from a real one afterwards.
 *   - PROVENANCE-CARRYING. `Source-Runs` names the run, and it is not decoration: it is the entire
 *     discriminator between "the run wrote its memory" and "the run cited a shard that already
 *     existed", which is the distinction the phase-8 gate turns on. It is also why the run id is
 *     stamped from the CALL rather than trusted per-doc.
 *   - DEDUPLICATED, IDEMPOTENTLY. Writing the same doc again from the same run is a no-op that SAYS
 *     so (`UNCHANGED`), because phase 8 closeout runs more than once — the training trigger's own
 *     reason for existing is the re-run — and a re-run must not duplicate a lesson or rewrite a doc
 *     byte-differently for no reason.
 *   - REFUSED WHEN THE ENTRY ALREADY EXISTS, unless the caller supersedes explicitly. Another run's
 *     shard is that run's evidence; silently overwriting it destroys provenance for a shard the plane
 *     could not restore. `supersede: true` is the deliberate path, and it ARCHIVES the previous
 *     revision under `memory/archive/` first — supersede, never delete, the same discipline the
 *     counters and the registry already follow.
 *   - AND NOTHING IS INVENTED. An empty scope or body, an unknown kind, a slug that is not a name, or
 *     a doc the linter would reject all come back as typed results with `written: false` — "zero
 *     writes" is a property a test asserts by listing the tree, not a promise in a comment.
 *
 * ⚠ THIS WRITES THIS PLUGIN'S MEMORY AND NOTHING ELSE. It never calls, wraps or delegates to another
 * plugin's memory tools: the plane it touches is the `.recursive/memory/` tree this plugin scaffolds
 * and lints, reached through this repo's own paths.
 */
export interface MemoryDocSpec {
  kind: MemoryDocKind
  /** The run that wrote it. Stamped into `Source-Runs`, which is what the phase-8 gate reads back. */
  runId: string
  /** Filename stem (`03-ambientcss-redesign`). Sanitised: a slug is a NAME, never a path. */
  slug: string
  /** Defaults to the slug. */
  title?: string
  /** What the doc is about, in one sentence — the field a later run ranks on. */
  scope: string
  /** The lesson itself. Empty is REFUSED rather than padded: an invented lesson is not memory. */
  body: string
  status?: string
  ownsPaths?: readonly string[]
  watchPaths?: readonly string[]
  tags?: readonly string[]
  /** The commit the doc was validated against. Defaults to a token NAMING the run (see below). */
  validatedAtCommit?: string
  /** ISO timestamp. Defaults to the moment of the write, which is measured rather than invented. */
  lastValidated?: string
  parent?: string
  /**
   * Runs that contributed BEFORE this one, kept in `Source-Runs` when this write replaces a doc.
   * Set by the writer on a supersede/update; a caller may set it, and the union is what keeps a
   * replaced revision's history readable.
   */
  priorRuns?: readonly string[]
}

export interface MemoryWriteOptions {
  /**
   * Replace a shard ANOTHER RUN owns, by archiving it under `memory/archive/` first. Default false:
   * the write is REFUSED and the refusal names both remedies.
   */
  supersede?: boolean
  /** The clock, injected so the caller (and a test) decides what "now" is. */
  now?: () => Date
}

export type MemoryWriteCode = 'WRITTEN' | 'UPDATED' | 'UNCHANGED' | 'REFUSED' | 'INVALID'

export interface MemoryWriteResult {
  code: MemoryWriteCode
  /** Repo-relative path (`memory/episodes/<slug>.md`); EMPTY only when no path could be resolved. */
  path: string
  /** True only for `WRITTEN` and `UPDATED`. */
  written: boolean
  /** Where a superseded revision was archived, when that happened. */
  archived: string | null
  /** Always says what happened — a silent refusal is a lost work item. */
  reason: string
}

/** `2026-10-10T08:39:59Z` — the lock fields' own timestamp shape, and the docs' `Last-Validated` one. */
export function isoSeconds(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** A slug is a FILE NAME: no separator, no traversal, no extension, no leading dot. */
export function sanitizeMemorySlug(slug: string): string {
  return slug
    .trim()
    .replace(/\.md$/i, '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.\-]+/, '')
    .replace(/[.\-]+$/, '')
}

/** The repo-relative path a doc gets, or null when the kind or the slug cannot name one. */
export function memoryDocRelativePath(kind: MemoryDocKind, slug: string): string | null {
  const location = MEMORY_DOC_LOCATIONS[kind]
  if (location === undefined) return null
  const clean = sanitizeMemorySlug(slug)
  if (clean === '') return null
  return location.dir + '/' + clean + '.md'
}

function bullets(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => '- `' + value.replace(/`/g, "'") + '`')
}

/**
 * The metadata header every durable doc carries: the nine fields `lint_memory_doc` requires, in the
 * order the SHIPPED docs use them (`Owns-Paths:` / `Watch-Paths:` / `Tags:` stand bare when empty,
 * which is what the workspace's own promoted docs do and what `has_header_field` accepts).
 *
 * ⚠ A BACKTICK INSIDE A FIELD VALUE IS REPLACED, NOT ESCAPED, because these values are read back by
 * a line-based field reader: a stray backtick would end the value early and leave the rest of the
 * sentence in the doc as if it were a field.
 */
export function renderMemoryMetadata(input: {
  type: string
  status: string
  scope: string
  sourceRuns: readonly string[]
  validatedAtCommit: string
  lastValidated: string
  ownsPaths?: readonly string[]
  watchPaths?: readonly string[]
  tags?: readonly string[]
  parent?: string
}): string {
  const lines = [
    'Type: `' + input.type + '`',
    'Status: `' + input.status + '`',
    'Scope: `' + input.scope.replace(/`/g, "'") + '`',
    'Owns-Paths:',
    ...bullets(input.ownsPaths),
    'Watch-Paths:',
    ...bullets(input.watchPaths),
    MEMORY_PROVENANCE_FIELD + ':',
    ...bullets(input.sourceRuns),
    'Validated-At-Commit: `' + input.validatedAtCommit.replace(/`/g, "'") + '`',
    'Last-Validated: `' + input.lastValidated.replace(/`/g, "'") + '`',
    'Tags:',
    ...bullets(input.tags),
  ]
  if (input.parent !== undefined && input.parent.trim() !== '') lines.push('Parent: `' + input.parent.replace(/`/g, "'") + '`')
  return lines.join('\n') + '\n'
}

/**
 * Render the whole doc: the canonical header, then the title, then the lesson.
 *
 * ⚠ `Validated-At-Commit` DEFAULTS TO A TOKEN THAT NAMES THE RUN, NOT A SHA. A run writing its own
 * lesson has no commit to be validated against yet, and a placeholder SHA would be a fabricated fact
 * in the one field a reader uses to decide whether the lesson still holds. The shipped generic docs
 * use the same convention (`generic-repository-guidance`).
 */
export function renderMemoryDoc(spec: MemoryDocSpec, options: { lastValidated?: string } = {}): string {
  const location = MEMORY_DOC_LOCATIONS[spec.kind]
  const sourceRuns = [...new Set([spec.runId, ...(spec.priorRuns ?? [])])].filter((run) => run.trim() !== '')
  const header = renderMemoryMetadata({
    type: location.type,
    status: spec.status ?? 'CURRENT',
    scope: spec.scope,
    sourceRuns,
    validatedAtCommit: spec.validatedAtCommit ?? 'written-by-run-' + spec.runId,
    lastValidated: spec.lastValidated ?? options.lastValidated ?? isoSeconds(),
    ownsPaths: spec.ownsPaths,
    watchPaths: spec.watchPaths,
    tags: spec.tags,
    parent: spec.parent,
  })
  return header + '\n# ' + (spec.title ?? spec.slug) + '\n\n' + spec.body.trim() + '\n'
}

/**
 * The problems that would make the memory plane FAIL this doc — checked with the LINTER'S own field
 * list, allowed Types and allowed Statuses, so this cannot accept a doc the plane rejects.
 */
export function memoryDocProblems(content: string): string[] {
  const problems: string[] = []
  const missing = MEMORY_REQUIRED_FIELDS.filter((field) => !hasHeaderField(content, field))
  if (missing.length > 0) problems.push('missing required memory metadata field(s): ' + missing.join(', '))
  const type = (getMdFieldValue(content, 'Type') ?? '').toLowerCase()
  if (!MEMORY_ALLOWED_TYPES.has(type)) {
    problems.push("Type '" + type + "' is not one the memory plane accepts (expected one of: " + [...MEMORY_ALLOWED_TYPES].sort().join(', ') + ')')
  }
  const status = (getMdFieldValue(content, 'Status') ?? '').toUpperCase()
  if (!MEMORY_ALLOWED_STATUSES.has(status)) {
    problems.push("Status '" + status + "' is not one the memory plane accepts (expected one of: " + [...MEMORY_ALLOWED_STATUSES].sort().join(', ') + ')')
  }
  return problems
}

function unquoteMemoryValue(value: string): string {
  const trimmed = value.trim()
  for (const quote of ['`', '"', "'"]) {
    if (trimmed.length >= 2 && trimmed.startsWith(quote) && trimmed.endsWith(quote)) {
      return trimmed.slice(1, -1).trim()
    }
  }
  return trimmed
}

/**
 * The values of a list field (`Source-Runs:`), inline or as bullets.
 *
 * ⚠ THE BLOCK ENDS AT THE FIRST BLANK LINE, HEADING OR NEW FIELD, and that strictness is the point:
 * the alternative is a parser that reads an unrelated bullet list further down the document as
 * provenance — and provenance is the one thing here that must never be guessed.
 */
export function parseMemoryListField(content: string, fieldName: string): string[] {
  const fieldRe = new RegExp('^[ \\t]*(?:[-*][ \\t]+)?' + fieldName + ':[ \\t]*(.*)$')
  const values: string[] = []
  let inField = false
  for (const line of content.replace(/\r\n/g, '\n').split('\n')) {
    const field = fieldRe.exec(line)
    if (field !== null) {
      inField = true
      const inline = unquoteMemoryValue(field[1])
      if (inline !== '') values.push(inline)
      continue
    }
    if (!inField) continue
    const item = /^[ \t]*[-*][ \t]+(.+)$/.exec(line)
    if (item !== null) {
      const value = unquoteMemoryValue(item[1])
      if (value !== '') values.push(value)
      continue
    }
    // A blank line, a heading or the next field ends the block — see the note above: reading further
    // would let an unrelated list elsewhere in the doc become provenance.
    break
  }
  return values
}

/** The runs a doc's `Source-Runs` names. EXACT matches: `run-1` is not `run-10`. */
export function memoryDocProvenance(content: string): string[] {
  return parseMemoryListField(content, MEMORY_PROVENANCE_FIELD)
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Write bytes so a reader sees either the old file or the new one, never a mixture: a sibling temp
 * name, then a rename over the target.
 */
function writeTextAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = path + '.tmp-' + process.pid.toString(36) + '-' + Date.now().toString(36)
  try {
    writeFileSync(temp, content, 'utf8')
    renameSync(temp, path)
  } catch (err) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // A leftover temp file is a wart; the write failure is the news, and swallowing it here would be
      // the only way to lose it.
    }
    throw err
  }
}

/** The task-type token a shard's registry line carries, from the directory it lives in. */
export function taskTypeForMemoryPath(path: string): string {
  // The plane is spelled BOTH ways in this codebase — `.recursive/memory/…` (the scaffolded plane, the
  // linter, the phase-8 artifact) and the trigger's older `memory/…` (its call site joins that onto the
  // workspace root) — so the token is derived from the directory NAME and is insensitive to the base.
  const normalized = path.replace(/\\/g, '/').replace(/^\.recursive\//, '')
  for (const [kind, location] of Object.entries(MEMORY_DOC_LOCATIONS)) {
    if (normalized.startsWith(location.dir.replace(/^\.recursive\//, '') + '/')) return kind
  }
  const training = /^memory\/training\/(.+)\.md$/.exec(normalized)
  return training === null ? 'memory' : training[1]
}

/**
 * Write ONE durable doc, atomically, with provenance — and refuse rather than guess.
 *
 * The four decided behaviours (see {@link MemoryDocSpec}'s block comment): atomic, provenance-carrying,
 * idempotent for the same run, and refused when another run owns the path unless `supersede` is
 * explicit — in which case the previous revision is ARCHIVED first, so nothing is ever deleted.
 */
export function writeMemoryDoc(root: string, spec: MemoryDocSpec, options: MemoryWriteOptions = {}): MemoryWriteResult {
  const path = memoryDocRelativePath(spec.kind, spec.slug)
  if (path === null) {
    return {
      code: 'INVALID',
      path: '',
      written: false,
      archived: null,
      reason: "kind '" + String(spec.kind) + "' has no location in the memory plane, or the slug is empty, so NOTHING was written",
    }
  }
  if (spec.scope.trim() === '' || spec.body.trim() === '') {
    return {
      code: 'INVALID',
      path,
      written: false,
      archived: null,
      reason: 'Scope and body are both required and neither may be empty: a doc whose lesson nobody wrote is not memory, so NOTHING was written',
    }
  }
  const content = renderMemoryDoc(spec, options.now === undefined ? {} : { lastValidated: isoSeconds(options.now()) })
  const problems = memoryDocProblems(content)
  if (problems.length > 0) {
    return {
      code: 'INVALID',
      path,
      written: false,
      archived: null,
      reason: 'the rendered doc would FAIL the memory-plane lint (' + problems.join('; ') + '), so NOTHING was written',
    }
  }

  const absolute = join(root, path)
  const existing = readTextOrNull(absolute)
  if (existing === null) {
    writeTextAtomic(absolute, content)
    return { code: 'WRITTEN', path, written: true, archived: null, reason: 'wrote ' + path + ' with ' + MEMORY_PROVENANCE_FIELD + ' naming ' + spec.runId }
  }

  const owners = memoryDocProvenance(existing)
  if (owners.includes(spec.runId)) {
    if (existing === content) {
      return {
        code: 'UNCHANGED',
        path,
        written: false,
        archived: null,
        reason: path + ' is already written by ' + spec.runId + ' byte-for-byte, so this write was a no-op (phase 8 closeout re-runs, and a re-run must not duplicate a lesson)',
      }
    }
    // ⚠ THIS RUN MAY CORRECT ITS OWN DOC. Refusing here would make a typo unfixable by the only party
    // entitled to fix it, so the doc is replaced — and the Source-Runs of every earlier contributor
    // are carried forward rather than dropped with the old revision.
    const updatedContent = renderMemoryDoc({ ...spec, priorRuns: [...owners, ...(spec.priorRuns ?? [])] }, options.now === undefined ? {} : { lastValidated: isoSeconds(options.now()) })
    writeTextAtomic(absolute, updatedContent)
    return { code: 'UPDATED', path, written: true, archived: null, reason: 'replaced ' + path + ', which this run already owned, keeping every earlier ' + MEMORY_PROVENANCE_FIELD + ' entry' }
  }

  if (options.supersede !== true) {
    return {
      code: 'REFUSED',
      path,
      written: false,
      archived: null,
      reason: path + ' already exists and its ' + MEMORY_PROVENANCE_FIELD + ' names ' + owners.join(', ') + ' rather than ' + spec.runId
        + ', so it was NOT overwritten: pass supersede to replace it (the previous revision is ARCHIVED, never deleted), or file this lesson under a distinct slug',
    }
  }

  // Supersede: ARCHIVE FIRST. A crash between the two writes leaves the previous revision readable in
  // the archive and the original still in place — recoverable, and never a deleted learning.
  const archived = 'memory/archive/' + basename(path).replace(/\.md$/, '') + '.' + sanitizeMemorySlug(owners[0] ?? 'unknown') + '.md'
  writeTextAtomic(join(root, archived), existing)
  writeTextAtomic(absolute, renderMemoryDoc({ ...spec, priorRuns: [...owners, ...(spec.priorRuns ?? [])] }, options.now === undefined ? {} : { lastValidated: isoSeconds(options.now()) }))
  return { code: 'WRITTEN', path, written: true, archived, reason: 'superseded ' + path + ' (previous revision archived at ' + archived + ') with ' + MEMORY_PROVENANCE_FIELD + ' naming ' + spec.runId }
}

export interface RunMemoryWriteResult {
  /** Repo-relative paths actually written (`WRITTEN` or `UPDATED`), in order. */
  writes: string[]
  results: MemoryWriteResult[]
  /** The registry write (`memory/MEMORY.md`), or null when nothing was written. */
  registry: MemoryWriteResult | null
  /** What happened, INCLUDING the failure sentence — a caller must not have to infer it. */
  reason: string
}

/**
 * T40 — THE PHASE-8 CALL: write this run's durable docs and register them.
 *
 * ⚠ THE RUN ID COMES FROM THE ARGUMENT, NOT FROM EACH SPEC. A spec that named a different run would
 * write provenance the phase-8 gate then refuses — a doc claiming a write this run did not make —
 * and the caller would be left holding a file that blocks its own lock. One run per call removes
 * that possibility instead of documenting it.
 *
 * ⚠ THE REGISTRY IS REFRESHED ONLY WHEN SOMETHING WAS WRITTEN, because the failure paths must write
 * NOTHING (the module's standing contract) and because a registry refreshed over an unchanged plane
 * is a claim that something changed. `updateMemoryRegistry` is reused rather than reimplemented: a
 * shard's line is REPLACED, never duplicated, and a shard is never removed.
 *
 * ⚠ AND IT IS THE PLANE'S REGISTRY, `.recursive/memory/MEMORY.md` — the file `MEMORY_INDEX_FILE`
 * names and the same one `bootstrap.ts` marker-upserts. The trigger's older `memory/MEMORY.md` is read
 * as a FALLBACK so a registry the previous call site wrote is not silently discarded, and it is never
 * written to: two registries in one workspace would be two answers to "what does this plane hold".
 */
export function writeRunMemory(
  root: string,
  runId: string,
  specs: readonly MemoryDocSpec[],
  options: MemoryWriteOptions = {},
): RunMemoryWriteResult {
  if (specs.length === 0) {
    return {
      writes: [],
      results: [],
      registry: null,
      reason: 'no memory docs were supplied, so NOTHING was written — phase 8 requires at least one, and ' + MEMORY_ALWAYS_AVAILABLE + ' is always available',
    }
  }
  const results = specs.map((spec) => writeMemoryDoc(root, { ...spec, runId }, options))
  const writes = results.filter((result) => result.written).map((result) => result.path)
  if (writes.length === 0) {
    return {
      writes,
      results,
      registry: null,
      reason: 'NOTHING was written: ' + results.map((result) => result.code + ' ' + (result.path === '' ? '(no path)' : result.path) + ' — ' + result.reason).join('; '),
    }
  }
  const registryPath = '.recursive/memory/MEMORY.md'
  const existing = readTextOrNull(join(root, registryPath)) ?? readTextOrNull(join(root, 'memory/MEMORY.md')) ?? ''
  const updated = updateMemoryRegistry(existing, writes.map((path) => ({ path, taskType: taskTypeForMemoryPath(path) })))
  const changed = updated !== existing
  if (changed) writeTextAtomic(join(root, registryPath), updated)
  return {
    writes,
    results,
    registry: {
      code: changed ? 'WRITTEN' : 'UNCHANGED',
      path: registryPath,
      written: changed,
      archived: null,
      reason: changed
        ? 'registered ' + writes.length + ' shard(s) in ' + registryPath + ' (a shard\'s line is REPLACED, never duplicated, and never removed)'
        : registryPath + ' already registered every shard this call wrote',
    },
    reason: 'wrote ' + writes.length + ' memory doc(s): ' + writes.join(', '),
  }
}

/** Every `.recursive/memory/**` path a text declares, in the absolute or repo-relative spelling. */
export function phase8MemoryRefs(text: string): string[] {
  const found = new Set<string>()
  const absolute = /(?:^|[\s(`'"<[])\/?\.recursive\/memory\/[A-Za-z0-9._@\-/]*\.md/g
  const relative = /(?:^|[\s(`'"<[])(memory\/(?:domains|patterns|incidents|episodes|training|skills|archive)\/[A-Za-z0-9._@\-/]*\.md)/g
  let match: RegExpExecArray | null
  while ((match = absolute.exec(text)) !== null) {
    found.add(match[0].replace(/^[\s(`'"<[]/, '').replace(/^\/+/, ''))
  }
  while ((match = relative.exec(text)) !== null) {
    found.add(MEMORY_PLANE_PREFIX + match[1].slice('memory/'.length))
  }
  return [...found].sort()
}

export interface Phase8MemoryEvidence {
  ok: boolean
  /** Paths under the plane the artifact declares, repo-relative to the repo root (sorted, deduped). */
  declared: string[]
  /** Declared paths that exist on disk. */
  existing: string[]
  /** Declared paths whose own text carries THIS run's provenance: the writes that COUNT. */
  written: string[]
  reason: string
}

/**
 * T40 — THE CHECKABLE FACT BEHIND "the run wrote its durable memory".
 *
 * Three conditions, and each one exists because of a way the claim could be made without the work
 * being done: the artifact DECLARES a path under the plane (not prose about memory in general); the
 * path EXISTS (a declaration is not a write); and the doc on disk carries `Source-Runs` naming THIS
 * run (a shard the run merely read, or one an earlier run wrote, is not this run's memory).
 *
 * ⚠ WHAT IT CANNOT TELL, stated rather than hidden: WHEN the doc was written. A run that wrote a
 * memory doc before phase 8 and cites it here passes — and the phase 6/7 baselines deny memory-plane
 * writes outright (`phaseBaselineRules`), so within this workflow the only phase that can produce
 * such a doc is 8. The check is about the FACT existing at lock time, not about the clock.
 */
export function phase8MemoryEvidence(
  root: string,
  runId: string,
  artifactText: string,
  readText: (path: string) => string | null = readTextOrNull,
): Phase8MemoryEvidence {
  const declared = phase8MemoryRefs(artifactText)
  if (declared.length === 0) {
    return { ok: false, declared, existing: [], written: [], reason: 'the artifact declares no path under ' + MEMORY_PLANE_PREFIX + ' at all' }
  }
  const existing: string[] = []
  const written: string[] = []
  for (const path of declared) {
    const text = readText(join(root, path))
    if (text === null) continue
    existing.push(path)
    if (memoryDocProvenance(text).includes(runId)) written.push(path)
  }
  if (written.length > 0) {
    return {
      ok: true,
      declared,
      existing,
      written,
      reason: written.length + ' declared memory doc(s) carry ' + MEMORY_PROVENANCE_FIELD + ' naming ' + runId + ': ' + written.join(', '),
    }
  }
  if (existing.length === 0) {
    return {
      ok: false,
      declared,
      existing,
      written,
      reason: 'the artifact declares ' + declared.length + ' path(s) under ' + MEMORY_PLANE_PREFIX + ' (' + declared.join(', ') + '), but none of them exists, so no memory doc was written',
    }
  }
  return {
    ok: false,
    declared,
    existing,
    written,
    reason: 'the artifact declares ' + existing.length + ' existing memory doc(s) (' + existing.join(', ') + '), but none carries ' + MEMORY_PROVENANCE_FIELD + ' naming run ' + runId + ' — citing a shard this run did not write is not a write',
  }
}

/**
 * T40 — THE REFUSAL, as a sentence, or null when the run may lock.
 *
 * ⚠ THE MESSAGE NAMES THE REMEDY, not only the fault. A refusal that says "no memory doc" leaves the
 * agent to guess a format it cannot guess (nine fields, five allowed Types, a provenance list), which
 * is how the step became a ticked box in the first place.
 */
export function phase8MemoryRefusal(
  root: string,
  runId: string,
  artifactText: string,
  readText: (path: string) => string | null = readTextOrNull,
): string | null {
  const evidence = phase8MemoryEvidence(root, runId, artifactText, readText)
  if (evidence.ok) return null
  return 'locking ' + PHASE8_ARTIFACT + ' requires this run to have WRITTEN a doc under ' + MEMORY_PLANE_PREFIX + ': ' + evidence.reason
    + '. Write one (memory/episodes/' + runId + '.md is always available), declare its path under `## ' + PHASE8_MEMORY_SECTION
    + '`, and give the doc `' + MEMORY_PROVENANCE_FIELD + ': ' + runId + '` — then retry the lock.'
}

/**
 * T40 — THE LOCK-TIME ENTRY POINT: the refusal for the artifact being locked, or null.
 *
 * ⚠ THIS EXISTS SO THE GATE IS ONE LINE AT ITS CALL SITE. The decision (declared → exists → carries
 * this run's provenance) belongs in this module with the write surface that produces it; `lockArtifact`
 * should have to say only WHICH artifact it is locking, not how a memory doc is recognised. A caller
 * that has to reproduce the rule would be a second copy of it.
 *
 * ⚠ AND A MISSING ARTIFACT IS NOT THIS GATE'S REFUSAL. `lockArtifact` already refuses an absent
 * artifact before any gate can run, and returning a memory refusal for a file that does not exist
 * would replace "the artifact is missing" with a sentence about memory — a misleading diagnosis in
 * exchange for nothing.
 */
export function phase8MemoryLockRefusal(root: string, runId: string, artifact: string): string | null {
  if (artifact !== PHASE8_ARTIFACT) return null
  const artifactText = readTextOrNull(join(root, '.recursive', 'run', runId, PHASE8_ARTIFACT))
  if (artifactText === null) return null
  return phase8MemoryRefusal(root, runId, artifactText)
}
