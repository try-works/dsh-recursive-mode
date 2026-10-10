import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resolveEnforcementConfig, DEFAULT_ENFORCEMENT, DEFAULT_ENFORCEMENT_MODE, DEFAULT_BUDGETS,
  evaluateToolGuard, detectTamper, tamperCandidatePath, coerceAskToDecision, type EnforcementConfig,
} from '../src/enforcement.ts'
import { buildGateBlockAsk, renderGateBlockAsk } from '../src/recursive_ask.tool.ts'
import { getLockStatus, lockHashFromContent } from '../src/lock.ts'

describe('enforcement.ts — gates + config (R3/R4/R7/R8)', () => {
  it('resolveEnforcementConfig defaults strict and rejects unknown keys', () => {
    expect(resolveEnforcementConfig(undefined)).toEqual(DEFAULT_ENFORCEMENT)
    // T28 added `budgets` to the shape, so the expected object carries it: the
    // assertion is about resolveEnforcementConfig filling in defaults, and the
    // defaults now include the caps. Pinned explicitly rather than relaxed to a
    // partial match, so a future shape change still fails here loudly.
    //
    // ⚠ AND THE MODE FILL IS PINNED THE SAME WAY, with LITERALS: a config that states one
    // gate and leaves the others unstated must fill them with the default posture. A partial
    // section comes from a settings patch (`update(ns, patch)` merges one field in), so the
    // fill is a live path, not a formality.
    expect(resolveEnforcementConfig({ preStep: 'strict' })).toEqual({
      preStep: 'strict',
      toolGuards: 'strict',
      tamper: 'strict',
      budgets: DEFAULT_BUDGETS,
    })
    // The same fill, read from the OTHER direction: the one gate that IS stated keeps its
    // value while the unstated ones take the default — which is what rules out a "fill =
    // whatever the first stated gate was" implementation passing the case above.
    expect(resolveEnforcementConfig({ toolGuards: 'advisory' })).toEqual({
      preStep: 'strict',
      toolGuards: 'advisory',
      tamper: 'strict',
      budgets: DEFAULT_BUDGETS,
    })
    // An UNRECOGNIZED value resolves to the default posture too, so a typo fails CLOSED
    // rather than silently granting the permissive branch.
    expect(resolveEnforcementConfig({ tamper: 'advisery' }).tamper).toBe('strict')
    expect(() => resolveEnforcementConfig({ bogus: 'x' })).toThrow(/unknown key/)
  })

  /**
   * ⚠ THE DEFAULT POSTURE IS STRICT, AND THIS CASE READS IT RATHER THAN CONSTRUCTING IT.
   *
   * Every value below is READ from the plugin's own default objects or from a call that omits
   * the argument, and every expectation is a LITERAL. That combination is the whole point: an
   * assertion that compared two things which move together (say, the resolver's output against
   * `DEFAULT_ENFORCEMENT`) would keep passing after a revert to `advisory` and prove nothing.
   * A revert of the owner's decision must turn this red.
   */
  it('defaults to STRICT on all three gates', () => {
    expect(DEFAULT_ENFORCEMENT_MODE).toBe('strict')
    expect(DEFAULT_ENFORCEMENT.preStep).toBe('strict')
    expect(DEFAULT_ENFORCEMENT.toolGuards).toBe('strict')
    expect(DEFAULT_ENFORCEMENT.tamper).toBe('strict')
    // …and the resolver, which is the layer a PARTIAL config goes through, agrees.
    const resolved = resolveEnforcementConfig(undefined)
    expect(resolved.preStep).toBe('strict')
    expect(resolved.toolGuards).toBe('strict')
    expect(resolved.tamper).toBe('strict')
  })

  it('a BARE evaluateToolGuard call carries the default posture, not the permissive one', () => {
    // The parameter defaults follow the config default. This case exists because they used to
    // be their own `'advisory'` literals: a caller that forgot the argument got the mode the
    // config no longer defaults to, and no config could turn that back off.
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-bare-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, '00-requirements.md'), 'Run: r1\nPhase: 0\nStatus: DRAFT\n', 'utf8')
    const d = evaluateToolGuard({ name: 'recursive_lock', arguments: { artifact: '01-as-is.md' } }, root, 'r1')
    expect(d.kind).toBe('deny')
    expect((d as { reason: string }).reason).toContain('monotonic lock-order')
  })

  it('evaluateToolGuard denies an out-of-order recursive_lock (strict)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, '00-requirements.md'), 'Run: r1\nPhase: 0\nStatus: DRAFT\n', 'utf8')
    const d = evaluateToolGuard({ name: 'recursive_lock', arguments: { artifact: '01-as-is.md' } }, root, 'r1', 'strict')
    expect(d.kind).toBe('deny')
    expect((d as { reason: string }).reason).toContain('monotonic lock-order')
  })

  it('evaluateToolGuard asks (advisory) instead of deny on out-of-order lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, '00-requirements.md'), 'Run: r1\nPhase: 0\nStatus: DRAFT\n', 'utf8')
    const d = evaluateToolGuard({ name: 'recursive_lock', arguments: { artifact: '01-as-is.md' } }, root, 'r1', 'advisory')
    expect(d.kind).toBe('ask')
    // FU-7: and the advisory ask carries NO gate-block payload of its own. Nothing is refused at this
    // layer in advisory — the live path co-erces this to an allow-with-warning and the TOOL then
    // refuses with its own payload when `lockArtifact` throws — so a payload here would be a claim
    // about a refusal that was never made. Asserted, not assumed: the two asks are not interchangeable.
    expect((d as { ask?: unknown }).ask).toBeUndefined()
  })

  /**
   * FU-7 — THE ORDERING REFUSAL CARRIES THE HUMAN'S RECOVERY OPTIONS.
   *
   * `fix | reopen | abandon` is how a person unblocks a lock, and it used to be attached by
   * `recursive_lock`'s own catch — the branch that runs when the guard ABSTAINS. Under the strict
   * default the guard refuses an out-of-order lock BEFORE dispatch, so that branch never ran and the
   * caller got a bare sentence. These two cases pin the new truth at the layer that decides it: the
   * refusal carries the payload, the payload is the SHARED builder's output, and the plain reason is
   * still there beside it.
   */
  it('the strict lock-order refusal carries the gate-block ask, built from the blockers it read', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-ask-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, '00-requirements.md'), 'Run: r1\nPhase: 0\nStatus: DRAFT\n', 'utf8')
    const d = evaluateToolGuard({ name: 'recursive_lock', arguments: { artifact: '01-as-is.md' } }, root, 'r1', 'strict')
    expect(d.kind).toBe('deny')
    const reason = (d as { reason: string }).reason
    // The plain refusal is INTACT — the ask is added beside it, never instead of it.
    expect(reason).toContain('monotonic lock-order')
    expect(reason).toContain('00-requirements.md (DRAFT)')
    // The options, and the artifact the caller named.
    const ask = (d as { ask?: ReturnType<typeof buildGateBlockAsk> }).ask
    expect(ask, 'the strict refusal carried no ask').toBeDefined()
    expect(ask!.gate).toBe('gate-block')
    expect(ask!.artifact).toBe('01-as-is.md')
    expect(ask!.options.map((option) => option.label)).toEqual(['fix', 'reopen', 'abandon'])
    // ⚠ AND IT IS THE SAME OBJECT THE LOCK TOOL ATTACHES: compared against the shared builder with
    // this refusal's own sentence as `blocked`. A hand-written second payload here would differ in
    // some field and fail — which is the drift this comparison exists to catch.
    expect(ask).toEqual(buildGateBlockAsk('01-as-is.md', reason))
    expect(ask!.blocked).toBe(reason)
    // The payload renders to the sentence a caller reads, so what is said and what is carried agree.
    expect(renderGateBlockAsk(ask!)).toContain('fix (Return to the phase and satisfy the gate.)')
    expect(renderGateBlockAsk(ask!)).toContain('recursive_ask gate=gate-block artifact=01-as-is.md')
  })

  it('a refusal that no person has to resolve carries NO ask (the locked-write denial)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-noask-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    const content = 'Run: r1\nPhase: 0\nStatus: LOCKED\nCoverage: PASS\nApproval: PASS\n## TODO\n- [x] d\n'
    const hash = lockHashFromContent(content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + '0'.repeat(64) + '\n')
    writeFileSync(join(runDir, '00-requirements.md'), content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + hash + '\n', 'utf8')
    const d = evaluateToolGuard({ name: 'write', arguments: { file_path: join(runDir, '00-requirements.md') } }, root, 'r1', 'strict')
    expect(d.kind).toBe('deny')
    // A write to a LOCKED artifact is a caller state, not an ordering violation a person resolves by
    // reopening or abandoning a run: offering those there is the noise FU-7 deliberately excludes.
    expect((d as { ask?: unknown }).ask).toBeUndefined()
  })

  it('evaluateToolGuard denies a write to a LOCKED run doc (strict)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    const content = 'Run: r1\nPhase: 0\nStatus: LOCKED\nCoverage: PASS\nApproval: PASS\n## TODO\n- [x] d\n'
    const hash = lockHashFromContent(content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + '0'.repeat(64) + '\n')
    writeFileSync(join(runDir, '00-requirements.md'), content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + hash + '\n', 'utf8')
    const d = evaluateToolGuard({ name: 'write', arguments: { file_path: join(runDir, '00-requirements.md') } }, root, 'r1', 'strict')
    expect(d.kind).toBe('deny')
    expect((d as { reason: string }).reason).toContain('locked-artifact write denial')
  })

  it('detectTamper flags a locked artifact with a hash mismatch', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    const content = 'Run: r1\nPhase: 0\nStatus: LOCKED\nCoverage: PASS\nApproval: PASS\n## TODO\n- [x] d\n'
    const hash = lockHashFromContent(content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + '0'.repeat(64) + '\n')
    // write a DIFFERENT hash to force STALE_LOCK
    writeFileSync(join(runDir, '00-requirements.md'), content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + 'f'.repeat(64) + '\n', 'utf8')
    const tamper = detectTamper(join(runDir, '00-requirements.md'), root, 'r1')
    expect(tamper).not.toBeNull()
    expect(tamper?.reason).toContain('tampered')
  })

  it('detectTamper is null for a clean locked artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    const content = 'Run: r1\nPhase: 0\nStatus: LOCKED\nCoverage: PASS\nApproval: PASS\n## TODO\n- [x] d\n'
    const hash = lockHashFromContent(content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + '0'.repeat(64) + '\n')
    writeFileSync(join(runDir, '00-requirements.md'), content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + hash + '\n', 'utf8')
    expect(detectTamper(join(runDir, '00-requirements.md'), root, 'r1')).toBeNull()
  })
})

/**
 * ISSUE 2 (b), AT THE LAYER THAT DECIDES IT — the refusal and the decision are about ONE run.
 *
 * The measured defect: a lock naming run-b was judged against run-a's tree (the guard resolved the run from
 * the filesystem) and the refusal said `00-requirements.md (DRAFT)` — run-a's blocker — with no run named
 * anywhere in the sentence. These cases pin the two halves of the fix at the guard's own entry point:
 *
 *   - the DECISION carries the run the guard resolved (`runId`), on an allow as well as on a refusal, so
 *     the layer that logs it cannot attribute the answer to a different run;
 *   - the REFUSAL names that run, and the gate-block ask built from it is still the SHARED builder's output
 *     (`buildGateBlockAsk(artifact, reason)`) — no new field, so the guard's refusal and the lock tool's
 *     refusal keep one payload shape.
 *
 * WHAT WOULD MAKE THESE PASS VACUOUSLY: a fixture in which both runs produce the same blocker. The
 * counterfactual below asserts the OPPOSITE verdict for the same call aimed at the active run, so "judged
 * the named run" and "judged the active run" cannot be confused for one another.
 */
describe('ISSUE 2 — the guard decides about the run the CALL names, and says which run that was', () => {
  /** A minimal DRAFT artifact, enough for `getLockStatus` to classify it DRAFT. */
  function draftArtifact(): string {
    return 'Run: `/.recursive/run/x/`\nPhase: `00 Requirements`\nStatus: `DRAFT`\n\n## TODO\n\n- [ ] x\n'
  }

  /**
   * Two runs under one root: `run-b`'s `00-requirements.md` LOCKED (so locking its `01-as-is.md` is LEGAL)
   * and `run-a`'s DRAFT (so the same call aimed at run-a is REFUSED).
   */
  function twoRuns(lockOther = true): { root: string; otherRunDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-two-'))
    const activeDir = join(root, '.recursive', 'run', 'run-a')
    const otherRunDir = join(root, '.recursive', 'run', 'run-b')
    mkdirSync(activeDir, { recursive: true })
    mkdirSync(otherRunDir, { recursive: true })
    writeFileSync(join(activeDir, '00-requirements.md'), draftArtifact(), 'utf8')
    writeFileSync(join(activeDir, '01-as-is.md'), draftArtifact(), 'utf8')
    const content = 'Run: run-b\nPhase: `00 Requirements`\nStatus: LOCKED\nCoverage: PASS\nApproval: PASS\n## TODO\n- [x] d\n'
    const trailer = 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + '0'.repeat(64) + '\n'
    writeFileSync(
      join(otherRunDir, '00-requirements.md'),
      lockOther
        ? content + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + lockHashFromContent(content + trailer) + '\n'
        : draftArtifact(),
      'utf8',
    )
    expect(getLockStatus(join(otherRunDir, '00-requirements.md')), 'precondition: run-b\'s phase 0 has the status this case is about')
      .toBe(lockOther ? 'LOCKED' : 'DRAFT')
    writeFileSync(join(otherRunDir, '01-as-is.md'), draftArtifact(), 'utf8')
    return { root, otherRunDir }
  }

  it('honours the run a LOCK call names — and names it in the decision and in the refusal', () => {
    const { root } = twoRuns()
    // LEGAL: run-b's prerequisite is locked, so the caller's run is the one that decides this.
    const legal = evaluateToolGuard(
      { name: 'recursive_lock', arguments: { runId: 'run-b', artifact: '01-as-is.md' } }, root, 'run-a', 'strict',
    )
    expect(legal.kind, 'a legal lock in run-b was refused: ' + JSON.stringify(legal)).toBe('allow')
    expect(legal.runId).toBe('run-b')

    // ILLEGAL in run-b (its `00-worktree.md` is ABSENT but its `01-as-is.md` is DRAFT) — the point is the
    // same call aimed at the ACTIVE run: it is refused, with the blocker of the run it named.
    const illegal = evaluateToolGuard(
      { name: 'recursive_lock', arguments: { runId: 'run-a', artifact: '01-as-is.md' } }, root, 'run-a', 'strict',
    )
    expect(illegal.kind).toBe('deny')
    const reason = (illegal as { reason: string }).reason
    expect(reason).toContain('monotonic lock-order')
    expect(reason).toContain('00-requirements.md (DRAFT)')
    expect(reason, 'the refusal does not name the run it read').toContain('[run: run-a]')
    expect(illegal.runId).toBe('run-a')

    // AND A CALL THAT NAMES NO RUN KEEPS THE ACTIVE RUN — the pre-existing behaviour every write-side rule
    // and every lock without a runId relies on.
    const unnamed = evaluateToolGuard({ name: 'recursive_lock', arguments: { artifact: '01-as-is.md' } }, root, 'run-a', 'strict')
    expect(unnamed.kind).toBe('deny')
    expect(unnamed.runId).toBe('run-a')
    expect((unnamed as { reason: string }).reason).toContain('[run: run-a]')
  })

  it('a refusal about a NAMED run carries the same shared gate-block payload, built from its own sentence', () => {
    const { root } = twoRuns(false)
    const d = evaluateToolGuard(
      { name: 'recursive_lock', arguments: { runId: 'run-b', artifact: '01-as-is.md' } }, root, 'run-a', 'strict',
    )
    expect(d.kind).toBe('deny')
    const reason = (d as { reason: string }).reason
    expect(reason).toContain('[run: run-b]')
    // ⚠ ONE BUILDER, AND NO NEW FIELD: the run is named INSIDE the sentence, so the payload stays exactly
    // `buildGateBlockAsk(artifact, reason)` — the object `recursive_lock` attaches to its own refusal.
    const ask = (d as { ask?: ReturnType<typeof buildGateBlockAsk> }).ask
    expect(ask, 'the strict named-run refusal carried no ask').toBeDefined()
    expect(ask).toEqual(buildGateBlockAsk('01-as-is.md', reason))
    expect(ask!.blocked).toContain('[run: run-b]')
    expect(renderGateBlockAsk(ask!)).toContain('recursive_ask gate=gate-block artifact=01-as-is.md')
  })
})

/**
 * The tamper ADMISSION test — the guard used to be blind to one spelling of one
 * path, measured rather than theorised.
 *
 * ⚠ THE REGRESSION these assertions pin. `detectTamper` admitted a target with a
 * substring test for `/.recursive/run/` ON THE TARGET STRING. A repo-relative
 * target has no separator before `.recursive`, so the spelling a model actually
 * types — and its backslash form — was rejected BEFORE anything was examined, and
 * a tampered locked artifact was invisible through it, while the ABSOLUTE
 * spelling of the same file was reported. One file, two spellings, two answers.
 * The identical defect in the identical spelling was fixed one module over
 * (`policy-globs.ts` `lockedWriteRule`); this is that fix's shape. `src/index.ts`'s
 * `fs/observed` listener carried a hand-copied MIRROR of the same admission test,
 * which is why the test now lives in ONE place (`tamperCandidatePath`) that both
 * callers use: widening only one of the two would have changed nothing on the
 * live path, because the listener would still have rejected the candidate first.
 */
describe('enforcement.ts — every spelling of one path gets one tamper answer', () => {
  const CONTENT = 'Run: r1\nPhase: 0\nStatus: LOCKED\nCoverage: PASS\nApproval: PASS\n## TODO\n- [x] d\n'

  /** A LOCKED `*.md` whose stored hash MISMATCHES its content: STALE_LOCK, i.e. a real tamper. */
  function writeTampered(path: string): void {
    writeFileSync(path, CONTENT + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + 'f'.repeat(64) + '\n', 'utf8')
  }

  /** A LOCKED `*.md` whose stored hash MATCHES: lock-valid, nothing to report. */
  function writeLockValid(path: string): void {
    const trailer = 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + '0'.repeat(64) + '\n'
    writeFileSync(path, CONTENT + 'LockedAt: 2026-01-01T00:00:00Z\nLockHash: ' + lockHashFromContent(CONTENT + trailer) + '\n', 'utf8')
  }

  it('reports the SAME tampered artifact named relatively or absolutely', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-rel-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    const artifact = join(runDir, '00-requirements.md')
    writeTampered(artifact)
    // Precondition, ASSERTED rather than assumed: the file really is STALE_LOCK, so a
    // `null` below cannot be an artifact of a clean or missing fixture.
    expect(getLockStatus(artifact)).toBe('STALE_LOCK')

    const spellings = [
      // The absolute spelling, which always worked — asserted BESIDE the others so a
      // change that only learned relative paths (or that dropped the resolved-path
      // test again) cannot pass.
      artifact,
      // ⚠ These two were `null` before the fix: repo-relative POSIX, and backslashes.
      '.recursive/run/r1/00-requirements.md',
      '.recursive\\run\\r1\\00-requirements.md',
      // `./`-relative only ever matched by ACCIDENT (its leading `./` supplied the
      // separator the marker needs); pinned so it keeps working for the right reason.
      './.recursive/run/r1/00-requirements.md',
      // A non-canonical absolute (`/./`) — the fifth spelling, which resolved cleanly
      // even before the fix and must not regress.
      root.replace(/\\/g, '/') + '/.recursive/run/r1/./00-requirements.md',
    ]
    for (const target of spellings) {
      const tamper = detectTamper(target, root, 'r1')
      expect(tamper, 'no tamper reported for ' + target).not.toBeNull()
      // The RECORD's contents are pinned, not merely its existence: the run the
      // observation was attributed to, and the target AS WRITTEN normalized to
      // forward slashes. That is the pre-fix contract, unchanged by the admission fix.
      const asWritten = target.replace(/\\/g, '/')
      expect(tamper?.runId, target).toBe('r1')
      expect(tamper?.path, target).toBe(asWritten)
      expect(tamper?.reason, target).toContain('tampered')
      expect(tamper?.reason, target).toContain(asWritten)
    }
  })

  it('still admits a target that NAMES the run tree but resolves away from it (the string test is KEPT)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-super-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    // The same file, reachable by a spelling that carries the marker in its TEXT and
    // loses it on RESOLUTION — the case the kept string test exists for.
    const elsewhere = join(root, 'other', '00-requirements.md')
    mkdirSync(join(root, 'other'), { recursive: true })
    writeTampered(elsewhere)
    expect(getLockStatus(elsewhere)).toBe('STALE_LOCK')

    const escaping = runDir.replace(/\\/g, '/') + '/../../../other/00-requirements.md'
    // Both halves of the premise, so this test cannot pass vacuously: the string as
    // written DOES carry the marker, and the path it resolves to does NOT.
    expect(escaping).toContain('/.recursive/run/')
    const resolved = tamperCandidatePath(escaping, root)
    expect(resolved).not.toBeNull()
    expect(resolved!.replace(/\\/g, '/'), 'a resolved-only admission would abstain here').not.toContain('/.recursive/run/')

    // Admitted anyway — a strict SUPERSET of the pre-fix behaviour, so no target that
    // was reported before can become invisible now.
    const tamper = detectTamper(escaping, root, 'r1')
    expect(tamper, 'the string test is KEPT: a target that names the run tree stays admitted').not.toBeNull()
    expect(tamper?.path).toBe(escaping)
  })

  it('never reports a file OUTSIDE a run tree — lock-valid OR stale', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-enf-outside-'))
    const runDir = join(root, '.recursive', 'run', 'r1')
    mkdirSync(runDir, { recursive: true })
    // (a) lock-valid and outside any run tree: an admission test that reported this
    // would be reporting a file the rule is not about.
    const valid = join(root, 'notes.md')
    writeLockValid(valid)
    // (b) STALE and outside any run tree — a REAL tamper by hash, rejected anyway
    // because the ADMISSION test (not the lock status) is what scopes this rule. This
    // is the control with teeth for the widened admission: (a) would also be `null`
    // from a rule that reported nothing at all, (b) would be reported by a rule whose
    // admission had widened past the run tree.
    const loose = join(root, 'loose', '00-requirements.md')
    mkdirSync(join(root, 'loose'), { recursive: true })
    writeTampered(loose)
    // Preconditions: the two fixtures really carry the lock statuses claimed, so the
    // `null`s below cannot pass because a file was missing or clean by accident.
    expect(getLockStatus(valid)).toBe('LOCKED')
    expect(getLockStatus(loose)).toBe('STALE_LOCK')

    for (const target of ['notes.md', valid, 'loose/00-requirements.md', loose]) {
      expect(detectTamper(target, root, 'r1'), target + ' is not a run-tree artifact').toBeNull()
    }
  })
})

describe('enforcement.ts — coerceAskToDecision (T6 ask→policy bridge)', () => {
  it('passes allow and deny through unchanged', () => {
    expect(coerceAskToDecision({ kind: 'allow' }, 'strict')).toEqual({ kind: 'allow' })
    expect(coerceAskToDecision({ kind: 'deny', reason: 'r' }, 'strict')).toEqual({ kind: 'deny', reason: 'r' })
  })

  it('coerces ask -> deny under strict (never a silent allow)', () => {
    const d = coerceAskToDecision({ kind: 'ask', reason: 'monotonic lock-order' }, 'strict')
    expect(d.kind).toBe('deny')
    expect((d as { reason: string }).reason).toContain('monotonic lock-order')
  })

  it('coerces ask -> allow+warn under advisory (logged, never silent)', () => {
    const d = coerceAskToDecision({ kind: 'ask', reason: 'monotonic lock-order' }, 'advisory')
    expect(d.kind).toBe('allow')
    expect((d as { warn?: string }).warn).toContain('monotonic lock-order')
  })

  it('defaults a bare ask to the config default posture — strict, so a refusal', () => {
    // ⚠ THIS ASSERTS THE PARAMETER DEFAULT, and the parameter default now FOLLOWS the config
    // default by reference (`DEFAULT_ENFORCEMENT.toolGuards`). Deliberate: there is no neutral
    // branch here — one posture allows the call and the other refuses it — so "the caller did
    // not say" must resolve the way an omitted config resolves, and the codebase's rule for an
    // undecidable path is to fail CLOSED. The advisory branch keeps its own case above, stated
    // explicitly, so the permissive behaviour is still tested rather than assumed.
    const d = coerceAskToDecision({ kind: 'ask' })
    expect(d.kind).toBe('deny')
    expect((d as { reason?: string }).reason).toBeTruthy()
    expect(coerceAskToDecision({ kind: 'ask', reason: 'monotonic lock-order' }, DEFAULT_ENFORCEMENT_MODE).kind).toBe('deny')
  })
})
