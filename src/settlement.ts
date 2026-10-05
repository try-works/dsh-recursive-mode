/**
 * T36 — observe a delegated child's settlement WITHOUT reading session history.
 *
 * THE CONSTRAINT, VERIFIED IN THE CHECKOUT RATHER THAN ASSUMED. DSH prohibits new
 * production calls to `Session.snapshotEvents()`, `Session.eventAt()` and
 * `Session.ownEvents()`: *"existing logic may remain unmigrated for now, but new
 * calls are prohibited"*, the rule is enforced by an executable lint check, and
 * *"copying a waiver to a new production call violates this policy"*. The obvious
 * implementation of an observer — scan the parent's log for the `subagent-settled`
 * notice — is therefore exactly the thing that is forbidden, and it would also be
 * the wrong shape: history reads make ordinary logic depend on storage.
 *
 * THE PRESCRIBED REPLACEMENT is to *"process the delivered current event"* or read
 * maintained projection state. So this module never looks back. It recognises the
 * settlement **at delivery time** (the `session/event` listener passes it as it is
 * committed) and records it in the run's own file state, which is precisely the
 * plugin's zero-emission, file-derived architecture: nothing is appended to the
 * session, and the durable fact lands where every other plugin fact lands.
 *
 * WHY THE NOTICE ARRIVES AT ALL. A continuable child that finishes produces a
 * durable user message in the parent whose source is `{ kind: 'subagent-settled' }`
 * — the parent-side settlement seam. There is no promise to await, which is why
 * `delegateContinuable` takes an injected observer instead of awaiting one.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SubagentResultLike, ContinuableChildId, ContinuableMessageId } from './delegation.ts'

/** A settlement notice, as the plugin records it. */
export interface SettlementNotice {
  /** The durable child this settles. */
  childId: string
  /** One line saying the child is finished and why, in the parent's vocabulary. */
  summary: string
  /** The child's own closing text, if it left any. */
  closingText: string
  /** The message id the notice arrived as, when the event carried one. */
  messageId?: string
}

/** Minimal structural view of a delivered session event (no harness import). */
export interface SessionEventLike {
  type?: string
  data?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function textOf(block: unknown): string {
  const record = asRecord(block)
  return record !== null && record.type === 'text' && typeof record.text === 'string' ? record.text : ''
}

/**
 * Recognise a settlement notice from a DELIVERED session event, or null when the
 * event is not one. Pure: no I/O, no history read, safe on any event.
 *
 * The notice's shape is the harness's: a `user/message` whose `source.kind` is
 * `subagent-settled` and whose `source.senderSessionId` names the child. The
 * content is a summary line, then optionally `Its closing message:` followed by
 * the child's own text — so the closing text is everything after that marker, and
 * a child that left nothing yields the harness's own "It left no closing message."
 */
export function settlementFromEvent(event: SessionEventLike): SettlementNotice | null {
  if (event?.type !== 'user/message') return null
  const message = asRecord(event.data)
  if (message === null) return null
  const source = asRecord(message.source)
  if (source === null || source.kind !== 'subagent-settled') return null
  const childId = typeof source.senderSessionId === 'string' ? source.senderSessionId : ''
  if (childId === '') return null

  const content = Array.isArray(message.content) ? message.content : []
  const texts = content.map(textOf).filter((t) => t !== '')
  const markerIndex = texts.findIndex((t) => t === 'Its closing message:')
  const summary = typeof source.summary === 'string' && source.summary !== ''
    ? source.summary
    : (texts[0] ?? '')
  const closingText = markerIndex >= 0 ? texts.slice(markerIndex + 1).join('\n\n') : ''

  const notice: SettlementNotice = { childId, summary, closingText }
  if (typeof message.id === 'string' && message.id !== '') notice.messageId = message.id
  return notice
}

/** The run-scoped append-only settlement log. */
export function settlementLogPath(runDir: string): string {
  return join(runDir, 'subagents', 'settlements.jsonl')
}

/**
 * Which run owns this child, resolved from the FILESYSTEM alone.
 *
 * The delivered event names the child (`source.senderSessionId`) but not the run,
 * and the plugin's whole design is to derive placement from what is on disk rather
 * than to keep a registry that could go stale. A delegation writes its child
 * directories as `subagents/<delegationId>/child-<childId>/`, so the run holding
 * that child is the run the settlement belongs to.
 *
 * AMBIGUITY RETURNS NULL rather than guessing. Two runs claiming the same child
 * would mean a copied tree, and filing a settlement into the wrong run is worse
 * than not filing it: it would attach one run's evidence to another run's chain.
 * A miss costs a settlement the loop will report as "no settlement yet", which is
 * recoverable; mis-filing is not.
 */
export function runDirForChild(root: string, childId: string): string | null {  if (childId === '' || root === '') return null
  const runsRoot = join(root, '.recursive', 'run')
  let runs: string[]
  try {
    runs = readdirSync(runsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return null
  }

  const matches: string[] = []
  for (const runName of runs) {
    const runDir = join(runsRoot, runName)
    let delegations: string[]
    try {
      delegations = readdirSync(join(runDir, 'subagents'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      continue
    }
    for (const delegationId of delegations) {
      if (existsSync(join(runDir, 'subagents', delegationId, 'child-' + childId))) {
        matches.push(runDir)
        break
      }
    }
  }
  return matches.length === 1 ? matches[0]! : null
}

/**
 * Record one notice in the run's file state. APPEND-ONLY, matching the run's own
 * evidence posture: a settlement that already happened is a fact, and rewriting
 * the log would let a later write erase the record of an earlier round.
 */
export function recordSettlement(runDir: string, notice: SettlementNotice): string {
  const path = settlementLogPath(runDir)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(notice) + '\n', 'utf8')
  return path
}

/** Every recorded notice for a run, in arrival order. Never throws. */
export function readSettlements(runDir: string): SettlementNotice[] {
  let raw: string
  try {
    raw = readFileSync(settlementLogPath(runDir), 'utf8')
  } catch {
    return []
  }
  const out: SettlementNotice[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = asRecord(JSON.parse(trimmed))
      if (parsed !== null && typeof parsed.childId === 'string' && typeof parsed.summary === 'string') {
        const notice: SettlementNotice = {
          childId: parsed.childId,
          summary: parsed.summary,
          closingText: typeof parsed.closingText === 'string' ? parsed.closingText : '',
        }
        if (typeof parsed.messageId === 'string') notice.messageId = parsed.messageId
        out.push(notice)
      }
    } catch {
      // A malformed line is skipped rather than failing the whole read: a log
      // that a partial write corrupted must not make the run unobservable.
    }
  }
  return out
}

/** The LATEST recorded settlement for one child, or null when none has landed. */
export function readSettlement(runDir: string, childId: string): SettlementNotice | null {
  const mine = readSettlements(runDir).filter((n) => n.childId === childId)
  return mine.length === 0 ? null : mine[mine.length - 1]!
}

/**
 * Turn a recorded settlement into the result shape the delegation loop reads.
 *
 * `success` is deliberately NOT asserted from the summary: the notice reports how
 * the child's turn ENDED, not whether its work is acceptable. Acceptance is the
 * verdict's job (`readVerdict` + `evaluateDelegationResult`), and defaulting to
 * success here would let a stopped child be treated as a passing review — the
 * exact silent-approval failure `delegateContinuable` refuses to fabricate.
 */
export function settlementResult(notice: SettlementNotice): SubagentResultLike {
  const result: SubagentResultLike = {
    output: notice.closingText,
    stopReason: 'completed',
  } as SubagentResultLike
  // A child that reported structured JSON leaves it as the closing text.
  const parsed = (() => {
    try { return JSON.parse(notice.closingText) } catch { return undefined }
  })()
  if (parsed !== undefined) (result as { structured?: unknown }).structured = parsed
  return result
}

/**
 * Build the `awaitRoundResult` observer the continuable loop injects: it reports a
 * settlement ONLY once the listener has recorded one, and returns null while the
 * child is still working — which is the loop's documented "no settlement yet"
 * signal, not a failure to observe.
 *
 * This is the whole point of parking rather than blocking: there is no
 * parent-side promise to await, so an observer that cannot see a settlement must
 * say so and let the caller resume on a later turn with the SAME child id (the
 * loop preserves it for exactly that reason).
 */
export function settlementRoundObserver(
  runDir: string,
): (childId: ContinuableChildId, messageId: ContinuableMessageId) => Promise<SubagentResultLike | null> {
  return async (childId: ContinuableChildId) => {
    const notice = readSettlement(runDir, String(childId))
    return notice === null ? null : settlementResult(notice)
  }
}

/**
 * Handle one delivered session event: record it when it is a settlement, and
 * report whether it was one. Wired to `ctx.on('session/event', …)`, which the
 * harness documents as the delivery point for every committed event.
 */
export function captureSettlement(runDir: string, event: SessionEventLike): SettlementNotice | null {
  const notice = settlementFromEvent(event)
  if (notice === null) return null
  recordSettlement(runDir, notice)
  return notice
}

/**
 * FU-3 — the children a run has on its books, read from the layout the delegations already write.
 *
 * WHY FROM DISK AND NOT FROM MEMORY. A delegation records itself as `subagents/<delegationId>/child-<childId>/`
 * (see {@link runDirForChild}), which is the same fact the settlement log is keyed on. Reading it back
 * means a drain at closeout works **in a fresh process** — after a resume, a crash or a compaction — where
 * an in-memory list of children would be empty and the run would silently leak every child it started.
 *
 * ⚠ AN EMPTY ANSWER IS A REAL ANSWER: a run that delegated nothing has no children, and the caller must
 * be able to tell that from a failed lookup — hence a plain `[]` rather than `null`.
 */
export function runChildIds(runDir: string): string[] {
  const base = join(runDir, 'subagents')
  if (!existsSync(base)) return []
  const ids: string[] = []
  for (const delegation of readdirSync(base, { withFileTypes: true })) {
    if (!delegation.isDirectory()) continue
    const delegationDir = join(base, delegation.name)
    for (const child of readdirSync(delegationDir, { withFileTypes: true })) {
      if (child.isDirectory() && child.name.startsWith('child-')) {
        const id = child.name.slice('child-'.length)
        if (id !== '' && !ids.includes(id)) ids.push(id)
      }
    }
  }
  return ids
}
