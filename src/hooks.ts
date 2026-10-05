/**
 * T27 — a hook registry: named points, an ordered chain, and declarative failure
 * behaviour.
 *
 * WHY. Enforcement is currently two listeners inlined in `apply()`: no ordering, no
 * timeout, no failure policy, and no way for a SIBLING plugin to participate without
 * patching this one. The harness's version is the most reusable idea in the audit —
 * named points, a chain ordered by `priority`, a `continue | deny | hold` decision,
 * per-binding `timeout_ms`, and `on_error` defaults that differ by the KIND of point —
 * with *hook logic lives in the sibling, never the harness* as the governing rule.
 *
 * THE FIVE POINTS map onto DSH seams:
 *   `pre_turn`      → `agent/pre-step`, before `next()`
 *   `pre_generate`  → the policy section callback
 *   `post_generate` → a post-step listener — **OBSERVE ONLY** (see below)
 *   `pre_trigger`   → `tools/pre-execute`
 *   `post_trigger`  → `tools/post-execute`
 *
 * ⚠ OBSERVE-ONLY POINTS CANNOT DENY, and the registry ENFORCES that rather than
 * documenting it. `post_generate` and `post_trigger` run after the model message has
 * already streamed, so a "deny" there cannot un-send it — it would be a veto that
 * vetoes nothing. A deny from an observing point is therefore downgraded to
 * `continue` and REPORTED as an annotation, so the attempt is visible on the audit
 * trail instead of silently ignored or silently obeyed.
 *
 * ⚠ FAILURE DEFAULTS DIFFER BY POINT, because the right answer does. A GATING point
 * that cannot decide must not proceed — `fail_closed`. An OBSERVING point that fails
 * must not break the turn it was only watching — `fail_open`. Getting this backwards
 * in either direction is the classic hook bug: one bricks the run, the other hides
 * the failure.
 *
 * ⚠ HOOKS RUN ON AT-LEAST-ONCE PATHS AND MUST BE IDEMPOTENT. The same point can be
 * reached more than once for one logical step (a retry, a resumed turn), so a hook
 * that appends, increments or writes is a hook that eventually double-counts. The
 * chain reports every hook it ran, so a caller can SEE repeats rather than guess.
 *
 * ⚠ HOOK INPUT IS UNTRUSTED, and MUTATIONS ARE SILENT. A hook receives data derived
 * from a model turn; it must not be trusted to be well-formed. Anything a hook changes
 * about behaviour must come back as an `annotation`, because a hook that quietly
 * mutates shared state leaves nothing for the next reader to find.
 *
 * Hooks must never START A TURN: a hook that drives the loop it is embedded in
 * re-enters itself, and the chain's timeout is the only thing that would stop it.
 */
import { canonicalInput } from './identity.ts'

/** The five named points, mapped onto DSH seams (see the module comment). */
export const HOOK_POINTS = ['pre_turn', 'pre_generate', 'post_generate', 'pre_trigger', 'post_trigger'] as const

export type HookPoint = (typeof HOOK_POINTS)[number]

/** What a hook decided. `hold` means "stop and wait", distinct from a refusal. */
export type HookDecision = 'continue' | 'deny' | 'hold'

/**
 * Points that may STOP the work, versus points that only observe it. A deny from an
 * observing point is downgraded, because the thing it would veto has already happened.
 */
export const GATING_POINTS: readonly HookPoint[] = ['pre_turn', 'pre_generate', 'pre_trigger']
export const OBSERVING_POINTS: readonly HookPoint[] = ['post_generate', 'post_trigger']

export function isGating(point: HookPoint): boolean {
  return GATING_POINTS.includes(point)
}

export function isObserving(point: HookPoint): boolean {
  return OBSERVING_POINTS.includes(point)
}

/** What a hook returns. `void` means "no opinion", i.e. continue. */
export interface HookOutcome {
  decision: HookDecision
  /** Why — required in spirit for a deny or a hold, and carried verbatim. */
  reason?: string
  /**
   * What the hook CHANGED or learned, returned rather than mutated in place. Silent
   * mutation leaves the next reader nothing to find.
   */
  annotations?: Record<string, unknown>
}

export interface HookRunContext {
  readonly point: HookPoint
  /** The binding's own deadline in ms, so a hook can bail before it is cut off. */
  readonly timeoutMs: number
  /** Monotonic-ish clock from the registry, for a hook that wants to time itself. */
  readonly now: () => number
}

export interface Hook<I = unknown> {
  /** Stable name: it is what the audit trail and the board show. */
  readonly name: string
  /**
   * Higher runs FIRST. Ties break by REGISTRATION ORDER, which is what makes the
   * chain reproducible — an ordering that depends on object key order or on
   * scheduling is an ordering nobody can reason about.
   */
  readonly priority: number
  /** Per-binding deadline; falls back to the point's default. */
  readonly timeoutMs?: number
  /**
   * What to do when this hook throws or times out. Defaults by POINT: fail_closed on
   * a gating point, fail_open on an observing one.
   */
  readonly onError?: 'fail_closed' | 'fail_open'
  readonly run: (input: I, context: HookRunContext) => HookOutcome | void | Promise<HookOutcome | void>
}

/** One hook's contribution to a chain run — the audit trail. */
export interface HookRunRecord {
  name: string
  decision: HookDecision
  durationMs: number
  /** Present when the hook failed or timed out; the chain's policy decided what next. */
  error?: string
  annotations?: Record<string, unknown>
  /** True when the hook's own decision was overridden (an observing point denying). */
  downgraded?: boolean
}

export interface HookChainResult {
  point: HookPoint
  decision: HookDecision
  reason?: string
  /** Every hook that ran, in order; hooks after a short-circuit are absent by design. */
  ran: HookRunRecord[]
}

/** Registry configuration: per-point deadlines. */
export interface HookRegistryOptions {
  /** Default deadline per point when a binding does not set one. */
  timeoutMs?: Partial<Record<HookPoint, number>>
  /** Clock injection, so a test can drive timeouts without sleeping. */
  now?: () => number
}

const DEFAULT_TIMEOUT_MS = 5_000

/**
 * A hook as STORED. The registry holds hooks of many input types in one chain, so the
 * input is erased here and re-narrowed at `register`/`run`: `Hook<string>` is not
 * assignable to `Hook<unknown>` under contravariant parameter checking, and pretending
 * otherwise would need an `any`. The public API stays generic; only the shelf is erased.
 */
interface StoredHook {
  name: string
  priority: number
  timeoutMs?: number
  onError?: 'fail_closed' | 'fail_open'
  run: (input: unknown, context: HookRunContext) => HookOutcome | void | Promise<HookOutcome | void>
}

interface Bound {
  point: HookPoint
  hook: StoredHook
  /** Registration sequence: the deterministic tie-break. */
  seq: number
}

export interface HookRegistry {
  readonly points: readonly HookPoint[]
  /** Register one hook. Returns a disposer, so a sibling can withdraw cleanly. */
  register<I>(point: HookPoint, hook: Hook<I>): () => void
  /** Run the chain for a point. Never throws: failure policy decides the outcome. */
  run<I>(point: HookPoint, input: I): Promise<HookChainResult>
  /** The registered chain, in execution order — what the board would show. */
  list(point?: HookPoint): Array<{ point: HookPoint; name: string; priority: number; onError: 'fail_closed' | 'fail_open'; timeoutMs: number }>
  clear(point?: HookPoint): void
}

/**
 * Build a registry. `now` is injectable so a timeout is testable without waiting for
 * one: real deadlines in a test are a flake waiting to happen, which this codebase has
 * already paid for once.
 */
export function createHookRegistry(options: HookRegistryOptions = {}): HookRegistry {
  const bound: Bound[] = []
  let seq = 0
  const now = options.now ?? (() => Date.now())

  const timeoutFor = (point: HookPoint, hook: StoredHook): number => {
    const own = hook.timeoutMs
    if (typeof own === 'number' && own > 0) return own
    return options.timeoutMs?.[point] ?? DEFAULT_TIMEOUT_MS
  }

  const policyFor = (point: HookPoint, hook: StoredHook): 'fail_closed' | 'fail_open' =>
    hook.onError ?? (isGating(point) ? 'fail_closed' : 'fail_open')

  const chainFor = (point: HookPoint): Bound[] =>
    bound
      .filter((entry) => entry.point === point)
      // Priority DESC, then registration order ASC. Both keys are total, so the
      // result cannot depend on the sort implementation or on insertion luck.
      .sort((a, b) => (b.hook.priority - a.hook.priority) || (a.seq - b.seq))

  async function run<I>(point: HookPoint, input: I): Promise<HookChainResult> {
    const ran: HookRunRecord[] = []
    for (const entry of chainFor(point)) {
      const hook = entry.hook
      const timeoutMs = timeoutFor(point, entry.hook)
      const started = now()

      let outcome: HookOutcome | void
      let error: string | undefined
      try {
        // `Promise.resolve` so a synchronous hook and an async one take the same
        // path; the timeout is a race because a hung promise cannot be cancelled.
        outcome = await withTimeout(hook.run(input, { point, timeoutMs, now }), timeoutMs)
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        outcome = undefined
      }
      const durationMs = Math.max(0, now() - started)

      if (error !== undefined) {
        const policy = policyFor(point, entry.hook)
        ran.push({ name: hook.name, decision: policy === 'fail_closed' ? 'deny' : 'continue', durationMs, error })
        if (policy === 'fail_closed') {
          return { point, decision: 'deny', reason: 'hook ' + hook.name + ' failed on a gating point: ' + error, ran }
        }
        // fail_open: the hook is SKIPPED and the chain continues — an observing hook
        // must not break the turn it was only watching.
        continue
      }

      const decision = outcome?.decision ?? 'continue'
      const annotations = outcome?.annotations
      const record: HookRunRecord = {
        name: hook.name,
        decision,
        durationMs,
        ...(annotations === undefined ? {} : { annotations }),
      }

      // OBSERVE-ONLY POINTS CANNOT DENY: the message has already streamed, so the
      // override is applied HERE, recorded, and surfaced — not ignored.
      if (decision !== 'continue' && isObserving(point)) {
        record.decision = 'continue'
        record.downgraded = true
        record.annotations = { ...(annotations ?? {}), overriddenDecision: decision, overriddenReason: outcome?.reason ?? null }
        ran.push(record)
        continue
      }

      ran.push(record)
      if (decision === 'deny' || decision === 'hold') {
        // FIRST decisive hook short-circuits: later hooks are not run, and their
        // absence from `ran` is the evidence that they were not.
        return { point, decision, ...(outcome?.reason === undefined ? {} : { reason: outcome.reason }), ran }
      }
    }
    return { point, decision: 'continue', ran }
  }

  return {
    points: HOOK_POINTS,
    register<I>(point: HookPoint, hook: Hook<I>): () => void {
      if (!HOOK_POINTS.includes(point)) throw new Error('unknown hook point: ' + String(point))
      if (typeof hook?.name !== 'string' || hook.name.trim() === '') {
        throw new Error('a hook must have a non-empty name: it is what the audit trail shows')
      }
      if (!Number.isFinite(hook.priority)) {
        throw new Error('hook ' + hook.name + ' must declare a finite priority: ordering must be declarative')
      }
      const entry: Bound = { point, hook: hook as unknown as StoredHook, seq: seq++ }
      bound.push(entry)
      return () => {
        const index = bound.indexOf(entry)
        if (index >= 0) bound.splice(index, 1)
      }
    },
    run,
    list(point?: HookPoint) {
      const points = point === undefined ? HOOK_POINTS : [point]
      return points.flatMap((p) => chainFor(p).map((entry) => ({
        point: p,
        name: entry.hook.name,
        priority: entry.hook.priority,
        onError: policyFor(p, entry.hook),
        timeoutMs: timeoutFor(p, entry.hook),
      })))
    },
    clear(point?: HookPoint) {
      if (point === undefined) { bound.length = 0; return }
      for (let i = bound.length - 1; i >= 0; i -= 1) if (bound[i]!.point === point) bound.splice(i, 1)
    },
  }
}

/**
 * Race a hook against its deadline.
 *
 * A hung promise cannot be cancelled, so a timeout does not stop the hook — it stops
 * the CHAIN from waiting for it, which is the part that can brick a run. That is
 * stated here rather than implied, because "timed out" and "stopped" are different
 * claims.
 */
async function withTimeout<T>(value: T | Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('hook timed out after ' + timeoutMs + 'ms')), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** A stable fingerprint of one hook binding, for a board that lists the chain. */
export function hookFingerprint(entry: { point: HookPoint; name: string; priority: number; onError: string }): string {
  return canonicalInput({ point: entry.point, name: entry.name, priority: entry.priority, onError: entry.onError })
}
