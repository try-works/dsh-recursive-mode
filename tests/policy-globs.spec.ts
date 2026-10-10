/**
 * T16 — declarative, ordered tool policy (plan §4 T16). RED first.
 *
 * The semantics under test are the ones the two audited systems converged on:
 *   - an ordered rule list, FIRST match wins;
 *   - `deny` beats `allow` when both match the same id;
 *   - an invalid pattern fails the WHOLE policy closed (deny everything),
 *     naming the offending pattern;
 *   - a PRESENT-but-empty policy denies everything (an empty allow-list is not
 *     an "allow all" list);
 *   - NO match yields `ask` — never deny, never allow.
 *
 * The absent-file case is the one the plan's RED list leaves ambiguous, and it
 * is the difference between "safe default" and "bricked repo":
 *   - ABSENT policy file  -> the BUILT-IN default list, which reproduces today's
 *     guard behaviour (otherwise every existing repo would deny every tool call);
 *   - PRESENT but empty/invalid -> fail closed.
 * Both directions are asserted below so neither can regress.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  globMatch, isValidGlobPattern, patternSyntaxError, patternSpecificity, isCatchAllPattern,
  evaluateToolPolicy, resolveToolPolicy, loadToolPolicyFile, toolPolicyPath, builtInToolPolicyRules,
  TOOL_POLICY_RELATIVE_PATH, WRITE_TOOL_NAMES,
  type ToolPolicy, type ToolPolicyRule, type ToolPolicyContext, type Verdict,
} from '../src/policy-globs.ts'
import { withPhaseBaseline, phaseBaselineRules, policyVerdictRank } from '../src/phase-rules.ts'
import { lockHashFromContent, getLockStatus } from '../src/lock.ts'

// NOTE: nothing here calls `setBuiltInToolPolicy`. That is deliberate and is the
// regression guard for the import cycle this module graph once had: this spec
// imports policy-globs.ts (and phase-rules.ts, whose edge to it is type-only)
// WITHOUT importing enforcement.ts, so the absent-file fallback must already be
// wired by the definition inside policy-globs.ts itself. If it were not, every
// absent-file case below would fail closed and the suite would say so.

const NO_CONTEXT: ToolPolicyContext = { args: {} }

function rule(pattern: string, verdict: Verdict, reason = pattern + ' -> ' + verdict): ToolPolicyRule {
  return { pattern, verdict, reason }
}

function policyOf(rules: ToolPolicyRule[]): ToolPolicy {
  return { version: 1, rules }
}

/** Write a policy file at the shipped path (or nothing, when raw is null). */
function repoWithPolicy(raw: string | null): string {
  const repo = mkdtempSync(join(tmpdir(), 'rm-pol-'))
  if (raw !== null) {
    const path = toolPolicyPath(repo)
    mkdirSync(join(repo, '.recursive', 'config'), { recursive: true })
    writeFileSync(path, raw, 'utf8')
  }
  return repo
}

describe('T16 — glob matching (exact, id glob, catch-all)', () => {
  it('matches exact ids only when the pattern has no wildcard', () => {
    expect(globMatch('recursive_lock', 'recursive_lock')).toBe(true)
    expect(globMatch('recursive_lock', 'recursive_locks')).toBe(false)
    expect(globMatch('recursive_lock', 'recursive_lock_phase')).toBe(false)
  })

  it('matches the worker::* id-glob form against the id segment it names', () => {
    expect(globMatch('worker::*', 'worker::implementer')).toBe(true)
    expect(globMatch('worker::*', 'worker::')).toBe(true)
    expect(globMatch('worker::*', 'worker')).toBe(false)
    expect(globMatch('recursive_*', 'recursive_lock')).toBe(true)
  })

  it('matches the catch-all form against every non-empty id', () => {
    expect(globMatch('*', 'write')).toBe(true)
    expect(globMatch('*', 'worker::implementer')).toBe(true)
    expect(globMatch('*', 'write.md')).toBe(true)
  })

  it('accepts the documented pattern forms and rejects everything else', () => {
    for (const ok of ['*', 'recursive_lock', 'worker::*', 'fs_write', 'a-b.c_d:e*']) {
      expect(isValidGlobPattern(ok)).toBe(true)
    }
    for (const bad of ['', '   ', '[', 'a b', 'a/b', 'a\\b', 'a|b', 'a?b', 'worker::']) {
      expect(isValidGlobPattern(bad)).toBe(false)
      expect(patternSyntaxError(bad)).toBeTruthy()
    }
    expect(patternSyntaxError('*')).toBeNull()
  })

  it('ranks patterns by specificity so a specific rule outranks the catch-all', () => {
    expect(patternSpecificity('*')).toBeLessThan(patternSpecificity('*_write'))
    expect(patternSpecificity('*_write')).toBeLessThan(patternSpecificity('worker::*'))
    expect(patternSpecificity('worker::*')).toBeLessThan(patternSpecificity('write'))
    // Prefix globs and exact ids within a tier are equally specific -> file order.
    expect(patternSpecificity('recursive_*')).toBe(patternSpecificity('worker::*'))
    expect(patternSpecificity('write')).toBe(patternSpecificity('edit'))
  })
})

describe('T16 — ordered rules: first match wins, deny beats allow', () => {
  it('deny wins when a catch-all allow for the same id is listed FIRST', () => {
    // Precedence is SPECIFICITY FIRST, THEN FILE ORDER: the more specific `writ*`
    // outranks the catch-all even though the catch-all is earlier in the file.
    const p = policyOf([rule('*', 'allow', 'allow all'), rule('writ*', 'deny', 'write denied')])
    const d = evaluateToolPolicy(p, 'write', {}, NO_CONTEXT)
    expect(d.kind).toBe('deny')
    expect(d.reason).toBe('write denied')
  })

  it('a catch-all allow listed FIRST cannot shield an id from a more specific deny', () => {
    const p = policyOf([rule('*', 'allow', 'allow all'), rule('edit', 'deny', 'edit denied')])
    expect(evaluateToolPolicy(p, 'edit', {}, NO_CONTEXT).kind).toBe('deny')
    // ...while an id the deny does not name is still allowed by the catch-all.
    expect(evaluateToolPolicy(p, 'read', {}, NO_CONTEXT).kind).toBe('allow')
  })

  it('between EQUALLY specific rules, file order decides', () => {
    const allowFirst = policyOf([rule('write', 'allow', 'write allowed'), rule('write', 'deny', 'write denied')])
    expect(evaluateToolPolicy(allowFirst, 'write', {}, NO_CONTEXT).reason).toBe('write allowed')
    const denyFirst = policyOf([rule('write', 'deny', 'write denied'), rule('write', 'allow', 'write allowed')])
    expect(evaluateToolPolicy(denyFirst, 'write', {}, NO_CONTEXT).reason).toBe('write denied')
  })

  it('first-match-wins: the earlier rule decides, not the stricter one', () => {
    const p = policyOf([rule('write', 'allow', 'write allowed'), rule('write', 'deny', 'write denied')])
    const d = evaluateToolPolicy(p, 'write', {}, NO_CONTEXT)
    expect(d.kind).toBe('allow')
    expect(d.reason).toBe('write allowed')
  })

  it('honours order across id-specific and catch-all rules', () => {
    const p = policyOf([rule('recursive_*', 'allow', 'recursive tools allowed'), rule('*', 'deny', 'everything else denied')])
    expect(evaluateToolPolicy(p, 'recursive_status', {}, NO_CONTEXT).kind).toBe('allow')
    expect(evaluateToolPolicy(p, 'write', {}, NO_CONTEXT).kind).toBe('deny')
  })

  it('no rule matches -> ask (not deny, not allow), even with an explicit deny rule present', () => {
    const p = policyOf([rule('write', 'deny', 'write denied')])
    const d = evaluateToolPolicy(p, 'recursive_status', {}, NO_CONTEXT)
    expect(d.kind).toBe('ask')
    expect(d.reason).toBeTruthy()
  })

  it('an empty rule list yields ask — the documented no-match default', () => {
    expect(evaluateToolPolicy(policyOf([]), 'any_tool', {}, NO_CONTEXT).kind).toBe('ask')
  })
})

describe('T16 — fail closed: invalid pattern, present-but-empty policy', () => {
  it('an INVALID pattern denies everything and names the offending pattern', () => {
    const p = policyOf([rule('worker::', 'allow', 'worker allowed')])
    for (const id of ['worker::implementer', 'write', 'recursive_status']) {
      const d = evaluateToolPolicy(p, id, {}, NO_CONTEXT)
      expect(d.kind).toBe('deny')
      expect(d.reason).toContain('worker::')
      expect(d.reason).toContain('invalid pattern')
    }
  })

  it('an invalid pattern fails closed even when a valid allow rule precedes it', () => {
    const p = policyOf([rule('*', 'allow', 'allow all'), rule('a b', 'deny', 'bad')])
    const d = evaluateToolPolicy(p, 'write', {}, NO_CONTEXT)
    expect(d.kind).toBe('deny')
    expect(d.reason).toContain('a b')
  })

  it('names the offending pattern for a malformed RULE, not just a malformed pattern', () => {
    const p = { version: 1, rules: [{ pattern: 'write' } as unknown as ToolPolicyRule] }
    const d = evaluateToolPolicy(p, 'write', {}, NO_CONTEXT)
    expect(d.kind).toBe('deny')
    expect(d.reason).toContain('write')
    expect(d.reason).toContain('verdict')
  })

  it('a PRESENT-but-empty policy file denies everything', () => {
    const repo = repoWithPolicy(JSON.stringify({ version: 1, rules: [] }))
    const loaded = loadToolPolicyFile(repo)
    // A present-but-empty file is a DEFECT, not a healthy policy: `ok` is false
    // and the policy it yields is the fail-closed deny-all.
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.source).toBe('file')
    const d = evaluateToolPolicy(loaded.policy, 'recursive_status', {}, NO_CONTEXT)
    expect(d.kind).toBe('deny')
    expect(d.reason).toBeTruthy()
  })

  it('a PRESENT but malformed policy file fails closed with the parse detail', () => {
    const repo = repoWithPolicy('{ not json')
    const loaded = loadToolPolicyFile(repo)
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.source).toBe('file')
    expect(evaluateToolPolicy(loaded.policy, 'write', {}, NO_CONTEXT).kind).toBe('deny')
  })

  it('an unknown key on a rule fails closed and names the pattern', () => {
    const repo = repoWithPolicy(JSON.stringify({ version: 1, rules: [{ pattern: 'write', verdict: 'allow', reason: 'r', bogus: 1 }] }))
    const loaded = loadToolPolicyFile(repo)
    const d = evaluateToolPolicy(loaded.policy, 'write', {}, NO_CONTEXT)
    expect(d.kind).toBe('deny')
    expect(d.reason).toContain('write')
    expect(d.reason).toContain('unknown key')
  })
})

describe('T16 — the absent-file fallback reproduces today\'s behaviour', () => {
  it('no policy file at all -> built-in defaults, and the file path is the documented one', () => {
    const repo = repoWithPolicy(null)
    expect(existsSync(toolPolicyPath(repo))).toBe(false)
    expect(TOOL_POLICY_RELATIVE_PATH).toBe('.recursive/config/recursive-permissions.json')
    const loaded = loadToolPolicyFile(repo)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.source).toBe('builtin')
  })

  it('the absent fallback still denies a write to a LOCKED artifact and allows an unrelated tool', () => {
    const repo = repoWithPolicy(null)
    const runDir = join(repo, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    const content = 'Run: r1\nPhase: 0\nStatus: LOCKED\nCoverage: PASS\nApproval: PASS\n## TODO\n- [x] d\n'
    const hash = lockHashFromContent(content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + '0'.repeat(64) + '\n')
    const artifact = join(runDir, '00-requirements.md')
    writeFileSync(artifact, content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + hash + '\n', 'utf8')

    const loaded = loadToolPolicyFile(repo)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    const ctx: ToolPolicyContext = { args: { file_path: artifact }, runDir, runId: 'r1', worktreeRoot: repo }
    const denied = evaluateToolPolicy(loaded.policy, 'write', { file_path: artifact }, ctx)
    expect(denied.kind).toBe('deny')
    expect(denied.reason).toContain('locked-artifact write denial')
    // An ordinary tool with no matching deny rule still allows, so the built-in
    // list does not turn every call into an `ask`.
    const allowed = evaluateToolPolicy(loaded.policy, 'recursive_status', {}, ctx)
    expect(allowed.kind).toBe('allow')
  })

  it('the absent fallback denies the SAME locked artifact named REPO-RELATIVELY — the two forms agree', () => {
    const repo = repoWithPolicy(null)
    const runDir = join(repo, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    const content = 'Run: r1\nPhase: 0\nStatus: LOCKED\nCoverage: PASS\nApproval: PASS\n## TODO\n- [x] d\n'
    const hash = lockHashFromContent(content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + '0'.repeat(64) + '\n')
    writeFileSync(join(runDir, '00-requirements.md'), content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + hash + '\n', 'utf8')
    // A DRAFT artifact in the SAME run, so the control below proves the match is CONDITIONAL
    // on the lock rather than a blanket denial of every run-tree write.
    writeFileSync(join(runDir, '01-as-is.md'), 'Run: r1\nPhase: 1\nStatus: DRAFT\n## TODO\n- [ ] x\n', 'utf8')

    const loaded = loadToolPolicyFile(repo)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    const ctx: ToolPolicyContext = { args: {}, runDir, runId: 'r1', worktreeRoot: repo }
    // The control below is only meaningful if the files are what it claims: the locked one
    // really lock-valid, the other really unlocked. Asserted rather than assumed, so an
    // `allow` cannot pass because a file was MISSING and the rule abstained for that reason.
    expect(getLockStatus(join(runDir, '00-requirements.md'))).toBe('LOCKED')
    expect(getLockStatus(join(runDir, '01-as-is.md'))).toBe('DRAFT')

    // ⚠ THE REGRESSION these assertions pin: `lockedWriteRule` admitted a target only when the
    // STRING it was handed contained `/.recursive/run/`, and a repo-relative path has no
    // separator before `.recursive` — so the relative spelling of this locked artifact was
    // ALLOWED while the absolute spelling of the same file was DENIED. Both spellings resolve
    // to one file and must get one verdict, for the POSIX form a model types, its backslash
    // form, and the `./`-prefixed form (which only ever matched by accident).
    const relativeTargets = [
      '.recursive/run/r1/00-requirements.md',
      '.recursive\\run\\r1\\00-requirements.md',
      './.recursive/run/r1/00-requirements.md',
    ]
    for (const target of relativeTargets) {
      const denied = evaluateToolPolicy(loaded.policy, 'write', { file_path: target }, ctx)
      expect(denied.kind, 'target ' + target + ' names a LOCKED artifact and must be denied').toBe('deny')
      expect(denied.reason, target).toContain('locked-artifact write denial')
      // The label, not merely the verdict: a denial for some OTHER reason would not prove the
      // locked-artifact rule fired.
      expect(denied.rule, target).toBe('locked-write')
    }

    // The absolute spelling asserted BESIDE them, so a change that only learned relative paths
    // (or that dropped the resolved-path test again) cannot pass.
    const absolute = evaluateToolPolicy(loaded.policy, 'write', { file_path: join(runDir, '00-requirements.md') }, ctx)
    expect(absolute.kind).toBe('deny')
    expect(absolute.reason).toContain('locked-artifact write denial')
    expect(absolute.rule).toBe('locked-write')

    // CONTROL — same run, same relative form, artifact NOT locked: still allowed.
    const draft = evaluateToolPolicy(loaded.policy, 'write', { file_path: '.recursive/run/r1/01-as-is.md' }, ctx)
    expect(draft.kind).toBe('allow')
  })

  it('the admission test still scopes the locked-write rule to the run tree', () => {
    const repo = repoWithPolicy(null)
    const runDir = join(repo, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    // A LOCK-VALID `*.md` outside any run tree: the rule is about run artifacts, so its
    // admission test must still abstain here. Without that test (a locked-write rule that
    // denied any lock-valid file it was handed) this file would be denied instead of allowed.
    const content = 'Status: LOCKED\nCoverage: PASS\nApproval: PASS\n## TODO\n- [x] d\n'
    const hash = lockHashFromContent(content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + '0'.repeat(64) + '\n')
    writeFileSync(join(repo, 'notes.md'), content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + hash + '\n', 'utf8')

    const loaded = loadToolPolicyFile(repo)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    // Precondition, so the `allow` below cannot pass because the file was MISSING (the rule
    // abstains on MISSING too): `notes.md` must really be lock-valid and outside a run tree.
    expect(getLockStatus(join(repo, 'notes.md'))).toBe('LOCKED')
    const ctx: ToolPolicyContext = { args: {}, runDir, runId: 'r1', worktreeRoot: repo }
    for (const target of ['notes.md', join(repo, 'notes.md')]) {
      const decision = evaluateToolPolicy(loaded.policy, 'write', { file_path: target }, ctx)
      expect(decision.kind, 'target ' + target + ' is not a run-tree artifact').toBe('allow')
    }
  })

  it('the absent fallback denies an out-of-order recursive_lock', () => {
    const repo = repoWithPolicy(null)
    const runDir = join(repo, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, '00-requirements.md'), 'Run: r1\nPhase: 0\nStatus: DRAFT\n', 'utf8')
    const loaded = loadToolPolicyFile(repo)
    if (!loaded.ok) throw new Error('expected built-in policy')
    const d = evaluateToolPolicy(loaded.policy, 'recursive_lock', { artifact: '01-as-is.md' }, { args: { artifact: '01-as-is.md' }, runDir, runId: 'r1', worktreeRoot: repo })
    expect(d.kind).toBe('deny')
    expect(d.reason).toContain('monotonic lock-order')
  })

  /**
   * ISSUE 2 (b) AT THE PURE LAYER — the refusal names the run whose directory it read.
   *
   * The guard resolves WHICH run to read one layer up (`resolveGuardRunId`, `enforcement.ts`); what this
   * rule owns is the SENTENCE, and the sentence is where the two-runs-in-one-payload defect was visible:
   * blockers read from one run's directory, no run named, so a reader had to cross-reference the guard log
   * to find out which tree the answer was about. `ctx.runId` is that answer, carried in by the caller.
   *
   * ⚠ AND IT IS NOT INVENTED WHEN THE CALLER HAS NO RUN CONTEXT: a pure policy call with no `runId` gets
   * exactly the sentence it always got, because a fabricated run name in a refusal is a worse lie than an
   * unnamed one.
   */
  it('names the run it read in the lock-order refusal, and invents none when there is no run context', () => {
    const repo = repoWithPolicy(null)
    const runDir = join(repo, '.recursive', 'run', 'r2')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, '00-requirements.md'), 'Run: r2\nPhase: 0\nStatus: DRAFT\n', 'utf8')
    const loaded = loadToolPolicyFile(repo)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return

    const named = evaluateToolPolicy(loaded.policy, 'recursive_lock', { artifact: '01-as-is.md' }, { args: { artifact: '01-as-is.md' }, runDir, runId: 'r2', worktreeRoot: repo })
    expect(named.kind).toBe('deny')
    expect(named.reason).toContain('monotonic lock-order')
    expect(named.reason).toContain('00-requirements.md (DRAFT)')
    expect(named.reason, 'the refusal does not name the run it read').toContain('[run: r2]')

    // No run context -> the pre-existing sentence, byte for byte, with no `[run: …]` suffix at all.
    const unnamed = evaluateToolPolicy(loaded.policy, 'recursive_lock', { artifact: '01-as-is.md' }, { args: { artifact: '01-as-is.md' }, runDir, worktreeRoot: repo })
    expect(unnamed.kind).toBe('deny')
    expect(unnamed.reason).not.toContain('[run:')
    expect(named.reason).toBe(unnamed.reason + ' [run: r2]')
  })
})

describe('T16 — the shipped policy file (repo self-check)', () => {
  it('the repo\'s own .recursive/config/recursive-permissions.json loads clean and mirrors the built-ins', () => {

    const repo = join(import.meta.dirname, '..')
    const loaded = loadToolPolicyFile(repo)
    expect(loaded.ok).toBe(true)
    expect(loaded.source).toBe('file')
    if (!loaded.ok || loaded.source !== 'file') return
    // Same verdicts, same order as the built-in list: the file is documentation
    // AND behaviour, so drift between the two would be a lie in one of them.
    const fromFile = loaded.policy.rules.map((r) => r.pattern + ':' + r.verdict)
    const fromCode = builtInToolPolicyRules().map((r) => r.pattern + ':' + r.verdict)
    expect(fromFile).toEqual(fromCode)
    // And the semantics it documents are the ones the engine implements: an
    // ordinary tool is ALLOWED (rule `none`) rather than asked, because the
    // catch-all allow is present — the pre-T16 parity guarantee. The no-match
    // `ask` default is unreachable in THIS policy and is covered above with a
    // policy that has no catch-all.
    expect(evaluateToolPolicy(loaded.policy, 'recursive_status', {}, NO_CONTEXT).kind).toBe('allow')
    expect(evaluateToolPolicy(loaded.policy, 'get_weather', {}, NO_CONTEXT).kind).toBe('allow')
    // A rule that guards a CONDITION must not deny unconditionally: `recursive_lock`
    // with no run context, and a write of a *_write tool id, must not be denied by
    // the pattern alone. (A JSON rule cannot carry the predicate, so the loader
    // attaches it by pattern — without that, this whole file would deny everything
    // that matches a deny pattern, i.e. brick the repo.)
    expect(evaluateToolPolicy(loaded.policy, 'recursive_lock', { artifact: 'x.md' }, NO_CONTEXT).kind).toBe('allow')
    expect(evaluateToolPolicy(loaded.policy, 'fs_write', { file_path: 'notes.md' }, NO_CONTEXT).kind).toBe('allow')
  })

  it('mirrors the built-in list down to the LABEL, which is what selects a rule\'s CONDITION', () => {
    // ⚠ WHY THE LABEL IS PART OF THE MIRROR AND NOT DECORATION. Three rules share each write-tool pattern in
    // both lists (locked-artifact, phase-order, memory-read), and `attachPolicyPredicate` selects their
    // conditions BY LABEL, falling back to the pattern when a rule has none. A rule that lost its label
    // would therefore keep the same pattern and the same verdict and be given the WRONG CONDITION — the
    // file's `memory-read` rule would deny on the locked-artifact condition and the gate would vanish from
    // every repo that ships this file while the `pattern:verdict` comparison above still passed. So the
    // label is compared with the pattern and the verdict, and the gate is asserted present on every
    // write-tool id in BOTH lists.
    const repo = join(import.meta.dirname, '..')
    const loaded = loadToolPolicyFile(repo)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok || loaded.source !== 'file') return
    const labelled = (r: ToolPolicyRule) => r.pattern + ':' + r.verdict + ':' + (r.label ?? 'none')
    expect(loaded.policy.rules.map(labelled)).toEqual(builtInToolPolicyRules().map(labelled))
    for (const [where, rules] of [['file', loaded.policy.rules], ['built-in', builtInToolPolicyRules()]] as const) {
      const gate = rules.filter((r) => r.label === 'memory-read')
      expect(gate, where + ': one memory-read rule per write-tool id').toHaveLength(WRITE_TOOL_NAMES.size)
      for (const r of gate) {
        expect(r.verdict, where + ': ' + r.pattern).toBe('deny')
        expect(typeof r.predicate, where + ': ' + r.pattern + ' must carry the gate, not a bare verdict').toBe('function')
      }
    }
  })
})

describe('T16 — per-phase baseline narrows, never widens', () => {
  it('phase 3 denies recursive_lock until TDD evidence exists', () => {
    const repo = repoWithPolicy(null)
    const builtin = resolveToolPolicy(repo)
    const baseline = phaseBaselineRules('03-implementation-summary.md')
    expect(baseline.length).toBeGreaterThan(0)
    const narrowed = withPhaseBaseline(builtin, '03-implementation-summary.md')
    const runDir = join(repo, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    const artifact = join(runDir, '03-implementation-summary.md')
    writeFileSync(artifact, 'Run: r1\nPhase: 3\nStatus: DRAFT\nTDD Mode: strict\n\n## TODO\n- [ ] x\n', 'utf8')
    const ctx: ToolPolicyContext = { args: { artifact: '03-implementation-summary.md' }, runDir, runId: 'r1', worktreeRoot: repo }
    const d = evaluateToolPolicy(narrowed, 'recursive_lock', { artifact: '03-implementation-summary.md' }, ctx)
    expect(d.kind).toBe('deny')
    expect(d.reason).toContain('TDD')
    // The T15 machine-readable rule label survives the move from a code branch
    // into a policy rule (GuardRule still lists 'tdd-evidence').
    expect(d.rule).toBe('tdd-evidence')
  })

  it('phase 3 ALLOWS the lock once RED + GREEN evidence exists', () => {
    const repo = repoWithPolicy(null)
    const runDir = join(repo, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(
      join(runDir, '03-implementation-summary.md'),
      'Run: r1\nPhase: 3\nStatus: DRAFT\nTDD Mode: strict\nRED: evidence/logs/red.txt\nGREEN: evidence/logs/green.txt\n\n## TODO\n- [x] x\n',
      'utf8',
    )
    const narrowed = withPhaseBaseline(resolveToolPolicy(repo), '03-implementation-summary.md')
    const ctx: ToolPolicyContext = { args: { artifact: '03-implementation-summary.md' }, runDir, runId: 'r1', worktreeRoot: repo }
    const d = evaluateToolPolicy(narrowed, 'recursive_lock', { artifact: '03-implementation-summary.md' }, ctx)
    expect(d.kind).toBe('allow')
  })

  it('phase 3 does NOT gate a lock when the artifact is not in strict TDD mode', () => {
    const repo = repoWithPolicy(null)
    const runDir = join(repo, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, '03-implementation-summary.md'), 'Run: r1\nPhase: 3\nStatus: DRAFT\nTDD Mode: pragmatic\n\n## TODO\n- [x] x\n', 'utf8')
    const narrowed = withPhaseBaseline(resolveToolPolicy(repo), '03-implementation-summary.md')
    const ctx: ToolPolicyContext = { args: { artifact: '03-implementation-summary.md' }, runDir, runId: 'r1', worktreeRoot: repo }
    expect(evaluateToolPolicy(narrowed, 'recursive_lock', { artifact: '03-implementation-summary.md' }, ctx).kind).toBe('allow')
  })

  it('the baseline cannot widen a global deny into an allow', () => {
    const global = policyOf([rule('write', 'deny', 'global write denial'), rule('*', 'allow', 'allow all')])
    const narrowed = withPhaseBaseline(global, '06-decisions-update.md')
    // The baseline is rule-by-rule NARROWING-ONLY: a phase rule that would widen
    // (`allow` where the global verdict is `deny`) is dropped, so the global
    // denial still stands.
    for (const r of narrowed.rules) {
      if (r.pattern === 'write') expect(r.verdict).not.toBe('allow')
    }
    const d = evaluateToolPolicy(narrowed, 'write', {}, NO_CONTEXT)
    expect(d.kind).toBe('deny')
    expect(d.reason).toContain('global write denial')
  })

  it('a widening phase rule is dropped while the global ALLOW still allows', () => {
    const global = policyOf([rule('*', 'allow', 'allow all')])
    const narrowed = withPhaseBaseline(global, '03-implementation-summary.md')
    const d = evaluateToolPolicy(narrowed, 'recursive_status', {}, NO_CONTEXT)
    expect(d.kind).toBe('allow')
  })

  it('the verdict ranking orders deny < ask < allow by restrictiveness', () => {
    expect(policyVerdictRank('deny')).toBeLessThan(policyVerdictRank('ask'))
    expect(policyVerdictRank('ask')).toBeLessThan(policyVerdictRank('allow'))
  })

  it('a phase rule may not be the bare catch-all, so a narrowing cannot outrank every id', () => {
    for (const file of ['06-decisions-update.md', '07-state-update.md', '08-memory-impact.md', '03-implementation-summary.md']) {
      for (const r of phaseBaselineRules(file)) expect(isCatchAllPattern(r.pattern)).toBe(false)
    }
  })

  it('a phase with no baseline returns the global rules unchanged', () => {
    const global = policyOf([rule('*', 'allow', 'allow all')])
    expect(withPhaseBaseline(global, '04-test-summary.md')).toEqual(global)
    expect(phaseBaselineRules('04-test-summary.md')).toEqual([])
  })

  it('the default phase baseline denies a late-phase write outside its own artifact, and narrows only', () => {
    const global = policyOf([rule('*', 'allow', 'allow all')])
    const narrowed = withPhaseBaseline(global, '08-memory-impact.md')
    const d = evaluateToolPolicy(narrowed, 'write', { file_path: 'src/whatever.ts' }, NO_CONTEXT)
    expect(d.kind).toBe('deny')
    expect(d.reason).toBeTruthy()
  })
})
