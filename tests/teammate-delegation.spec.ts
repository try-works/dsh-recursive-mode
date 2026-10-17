/**
 * ⚠ G2/G3 — EVERY DELEGATED CHILD GOES THROUGH THE AGENT-TEAM ROSTER.
 *
 * `decisions/DECISION-teammate-delegation.md` (which supersedes the "wrap the primitive" half of
 * `ADR-delegation-surface.md`) requires review, work and audit children to be created with
 * `ctx.agentTeams.spawnTeammate` and followed up with `ctx.agentTeams.sendMessage`, instead of
 * `subagents.startContinuable` / `subagents.sendMessage` — and requires the primitive path to remain EXACTLY as it
 * is whenever there is no roster, or the caller is not its Lead.
 *
 * WHAT THESE CASES PROVE, one property each, and none of them by reading the source:
 *   1. the dispatch is TWO-STEP: spawn with a HOLD prompt, learn `member.id`, write the brief under
 *      `subagents/<delegationId>/child-<member.id>/`, then deliver the real prompt with `sendMessage`;
 *   2. a settlement is read through the run's log (G1) and an APPROVE is honoured;
 *   3. a REVISE delivers the repair through `agentTeams.sendMessage` to the SAME teammate name;
 *   4. a SECOND round for the same delegation RESUMES the same teammate — no second spawn;
 *   5. with no roster, or with a caller that is not its Lead, `startContinuable` is used exactly as before and
 *      `spawnTeammate` is never called (the fallback is byte-identical: the action record carries no team marker);
 *   6. a roster limit or a taken name FAILS CLOSED with a NAMED error, and never dispatches an unrecorded child;
 *   7. a roster dispatch is recorded in `operations.jsonl` with `delegationId` + the learned `childId`, and the
 *      provenance gate accepts a citation of that child's reply path.
 *
 * ⚠ WHAT IT DOES NOT PROVE, stated so a green is not read as more than it is: the roster is a FIXTURE satisfying
 * the structural seam (`src/teammate.ts`), so this proves the PLUGIN's dispatch sequence and records — not that the
 * live `TeamService` starts a real child, which is the same host-side leg `DSH-LIMITATIONS` records for the
 * primitive path. The fixture does enforce the one authority rule that matters here: `tryMembership` answers for
 * the EXACT live Agent object only, so a `{ id }` copy takes the primitive path (case 5b).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RecursiveRuntime } from '../src/runtime.ts'
import { readOperations } from '../src/identity.ts'
import { lintPhaseSpecificRules } from '../src/ts-lint.ts'
import { CURRENT_WORKFLOW_PROFILE } from '../src/phase-rules.ts'
import { recordSettlement, readSettlements, settlementRoundObserver, adoptSettlement } from '../src/settlement.ts'
import { readTeammates, teammateNameFor, type TeammateRosterLike, type TeamContentBlockLike, type SpawnTeammateRequestLike, type SendTeamMessageRequestLike } from '../src/teammate.ts'
import type { SubagentsRuntimeLike, SubagentParentHandle, SubagentResultLike } from '../src/delegation.ts'

const RUN = 'team-run'
const PHASE = '01'
const DELEGATION = '01-review'
const ROLE = 'code-reviewer'
const ARTIFACT = '01-as-is.md'
const RESERVED = 'reserved-child-id'
const MEMBER = 'team-member-1'

const POLICY = {
  version: 1,
  role_routes: {
    [ROLE]: { enabled: true, mode: 'external-cli', cli: null, model: null, fallback: 'self-audit' },
  },
  cli_overrides: {},
  custom_clis: [],
}

function approved(): SubagentResultLike {
  return { output: '{"verdict":"APPROVE"}', stopReason: 'completed', success: true, structured: { verdict: 'APPROVE', findings: [], references: [] } } as SubagentResultLike
}

function revised(): SubagentResultLike {
  return {
    output: '{"verdict":"REVISE"}',
    stopReason: 'completed',
    success: true,
    structured: { verdict: 'REVISE', findings: [{ severity: 'HIGH', title: 'rollback path missing', detail: 'd' }], references: [] },
  } as SubagentResultLike
}

/** One recorded settlement, as the harness's own `subagent-settled` notice becomes in the run log. */
function settle(runDir: string, childId: string, verdict: 'APPROVE' | 'REVISE'): void {
  const payload = verdict === 'APPROVE'
    ? { verdict: 'APPROVE', findings: [], references: [] }
    : { verdict: 'REVISE', findings: [{ severity: 'HIGH', title: 'rollback path missing', detail: 'd' }], references: [] }
  recordSettlement(runDir, { childId, summary: 'Background subagent finished.', closingText: JSON.stringify(payload) })
}

interface RosterCall {
  op: 'spawn' | 'send'
  name?: string
  target?: string
  text?: string
  signal?: unknown
  prompt?: string
}

/**
 * A structural `agentTeams` FIXTURE. It records every call, enforces the identity rule the live roster enforces
 * (`tryMembership` answers only for the exact Lead object), and can be told to fail a spawn the way the live
 * service does when a deployment limit or a name collision is hit.
 */
function fakeRoster(options: { failSpawn?: unknown; lead?: object } = {}) {
  const lead = options.lead ?? {}
  const calls: RosterCall[] = []
  const members: Array<{ id: string; name: string; role: string; status: string }> = []
  let seq = 0
  const service: TeammateRosterLike = {
    tryMembership(agent: unknown) {
      // ⚠ THE LIVE RULE: the exact live Agent, never a `{ id }` copy.
      return agent === lead ? { role: 'lead', name: 'lead' } : undefined
    },
    listMembers(agent: unknown) {
      return agent === lead ? members.slice() : []
    },
    async spawnTeammate(caller: unknown, request: SpawnTeammateRequestLike) {
      if (caller !== lead) throw Object.assign(new Error('only the Team Lead can create teammates'), { code: 'TEAM_LEAD_REQUIRED' })
      if (options.failSpawn !== undefined) throw options.failSpawn
      const id = MEMBER.slice(0, -1) + (++seq)
      const member = { id, name: request.name, role: 'teammate', status: 'inactive' }
      members.push(member)
      calls.push({
        op: 'spawn',
        name: request.name,
        signal: request.signal,
        prompt: request.prompt.map((block: TeamContentBlockLike) => block.text).join('\n'),
      })
      return { member }
    },
    async sendMessage(caller: unknown, request: SendTeamMessageRequestLike) {
      if (caller !== lead) throw Object.assign(new Error('not a member'), { code: 'TEAM_NOT_MEMBER' })
      calls.push({
        op: 'send',
        target: request.target,
        text: request.content.map((block: TeamContentBlockLike) => block.text).join('\n'),
        signal: request.signal,
      })
      return { messageId: 'team-message-' + calls.length, status: 'accepted' as const }
    },
  }
  return { service, calls, members, lead }
}

/** The primitive seam, so a case can assert that the roster path never touched it. */
function fakePrimitive() {
  const calls: string[] = []
  const seam: SubagentsRuntimeLike = {
    start: async () => { calls.push('start'); return approved() },
    startContinuable: async (spec) => {
      calls.push('startContinuable:' + String(spec.childId ?? 'allocated'))
      return { childId: spec.childId ?? 'allocated-child', messageId: 'm1' }
    },
    followup: async (_parent, childId) => { calls.push('followup:' + childId); return 'm2' },
  }
  return { calls, seam }
}

interface Mounted {
  root: string
  runDir: string
  runtime: RecursiveRuntime
  dispose: () => Promise<void>
}

async function mount(): Promise<Mounted> {
  const root = mkdtempSync(join(tmpdir(), 'rm-team-'))
  const cfg = join(root, '.recursive', 'config')
  mkdirSync(cfg, { recursive: true })
  writeFileSync(join(cfg, 'recursive-router.json'), JSON.stringify(POLICY), 'utf8')
  const runDir = join(root, '.recursive', 'run', RUN)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, ARTIFACT), '# AS-IS\n\nStatus: `DRAFT`\n\n## TODO\n\n- [x] done\n', 'utf8')
  const ctx = new Context()
  await ctx.plugin(RecursiveRuntime, { repoRoot: root })
  const runtime = ctx.recursive
  return {
    root,
    runDir,
    runtime,
    dispose: async () => {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function reviewInput(m: Mounted, over: Record<string, unknown> = {}) {
  return {
    root: m.root,
    runId: RUN,
    phase: PHASE,
    role: ROLE,
    delegationId: DELEGATION,
    childId: RESERVED,
    artifactPath: join(m.runDir, ARTIFACT),
    upstreamArtifacts: [],
    auditQuestions: ['does the artifact hold up?'],
    requiredOutput: 'verdict',
    providers: { spawn: { name: 'spawn', capabilities: { outputSchema: true } } },
    awaitRoundResult: settlementRoundObserver(m.runDir, { timeoutMs: 0 }),
    ...over,
  } as never
}

describe('G2 — the roster dispatch: spawn, learn the id, brief, deliver', () => {
  let m: Mounted
  beforeEach(async () => { m = await mount() })
  afterEach(async () => { await m.dispose() })

  it('spawns ONCE with a kebab name + signal, briefs under child-<member.id>, and DELIVERS the brief by sendMessage', async () => {
    const team = fakeRoster()
    m.runtime.attachTeams(team.service)
    const primitive = fakePrimitive()
    settle(m.runDir, MEMBER, 'APPROVE')

    const result = await m.runtime.delegateReview(reviewInput(m, {
      subagents: primitive.seam,
      parent: team.lead as unknown as SubagentParentHandle,
    }))

    const spawns = team.calls.filter((call) => call.op === 'spawn')
    expect(spawns, 'exactly one teammate was created').toHaveLength(1)
    expect(spawns[0]!.name, 'the name is the deterministic lower-kebab name').toBe(teammateNameFor(RUN, DELEGATION, ROLE))
    expect(spawns[0]!.name!).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    expect(spawns[0]!.name!.length).toBeLessThanOrEqual(64)
    expect(spawns[0]!.name).not.toBe('lead')
    expect(spawns[0]!.signal, 'signal is REQUIRED by the live service').toBeDefined()
    // STEP 1 of the protocol: the spawn prompt cannot carry the brief (no child id exists yet), so it must say so
    // and tell the child to WAIT — otherwise the child works from a placeholder and replies where no round reads.
    expect(spawns[0]!.prompt).toContain('WAIT')
    expect(spawns[0]!.prompt).toContain('next message')

    // STEP 2: the brief was written for the id the ROSTER learned, not the reserved one.
    const childDir = join(m.runDir, 'subagents', DELEGATION, 'child-' + MEMBER)
    const brief = readFileSync(join(childDir, 'brief.md'), 'utf8')
    expect(brief).toContain('Reply file:')
    expect(brief).toContain('child-' + MEMBER)
    expect(existsSync(join(m.runDir, 'subagents', DELEGATION, 'child-' + RESERVED)), 'the reserved id never became the child').toBe(false)

    // ... and it was DELIVERED through the roster, to the same name.
    const sends = team.calls.filter((call) => call.op === 'send')
    expect(sends, 'the brief is DELIVERED, not merely written').toHaveLength(1)
    expect(sends[0]!.target).toBe(spawns[0]!.name)
    expect(sends[0]!.text).toContain('child-' + MEMBER)
    expect(sends[0]!.text).toContain('brief.md')
    expect(sends[0]!.signal).toBeDefined()

    // THE PRIMITIVE PATH WAS NEVER TOUCHED — not to create the child, not to find it.
    expect(primitive.calls.filter((call) => call.startsWith('startContinuable'))).toHaveLength(0)
    expect(primitive.calls).not.toContain('start')

    // The payload names the teammate so a caller can resume it next turn.
    expect((result as unknown as { teammate: { name: string; childId: string } | null }).teammate)
      .toEqual({ name: spawns[0]!.name, childId: MEMBER })
  })

  it('the roster path needs NEITHER the primitive start nor its follow-up seam', async () => {
    // ⚠ THE POINT OF THE RELAXED SEAM CHECK. A roster child was created by `spawnTeammate`, so the round loop only
    // RESUMES it — `startContinuable` is not part of this path at all. A composition whose `subagents` service has no
    // start seam therefore still gets a working delegation; demanding one would have refused a round for a method it
    // never calls. The primitive seam here has neither `startContinuable` nor `followup`.
    const team = fakeRoster()
    m.runtime.attachTeams(team.service)
    const calls: string[] = []
    const bare: SubagentsRuntimeLike = {
      start: async () => { calls.push('start'); return approved() },
    }
    settle(m.runDir, MEMBER, 'APPROVE')

    const result = await m.runtime.delegateReview(reviewInput(m, {
      subagents: bare,
      parent: team.lead as unknown as SubagentParentHandle,
    })) as unknown as { evaluation: { accepted: boolean }; error: string | null; continuable: { refused?: string } | null }

    expect(result.continuable?.refused, 'the delegation must not REFUSE for a method the roster path never calls').toBeUndefined()
    expect(result.error).toBeNull()
    expect(result.evaluation.accepted).toBe(true)
    expect(calls).toEqual([])
    expect(team.calls.filter((call) => call.op === 'spawn')).toHaveLength(1)
  })

  it('G1 × G2: a settlement ADOPTED into the run still feeds the roster round', async () => {
    // ⚠ THE WINDOW THE TWO CHANGES MEET IN. A roster child has no delegation directory between `spawnTeammate` and the
    // brief write, so a settlement arriving there cannot be attributed by `runDirForChild` and is ADOPTED into the
    // single run. Before G1 that record was filed in a file nothing reads, so this round would have waited forever
    // for a child that had already answered. Here the adopted record is the ONLY thing the observer can find, and
    // the round must still be approved from it.
    const team = fakeRoster()
    m.runtime.attachTeams(team.service)
    const primitive = fakePrimitive()
    const adopted = adoptSettlement(m.root, {
      childId: MEMBER,
      summary: 'Background subagent finished.',
      closingText: JSON.stringify({ verdict: 'APPROVE', findings: [], references: [] }),
    })
    expect(adopted).not.toBeNull()
    expect(readSettlements(m.runDir).map((notice) => [notice.childId, notice.adopted])).toEqual([[MEMBER, true]])

    const result = await m.runtime.delegateReview(reviewInput(m, {
      subagents: primitive.seam,
      parent: team.lead as unknown as SubagentParentHandle,
    })) as unknown as { evaluation: { accepted: boolean }; continuable: { childId?: string } | null; parked: boolean }

    expect(result.continuable?.childId).toBe(MEMBER)
    expect(result.parked).toBe(false)
    expect(result.evaluation.accepted, 'an ADOPTED verdict is readable by the round (that is what G1 fixed)').toBe(true)
  })

  it('reads the settlement (G1) and honours an APPROVE', async () => {
    const team = fakeRoster()
    m.runtime.attachTeams(team.service)
    const primitive = fakePrimitive()
    settle(m.runDir, MEMBER, 'APPROVE')

    const result = await m.runtime.delegateReview(reviewInput(m, {
      subagents: primitive.seam,
      parent: team.lead as unknown as SubagentParentHandle,
    })) as unknown as {
      evaluation: { accepted: boolean }
      parked: boolean
      delegationMode: string
      result: { structured?: { verdict?: string } }
      continuable: { childId?: string; ok: boolean } | null
    }

    expect(result.evaluation.accepted, 'an APPROVE must be honoured').toBe(true)
    expect(result.parked).toBe(false)
    expect(result.result?.structured?.verdict).toBe('APPROVE')
    expect(result.continuable?.childId, 'the loop ran on the roster child').toBe(MEMBER)
    expect(result.delegationMode).toBe('continuable')
  })

  it('delivers a REVISE repair through agentTeams.sendMessage to the SAME target name', async () => {
    const team = fakeRoster()
    m.runtime.attachTeams(team.service)
    const primitive = fakePrimitive()
    settle(m.runDir, MEMBER, 'REVISE')

    const result = await m.runtime.delegateReview(reviewInput(m, {
      subagents: primitive.seam,
      parent: team.lead as unknown as SubagentParentHandle,
    })) as unknown as { parked: boolean; continuable: { rounds: Array<{ revise?: boolean; repair?: string }> } | null }

    const spawns = team.calls.filter((call) => call.op === 'spawn')
    const sends = team.calls.filter((call) => call.op === 'send')
    // One spawn (it created the child), one send for the brief, one send for the REPAIR — all to the same name.
    expect(spawns).toHaveLength(1)
    expect(sends).toHaveLength(2)
    expect(sends[1]!.target, 'the repair goes to the SAME teammate name').toBe(spawns[0]!.name)
    expect(sends[1]!.text, 'and it carries the reviewer\'s findings').toContain('rollback path missing')
    // The repair was delivered by the ROSTER, not by the primitive follow-up seam.
    expect(primitive.calls.filter((call) => call.startsWith('followup'))).toHaveLength(0)
    // The round is PARKED waiting for the re-submission, exactly as the primitive path would report.
    expect(result.parked).toBe(true)
    expect(result.continuable?.rounds[0]?.revise).toBe(true)
  })

  it('REUSES the same teammate on a second round: one spawn, two rounds, same child', async () => {
    const team = fakeRoster()
    m.runtime.attachTeams(team.service)
    const primitive = fakePrimitive()
    settle(m.runDir, MEMBER, 'REVISE')

    const first = await m.runtime.delegateReview(reviewInput(m, {
      subagents: primitive.seam,
      parent: team.lead as unknown as SubagentParentHandle,
    }))
    expect((first as unknown as { parked: boolean }).parked).toBe(true)

    // Round two: a FRESH call for the same delegation (no resumeChild). It must RESUME the recorded teammate.
    settle(m.runDir, MEMBER, 'APPROVE')
    const second = await m.runtime.delegateReview(reviewInput(m, {
      subagents: primitive.seam,
      parent: team.lead as unknown as SubagentParentHandle,
      childId: 'a-second-reserved-id',
    })) as unknown as {
      evaluation: { accepted: boolean }
      teammate: { name: string; childId: string } | null
      briefPath: string
      replyPath: string
    }

    expect(team.calls.filter((call) => call.op === 'spawn'), 'NO second spawn').toHaveLength(1)
    expect(second.evaluation.accepted).toBe(true)
    expect(second.teammate?.childId).toBe(MEMBER)
    expect(second.replyPath).toContain('child-' + MEMBER)
    expect(second.briefPath).toContain('child-' + MEMBER)
    // The second round was OPENED by a message to the same name (the brief + the round prompt, plus the
    // repair from round one).
    const sends = team.calls.filter((call) => call.op === 'send')
    expect(sends.length).toBeGreaterThanOrEqual(3)
    expect(sends.every((call) => call.target === teammateNameFor(RUN, DELEGATION, ROLE))).toBe(true)
    // The durable mapping names the child the round was really talking to.
    expect(readTeammates(m.runDir).map((entry) => [entry.delegationId, entry.role, entry.name, entry.childId]))
      .toEqual([[DELEGATION, ROLE, teammateNameFor(RUN, DELEGATION, ROLE), MEMBER]])
  })
})

describe('G3 — the fail-closed limits', () => {
  let m: Mounted
  beforeEach(async () => { m = await mount() })
  afterEach(async () => { await m.dispose() })

  it('the 17th member FAILS CLOSED with a named limit and dispatches no unrecorded child', async () => {
    const team = fakeRoster({ failSpawn: Object.assign(new Error('Team member limit 16 reached'), { code: 'TEAM_MEMBER_LIMIT' }) })
    m.runtime.attachTeams(team.service)
    const primitive = fakePrimitive()
    settle(m.runDir, MEMBER, 'APPROVE')

    const result = await m.runtime.delegateReview(reviewInput(m, {
      subagents: primitive.seam,
      parent: team.lead as unknown as SubagentParentHandle,
    })) as unknown as { error: string | null; delegationMode: string; teammate: unknown; continuable: unknown }

    expect(result.error, 'the refusal names WHICH limit was hit').toContain('Team member limit 16 reached')
    expect(result.error).toContain('maxMembers')
    expect(result.error).toContain('did NOT fall back')
    expect(result.teammate).toBeNull()
    expect(result.continuable).toBeNull()
    expect(result.delegationMode).toBe('none')
    // THE POINT: no silent unrecorded child was started in its place.
    expect(primitive.calls.filter((call) => call.startsWith('startContinuable'))).toHaveLength(0)
    expect(primitive.calls).not.toContain('start')
    // ... and the run RECORDS the refusal, with the named reason, rather than going quiet.
    const record = readdirSync(join(m.runDir, 'subagents')).find((entry) => entry.endsWith('-action.md'))!
    expect(readFileSync(join(m.runDir, 'subagents', record), 'utf8')).toContain('maxMembers')
  })

  it('a TAKEN name FAILS CLOSED, saying a teammate name is never reused', async () => {
    const team = fakeRoster({
      failSpawn: Object.assign(new Error('teammate name "rm-01-review-code-reviewer-1234abcd" was already used in this Team'), { code: 'TEAM_MEMBER_NAME_TAKEN' }),
    })
    m.runtime.attachTeams(team.service)
    const primitive = fakePrimitive()
    settle(m.runDir, MEMBER, 'APPROVE')

    const result = await m.runtime.delegateReview(reviewInput(m, {
      subagents: primitive.seam,
      parent: team.lead as unknown as SubagentParentHandle,
    })) as unknown as { error: string | null }

    expect(result.error).toContain('NEVER REUSED')
    expect(result.error).toContain('teammates.json')
    expect(primitive.calls.filter((call) => call.startsWith('startContinuable'))).toHaveLength(0)
  })

  it('a caller with NO roster refuses nothing: the primitive path runs exactly as it does today', async () => {
    // No team attached at all.
    const primitive = fakePrimitive()
    settle(m.runDir, RESERVED, 'APPROVE')

    const result = await m.runtime.delegateReview(reviewInput(m, {
      subagents: primitive.seam,
      parent: { id: 'agent-1' },
    })) as unknown as { evaluation: { accepted: boolean }; teammate: unknown; briefPath: string; actionRecordPath: string }

    expect(result.teammate).toBeNull()
    expect(primitive.calls.filter((call) => call.startsWith('startContinuable:' + RESERVED))).toHaveLength(1)
    expect(result.evaluation.accepted).toBe(true)
    // BYTE-IDENTICAL RECORD: the reserved child id, and no team marker in the execution mode.
    expect(result.briefPath).toContain('child-' + RESERVED)
    const record = readFileSync(result.actionRecordPath, 'utf8')
    expect(record).toContain('- Subagent ID: ' + RESERVED)
    expect(record).toContain('Execution Mode: native (continuable)')
    expect(record).not.toContain('team ')
  })

  it('a NON-LEAD caller — including a `{ id }` copy of the Lead — takes the primitive path', async () => {
    const team = fakeRoster()
    m.runtime.attachTeams(team.service)
    const primitive = fakePrimitive()
    settle(m.runDir, RESERVED, 'APPROVE')

    // ⚠ THE AUTHORITY RULE: the roster authorizes the EXACT live Agent. A copy carrying the same id is not a
    // member, so this must not be treated as the Lead — and must not spawn anything.
    const copy = { id: (team.lead as { id?: string }).id ?? 'lead-copy' }
    const result = await m.runtime.delegateReview(reviewInput(m, {
      subagents: primitive.seam,
      parent: copy,
    })) as unknown as { teammate: unknown; error: string | null }

    expect(result.teammate).toBeNull()
    expect(result.error).toBeNull()
    expect(team.calls.filter((call) => call.op === 'spawn')).toHaveLength(0)
    expect(primitive.calls.filter((call) => call.startsWith('startContinuable'))).toHaveLength(1)
  })

  it('RESUMING a child the roster has never seen keeps the primitive surface (and spawns nothing)', async () => {
    // ⚠ THE UPGRADE CASE. A run that parked a delegation under the primitive path holds a child id no roster knows.
    // Following it up by teammate name would fail for a child that is perfectly repairable, so the resume stays on
    // the surface the child was created on — and, crucially, creates nothing.
    const team = fakeRoster()
    m.runtime.attachTeams(team.service)
    const primitive = fakePrimitive()
    settle(m.runDir, 'legacy-child', 'REVISE')

    const result = await m.runtime.delegateReview(reviewInput(m, {
      subagents: primitive.seam,
      parent: team.lead as unknown as SubagentParentHandle,
      resumeChild: 'legacy-child',
    })) as unknown as { teammate: unknown; routingNotes: string[]; continuable: { rounds: Array<{ revise?: boolean }> } | null }

    expect(team.calls.filter((call) => call.op === 'spawn'), 'a resume never creates a child').toHaveLength(0)
    expect(result.teammate).toBeNull()
    expect(result.routingNotes.join('\n')).toContain('has no record in `subagents/teammates.json`')
    // The repair went through the PRIMITIVE seam, which is how the child was created.
    expect(primitive.calls.filter((call) => call.startsWith('followup:legacy-child'))).toHaveLength(1)
    expect(team.calls.filter((call) => call.op === 'send')).toHaveLength(0)
    expect(result.continuable?.rounds[0]?.revise).toBe(true)
    // And no mapping was invented for it, so a later round cannot mis-address it as a teammate.
    expect(readTeammates(m.runDir)).toEqual([])
  })
})

describe('PROVENANCE — a roster dispatch is recorded and the gate accepts it', () => {
  let m: Mounted
  beforeEach(async () => { m = await mount() })
  afterEach(async () => { await m.dispose() })

  it('operations.jsonl carries delegationId + the LEARNED childId, and a citation of its reply passes the gate', async () => {
    const team = fakeRoster()
    m.runtime.attachTeams(team.service)
    const primitive = fakePrimitive()
    settle(m.runDir, MEMBER, 'APPROVE')

    const result = await m.runtime.delegateReview(reviewInput(m, {
      subagents: primitive.seam,
      parent: team.lead as unknown as SubagentParentHandle,
    })) as unknown as { actionRecordPath: string; evaluation: { accepted: boolean } }
    expect(result.evaluation.accepted).toBe(true)

    const dispatched = readOperations(m.runDir).filter((entry) => entry.act === 'delegate-review')
    expect(dispatched.map((entry) => [entry.delegationId, entry.childId])).toEqual([[DELEGATION, MEMBER]])

    // The action record names the same child and delegation, so the two artifacts agree.
    const record = readFileSync(result.actionRecordPath, 'utf8')
    expect(record).toContain('- Subagent ID: ' + MEMBER)
    expect(record).toContain('- Delegation: ' + DELEGATION)
    expect(record).toContain(', team ' + teammateNameFor(RUN, DELEGATION, ROLE))

    // THE GATE, called where it blocks (lintPhaseSpecificRules is what the lock standard counts as FAIL).
    writeFileSync(join(m.runDir, 'subagents', DELEGATION, 'child-' + MEMBER, 'reply.md'), '{"verdict":"APPROVE"}\n', 'utf8')
    const cited = '.recursive/run/' + RUN + '/subagents/' + DELEGATION + '/child-' + MEMBER + '/reply.md'
    const content = [
      'Run: `' + RUN + '`',
      'Phase: `' + PHASE + '`',
      'Status: `DRAFT`',
      '',
      '## Subagent Contribution Verification',
      '',
      '- Reviewed Action Records: `' + cited + '`',
      '- Main-Agent Verification Performed: the controller re-read the reply against the artifact.',
      '- Acceptance Decision: accepted',
      '- Refresh Handling: not applicable; the delegation consumed no external context to refresh.',
      '- Repair Performed After Verification: none required; the reviewer approved.',
      '',
    ].join('\n')
    const provenance = lintPhaseSpecificRules(
      join(m.runDir, ARTIFACT), content, CURRENT_WORKFLOW_PROFILE, m.runDir, m.root, [], null,
    ).filter((issue) => issue.includes('operations.jsonl'))
    expect(provenance, 'the roster dispatch must satisfy the provenance gate').toEqual([])
  })
})

describe('G2 — the repair seam picks the surface the child was created on', () => {
  let m: Mounted
  beforeEach(async () => { m = await mount() })
  afterEach(async () => { await m.dispose() })

  it('deliverRepair sends a roster child THROUGH THE ROSTER, by name', async () => {
    const team = fakeRoster()
    m.runtime.attachTeams(team.service)
    settle(m.runDir, MEMBER, 'REVISE')
    const primitive = fakePrimitive()
    // One real dispatch, so the durable mapping exists exactly as production writes it.
    await m.runtime.delegateReview(reviewInput(m, {
      subagents: primitive.seam,
      parent: team.lead as unknown as SubagentParentHandle,
    }))
    const before = team.calls.filter((call) => call.op === 'send').length

    const sent = await m.runtime.deliverRepair({
      root: m.root,
      runId: RUN,
      delegationId: DELEGATION,
      childId: MEMBER,
      instruction: 'the rollback path is missing',
      parent: team.lead as unknown as SubagentParentHandle,
      subagents: primitive.seam,
    })
    expect(sent.via).toBe('team')
    const sends = team.calls.filter((call) => call.op === 'send')
    expect(sends.length).toBe(before + 1)
    expect(sends[sends.length - 1]!.target).toBe(teammateNameFor(RUN, DELEGATION, ROLE))
    expect(sends[sends.length - 1]!.text).toContain('rollback')
    expect(primitive.calls.filter((call) => call.startsWith('followup'))).toHaveLength(0)
  })

  it('a child with NO roster record still uses the primitive follow-up seam', async () => {
    const primitive = fakePrimitive()
    const sent = await m.runtime.deliverRepair({
      root: m.root,
      runId: RUN,
      delegationId: DELEGATION,
      childId: 'primitive-child',
      instruction: 'repair it',
      parent: { id: 'agent-1' },
      subagents: primitive.seam,
    })
    expect(sent.via).toBe('subagents')
    expect(primitive.calls).toContain('followup:primitive-child')
  })
})

describe('the deterministic teammate name', () => {
  it('is stable, lower-kebab, ≤64 chars and never "lead"', () => {
    const name = teammateNameFor('run-a', '01-review', 'code-reviewer')
    expect(teammateNameFor('run-a', '01-review', 'code-reviewer')).toBe(name)
    expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    expect(name.length).toBeLessThanOrEqual(64)
    expect(name).not.toBe('lead')
    expect(name.startsWith('rm-01-review-code-reviewer-')).toBe(true)
    // Every different input is a different name: a name collision is unrecoverable in a team.
    const variants = [
      teammateNameFor('run-b', '01-review', 'code-reviewer'),
      teammateNameFor('run-a', '02-review', 'code-reviewer'),
      teammateNameFor('run-a', '01-review', 'analyst'),
    ]
    expect(new Set([name, ...variants]).size).toBe(4)
  })

  it('fits the roster\'s limit even for absurd delegation ids, and keeps a usable suffix', () => {
    const name = teammateNameFor('r'.repeat(200), 'D'.repeat(120) + ' / weird id', 'Reviewer With Spaces')
    expect(name.length).toBeLessThanOrEqual(64)
    expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    expect(name).toBe(teammateNameFor('r'.repeat(200), 'D'.repeat(120) + ' / weird id', 'Reviewer With Spaces'))
  })
})
