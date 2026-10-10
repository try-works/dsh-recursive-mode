/**
 * T16 — declarative, ordered tool policy (plan §4 T16).
 *
 * Enforcement used to be a hardcoded `WRITE_TOOL_NAMES` set plus a
 * `endsWith('.md') && includes('/.recursive/run/')` substring test inside
 * `evaluateToolGuard`. A code path is not auditable; an ordered rule list is.
 * This module is the rule list and its evaluator, plus the loader — nothing
 * else. The RULES THEMSELVES live in `src/enforcement.ts` (built-in defaults)
 * and `src/phase-rules.ts` (per-phase baselines), so this module stays pure and
 * importable by both without a cycle.
 *
 *   - PRECEDENCE is SPECIFICITY FIRST, THEN FILE ORDER (see
 *     `patternSpecificity`/`evaluateToolPolicy`): the most specific matching
 *     pattern decides, and equally specific rules are decided by file order. This
 *     is what makes "deny beats a matching allow" true no matter where the
 *     catch-all `*` sits in the file;
 *   - a matched `deny` before a matched `allow` of the same specificity wins, and
 *     the shipped lists keep every `deny` above every `allow` as a READABILITY
 *     convention, not as the correctness mechanism;
 *   - an INVALID pattern fails the WHOLE policy closed — deny everything, and
 *     the reason NAMES the offending pattern;
 *   - NO match yields `ask` — not deny, not allow. `ask` is the only verdict
 *     that neither silently permits nor bricks the session, so it is the default.
 *
 * ---------------------------------------------------------------------------
 * THE ABSENT-vs-PRESENT DISTINCTION (read this before changing the loader)
 * ---------------------------------------------------------------------------
 *   ABSENT policy file   -> the BUILT-IN default rule list, which reproduces
 *                           the guard behaviour that shipped before T16. This
 *                           is the SAFE DEFAULT: every existing repo, and every
 *                           temp repo a test creates, keeps working.
 *   PRESENT but empty    -> FAIL CLOSED: deny everything. An empty allow-list
 *                           is not an allow-all list.
 *   PRESENT but invalid  -> FAIL CLOSED: deny everything, naming the pattern /
 *                           rule field that is wrong.
 *
 * Collapsing those two cases in EITHER direction is the bug this comment exists
 * to prevent: treating absent as invalid BRICKS every repo (all tool calls
 * denied), and treating invalid as absent silently ignores the policy a human
 * just wrote and believes is in force.
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { getLockStatus, getPrerequisiteBlockers, type PrerequisiteBlocker } from './lock.ts'
import { getMdFieldValue } from './status.ts'
import { phaseNumberForArtifact, policyTargetPath, resolveFrom } from './phase-rules.ts'

/** The three verdicts a rule may carry. */
export type Verdict = 'allow' | 'deny' | 'ask'

/**
 * The policy engine's own decision shape (no `warn`/`transition` — those are the
 * guard's, see enforcement.ts). `rule` is the `label` of the rule that decided
 * the call, so a verdict is traceable to an auditable line in the policy file;
 * it is absent when the no-match default decided.
 */
export interface Decision {
  kind: Verdict
  reason?: string
  rule?: string
  /**
   * THE FACTS THE PREDICATE DECIDED FROM, when it read any. The lock-order rule resolves the
   * artifact's prerequisites from disk, and the layer that turns this decision into a refusal
   * needs those same facts to build the caller's recovery options. Carrying them is what makes
   * "the guard already has them" true: a second `getPrerequisiteBlockers` call from the denial
   * would re-read a run tree that is on disk and unlocked, and could answer differently.
   *
   * Absent for every rule that decides on its pattern alone, and absent when the predicate read
   * nothing — so its presence means "this refusal was decided from these blockers", not "the
   * policy mentions blockers".
   */
  blockers?: readonly PrerequisiteBlocker[]
}

/**
 * Extra facts a rule predicate may need. `args` is always the tool call's
 * arguments; the run coordinates are present only when the caller has them
 * (a guard call from a real session does; a pure policy unit test need not).
 *
 * ⚠ `runId` IS NOT DECORATION: the lock-order rule puts it in the refusal (`[run: <id>]`), so a refusal
 * names the run whose tree it was decided from. It is the run the guard RESOLVED for this call — the run
 * the call named when it named a usable one, otherwise the active run (see `resolveGuardRunId` in
 * `enforcement.ts`) — never a second, independently-derived answer.
 */
export interface ToolPolicyContext {
  args: Record<string, unknown>
  runDir?: string
  runId?: string
  worktreeRoot?: string
  /**
   * The ACTIVE phase artifact of the run — the LOWEST-numbered phase artifact that is not
   * LOCKED, falling back to the highest when every one of them is locked.
   *
   * ⚠ THIS IS NOT A SECOND SELECTOR. It is the answer `currentPhaseArtifact` in
   * `enforcement.ts` produced for this call, carried here so a rule in THIS module can
   * compare against it. `policy-globs.ts` cannot import that function (enforcement.ts
   * imports this module, and the repo has already paid once for a value-level import
   * cycle), so the value is passed in rather than recomputed. A caller that omits it
   * gets NO phase-order verdict — the rule abstains rather than guessing a phase.
   */
  activePhaseArtifact?: string
}

/**
 * What a rule predicate returns when the condition it guards DOES apply:
 * the verdict, plus an optional `detail` appended to the rule's own `reason`.
 * The rule keeps the static, auditable sentence (the same sentence the policy
 * file and the built-in list carry, so the two cannot drift); the predicate adds
 * only the per-call particular — which artifact blocked the lock, and its status.
 *
 * `null` means the condition does NOT apply, and the engine falls through to the
 * NEXT rule. That fall-through is how an id-glob rule such as `write` can guard
 * write tools without deciding for an ordinary write that violates nothing
 * (which a bare pattern match would otherwise deny).
 */
export interface ToolPolicyPredicateMatch {
  verdict: Verdict
  detail?: string
  /**
   * The blockers the predicate READ, when it read any (see `Decision.blockers`). Optional and
   * additive: a predicate that decided from something else returns none, and the engine's
   * verdict is unchanged either way.
   */
  blockers?: readonly PrerequisiteBlocker[]
}

export type ToolPolicyPredicate = (
  id: string,
  args: Record<string, unknown>,
  ctx: ToolPolicyContext,
) => ToolPolicyPredicateMatch | null

export interface ToolPolicyRule {
  pattern: string
  verdict: Verdict
  reason: string
  /** The guard's machine-readable rule label for a decision this rule makes. */
  label?: string
  predicate?: ToolPolicyPredicate
}

/**
 * The `defaults` block of a policy file. `no_match_verdict` is documented for a
 * human reader and may only ever be `"ask"`: the no-match default is a property
 * of the engine, not a knob, because a configurable one would let a policy file
 * silently allow (or deny) every unlisted tool.
 */
export interface ToolPolicyFileDefaults {
  no_match_verdict?: 'ask'
}

export interface ToolPolicy {
  version: number
  description?: string
  rules: ToolPolicyRule[]
}

/** Where the shipped default policy lives, relative to the worktree root. */
export const TOOL_POLICY_RELATIVE_PATH = '.recursive/config/recursive-permissions.json'

/** Absolute path of the policy file for a worktree. */
export function toolPolicyPath(worktreeRoot: string): string {
  return join(worktreeRoot, ...TOOL_POLICY_RELATIVE_PATH.split('/'))
}

/* -------------------------------------------------------------------------- */
/* Glob matching                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Pattern grammar, deliberately tiny so a human can predict a verdict:
 *   `*`          any run of characters, INCLUDING the empty run (catch-all)
 *   `<literal>`  the exact tool id
 * Combining them gives the documented id-glob form `worker::*` (every id that
 * starts with the literal `worker::`) and `recursive_*`.
 *
 * A literal character must be one a tool id may contain: letters, digits, `_`,
 * `-`, `.` and `:`. Anything else — an empty/blank pattern, a space, a path
 * separator, a regex metacharacter such as `[` or `?` — is INVALID, and an
 * invalid pattern fails the whole policy closed. That strictness is the point:
 * a pattern a human believes matches something it does not is a silent hole.
 */
const LITERAL = /^[A-Za-z0-9_.:-]$/

/** Collapse runs of `*`, so bare `**` is the same catch-all as `*`. */
function normalizePattern(pattern: string): string {
  return pattern.replace(/\*+/g, '*')
}

/**
 * The syntax error in `pattern`, or null when it is well formed.
 *
 * Beyond the character rule there are two STRUCTURAL rules, because a pattern
 * that a human reads as "the worker tools" must not be a silent no-op:
 *   - a pattern may not END with a separator (`worker::`, `a.`, `a:`) — a
 *     dangling separator names nothing, so it would sit in the file looking like
 *     a rule while matching no tool id at all;
 *   - a pattern may not START with one (`.foo`), for the same reason.
 * `worker::*` is unaffected: it ends with the wildcard, which is how the id-glob
 * form is written.
 */
export function patternSyntaxError(pattern: unknown): string | null {
  if (typeof pattern !== 'string') return 'pattern must be a string, got ' + (pattern === null ? 'null' : typeof pattern)
  if (pattern.length === 0) return 'pattern is empty'
  if (pattern.trim().length === 0) return 'pattern is blank'
  for (const ch of pattern) {
    if (ch === '*') continue
    if (!LITERAL.test(ch)) return 'pattern contains the unsupported character ' + JSON.stringify(ch)
  }
  if (/[.:]$/.test(pattern)) return 'pattern ends with a separator, which names nothing (write "worker::*", not "worker::")'
  if (/^[.:]/.test(pattern)) return 'pattern starts with a separator, which names nothing'
  return null
}

export function isValidGlobPattern(pattern: unknown): boolean {
  return patternSyntaxError(pattern) === null
}

/**
 * Glob-match a tool id. Every `*` matches strictly up to the next literal, so
 * the matcher is anchored at both ends: `worker::*` does NOT match `xworker::y`.
 * Single-restart backtracking, no recursion.
 */
export function globMatch(pattern: string, id: string): boolean {
  const p = normalizePattern(pattern)
  const n = p.length
  let pi = 0
  let si = 0
  let star = -1
  let mark = 0
  while (si < id.length) {
    if (pi < n && p[pi] !== '*' && p[pi] === id[si]) {
      pi++
      si++
      continue
    }
    if (pi < n && p[pi] === '*') {
      star = pi
      mark = si
      pi++
      continue
    }
    if (star >= 0) {
      // Give the star one more character and retry from just after it.
      pi = star + 1
      mark++
      si = mark
      continue
    }
    return false
  }
  while (pi < n && p[pi] === '*') pi++
  return pi === n
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

/** The first syntax/contract problem in a policy, in rule order. */
export function firstPolicyDefect(policy: ToolPolicy): string | null {
  if (!policy || typeof policy !== 'object') return 'policy must be a JSON object'
  if (!Array.isArray(policy.rules)) return 'policy.rules must be an array'
  for (const rule of policy.rules as unknown[]) {
    if (!rule || typeof rule !== 'object') return 'policy.rules contains a non-object entry'
    const r = rule as Record<string, unknown>
    const pattern = typeof r.pattern === 'string' ? r.pattern : JSON.stringify(r.pattern)
    const unknownKeys = Object.keys(r).filter((k) => !['pattern', 'verdict', 'reason', 'label', 'predicate'].includes(k))
    if (unknownKeys.length > 0) return 'rule ' + pattern + ' has unknown key(s) ' + unknownKeys.join(', ')
    const syntax = patternSyntaxError(r.pattern)
    if (syntax) return 'invalid pattern ' + pattern + ': ' + syntax
    if (r.verdict !== 'allow' && r.verdict !== 'deny' && r.verdict !== 'ask') {
      return 'rule ' + pattern + ' has an invalid verdict ' + JSON.stringify(r.verdict) + ' - expected allow | deny | ask'
    }
    if (typeof r.reason !== 'string' || r.reason.trim() === '') {
      return 'rule ' + pattern + ' has no reason - a verdict with no stated reason is not auditable'
    }
    if (r.predicate !== undefined && typeof r.predicate !== 'function') {
      return 'rule ' + pattern + ' has a non-function predicate'
    }
  }
  return null
}

/** The fail-closed decision: everything is denied, and the defect is named. */
export function failClosedDecision(defect: string): Decision {
  return { kind: 'deny', reason: 'tool policy failed closed - ' + defect }
}

/** True when the pattern is the bare catch-all (`*`), which is least specific. */
export function isCatchAllPattern(pattern: unknown): boolean {
  return pattern === '*'
}

/**
 * Evaluation PRECEDENCE: SPECIFICITY FIRST, THEN FILE ORDER.
 *
 * T16 asks for "deny wins over allow" AND for "first-match-wins", which cannot
 * both hold under adversarial ordering. The reconciliation — and the semantics
 * this engine implements — is:
 *
 *   1. Among the rules whose pattern MATCHES the call, a rule with a MORE
 *      SPECIFIC pattern outranks one with a less specific pattern. So a
 *      catch-all `*` allow can never shield an id from a specific `deny` written
 *      BELOW it.
 *   2. Among equally specific matching rules, the EARLIER rule in the file wins.
 *   3. A rule whose predicate ABSTAINS (`null`) does not participate at all: it
 *      is as if the rule were not in the file for this call, so the next rule in
 *      precedence order decides.
 *
 * Why not plain first-match-wins: it would make "deny wins over allow" merely a
 * property of how the file happens to be ordered. A hand-edit that put a
 * catch-all allow at the top would then silently disable every deny in the file,
 * which is precisely the failure the phrase exists to prevent.
 *
 * Specificity tiers, most to least:
 *   3  an EXACT id (`write`) — the narrowest thing a pattern can name;
 *   2  a PREFIX glob (`worker::*`, `recursive_*`) — still names a family;
 *   1  a glob with a wildcard in the middle (`*_write`) — matched anywhere in
 *      the id, so it is narrower than the bare catch-all but names no family;
 *   0  the bare catch-all (`*`).
 * These are TIERS, not a fine-grained metric: patterns within a tier are
 * "equally specific" and are decided by file order.
 */
export function patternSpecificity(pattern: string): number {
  const p = normalizePattern(pattern)
  if (p === '*') return 0
  if (!p.includes('*')) return 3
  if (p.endsWith('*')) return 2
  return 1
}

/**
 * Evaluate a tool call against a policy. PURE: no filesystem, no config, no
 * caching. The loader resolves WHICH policy applies; this decides what it says,
 * using the precedence above.
 */
export function evaluateToolPolicy(
  policy: ToolPolicy,
  id: string,
  args: Record<string, unknown> = {},
  ctx?: ToolPolicyContext,
): Decision {
  const context: ToolPolicyContext = ctx ?? { args }
  const defect = firstPolicyDefect(policy)
  if (defect) return failClosedDecision(defect)

  // Specificity first, file order as the tie-break (a stable sort keeps the
  // policy's own order within a tier).
  const matching = policy.rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => globMatch(rule.pattern, id))
    .sort((a, b) => {
      const bySpecificity = patternSpecificity(b.rule.pattern) - patternSpecificity(a.rule.pattern)
      return bySpecificity !== 0 ? bySpecificity : a.index - b.index
    })

  for (const { rule } of matching) {
    if (rule.predicate) {
      const match = rule.predicate(id, args, context)
      // Abstention: this rule does not govern this call, so it does not
      // participate and the next rule in precedence order decides.
      if (match === null) continue
      return decide(rule, match.verdict, match.detail ? rule.reason + ' ' + match.detail : rule.reason, match.blockers)
    }
    return decide(rule, rule.verdict, rule.reason)
  }
  // NO MATCH -> ask. Not deny (which would brick an unlisted tool), not allow
  // (which would be a silent permit).
  return { kind: 'ask', reason: 'no policy rule matches ' + id + ' - ask is the no-match default' }
}

/**
 * One place where a rule's verdict becomes a decision, so `label` cannot drift.
 *
 * `blockers` rides along untouched when the predicate supplied any (see `Decision.blockers`);
 * an EMPTY list is dropped rather than carried, so `blockers` on a decision always means "there
 * were blockers", never "the rule looked and found none".
 */
function decide(rule: ToolPolicyRule, kind: Verdict, reason: string, blockers?: readonly PrerequisiteBlocker[]): Decision {
  const decision: Decision = { kind, reason }
  if (rule.label) decision.rule = rule.label
  if (blockers !== undefined && blockers.length > 0) decision.blockers = blockers
  return decision
}

/* -------------------------------------------------------------------------- */
/* Loading (absent -> built-in, present-but-broken -> fail closed)             */
/* -------------------------------------------------------------------------- */

export interface ToolPolicyLoadResult {
  ok: boolean
  /** `file` when a policy file was found, `builtin` when it was ABSENT. */
  source: 'file' | 'builtin'
  policy: ToolPolicy
  /** Absolute path of the policy file, when one was found. */
  path?: string
  /** Why the file could not be used, when `ok` is false. */
  error?: string
}

/**
 * The ABSENT-file fallback policy, and the slot it lives in.
 *
 * `src/policy-builtin.ts` used to hold the list and call `setBuiltInToolPolicy`
 * at its own top level. That was an import cycle — the list needs this module's
 * predicate contract, this module imported the list — and a cycle means whichever
 * entry loads first observes a partially initialised namespace, which is how a
 * top-level wiring call came to throw `setBuiltInToolPolicy is not a function`.
 *
 * So: the list is defined BELOW, in this module, and wired by the
 * `setBuiltInToolPolicy(builtInToolPolicyDefault)` call at its end. A consumer
 * that imports only `policy-globs.ts` — the loader's own unit tests, for one —
 * therefore gets the safe default without having to remember to install it, and
 * no wiring step can be forgotten.
 *
 * `setBuiltInToolPolicy` stays exported for a caller that genuinely wants a
 * different fallback. The initial value below is unreachable once this module has
 * finished evaluating; it exists so that a hypothetical unwired state denies
 * rather than silently allows, and names the missing wire instead of being
 * mysterious.
 */
let builtInPolicy: () => ToolPolicy = () =>
  failClosedPolicy('no built-in tool policy is wired (setBuiltInToolPolicy was never called)')

/** Wire the built-in default policy used when no policy file exists. */
export function setBuiltInToolPolicy(factory: () => ToolPolicy): void {
  builtInPolicy = factory
}

/** The built-in policy in force for the absent-file case. */
export function builtInToolPolicy(): ToolPolicy {
  return builtInPolicy()
}

/* -------------------------------------------------------------------------- */
/* Built-in default rules — the ABSENT-file fallback                          */
/* -------------------------------------------------------------------------- */

/** Tool names the locked-artifact write rule guards. */
export const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'fs_write', 'fs-write', 'pwsh', 'shell', 'bash', 'run_code'])

/** Tool names the monotonic lock-order rule guards. */
export const LOCK_TOOL_NAMES = new Set(['recursive_lock', 'recursive_lock_phase'])

/**
 * Monotonic lock-order rule: a denial when an earlier phase is not locked,
 * `null` when nothing blocks the lock. The rule carries the static, auditable
 * sentence; the predicate adds the blocking artifact and its status, which is
 * what distinguishes a guard refusal from `lockArtifact`'s own
 * `Prerequisite blockers:` error (`tests/guard-path.spec.ts` asserts both).
 *
 * ⚠ ISSUE 2 (b) — AND IT NAMES THE RUN IT READ, `ctx.runId`, as `[run: <id>]`.
 *
 * The blockers above are read FROM A DIRECTORY (`runDir`), and until this suffix existed the refusal said
 * only "an earlier phase must be locked first  00-requirements.md (DRAFT)" — a sentence with no run in it.
 * That is what let a refusal MIX TWO RUNS in one payload: a call naming run-b could be judged against
 * run-a's tree (the guard resolved the run from the filesystem, the tool from `args.runId`) and the caller
 * was told about `00-requirements.md (DRAFT)` while the guard-decision record said `runId: run-a` and the
 * gate-block ask said `artifact: 01-as-is.md`. The blocking artifact, the artifact the caller named and the
 * run the record attributed it to were three answers to one question.
 *
 * The fix is two-sided: the guard now judges the run the CALL NAMES (see `resolveGuardRunId` in
 * `enforcement.ts`), and this suffix makes the evaluated run part of the sentence, so the payload can be
 * read without cross-referencing the log record — and a reader can SEE which run was read, which is what
 * makes a future mismatch visible instead of silent.
 *
 * `runId` is optional because the pure policy layer may be called with no run context at all (a policy
 * unit test, a preview probe): the sentence is then exactly what it always was, and no run is invented.
 */
function lockOrderRule(artifact: unknown, runDir: string | undefined, runId?: string): ToolPolicyPredicateMatch | null {
  const name = String(artifact ?? '')
  if (!name || !runDir) return null
  const blockers = getPrerequisiteBlockers(runDir, name)
  if (blockers.length === 0) return null
  const where = typeof runId === 'string' && runId.trim() !== '' ? ' [run: ' + runId.trim() + ']' : ''
  return {
    verdict: 'deny',
    detail: blockers.map((b) => b.artifact + ' (' + b.status + ')').join(', ') + where,
    // THE SAME READ, carried up rather than thrown away: the denial's recovery options are built
    // from these blockers, and re-deriving them one layer higher would be a second filesystem
    // answer to a question this rule has already answered.
    blockers,
  }
}

/**
 * Locked-artifact write rule: a denial when the target carries
 * `Status: LOCKED`, `null` otherwise. Only a run-tree `*.md` is a candidate —
 * the same admission test the pre-T16 branch used, now asked of the RESOLVED
 * path as well (see the ADMISSION note below).
 *
 * A caller with no `worktreeRoot` still gets `null` for every target, absolute
 * ones included: that is the pre-existing behaviour and it is left alone here —
 * the guard always carries a root, so nothing that reaches it changes.
 */
function lockedWriteRule(target: string | null, worktreeRoot: string | undefined): ToolPolicyPredicateMatch | null {
  if (!target || !worktreeRoot) return null
  const normalized = target.replace(/\\/g, '/')
  if (!normalized.endsWith('.md')) return null
  const abs = resolveFrom(worktreeRoot, normalized)
  if (!abs) return null
  // ADMISSION — a target is a candidate when it NAMES the run tree, and the marker is
  // looked for on the path the target RESOLVES to as well as on the string as written.
  //
  // The string test alone requires a separator BEFORE `.recursive`, so it admitted an
  // ABSOLUTE target and missed a REPO-RELATIVE one (`.recursive/run/<id>/00-requirements.md`,
  // the form a model actually types, and its backslash spelling too). The rule then
  // ABSTAINED, the phase baseline saw a write INSIDE the run tree — allowed by design — and
  // the catch-all allowed a write to an artifact whose `Status:` is LOCKED. The resolved test
  // is the fix, and it is the same question asked of the path the string names; `getLockStatus`
  // below already used `abs`, so the two halves of this rule now agree on one path.
  //
  // The string test is KEPT rather than replaced, so that no absolute spelling denied today
  // becomes allowed: a literal target that carries the marker but resolves away from it
  // (`…/.recursive/run/../…`) is still admitted, exactly as before.
  const resolved = abs.replace(/\\/g, '/')
  if (!normalized.includes('/.recursive/run/') && !resolved.includes('/.recursive/run/')) return null
  if (getLockStatus(abs) !== 'LOCKED') return null
  return { verdict: 'deny', detail: normalized + ' carries Status: LOCKED (reopen explicitly to edit)' }
}

/**
 * The file name when `abs` is a DIRECT CHILD of `runDir`, and `null` otherwise.
 *
 * ⚠ THE DIRECT-CHILD TEST IS NOT TIDINESS — IT IS WHAT KEEPS THE RULE OFF THE SUPPORT
 * FILES. `phaseNumberForArtifact` reads the leading digits of a NAME, so
 * `<run>/evidence/01-as-is.md` or `<run>/subagents/child/03-brief.md` would look like
 * phase 1 and phase 3 artifacts if the name were all that was examined. A phase artifact
 * is a file the run tree holds DIRECTLY beside the others (`recursive_init` writes all
 * twelve into `<run>/` itself), so the parent directory is part of the definition.
 *
 * The comparison normalizes separators and case: the same run directory reached through
 * a Windows spelling that differs in case is the same directory, and the rule must not
 * abstain on one spelling and fire on the other.
 */
function directChildName(abs: string, runDir: string): string | null {
  const normalize = (path: string) => resolve(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  if (normalize(dirname(abs)) !== normalize(runDir)) return null
  return basename(abs)
}

/**
 * PHASE-ORDER rule: a denial when the target is a LATER phase's artifact than the phase
 * currently active, `null` when it is not.
 *
 * ⚠ THE HOLE THIS CLOSES. The monotonic rule was enforced on `recursive_lock` ONLY. An
 * agent could therefore write `08-memory-impact.md` while the run sat at phase 0 — and a
 * live run did exactly that: twelve artifacts, not one of them locked, written out of
 * order, with a single line in `operations/operations.jsonl`. Ordering that only binds
 * the lock tool is not ordering; the model's ordinary `write` is the path that mattered.
 *
 * The owner's rule, verbatim: *only one phase may be active at a time, and the phases
 * should be sequential and the active phase must be locked before proceeding to next
 * phase*. The ACTIVE phase is the one the selector names (`ctx.activePhaseArtifact`), so:
 *
 *   - the target is the ACTIVE artifact, or shares its phase number (`00-requirements.md`
 *     and `00-worktree.md` are both phase 0; `01-as-is.md` and `01.5-root-cause.md` are
 *     both phase 1) -> ABSTAIN, the write is allowed;
 *   - the target is an EARLIER phase -> ABSTAIN. Such an artifact is LOCKED by
 *     construction (the active phase is the lowest UNLOCKED one), so the locked-artifact
 *     rule above decides it, and its rule label is preserved;
 *   - the target is a LATER phase -> DENY: working ahead.
 *
 * ⚠ THE ALLOW HALF IS LOAD-BEARING. An enforcement rule in this exact area was once the
 * bug: strict enforcement denied the run's OWN artifacts in every phase and made the
 * workflow unusable (see `resolveFrom` and `currentPhaseArtifact`). "The active artifact
 * stays writable at every phase" is therefore asserted by walking every phase, not by
 * one case — `tests/strict-run-tree.spec.ts` (d).
 *
 * WHAT IT ABSTAINS ON, deliberately:
 *   - no `activePhaseArtifact` (a caller with no run context, or a run with no phase
 *     artifacts yet) -> abstain, never guess a phase;
 *   - a target outside the active run's own directory -> abstain. The rule is about THIS
 *     run's sequence; another run's tree is a different question and denying it here
 *     would be a false positive;
 *   - a support file (anything not a direct child) -> abstain: `evidence/`, `scratch/`,
 *     `addenda/`, `subagents/`, `operations/` and a plain `<run>/notes.md` are not phases.
 *
 * The predicate adds only the per-call particular — which artifact, which phase, which is
 * active; the rule keeps the static, auditable sentence.
 */
function phaseOrderRule(target: string | null, ctx: ToolPolicyContext): ToolPolicyPredicateMatch | null {
  const active = ctx.activePhaseArtifact
  if (!target || !ctx.runDir || !ctx.worktreeRoot) return null
  if (typeof active !== 'string' || active === '') return null
  const activePhaseText = phaseNumberForArtifact(active)
  if (!activePhaseText) return null
  const normalized = target.replace(/\\/g, '/')
  if (!normalized.endsWith('.md')) return null
  const abs = resolveFrom(ctx.worktreeRoot, normalized)
  if (!abs) return null
  const name = directChildName(abs, ctx.runDir)
  if (name === null) return null
  const phaseText = phaseNumberForArtifact(name)
  if (!phaseText) return null
  if (Number(phaseText) <= Number(activePhaseText)) return null
  return {
    verdict: 'deny',
    detail: name + ' is phase ' + phaseText + ' but the ACTIVE phase is ' + active
      + ' (phase ' + activePhaseText + ') - the active phase must be locked before writing a later phase',
  }
}

/**
 * The BUILT-IN default rule list — the pre-T16 guard behaviour expressed as
 * data:
 *
 *   `recursive_lock*`  -> the monotonic lock-order denial;
 *   the write-tool ids -> the locked-artifact write denial;
 *   the write-tool ids -> the phase-order (write-ahead) denial;
 *   `*`                -> allow, so an ordinary tool is not turned into an `ask`.
 *
 * Every `deny` precedes the `allow`, which is what makes "deny wins over allow" a
 * fact about the list rather than a hope. The predicates return `null` when
 * their condition does not apply, so a matched-but-clean write falls through to
 * the allow instead of being denied by the pattern alone.
 *
 * `.recursive/config/recursive-permissions.json` mirrors this list in the same
 * order with the same reasons: a reviewer reads either one and predicts the same
 * verdict.
 */
export function builtInToolPolicyRules(): ToolPolicyRule[] {
  const rules: ToolPolicyRule[] = [
    {
      pattern: 'recursive_lock*',
      verdict: 'deny',
      reason: 'monotonic lock-order: an earlier phase must be locked first',
      label: 'lock-order',
      predicate: (id, args, ctx) => (LOCK_TOOL_NAMES.has(id) ? lockOrderRule(args.artifact, ctx.runDir, ctx.runId) : null),
    },
  ]
  for (const name of WRITE_TOOL_NAMES) {
    rules.push({
      pattern: name,
      verdict: 'deny',
      reason: 'locked-artifact write denial: the target carries Status: LOCKED',
      label: 'locked-write',
      predicate: (id, args, ctx) => (WRITE_TOOL_NAMES.has(id) ? lockedWriteRule(policyTargetPath(args), ctx.worktreeRoot) : null),
    })
  }
  // The SAME write-tool ids get a SECOND conditional deny, the phase-order rule. Two rules
  // share one pattern on purpose: the engine's predicates ABSTAIN (`null`) when their
  // condition does not apply, so a clean write falls through both to the catch-all allow,
  // and a target that is BOTH locked and a later phase is reported by the locked rule
  // first (file order within a specificity tier), which is the pre-existing wording.
  for (const name of WRITE_TOOL_NAMES) {
    rules.push({
      pattern: name,
      verdict: 'deny',
      reason: 'phase order: only one phase may be active at a time - the active phase must be locked before a later phase artifact is written',
      label: 'phase-order',
      predicate: (id, args, ctx) => (WRITE_TOOL_NAMES.has(id) ? phaseOrderRule(policyTargetPath(args), ctx) : null),
    })
  }
  rules.push({
    pattern: '*',
    verdict: 'allow',
    reason: 'no deny rule matches this tool',
  })
  return rules
}

/** The built-in default policy (the absent-file fallback), as a policy object. */
export function builtInToolPolicyDefault(): ToolPolicy {
  return { version: 1, description: 'built-in default tool policy (no policy file present)', rules: builtInToolPolicyRules() }
}

/**
 * Attach the CODE-side condition to a rule that was authored in JSON.
 *
 * This is the seam that makes a policy file honest. JSON cannot carry a
 * function, so a `deny` rule read from a file has no way to know whether its
 * condition actually holds — and an unguarded `deny` is an UNCONDITIONAL denial,
 * i.e. a policy file that denies locks whose prerequisites are met and writes to
 * artifacts that are not locked. The pattern identifies the rule's subject, so
 * the pattern is what selects the condition:
 *
 *   `recursive_lock*` -> the monotonic lock-order condition;
 *   any write-tool id -> the locked-artifact condition.
 *
 * A pattern the code knows nothing about keeps NO condition and is therefore an
 * absolute verdict — which is the honest reading of a rule like
 * `{"pattern": "run_code", "verdict": "deny"}` with no lock condition behind it.
 */
export function attachPolicyPredicate(rule: ToolPolicyRule): ToolPolicyRule {
  if (rule.predicate) return rule
  if (rule.pattern === 'recursive_lock*') {
    return { ...rule, predicate: (id, args, ctx) => (LOCK_TOOL_NAMES.has(id) ? lockOrderRule(args.artifact, ctx.runDir, ctx.runId) : null) }
  }
  // ⚠ THE LABEL IS CONSULTED BEFORE THE PATTERN, because the phase-order rule and the
  // locked-artifact rule share EVERY write-tool pattern (see `builtInToolPolicyRules`).
  // Selecting by pattern alone would give BOTH rules the locked-artifact condition — the
  // second would then deny a locked target with the wrong reason and the phase-order
  // condition would never be attached at all, so the hole would stay open in every repo
  // that ships a policy file. The `label` is already the rule's machine-readable identity
  // (`firstPolicyDefect` admits it, `decide` surfaces it as the decision's `rule`), so the
  // label is what names the condition. A rule with NO label keeps the pattern's condition,
  // exactly as before.
  if (rule.label === 'phase-order') {
    return { ...rule, predicate: (id, args, ctx) => (WRITE_TOOL_NAMES.has(id) ? phaseOrderRule(policyTargetPath(args), ctx) : null) }
  }
  if (WRITE_TOOL_NAMES.has(rule.pattern)) {
    return { ...rule, predicate: (id, args, ctx) => (WRITE_TOOL_NAMES.has(id) ? lockedWriteRule(policyTargetPath(args), ctx.worktreeRoot) : null) }
  }
  return rule
}

/**
 * TDD evidence predicate for a phase-3 lock (the `tdd-evidence` guard rule): the
 * denial match when the artifact declares `TDD Mode: strict` without both RED
 * and GREEN evidence, `null` otherwise — nothing to say, so the global lock rules
 * still apply. `phase-rules.ts` uses it for the phase-3 baseline.
 */
export function tddEvidenceVerdict(artifact: string, runDir: string | undefined): ToolPolicyPredicateMatch | null {
  if (!runDir || artifact !== '03-implementation-summary.md') return null
  const artifactPath = join(runDir, artifact)
  if (!existsSync(artifactPath)) return null
  const content = readFileSync(artifactPath, 'utf8')
  const tddMode = getMdFieldValue(content, 'TDD Mode') ?? ''
  if (tddMode !== 'strict') return null
  const hasRed = /RED|red evidence/i.test(content)
  const hasGreen = /GREEN|green evidence/i.test(content)
  if (hasRed && hasGreen) return null
  return { verdict: 'deny' }
}

// At DEFINITION time, not as a separate wiring step: any module that imports
// this file gets the absent-file safe default.
setBuiltInToolPolicy(builtInToolPolicyDefault)

/**
 * Read and validate the policy file. NEVER throws: an unreadable or malformed
 * file yields `ok: false` plus a fail-closed policy, so the guard reasons about
 * it instead of crashing the tools/pre-execute listener.
 */
export function loadToolPolicyFile(worktreeRoot: string): ToolPolicyLoadResult {
  const path = toolPolicyPath(worktreeRoot)
  if (!existsSync(path)) {
    // ABSENT -> the built-in list that reproduces pre-T16 behaviour. Do NOT make
    // this the fail-closed branch: every repo without a policy file would then
    // deny every tool call.
    return { ok: true, source: 'builtin', policy: builtInToolPolicy() }
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const defect = 'policy file is unreadable: ' + messageOf(error)
    return { ok: false, source: 'file', path, policy: failClosedPolicy(defect), error: defect }
  }
  // A PRESENT file is authoritative even when broken: a human wrote it, so a
  // defect must fail closed loudly rather than silently fall back to built-ins.
  const parsed = parseToolPolicy(raw, path)
  return { ok: parsed.ok, source: 'file', path, policy: parsed.policy, error: parsed.error }
}

/**
 * Parse policy JSON into a policy. A parse/validation failure does NOT throw and
 * does NOT return an empty rule list (which would mean "ask everything" and hide
 * the defect) — it returns a single deny-all rule carrying the defect, plus
 * `ok: false` and the same defect as `error`, so a caller can tell a healthy
 * policy from a fail-closed one WITHOUT having to compare reasons. Both the
 * malformed-JSON case and the PRESENT-but-empty case are `ok: false`.
 */
export function parseToolPolicy(raw: string, path?: string): ToolPolicyParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return parseFailure('policy file is not valid JSON: ' + messageOf(error))
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parseFailure('policy must be a JSON object with a rules array')
  }
  const record = parsed as Record<string, unknown>
  const unknown = Object.keys(record).filter((k) => !['version', 'description', 'defaults', 'rules'].includes(k))
  if (unknown.length > 0) return parseFailure('policy has unknown key(s) ' + unknown.join(', '))
  if (record.version !== undefined && typeof record.version !== 'number') {
    return parseFailure('policy.version must be a number')
  }
  const defaults = record.defaults as Record<string, unknown> | undefined
  if (defaults !== undefined) {
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
      return parseFailure('policy.defaults must be an object')
    }
    const unknownDefaults = Object.keys(defaults).filter((k) => k !== 'no_match_verdict')
    if (unknownDefaults.length > 0) return parseFailure('policy.defaults has unknown key(s) ' + unknownDefaults.join(', '))
    if (defaults.no_match_verdict !== undefined && defaults.no_match_verdict !== 'ask') {
      return parseFailure('policy.defaults.no_match_verdict must be "ask" - the no-match verdict is not configurable')
    }
  }
  if (!Array.isArray(record.rules)) return parseFailure('policy.rules must be an array')
  const rules = record.rules as ToolPolicyRule[]
  if (rules.length === 0) {
    // PRESENT but EMPTY -> fail closed. Not "ask everything", not "allow all".
    const where = path ?? TOOL_POLICY_RELATIVE_PATH
    return parseFailure('policy at ' + where + ' is PRESENT but declares no rules - every tool call is denied (an empty policy is not an allow-all policy)')
  }
  const policy: ToolPolicy = { version: typeof record.version === 'number' ? record.version : 1, rules: rules.map(attachPolicyPredicate) }
  if (typeof record.description === 'string') policy.description = record.description
  const defect = firstPolicyDefect(policy)
  if (defect) return parseFailure(defect)
  return { ok: true, policy }
}

export interface ToolPolicyParseResult {
  ok: boolean
  policy: ToolPolicy
  /** The defect the policy failed closed on, when `ok` is false. */
  error?: string
}

/** A parse result that fails closed, carrying the defect as both error and reason. */
function parseFailure(defect: string): ToolPolicyParseResult {
  return { ok: false, policy: failClosedPolicy(defect), error: defect }
}

/** A one-rule policy denying everything, with the defect as its reason. */
export function failClosedPolicy(defect: string): ToolPolicy {
  return { version: 1, rules: [{ pattern: '*', verdict: 'deny', reason: 'tool policy failed closed - ' + defect }] }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve the effective policy for a worktree: the file when present (even when
 * broken — a present-but-invalid file fails closed), the built-in list when
 * absent. Thin, so callers never re-implement the absent/present distinction.
 */
export function resolveToolPolicy(worktreeRoot: string): ToolPolicy {
  return loadToolPolicyFile(worktreeRoot).policy
}
