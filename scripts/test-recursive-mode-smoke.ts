#!/usr/bin/env -S npx tsx
/**
 * dsh-recursive-mode smoke harness (R7). Exercises the Phase A completion
 * surfaces end-to-end against a throwaway workspace on D:, workspace-scoped:
 *   R1  workspace root resolution (never scans other workspaces)
 *   R2  closeout scaffold
 *   R4  /recursive command grammar + scoped execution
 *   R5  scratch lifecycle
 *   R6  bootstrap idempotency + Stage B
 * Run:  npx tsx scripts/test-recursive-mode-smoke.ts
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { bootstrapScaffold, enumerateRuns, stageBWorkflowInit } from '../src/bootstrap.ts'
import { executeRecursiveCommand, parseRecursiveCommand } from '../src/commands.ts'
import { closeoutPhase } from '../src/closeout.ts'
import { readScratch, writeScratch } from '../src/scratch.ts'
import { resolveControlPlaneRoot, makeWorkspaceResolver } from '../src/workspace.ts'
import { lockHashFromContent } from '../src/lock.ts'
import { buildReviewBundle, contentSha256 } from '../src/review.ts'
import { createHandoff, createChildBrief, replyPath, childScratchPath, buildDelegationPrompt } from '../src/handoff.ts'
import { resolveRole, capabilityProbe, loadRouterPolicy } from '../src/router.ts'
import { validateReferences, writeActionRecord, reviewOutputSchema } from '../src/delegation.ts'
import { writeChildScratch, readParentScratch } from '../src/scratch.ts'
import { validateTransition, coupleGateBlockToGoal, type PhaseTransitionIntent } from '../src/lifecycle.ts'
import { snapshotWorkspace } from '../src/snapshot.ts'
import { RECURSIVE_API_PREFIX, makeRecursiveRoutes, mountRecursiveRoutesOnce } from '../src/live-route.ts'
import { columnForRun, cardFacts, nodeKeyOf, expandPhaseRows } from '../src/client/derive.ts'
import { evaluateToolGuard, coerceAskToDecision, resolveEnforcementConfig, DEFAULT_ENFORCEMENT, detectTamper } from '../src/enforcement.ts'
import { syncRunGoal, blockRunGoal, type GoalServiceLike, type GoalViewLike } from '../src/goals-projection.ts'
import { renderRecursivePolicy } from '../src/policy.ts'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + name + (detail ? ' — ' + detail : ''))
  if (!ok) failures++
}

async function main() {
  console.log('dsh-recursive-mode smoke (R7)')
  const base = join(process.env.TEMP || tmpdir(), 'rm-smoke-' + Date.now())
  mkdirSync(base, { recursive: true })
  const wsA = join(base, 'ws-a')
  const wsB = join(base, 'ws-b')
  mkdirSync(wsA, { recursive: true })
  mkdirSync(wsB, { recursive: true })

  try {
    // R6 bootstrap idempotency
    const b1 = bootstrapScaffold(wsA)
    check('R6 bootstrap creates scaffold', b1.created.length > 0, b1.created.join(','))
    const b2 = bootstrapScaffold(wsA)
    check('R6 bootstrap idempotent (no-op)', b2.created.length === 0, 'created=' + b2.created.length)
    check('R6 scaffold files exist', existsSync(join(wsA, '.recursive', 'RECURSIVE.md')))

    // R6 Stage B new + resume
    mkdirSync(join(wsA, '.recursive', 'run', '10-smoke'), { recursive: true })
    const sNew = stageBWorkflowInit({ root: wsA, source: 'new' })
    check('R6 Stage B new bootstraps', sNew.bootstrapped === true || sNew.runs.length > 0, 'runs=' + sNew.runs.join(','))
    const sResume = stageBWorkflowInit({ root: wsA, source: 'resume', activeRunId: '10-smoke' })
    check('R6 Stage B resume never re-bootstraps', sResume.bootstrapped === false, 'bootstrapped=' + String(sResume.bootstrapped))
    check('R6 enumerate runs dir-names only', sResume.runs.includes('10-smoke'))

    // R1 workspace scoping: wsA sees only its runs; wsB untouched
    const registry = {
      async resolveByPath(path: string) { return path === wsA ? { path: wsA, id: 'a' } : path === wsB ? { path: wsB, id: 'b' } : undefined },
    }
    const resolve = makeWorkspaceResolver(registry as never)
    const rootA = await resolve(wsA)
    const rootB = await resolve(wsB)
    check('R1 resolve A', rootA === wsA)
    check('R1 resolve B', rootB === wsB)
    const listA = executeRecursiveCommand(rootA as string, 'list')
    check('R1 scoped list (A has run, B does not)', listA.kind === 'success' && (listA.text ?? '').includes('10-smoke'))
    const listB = executeRecursiveCommand(rootB as string, 'list')
    check('R1 B sees no A runs', listB.kind === 'success' && !(listB.text ?? '').includes('10-smoke'), listB.text)
    const rootNoWs = await resolveControlPlaneRoot({ session: { header: { cwd: join(base, 'nowhere') } } } as never, registry as never)
    check('R1 unregistered cwd -> null (defer)', rootNoWs === null)

    // R2 closeout scaffold
    const runDir = join(wsA, '.recursive', 'run', '10-smoke')
    const req = [
      'Run: 10-smoke', 'Phase: 0', 'Status: \`LOCKED\`', 'Workflow version: recursive-mode-audit-v2', '',
      '## TODO', '', '- [x] done', '', 'Coverage: PASS', 'Approval: PASS',
      'LockedAt: \`2026-01-15T10:00:00Z\`', 'LockHash: \`PLACEHOLDER\`', '',
    ].join('\n')
    const hash = lockHashFromContent(req.replace('PLACEHOLDER', '0'.repeat(64)))
    writeFileSync(join(runDir, '00-requirements.md'), req.replace('PLACEHOLDER', hash), 'utf8')
    const co = closeoutPhase(runDir, '06', { strict: false })
    check('R2 closeout scaffolds 06', co.created.includes('06-decisions-update.md'), co.created.join(','))
    check('R2 closeout header', readFileSync(join(runDir, '06-decisions-update.md'), 'utf8').includes('## TODO'))

    // R4 command grammar + scoped execution
    check('R4 parse closeout', parseRecursiveCommand('closeout 10-smoke --phase 06').verb === 'closeout')
    const cmdCloseout = executeRecursiveCommand(wsA, 'closeout 10-smoke --phase 06')
    check('R4 closeout command success', cmdCloseout.kind === 'success')
    const cmdUnknown = executeRecursiveCommand(wsA, 'frobnicate')
    check('R4 unknown verb error', cmdUnknown.kind === 'error')

    // R5 scratch lifecycle
    writeScratch(runDir, 'md', '# scratch smoke')
    check('R5 scratch write+read', readScratch(runDir, 'md').includes('scratch smoke'))
    check('R5 scratch path', existsSync(join(runDir, 'scratch', 'scratch.md')))

    // Phase B (run 04) smoke: bundle, handoff, router, delegation shape, child scratch, validation
    writeFileSync(join(runDir, '03-implementation-summary.md'), '# impl\nStatus: `DRAFT`\n', 'utf8')
    const bundle = buildReviewBundle({
      root: wsA, runId: '10-smoke', phase: '03.5 Code Review', role: 'code-reviewer',
      artifactPath: '.recursive/run/10-smoke/03-implementation-summary.md',
      upstreamArtifacts: ['.recursive/run/10-smoke/00-requirements.md'],
      auditQuestions: ['scoped?'], requiredOutput: 'verdict',
      codeRefs: ['src/workspace.ts'], changedFiles: ['src/workspace.ts'],
    })
    check('R1 bundle built', existsSync(bundle.bundlePath) && bundle.markdown.includes('## Diff Basis'))
    check('R1 bundle hash', bundle.artifactContentHash === contentSha256(readFileSync(join(runDir, '03-implementation-summary.md'), 'utf8')))

    const handoff = createHandoff({ root: wsA, runId: '10-smoke', delegationId: 'rev-1', role: 'code-reviewer', objective: 'review', runDocRefs: [], codeRefs: [], auditQuestions: [], requiredOutput: 'v', decisionBasis: 'self-audit' })
    const brief = createChildBrief({ root: wsA, runId: '10-smoke', delegationId: 'rev-1', childId: 'c1', slice: 's' })
    check('R2 handoff+brief', existsSync(handoff) && existsSync(brief))
    check('R2 prompt pointers', buildDelegationPrompt({ root: wsA, runId: '10-smoke', delegationId: 'rev-1', childId: 'c1', handoffPath: handoff, briefPath: brief }).includes('reply.md'))

    const decision = resolveRole('code-reviewer', loadRouterPolicy(undefined), {})
    const probe = capabilityProbe({ providers: {}, role: 'code-reviewer', policy: loadRouterPolicy(undefined) })
    check('R3 router -> self-audit', decision.tier === 'self-audit' && probe.available === false)

    check('R4 outputSchema', (reviewOutputSchema() as { required?: string[] }).required?.includes('verdict') === true)

    const childScratch = childScratchPath({ root: wsA, runId: '10-smoke', childId: 'c1' })
    writeChildScratch(runDir, 'c1', 'child note')
    check('R5 child scratch written', existsSync(childScratch) && readFileSync(childScratch, 'utf8').includes('child note'))
    check('R5 parent scratch intact', readParentScratch(runDir, 'md').includes('scratch smoke'))

    const vref = validateReferences(wsA, [{ path: '.recursive/run/10-smoke/03-implementation-summary.md' }])
    check('R6 references valid', vref.ok === true)
    const arec = writeActionRecord({ root: wsA, runId: '10-smoke', subagentId: 'c1', phase: '03.5', purpose: 'review', executionMode: 'self-audit', success: false, stopReason: 'none' })
    check('R6 action record', existsSync(arec) && readFileSync(arec, 'utf8').includes('## Verification Handoff'))

    // Phase C (run 05) smoke: transition gate (zero-emission surface), tool
    // guard, T6 ask->policy bridge, policy, tamper, T1 goals projection.
    const gatedIntent: PhaseTransitionIntent = { runId: '10-smoke', worktreeRoot: wsA, targetArtifact: '03-implementation-summary.md', kind: 'lock' }
    const gateCheck = validateTransition(gatedIntent)
    check('R1 transition gate reads the lock chain', gateCheck.passed === false && gateCheck.failures.length > 0, gateCheck.failures.join(';'))
    const tddContent = 'Run: 10-smoke\nPhase: 3\nStatus: DRAFT\nTDD Mode: strict\nRED: evidence/logs/red/tdd-red.md\nGREEN: evidence/logs/green/tdd-green.md\n'
    writeFileSync(join(runDir, '03-implementation-summary.md'), tddContent, 'utf8')
    // Lock 03's prerequisites so the in-order lock guard passes (monotonic chain).
    // 01/02 are audited phases: the fold requires Audit: PASS for lock-valid.
    for (const [file, phase, audited] of [['00-worktree.md', '0 (Worktree)', false], ['01-as-is.md', '1 (AS-IS)', true], ['02-to-be-plan.md', '2 (TO-BE Plan)', true]] as const) {
      const doc = [
        'Run: 10-smoke', 'Phase: ' + phase, 'Status: `LOCKED`', 'Workflow version: recursive-mode-audit-v2', '',
        '## TODO', '', '- [x] done', '', 'Coverage: PASS', 'Approval: PASS',
        ...(audited ? ['Audit: PASS'] : []),
        'LockedAt: `2026-01-15T10:00:00Z`', 'LockHash: `PLACEHOLDER`', '',
      ].join('\n')
      const docHash = lockHashFromContent(doc.replace('PLACEHOLDER', '0'.repeat(64)))
      writeFileSync(join(runDir, file), doc.replace('PLACEHOLDER', docHash), 'utf8')
    }
    const lockGuard = evaluateToolGuard({ name: 'recursive_lock', arguments: { artifact: '03-implementation-summary.md' } }, wsA, '10-smoke', 'strict')
    check('R4 tool guard allows in-order lock', lockGuard.kind === 'allow')
    const outOfOrder = evaluateToolGuard({ name: 'recursive_lock', arguments: { artifact: '05-manual-qa.md' } }, wsA, '10-smoke', 'strict')
    check('R4 tool guard denies out-of-order lock', outOfOrder.kind === 'deny' && (outOfOrder as { reason: string }).reason.includes('monotonic'))
    const askDecision = evaluateToolGuard({ name: 'recursive_lock', arguments: { artifact: '05-manual-qa.md' } }, wsA, '10-smoke', 'advisory')
    check('T6 advisory guard asks', askDecision.kind === 'ask')
    const coercedStrict = coerceAskToDecision(askDecision, 'strict')
    const coercedAdvisory = coerceAskToDecision(askDecision, 'advisory')
    check('T6 ask->deny under strict', coercedStrict.kind === 'deny')
    check('T6 ask->allow+warn under advisory (never silent)', coercedAdvisory.kind === 'allow' && typeof (coercedAdvisory as { warn?: string }).warn === 'string')
    check('R7 config default advisory', JSON.stringify(resolveEnforcementConfig(undefined)) === JSON.stringify(DEFAULT_ENFORCEMENT))
    let configError = ''
    try { resolveEnforcementConfig({ bogus: 1 }) } catch (err) { configError = (err as Error).message }
    check('R7 unknown config key fails', configError.includes('unknown key'))
    const policyText = renderRecursivePolicy({ worktreeRoot: wsA, runId: '10-smoke', folded: null })
    check('R5 policy renders contract', policyText.includes('recursive-mode session') && policyText.includes('Current phase'))
    check('R8 tamper clean', detectTamper(join(runDir, '03-implementation-summary.md'), wsA, '10-smoke') === null)
    check('R6 goal coupling no-op', coupleGateBlockToGoal(null, {}, { id: 'g' }, { code: 'G', message: 'x' }) === false)
    // T1 (goals projection): structural fake of the live goals service.
    let goalCurrent: GoalViewLike | undefined
    const goalService: GoalServiceLike = {
      get: () => goalCurrent,
      create: (_agent, req) => { goalCurrent = { id: 'g1', revision: 1, objective: req.objective, phase: 'active' }; return goalCurrent },
      block: (_agent, ref) => { if (!goalCurrent || goalCurrent.id !== ref.id) throw new Error('mismatch'); goalCurrent = { ...goalCurrent, phase: 'blocked', revision: ref.revision + 1 }; return goalCurrent },
      pause: (_agent, ref) => { goalCurrent = { ...(goalCurrent ?? { id: ref.id, revision: ref.revision }), phase: 'paused', revision: ref.revision + 1 }; return goalCurrent },
      resume: (_agent, ref) => { goalCurrent = { ...(goalCurrent ?? { id: ref.id, revision: ref.revision }), phase: 'active', revision: ref.revision + 1 }; return goalCurrent },
      complete: (_agent, ref) => { goalCurrent = { ...(goalCurrent ?? { id: ref.id, revision: ref.revision }), phase: 'complete', revision: ref.revision + 1 }; return goalCurrent },
      clear: (_agent, ref) => { goalCurrent = undefined; return { id: ref.id, revision: ref.revision + 1 } },
    }
    const goalSync = syncRunGoal(goalService, {}, '10-smoke', 'active')
    check('T1 run goal armed', goalSync.ok === true && goalCurrent?.objective === 'recursive-run:10-smoke · active')
    const goalBlock = blockRunGoal(goalService, {}, '10-smoke', { code: 'prerequisite-blockers', message: 'monotonic lock-order' })
    check('T1 gate-block blocks the run goal', goalBlock.ok === true && goalCurrent?.phase === 'blocked')


    // ---- Phase D checks (SP2 R1 live route, replaces the session projection) ----
    // The live route folds the FILESYSTEM (snapshotWorkspace), not session events.
    const snapshot = snapshotWorkspace(wsA)
    check('R2 snapshot groups by worktreeRoot', Object.keys(snapshot).length === 1 && snapshot[wsA] !== undefined)
    const card = snapshot[wsA]?.['10-smoke']
    // Wire contract parity: phases are keyed by FILENAME (the deleted projection.ts
    // keyed recursive/phase events by filename), which derive.ts phaseGroupOf parses.
    // 03 is DRAFT here (written for the tool-guard test); 06 exists from closeoutPhase.
    check('R2/R9 snapshot card facts', card !== undefined && card.worktreeRoot === wsA && card.phases['03-implementation-summary.md']?.status === 'DRAFT')
    // R9 worktree-scope: a run directory outside wsA is never folded.
    check('R9 snapshot is workspace-scoped', Object.keys(snapshot).every(root => root === wsA))
    // R5/R6 derive over the snapshot card (furthest present phase is 06 -> closeout lane).
    check('R5 columnForRun maps to the furthest present phase', columnForRun(card as never) === '6-8')
    const facts = cardFacts(card as never)
    // Locked groups: 00 (requirements+worktree share one group), 01, 02.
    // 03 is DRAFT; no tamper; no gate-block (the fs carries no transient facts).
    check('R5 cardFacts progress + tampered + gateBlocked', facts.lockedCount === 3 && facts.tampered === false && facts.gateBlocked === false)
    // R7 node key
    check('R7 nodeKeyOf includes worktreeRoot', nodeKeyOf('10-smoke', wsA).includes(wsA))
    check('R6 expandPhaseRows always shows 3.5', expandPhaseRows(card as never).some(r => r.phase === '03.5'))
    // R2 route: prefix + mountOnce-global (second mount no-ops)
    check('R2 route prefix', RECURSIVE_API_PREFIX === '/.recursive/api')
    const routes = makeRecursiveRoutes({ resolveRoot: async () => wsA, snapshot: async (root: string) => snapshotWorkspace(root), revision: () => 1 })
    check('R2 route count (state, events, doc)', routes.length === 3 && routes[0].kind === 'exact' && routes[1].kind === 'exact' && routes[2].kind === 'exact')
    let registerCount = 0
    const fakeServer = { register: () => { registerCount++; return () => {} } }
    const mk = () => mountRecursiveRoutesOnce('@try-works/dsh-recursive-mode', () => makeRecursiveRoutes({ resolveRoot: async () => wsA, snapshot: async (root: string) => snapshotWorkspace(root), revision: () => 1 }), fakeServer)
    mk(); mk()
    check('R2 mountOnce-global (second mount no-ops)', registerCount === 3)

    console.log(failures === 0 ? 'SMOKE PASS' : 'SMOKE FAIL (' + failures + ' failures)')
    process.exitCode = failures === 0 ? 0 : 1
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

void main()
