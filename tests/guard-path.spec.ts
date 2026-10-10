/**
 * T15 — the live enforcement path (plan §4 T15).
 *
 * What was wrong (verified, not assumed):
 *   1. `src/index.ts` called `evaluateToolGuard(exec, root, '', …)` — an EMPTY
 *      runId. `enforceToolGuard` builds `runDir` from that argument, so the
 *      monotonic lock-order and Phase-3 TDD branches resolved prerequisites
 *      against `<root>/.recursive/run` (which holds run DIRECTORIES, not
 *      artifacts) and could never match. The locked-write branch was unaffected
 *      because it resolves its target path directly.
 *   2. `validateTransition` was imported and never called.
 *   3. `detectTamper` had no caller in `index.ts`, and — contrary to the plan's
 *      §2 gap map — there was NO `fs/observed` listener at all; the string
 *      appeared only in comments.
 *
 * These specs drive the LIVE path through `ctx.tools.execute`, so they fail if
 * the listener stops being wired, not merely if a pure function regresses.
 *
 * Distinguishing the guard from the tool: `lockArtifact` has its own
 * prerequisite validation and throws
 *   `Prerequisite blockers: 00-requirements.md (DRAFT)`
 * whereas the guard denies BEFORE dispatch with
 *   `monotonic lock-order: 00-requirements.md (DRAFT)`.
 * Only the guard's wording can appear if the guard short-circuits, so asserting
 * on it proves the guard — not the tool — produced the refusal.
 */
import { describe, it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, mkdirSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import { lockHashFromContent } from '../src/lock.ts'
import { resolveRunDir } from '../src/run.ts'
import { renderGateBlockAsk } from '../src/recursive_ask.tool.ts'
import { readGuardDecisions, readObservedTampers, guardDecisionLogPath } from '../src/guard-log.ts'
import type { GoalServiceLike, GoalViewLike } from '../src/goals-projection.ts'

const signal = new AbortController().signal
const RUN_ID = 'guard-run'

/** A minimal DRAFT artifact: enough for Status/lock folding, no gates. */
function draft(runId: string, status = 'DRAFT'): string {
  return 'Run: `/.recursive/run/' + runId + '/`\nPhase: `00 Requirements`\nStatus: `' + status + '`\n\n## TODO\n\n- [ ] x\n'
}

/** A LOCKED artifact whose stored LockHash matches its content (lock-valid). */
function locked(runId: string, tamper = false): string {
  const body = draft(runId, 'LOCKED') + 'Coverage: PASS\nApproval: PASS\nLockedAt: 2026-01-01T00:00:00Z\n'
  const hash = lockHashFromContent(body + 'LockHash: ' + '0'.repeat(64) + '\n')
  const stored = tamper ? 'f'.repeat(64) : hash
  return body + 'LockHash: ' + stored + '\n'
}

interface Mounted {
  ctx: Context
  repo: string
  runDir: string
  dispose: () => Promise<void>
}

/**
 * Mount the REAL plugin (so the tools/pre-execute + fs/observed listeners are
 * live) over a temp repo holding one run.
 */
async function mount(files: Record<string, string>): Promise<Mounted> {
  const repo = mkdtempSync(join(tmpdir(), 'rm-guard-'))
  const runDir = join(repo, '.recursive', 'run', RUN_ID)
  mkdirSync(runDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(runDir, name), content, 'utf8')

  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(plugin, { repoRoot: repo })
  return {
    ctx,
    repo,
    runDir,
    dispose: async () => {
      await ctx.fiber.dispose()
      rmSync(repo, { recursive: true, force: true })
    },
  }
}

/** A stub tool so a WRITE_TOOL_NAMES call has something to dispatch to. */
function stubWriteTool() {
  return defineTool({
    name: 'write',
    description: 'test stub standing in for the host fs write tool',
    parameters: { file_path: { type: 'string' }, content: { type: 'string' } },
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: 'ok' }] },
    async execute() {
      return { wrote: true } as never
    },
  })
}

describe('T15 — the guard resolves the ACTIVE RUN (was: empty runId)', () => {
  it('denies an out-of-order recursive_lock with the guard reason, not the tool reason', async () => {
    const m = await mount({ '00-requirements.md': draft(RUN_ID), '01-as-is.md': draft(RUN_ID) })
    try {
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      const out = await m.ctx.tools.execute({
        signal,
        callId: ToolCallId('g1'),
        name: 'recursive_lock',
        arguments: { runId: RUN_ID, artifact: '01-as-is.md' },
        agent: { session: { header: { cwd: m.repo } } },
      } as never)
      expect(out.isError).toBe(true)
      const message = (out as { error?: { message?: string } }).error?.message ?? ''
      // The GUARD's wording. If the guard let this through, `lockArtifact`'s own
      // check would produce 'Prerequisite blockers: …' instead.
      expect(message).toContain('monotonic lock-order')
      expect(message).toContain('00-requirements.md')
      expect(message).not.toContain('Prerequisite blockers')
    } finally {
      await m.dispose()
    }
  })

  it('records the decision with its rule, run and reason', async () => {
    const m = await mount({ '00-requirements.md': draft(RUN_ID), '01-as-is.md': draft(RUN_ID) })
    try {
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      await m.ctx.tools.execute({
        signal,
        callId: ToolCallId('g2'),
        name: 'recursive_lock',
        arguments: { runId: RUN_ID, artifact: '01-as-is.md' },
        agent: { session: { header: { cwd: m.repo } } },
      } as never)

      expect(existsSync(guardDecisionLogPath(m.repo))).toBe(true)
      const decisions = readGuardDecisions(m.repo, 10)
      expect(decisions.length).toBeGreaterThan(0)
      const denied = decisions.filter(d => d.kind === 'deny')
      expect(denied).toHaveLength(1)
      expect(denied[0].rule).toBe('lock-order')
      expect(denied[0].runId).toBe(RUN_ID)
      expect(denied[0].tool).toBe('recursive_lock')
      expect(denied[0].reason).toContain('monotonic lock-order')
    } finally {
      await m.dispose()
    }
  })

  it('reaches validateTransition from the guard and reports its gate set', async () => {
    const m = await mount({ '00-requirements.md': draft(RUN_ID), '01-as-is.md': draft(RUN_ID) })
    try {
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      await m.ctx.tools.execute({
        signal,
        callId: ToolCallId('g3'),
        name: 'recursive_lock',
        arguments: { runId: RUN_ID, artifact: '01-as-is.md' },
        agent: { session: { header: { cwd: m.repo } } },
      } as never)

      const [record] = readGuardDecisions(m.repo, 1)
      // Proof the transition gate is ON the live path, not merely exported.
      expect(record.transition).toBeDefined()
      expect(record.transition!.passed).toBe(false)
      // The gate reports failures the guard's own predicates never check — the
      // whole point of consulting it.
      expect(record.transition!.failures.join(' | ')).toMatch(/Effective Inputs Re-read/)
    } finally {
      await m.dispose()
    }
  })

  it('logs an allow too, so the log shows what the guard decided and not only refusals', async () => {
    const m = await mount({ '00-requirements.md': draft(RUN_ID) })
    try {
      const out = await m.ctx.tools.execute({
        signal,
        callId: ToolCallId('g4'),
        name: 'recursive_status',
        arguments: { runId: RUN_ID },
        agent: { session: { header: { cwd: m.repo } } },
      } as never)
      expect(out.isError).toBe(false)
      const decisions = readGuardDecisions(m.repo, 5)
      expect(decisions.some(d => d.kind === 'allow' && d.tool === 'recursive_status')).toBe(true)
    } finally {
      await m.dispose()
    }
  })

  /**
   * FU-7 — THE ORDERING REFUSAL CARRIES THE HUMAN'S RECOVERY OPTIONS, THROUGH THE LIVE PATH.
   *
   * The default posture is strict, so THIS is the refusal a caller meets when it locks ahead of the
   * run: the guard denies pre-dispatch and the harness renders the decision as `Error: <reason>`,
   * dropping every other field of it. That is why the assertion has two halves — the TEXT the model
   * actually reads, and the payload the decision carries — and why the text is checked against the
   * RENDER of the payload (`renderGateBlockAsk`) rather than against a second hand-written sentence:
   * a parallel sentence would pass a label grep and still be free to drift from the options the
   * workflow offers.
   */
  it('FU-7: a guard refusal carries the gate-block ask to the caller AND into the trace', async () => {
    const m = await mount({ '00-requirements.md': draft(RUN_ID), '01-as-is.md': draft(RUN_ID) })
    try {
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      const out = await m.ctx.tools.execute({
        signal,
        callId: ToolCallId('g-ask'),
        name: 'recursive_lock',
        arguments: { runId: RUN_ID, artifact: '01-as-is.md' },
        agent: { session: { header: { cwd: m.repo } } },
      } as never)
      // (1) THE GUARD refused, pre-dispatch: its wording, and none of the tool's.
      expect(out.isError).toBe(true)
      const text = ((out as { content?: Array<{ text?: string }> }).content ?? [])
        .map((part) => part.text ?? '').join('\n')
      expect(text).toContain('monotonic lock-order')
      expect(text).not.toContain('Prerequisite blockers')
      // (2) THE CALLER'S TEXT CARRIES THE OPTIONS. Without this the ask is invisible on the default
      //     path, which is the defect: `fix | reopen | abandon` is how the run gets unblocked.
      expect(text).toContain('fix (Return to the phase and satisfy the gate.)')
      expect(text).toContain('reopen (Reopen an earlier locked artifact and repair it there.)')
      expect(text).toContain('abandon (Stop the run; the block is not resolvable now.)')
      // (3) AND THE STRUCTURED PAYLOAD RIDES THE REFUSAL, in the log a human reads ("why was this
      //     lock refused?" — and now, what can be done about it).
      const [record] = readGuardDecisions(m.repo, 5)
      expect(record.kind).toBe('deny')
      expect(record.rule).toBe('lock-order')
      expect(record.ask, 'the refusal carried no gate-block ask').toBeDefined()
      expect(record.ask!.gate).toBe('gate-block')
      expect(record.ask!.artifact).toBe('01-as-is.md')
      expect(record.ask!.options.map((option) => option.label)).toEqual(['fix', 'reopen', 'abandon'])
      // `blocked` is the refusal's OWN sentence, so the payload is self-describing.
      expect(record.ask!.blocked).toBe(record.reason)
      expect(text).toContain(renderGateBlockAsk(record.ask!))
      // (4) THE PLAIN REASON SURVIVES INTACT: a caller that ignores the ask still gets the rule and
      //     the blocking artifact with its status.
      expect(record.reason).toContain('monotonic lock-order')
      expect(record.reason).toContain('00-requirements.md (DRAFT)')
    } finally {
      await m.dispose()
    }
  })

  it('still denies a write to a LOCKED artifact through the live path', async () => {
    const m = await mount({ '00-requirements.md': locked(RUN_ID) })
    try {
      m.ctx.tools.register(stubWriteTool())
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      const out = await m.ctx.tools.execute({
        signal,
        callId: ToolCallId('g5'),
        name: 'write',
        arguments: { file_path: join(m.runDir, '00-requirements.md'), content: 'x' },
        agent: { session: { header: { cwd: m.repo } } },
      } as never)
      expect(out.isError).toBe(true)
      expect((out as { error?: { message?: string } }).error?.message).toContain('locked-artifact write denial')
      expect(readGuardDecisions(m.repo, 5)[0].rule).toBe('locked-write')
    } finally {
      await m.dispose()
    }
  })

  /**
   * ITEM 2 — THE GUARD'S ALLOW-WITH-WARNING LINE NAMED A MODE THAT WAS NOT IN FORCE.
   *
   * The line read `[recursive] tool guard (advisory): <warn> — allowing` UNCONDITIONALLY, while the
   * warning it carries comes from the transition gate's REPORT-ONLY consult — which attaches a warning
   * to an ALLOW in BOTH modes. Under the strict default a reader was told enforcement was off while
   * every gate was strict: text asserting a state that was not so, which is the defect class this
   * project keeps fixing.
   *
   * THE SETUP IS THE WARN-ON-ALLOW ITSELF, and it is deliberate rather than convenient: `00` is
   * LOCKED, so the lock-order rule ABSTAINS and the guard ALLOWS `01-as-is.md`; `01` is MISSING, so
   * the transition gate reports `phase doc does not exist` — the report-only dissent this line
   * describes. The call is not asserted on beyond that: what is under test is the LOG, and the tool's
   * own refusal follows pre-existing behaviour.
   */
  describe('the allow-with-warning line names the mode it ran under', () => {
    /** The `[recursive]` lines one lock call emits, with `console.warn` captured. */
    async function warnLines(mode: 'strict' | 'advisory'): Promise<string[]> {
      const m = await mount({ '00-requirements.md': locked(RUN_ID) })
      const seen: string[] = []
      const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        seen.push(args.map((arg) => String(arg)).join(' '))
      })
      try {
        m.ctx.recursive.setEnforcementConfig({ toolGuards: mode })
        await m.ctx.tools.execute({
          signal,
          callId: ToolCallId('g-log-' + mode),
          name: 'recursive_lock',
          arguments: { runId: RUN_ID, artifact: '01-as-is.md' },
          agent: { session: { header: { cwd: m.repo } } },
        } as never)
        // Precondition, ASSERTED: the guard really did ALLOW this call, so the line below is the
        // warn-on-allow path and not a refusal that would have been logged differently.
        expect(readGuardDecisions(m.repo, 5)[0].kind, 'the guard did not allow the call').toBe('allow')
      } finally {
        spy.mockRestore()
        await m.dispose()
      }
      return seen.filter((line) => line.includes('[recursive]'))
    }

    it('says strict under strict, and names the gate as report-only instead of as the mode', async () => {
      const lines = await warnLines('strict')
      expect(lines, 'no guard warning was logged: ' + JSON.stringify(lines)).toHaveLength(1)
      expect(lines[0]).toContain('tool guard (strict) allowed this call')
      // The old text, verbatim, is what this case exists to keep out.
      expect(lines[0]).not.toContain('tool guard (advisory)')
      // The warning is the transition gate's dissent, and it says so.
      expect(lines[0]).toContain('transition gate (report-only) failed:')
      expect(lines[0]).toContain('01-as-is.md')
    })

    it('says advisory under advisory — the prefix follows the config, it is not a constant', async () => {
      const lines = await warnLines('advisory')
      expect(lines, 'no guard warning was logged: ' + JSON.stringify(lines)).toHaveLength(1)
      expect(lines[0]).toContain('tool guard (advisory) allowed this call')
      // The SAME warn text in both modes: it describes the gate's posture, not the configured mode,
      // which is exactly the distinction the old `(advisory)` prefix blurred.
      expect(lines[0]).toContain('transition gate (report-only) failed:')
    })
  })
})

describe('T15 — observed-write tamper path (fs/observed had NO listener)', () => {
  it('records a tamper when a locked artifact is observed with a mismatched hash', async () => {
    const m = await mount({ '00-requirements.md': locked(RUN_ID, true) })
    try {
      const emit = (m.ctx as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit.bind(m.ctx)
      emit(
        'fs/observed',
        { displayPath: join(m.runDir, '00-requirements.md') },
        { kind: 'present', version: 'v1' },
        { agent: { session: { header: { cwd: m.repo } } } },
      )
      const tampers = readObservedTampers(m.repo, 5)
      expect(tampers).toHaveLength(1)
      expect(tampers[0].reason).toContain('tampered')
      expect(tampers[0].runId).toBe(RUN_ID)
    } finally {
      await m.dispose()
    }
  })

  it('the listener never throws and never records a clean locked write', async () => {
    const m = await mount({ '00-requirements.md': locked(RUN_ID) })
    try {
      const emit = (m.ctx as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit.bind(m.ctx)
      const actor = { agent: { session: { header: { cwd: m.repo } } } }
      expect(() => emit('fs/observed', { displayPath: join(m.runDir, '00-requirements.md') }, { kind: 'present', version: 'v1' }, actor)).not.toThrow()
      // absent observations and unrelated paths are ignored, never errors
      expect(() => emit('fs/observed', { displayPath: join(m.runDir, '00-requirements.md') }, { kind: 'absent' }, actor)).not.toThrow()
      expect(() => emit('fs/observed', { displayPath: join(m.repo, 'notes.md') }, { kind: 'present', version: 'v1' }, actor)).not.toThrow()
      expect(readObservedTampers(m.repo, 5)).toHaveLength(0)
    } finally {
      await m.dispose()
    }
  })
})

describe('T15 — the board can see tamper facts (foldRunCard hardcoded tampers: {})', () => {
  it('derives a tamper row from the folded lock problems, with no stored state', async () => {
    const m = await mount({ '00-requirements.md': locked(RUN_ID, true) })
    try {
      const { snapshotWorkspace } = await import('../src/snapshot.ts')
      const projection = snapshotWorkspace(m.repo)
      const card = projection[m.repo][RUN_ID]
      const tamperPaths = Object.keys(card.tampers)
      expect(tamperPaths).toHaveLength(1)
      expect(tamperPaths[0]).toBe('00-requirements.md')
      expect(card.tampers['00-requirements.md'].reason).toContain('LockHash mismatch')
    } finally {
      await m.dispose()
    }
  })

  it('a lock-valid run has no tamper rows', async () => {
    const m = await mount({ '00-requirements.md': locked(RUN_ID) })
    try {
      const { snapshotWorkspace } = await import('../src/snapshot.ts')
      const projection = snapshotWorkspace(m.repo)
      expect(Object.keys(projection[m.repo][RUN_ID].tampers)).toHaveLength(0)
    } finally {
      await m.dispose()
    }
  })
})

describe('T15 — recursive_status surfaces the guard decisions', () => {
  it('includes the recent guard decisions for the active run', async () => {
    const m = await mount({ '00-requirements.md': draft(RUN_ID), '01-as-is.md': draft(RUN_ID) })
    try {
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      await m.ctx.tools.execute({
        signal,
        callId: ToolCallId('g6'),
        name: 'recursive_lock',
        arguments: { runId: RUN_ID, artifact: '01-as-is.md' },
        agent: { session: { header: { cwd: m.repo } } },
      } as never)
      const out = await m.ctx.tools.execute({
        signal,
        callId: ToolCallId('g7'),
        name: 'recursive_status',
        arguments: { runId: RUN_ID },
        agent: { session: { header: { cwd: m.repo } } },
      } as never)
      expect(out.isError).toBe(false)
      const value = out.value as { guardDecisions?: Array<{ kind: string; rule: string }> }
      expect(Array.isArray(value.guardDecisions)).toBe(true)
      expect(value.guardDecisions!.some(d => d.kind === 'deny' && d.rule === 'lock-order')).toBe(true)
    } finally {
      await m.dispose()
    }
  })
})

/* ========================================================================== */
/* ISSUE 1 + ISSUE 2 — the two consequences of the strict default, LIVE        */
/* ========================================================================== */

/** The plain text a tool result exposes: the `content` render, joined. */
function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? []
  return content.map((part) => part.text ?? '').join('\n')
}

/** The refusal message a DENIED (pre-dispatch) call exposes. */
function refusalOf(result: unknown): string {
  return (result as { error?: { message?: string } }).error?.message ?? ''
}

/**
 * A structural fake of the live `goals` service that COUNTS block ATTEMPTS and successful TRANSITIONS.
 *
 * ⚠ THE ATTEMPT IS RECORDED BEFORE THE TRANSITION IS VALIDATED, which is what makes "not blocked twice"
 * assertable rather than arguable: the real service refuses `block` on a goal that is not ACTIVE (its
 * documented transition table), so a second block of an already-blocked goal fails — and a fake that only
 * recorded successes would make that second attempt INVISIBLE, which is exactly the shape a double-block
 * defect would hide in. `transitions` therefore counts DURABLE phase changes, and `blocks` counts calls.
 */
function countingGoals(runId: string) {
  const store: {
    current?: GoalViewLike
    blocks: Array<{ code: string; message: string }>
    transitions: string[]
  } = {
    current: { id: 'g1', revision: 1, objective: 'recursive-run:' + runId + ' · active', phase: 'active' },
    blocks: [],
    transitions: [],
  }
  const service: GoalServiceLike = {
    get: () => store.current,
    create: (_agent, req) => {
      store.transitions.push('create')
      const created: GoalViewLike = { id: 'g2', revision: 1, objective: req.objective, phase: 'active' }
      store.current = created
      return created
    },
    block: (_agent, ref, reason) => {
      store.blocks.push(reason)
      if (store.current?.phase !== 'active') {
        throw new Error('goal "' + (store.current?.id ?? '?') + '" is ' + (store.current?.phase ?? 'absent') + ', so it cannot be blocked')
      }
      store.transitions.push('blocked')
      store.current = { ...store.current, phase: 'blocked', revision: ref.revision + 1 }
      return store.current
    },
    pause: (_agent, ref) => {
      store.transitions.push('paused')
      store.current = { ...(store.current as GoalViewLike), phase: 'paused', revision: ref.revision + 1 }
      return store.current
    },
    resume: (_agent, ref) => {
      store.transitions.push('resumed')
      store.current = { ...(store.current as GoalViewLike), phase: 'active', revision: ref.revision + 1 }
      return store.current
    },
    complete: (_agent, ref) => {
      store.transitions.push('complete')
      store.current = { ...(store.current as GoalViewLike), phase: 'complete', revision: ref.revision + 1 }
      return store.current
    },
    clear: (_agent, ref) => { store.current = undefined; return { id: ref.id, revision: ref.revision + 1 } },
  }
  return { service, store }
}

interface TwoRunMount {
  ctx: Context
  repo: string
  runA: string
  runB: string
  dispose: () => Promise<void>
}

/**
 * TWO runs under one control-plane root, with run-a ACTIVE by the filesystem's own rule.
 *
 * ⚠ THE ORDERING IS STAMPED AND READ BACK, because `resolveRunDir` picks the active run by MTIME: an
 * unstamped pair ties, the winner depends on unspecified directory order, and a case that means to exercise
 * "the guard judged a NON-active run" could silently be exercising the active one. `otherLocked` writes
 * run-b a lock-VALID `00-requirements.md`, which is the state in which locking run-b's `01-as-is.md` is
 * LEGAL (the measured scenario).
 */
async function mountTwoRuns(options: { otherLocked?: boolean } = {}): Promise<TwoRunMount> {
  const repo = mkdtempSync(join(tmpdir(), 'rm-guard-two-'))
  const runRoot = join(repo, '.recursive', 'run')
  const write = (runId: string, files: Record<string, string>): string => {
    const runDir = join(runRoot, runId)
    mkdirSync(runDir, { recursive: true })
    for (const [name, content] of Object.entries(files)) writeFileSync(join(runDir, name), content, 'utf8')
    return runDir
  }
  const head = (id: string) => ({ '01-as-is.md': draft(id) })
  const runB = write('run-b', {
    '00-requirements.md': options.otherLocked === true ? locked('run-b') : draft('run-b'),
    ...head('run-b'),
  })
  const runA = write('run-a', { '00-requirements.md': draft('run-a'), ...head('run-a') })
  const future = new Date(Date.now() + 60_000)
  utimesSync(runA, future, future)
  expect(resolveRunDir(repo)?.runId, 'precondition: run-a is the ACTIVE run by mtime').toBe('run-a')

  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(plugin, { repoRoot: repo })
  return {
    ctx,
    repo,
    runA,
    runB,
    dispose: async () => {
      await ctx.fiber.dispose()
      rmSync(repo, { recursive: true, force: true })
    },
  }
}

/** The shape a `ctx.tools.execute` result exposes to these cases (the fields they read). */
interface ToolOutcome {
  isError?: boolean
  value?: unknown
  content?: Array<{ text?: string }>
  error?: { message?: string }
}

/** One `recursive_lock` call through the LIVE `tools/pre-execute` path. */
async function lockCall(m: TwoRunMount, runId: string, artifact: string, callId: string): Promise<ToolOutcome> {
  return m.ctx.tools.execute({
    signal,
    callId: ToolCallId(callId),
    name: 'recursive_lock',
    arguments: { runId, artifact },
    agent: { session: { header: { cwd: m.repo } } },
  } as never) as unknown as ToolOutcome
}

/**
 * ISSUE 1 — A GUARD-REFUSED LOCK MUST BLOCK THE RUN'S GOAL.
 *
 * MEASURED before this fix: `lockArtifact` blocks the run's goal on its OWN ordering refusal
 * (`runtime.ts`, the `Prerequisite blockers:` branch). Under the strict default the guard refuses the same
 * ordering violation BEFORE DISPATCH, so `lockArtifact` never ran, its block never happened, and the run
 * was told it was blocked while the GOAL MACHINERY WAS NOT — the goal stayed armed and kept driving
 * autonomous rounds through a refused gate.
 *
 * WHERE THE BLOCK LIVES, decided from the code: the guard cannot do it. `evaluateToolGuard` is a pure
 * policy layer with no goals service, no live agent and no runtime handle, and it is also called from a
 * DRY-RUN preview (`recursive_preview.tool.ts`) where a side effect would be a lie. The boundary that
 * holds all three — the runtime, the agent from the exec payload, and the decision — is the live
 * `tools/pre-execute` listener in `src/index.ts`, which is also where the refusal's ask is rendered into
 * the caller's text. The block is called there.
 *
 * ⚠ NO DOUBLE-BLOCK, AND HOW IT IS PREVENTED. The two block sites are on MUTUALLY EXCLUSIVE branches of
 * one call: the boundary blocks only on a DENY (so the tool is never dispatched), and the tool's own block
 * runs only when the call WAS dispatched to `lockArtifact`. Each case below asserts the number of block
 * ATTEMPTS and the number of durable TRANSITIONS on one call, so a second block — from either layer —
 * would be visible rather than absorbed.
 */
describe('ISSUE 1 — the ordering refusal blocks the run goal, from whichever layer refused', () => {
  it('GUARD PATH (strict): the pre-dispatch refusal blocks the goal exactly once', async () => {
    const m = await mountTwoRuns()
    const goals = countingGoals('run-a')
    m.ctx.recursive.attachGoals(goals.service)
    try {
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      const out = await lockCall(m, 'run-a', '01-as-is.md', 'i1-guard')

      // (1) THE GUARD refused, PRE-DISPATCH: its wording, and none of the tool's. The absence of the
      //     tool's sentence is the evidence that `lockArtifact` never ran, which is the whole reason the
      //     boundary has to block the goal itself.
      expect(out.isError).toBe(true)
      const text = textOf(out) + refusalOf(out)
      expect(text).toContain('monotonic lock-order')
      expect(text).not.toContain('Prerequisite blockers')

      // (2) …AND THE GOAL WAS TOLD. One attempt, one durable transition, the same gate code the tool
      //     path uses, and a message that is the refusal the caller received.
      expect(goals.store.blocks, 'the guard refused the lock and the goal was not blocked').toHaveLength(1)
      expect(goals.store.blocks[0].code).toBe('prerequisite-blockers')
      expect(goals.store.blocks[0].message).toContain('monotonic lock-order')
      expect(goals.store.blocks[0].message).toContain('00-requirements.md (DRAFT)')
      expect(goals.store.transitions.filter((t) => t === 'blocked')).toHaveLength(1)
      expect(goals.store.current?.phase, 'the run goal is not blocked').toBe('blocked')

      // (3) THE DURABLE REASON IS THE PLAIN REFUSAL, not the refusal plus its rendered option list: the
      //     ask's options belong to the caller's text, and a `blockedReason` carrying them would be a
      //     payload pretending to be a sentence.
      expect(goals.store.blocks[0].message).not.toContain('Options:')
    } finally {
      await m.dispose()
    }
  })

  it('TOOL PATH (advisory): the same refusal from lockArtifact blocks the goal exactly once', async () => {
    const m = await mountTwoRuns()
    const goals = countingGoals('run-a')
    m.ctx.recursive.attachGoals(goals.service)
    try {
      // Advisory is not decoration: it is the mode in which the guard's `ask` is coerced to an
      // allow-with-warning, so the call REACHES the tool and `lockArtifact` produces the refusal. That is
      // the other layer of the same rule, and it must block the goal too — once, not twice.
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'advisory' })
      const out = await lockCall(m, 'run-a', '01-as-is.md', 'i1-tool')

      // The tool answered with a PAYLOAD (a tool-level refusal is not `isError`), naming its own gate.
      expect(out.isError).toBe(false)
      const payload = JSON.parse(JSON.stringify((out as { value?: unknown }).value ?? out)) as {
        error?: string
        ask?: { blocked?: string }
      }
      expect(payload.error, 'the tool did not refuse with its own ordering gate').toContain('Prerequisite blockers')
      expect(payload.error).not.toContain('monotonic lock-order: an earlier phase')  // not the guard's sentence
      expect(payload.ask?.blocked).toContain('Prerequisite blockers')

      // ⚠ ONE ATTEMPT. If the boundary had blocked on this call as well, `blocks` would hold TWO: the
      // guard allowed it, so the tool's block is the only one that may exist.
      expect(goals.store.blocks, 'the tool refused the lock and the goal was not blocked exactly once').toHaveLength(1)
      expect(goals.store.blocks[0].code).toBe('prerequisite-blockers')
      expect(goals.store.transitions.filter((t) => t === 'blocked')).toHaveLength(1)

      // …and the run's own state agrees with what the guard recorded, so the two layers cannot disagree
      // about the layer that refused either: the trace says `allow` with a warning, the tool refused.
      const record = readGuardDecisions(m.repo, 5).filter((d) => d.tool === 'recursive_lock')[0]
      expect(record.kind).toBe('allow')
      expect(record.reason ?? '', 'the advisory allow did not carry the ordering warning').toContain('monotonic lock-order')
    } finally {
      await m.dispose()
    }
  })

  it('a REPEAT of the same refused lock does not block the goal twice', async () => {
    const m = await mountTwoRuns()
    const goals = countingGoals('run-a')
    m.ctx.recursive.attachGoals(goals.service)
    try {
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      const first = await lockCall(m, 'run-a', '01-as-is.md', 'i1-repeat-1')
      expect(first.isError).toBe(true)
      expect(goals.store.current?.phase).toBe('blocked')

      // The SAME refused call again: the boundary re-enters (the guard refuses again), and the goal service
      // refuses the second transition because a blocked goal is not active. The DURABLE state must be
      // unchanged — one phase change, still blocked — which is what "not blocked twice" means.
      const second = await lockCall(m, 'run-a', '01-as-is.md', 'i1-repeat-2')
      expect(second.isError).toBe(true)
      expect(textOf(second) + refusalOf(second)).toContain('monotonic lock-order')
      expect(goals.store.transitions.filter((t) => t === 'blocked'), 'the goal was blocked twice').toHaveLength(1)
      expect(goals.store.current?.phase).toBe('blocked')
      // The attempts are visible (the boundary really did re-enter), so the single transition above is the
      // goal service's own contract and not a boundary that stopped trying.
      expect(goals.store.blocks.length).toBeGreaterThanOrEqual(2)
    } finally {
      await m.dispose()
    }
  })

  it('the block is routed at the run the guard JUDGED, not at the active run', async () => {
    const m = await mountTwoRuns()
    // The session's goal belongs to run-b — a session whose approved run is not the mtime-newest one, which
    // is the whole situation ISSUE 2 is about. A refusal the guard judged against run-b must block run-b's
    // goal: the block follows the RUN THE REFUSAL IS ABOUT, which is the run the guard read.
    const goals = countingGoals('run-b')
    m.ctx.recursive.attachGoals(goals.service)
    try {
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      expect(resolveRunDir(m.repo)?.runId, 'precondition: run-a is the ACTIVE run').toBe('run-a')
      const out = await lockCall(m, 'run-b', '01-as-is.md', 'i1-routed')
      expect(out.isError).toBe(true)
      expect(textOf(out) + refusalOf(out)).toContain('run-b')

      expect(goals.store.blocks, 'the block was not routed at the run the guard judged').toHaveLength(1)
      expect(goals.store.blocks[0].code).toBe('prerequisite-blockers')
      expect(goals.store.transitions.filter((t) => t === 'blocked')).toHaveLength(1)
      expect(goals.store.current?.phase, "run-b's goal is not blocked").toBe('blocked')
    } finally {
      await m.dispose()
    }
  })

  it("a refusal judged for a NON-ACTIVE run does not block the ACTIVE run's goal", async () => {
    const m = await mountTwoRuns()
    const agent = { session: { header: { cwd: m.repo } } }
    // The session's goal is run-a's — the run whose phase 0 was approved — and run-a is also the ACTIVE run.
    // A refusal about run-b must not be filed against it: the projection refuses a goal that is not the
    // named run's (`blockRunGoal`), which is what makes "block the run the refusal is about" safe rather
    // than a way to block an unrelated run.
    const goals = countingGoals('run-a')
    m.ctx.recursive.attachGoals(goals.service)
    try {
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      const out = await lockCall(m, 'run-b', '01-as-is.md', 'i1-foreign')
      expect(out.isError).toBe(true)
      expect(textOf(out) + refusalOf(out)).toContain('run-b')

      // Run-a's goal is untouched, and the projection refused the foreign block BEFORE reaching the
      // service — so the attempt count is zero, which is asserted rather than glossed: a fake that only
      // counted successes could not tell "refused the foreign goal" from "never asked".
      expect(goals.store.transitions, "run-a's goal was blocked by a refusal about run-b").toEqual([])
      expect(goals.store.current?.phase).toBe('active')
      expect(goals.store.blocks).toEqual([])
      // The routing is what makes that refusal happen, so it is asserted directly from the same runtime the
      // boundary called: the answer names the foreign goal rather than reporting "no goal" or "blocked".
      const routed = m.ctx.recursive.blockRunToGoal(agent, 'run-b', { code: 'prerequisite-blockers', message: 'x' })
      expect(routed.ok).toBe(false)
      expect(routed.ok === false ? routed.reason : '').toContain('not for this run')
      // …and the SAME call for the goal's own run DOES block it, so the refusal above is about which run
      // was named and not about a runtime that cannot block at all.
      const own = m.ctx.recursive.blockRunToGoal(agent, 'run-a', { code: 'prerequisite-blockers', message: 'x' })
      expect(own.ok).toBe(true)
      expect(goals.store.current?.phase).toBe('blocked')
    } finally {
      await m.dispose()
    }
  })
})

/**
 * ISSUE 2 — THE GUARD JUDGED THE WRONG RUN, THROUGH THE LIVE PATH.
 *
 * The pure-guard cases live in `tests/strict-run-tree.spec.ts`; what this pins is the part only the live
 * path can show: the guard-decision RECORD and the gate-block ASK agree on the run id. Measured before the
 * fix: the record said `runId: "run-a"` while `ask.artifact` was `"01-as-is.md"` — one refusal naming two
 * runs, because the record took the filesystem's active run while the rule read `args.runId`'s run.
 */
describe('ISSUE 2 — the record and the ask name the run the guard actually read', () => {
  it('an ILLEGAL lock on a NON-ACTIVE run is refused, and both payloads name THAT run', async () => {
    const m = await mountTwoRuns()
    try {
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      const out = await lockCall(m, 'run-b', '01-as-is.md', 'i2-illegal')
      expect(out.isError).toBe(true)
      const text = textOf(out) + refusalOf(out)
      expect(text).toContain('monotonic lock-order')
      expect(text).not.toContain('Prerequisite blockers')

      const [record] = readGuardDecisions(m.repo, 5).filter((d) => d.tool === 'recursive_lock')
      expect(record.kind).toBe('deny')
      expect(record.rule).toBe('lock-order')
      // ⚠ THE FIX, AS THE LOG SHOWS IT: the record is attributed to the run the rule READ.
      expect(record.runId, 'the record attributes the refusal to a run the rule did not read').toBe('run-b')
      expect(record.ask, 'the refusal carried no gate-block ask').toBeDefined()
      expect(record.ask!.artifact).toBe('01-as-is.md')
      // THE AGREEMENT: the payload's own sentence names the same run the record attributes it to, so the
      // artifact, the blockers and the run are all answers about ONE tree.
      expect(record.ask!.blocked).toBe(record.reason)
      expect(record.ask!.blocked).toContain('[run: ' + record.runId + ']')
      expect(record.reason).toContain('00-requirements.md (DRAFT)')
      expect(record.reason).not.toContain('run-a')
      // …and the caller's text is the SAME sentence plus the options, so what the model reads and what the
      // log records cannot describe different runs.
      expect(text).toContain(record.reason)
      expect(text).toContain(renderGateBlockAsk(record.ask!))
    } finally {
      await m.dispose()
    }
  })

  it('a LEGAL lock on a NON-ACTIVE run is ALLOWED, and the record names THAT run', async () => {
    // run-b's `00-requirements.md` is LOCKED, so locking `01-as-is.md` in run-b is legal — the measured
    // state in which the guard used to refuse with run-A's blocker.
    const m = await mountTwoRuns({ otherLocked: true })
    try {
      m.ctx.recursive.setEnforcementConfig({ toolGuards: 'strict' })
      const out = await lockCall(m, 'run-b', '01-as-is.md', 'i2-legal')

      const [record] = readGuardDecisions(m.repo, 5).filter((d) => d.tool === 'recursive_lock')
      expect(record.kind, 'the guard refused a legal lock on run-b: ' + (record.reason ?? '')).toBe('allow')
      expect(record.runId).toBe('run-b')

      // …AND THE CALL WAS DISPATCHED, so the allow was not a refusal in disguise: a guard refusal comes
      // back as `isError` with the guard's wording, while this result is the TOOL's own answer. Whatever
      // the tool's gates say next is the tool's business — the claim here is that the GUARD let a legal
      // lock on a non-active run through, judged against run-b's tree.
      expect(out.isError).toBe(false)
      const toolText = textOf(out)
      expect(toolText).not.toContain('monotonic lock-order')
      expect(toolText).not.toContain('run-a')
    } finally {
      await m.dispose()
    }
  })
})
