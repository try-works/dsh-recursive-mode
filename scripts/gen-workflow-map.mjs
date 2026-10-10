#!/usr/bin/env node
/**
 * gen-workflow-map.mjs — generates workflow-map/recursive-mode-workflow.html.
 *
 * WHY A GENERATOR. The page's whole value is that its content is TRANSCRIBED from
 * this repo's source, with a file:line citation on every factual block. Keeping the
 * facts as data in one place (below) and rendering them once means the citations and
 * the wording cannot drift apart from each other, and `--verify` re-reads the SOURCE
 * files and re-derives the claim-bearing lists, so a fact that stops being true in
 * `src/` fails loudly instead of shipping as a plausible diagram.
 *
 * WHAT IT DOES NOT DO: it does not parse TypeScript. The facts below were transcribed
 * by reading the sources, and `--verify` checks the ones that can be checked
 * mechanically (phase list and order, required sections, late/audited/optional sets,
 * tool names, hook seam strings, error codes, guard labels, the run-start labels).
 * Anything that cannot be checked mechanically is marked `unverified` in the page.
 *
 * Usage:
 *   node scripts/gen-workflow-map.mjs            # write the HTML
 *   node scripts/gen-workflow-map.mjs --verify   # check the facts against src/, write nothing
 *   node scripts/gen-workflow-map.mjs --out <p>  # write somewhere else
 *
 * READ-ONLY with respect to src/ and tests/. Writes exactly one file.
 *
 * ⚠ BEFORE YOU CHANGE ANYTHING HERE: read workflow-map/README.md. It is the maintainer's
 * guide to this generator, the layout engine's reserve() rule, the two checkers, the
 * citation anchors, the invariants and why each exists, and the vacuity trap that made
 * nineteen assertions here green over a visibly broken chart. A change to this file that
 * is not accompanied by `--verify`, both checkers, and a LOOK at the rendered page is not
 * a finished change.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_OUT = join(ROOT, 'workflow-map', 'recursive-mode-workflow.html')

/* ========================================================================== */
/* CITATIONS — resolved from source ANCHORS, never hardcoded line numbers.     */
/*                                                                            */
/* WHY. While this page was being written, another agent edited                */
/* `policy-globs.ts` and `runtime.ts` and inserted dozens of lines for a new   */
/* guard rule. Every line number the page had transcribed below that point     */
/* became WRONG — and a wrong citation is exactly the defect this page exists   */
/* to avoid: a diagram that asserts something the code does not say. So each    */
/* citation is resolved HERE, from a named anchor searched in the file it       */
/* belongs to, at generate time. A missing anchor is a hard failure; so is an   */
/* ambiguous one; so is a range that runs past the end of its file.            */
/* ========================================================================== */

/** Search texts written OUT (not read from the source) so a MOVED anchor is caught. */
const ANCHORS = {
  'lock.sequence': ['src/lock.ts', 'export const PHASE_SEQUENCE = ['],
  'lock.optional': ['src/lock.ts', 'export const OPTIONAL_PHASES = new Set(['],
  'lock.hash': ['src/lock.ts', 'export function lockHashFromContent'],
  'lock.status': ['src/lock.ts', 'export function getLockStatus'],
  'lock.receipts': ['src/lock.ts', 'export function receiptPath'],
  'lock.staleDownstream': ['src/lock.ts', 'export function getStaleDownstreamPhases'],
  'lock.staleAll': ['src/lock.ts', 'export function getAllStaleReceipts'],
  'lock.chainBreaks': ['src/lock.ts', 'export type ReceiptChainBreakKind'],
  'lock.validateChain': ['src/lock.ts', 'export function validateReceiptChain'],

  'rules.late': ['src/phase-rules.ts', 'export const LATE_PHASE_ARTIFACTS'],
  'rules.audited': ['src/phase-rules.ts', 'export const AUDITED_PHASE_FILES = new Set(['],
  'rules.priorEvidence': ['src/phase-rules.ts', 'export const PRIOR_RECURSIVE_EVIDENCE_FILES'],
  'rules.diffAudited': ['src/phase-rules.ts', 'export const DIFF_AUDITED_FILES'],
  'rules.traceability': ['src/phase-rules.ts', 'export const TRACEABILITY_REQUIRED_FILES = new Set(['],
  'rules.auditHeadings': ['src/phase-rules.ts', 'export const AUDIT_REQUIRED_HEADINGS'],
  'rules.sectionMapRoot': ['src/phase-rules.ts', 'const SECTION_MAP: Record<string, string[]> = {'],
  'rules.memoryPlane': ['src/phase-rules.ts', 'export const MEMORY_PLANE_PREFIX'],
  'rules.phase8Rule': ['src/phase-rules.ts', 'export const PHASE8_MEMORY_WRITE_RULE'],
  'rules.memoryLocations': ['src/phase-rules.ts', 'export const MEMORY_DOC_LOCATIONS'],
  'rules.getSections': ['src/phase-rules.ts', 'export function getArtifactRequiredSections'],
  'rules.reminderGate': ['src/phase-rules.ts', 'export class ReminderOnceGate'],
  'rules.lintMessage': ['src/phase-rules.ts', 'export function phaseLintRulesMessage'],
  'rules.narrowing': ['src/phase-rules.ts', 'export function withPhaseBaseline'],
  'rules.baseline': ['src/phase-rules.ts', 'export function phaseBaselineRules'],
  'rules.verdictRank': ['src/phase-rules.ts', 'const VERDICT_RANK'],
  'rules.phaseNumber': ['src/phase-rules.ts', 'export function phaseNumberForArtifact'],
  'rules.ownMemoryPlane': ['src/phase-rules.ts', 'function writesOwnMemoryPlane'],
  'rules.resolveFrom': ['src/phase-rules.ts', 'FIX 2 — THIS USED TO STRIP A LEADING DOT'],

  'lint.inputMap': ['src/ts-lint.ts', 'export function getPhaseExpectedInputArtifactNames'],
  'lint.inputAddenda': ['src/ts-lint.ts', 'export function getExpectedEffectiveInputAddendaPaths'],
  'lint.effectiveInputs': ['src/ts-lint.ts', 'lint_effective_input_addenda'],
  'lint.rereadPaths': ['src/ts-lint.ts', 'Effective Inputs Re-read is missing relevant addenda'],
  'lint.sequence': ['src/ts-lint.ts', 'export const RUN_ARTIFACT_SEQUENCE = ['],
  'lint.tddMode': ['src/ts-lint.ts', 'TDD Compliance Log is missing TDD Mode'],
  'lint.qaMode': ['src/ts-lint.ts', 'QA Execution Record is missing QA Execution Mode'],
  'lint.qaSignoff': ['src/ts-lint.ts', 'requires User Sign-Off -> Approved by'],
  'lint.auditContext': ['src/ts-lint.ts', 'Audit Context section is empty'],
  'lint.staleBundle': ['src/ts-lint.ts', 'Review bundle is stale'],

  'tpl.requirements': ['src/init-templates.ts', 'export function requirementsContent'],
  'tpl.worktree': ['src/init-templates.ts', 'export function worktreeContent'],
  'tpl.later': ['src/init-templates.ts', 'export function laterPhaseContent'],

  'runtime.lockArtifact': ['src/runtime.ts', 'async lockArtifact(runId: string'],
  'runtime.blockers': ['src/runtime.ts', "throw new Error('Prerequisite blockers: '"],
  'runtime.quiescence': ['src/runtime.ts', 'const inFlight = pendingWork(runDir)'],
  'runtime.memoryGate': ['src/runtime.ts', 'const memoryRefusal = phase8MemoryLockRefusal'],
  'runtime.lintGate': ['src/runtime.ts', 'const lint = await this.lintArtifact'],
  'runtime.lintRefusal': ['src/runtime.ts', 'does not meet the phase standard, so it was not locked'],
  'runtime.reopen': ['src/runtime.ts', 'private reopenArtifact('],
  'runtime.staleInvalidate': ['src/runtime.ts', 'for (const entry of stale) invalidateReceipt'],

  'index.tools': ['src/index.ts', 'ctx.tools.register(createRecursiveStatusTool(recursive))'],
  'index.auditTeam': ['src/index.ts', 'let auditTeamRegistered'],
  'index.injects': ['src/index.ts', "ctx.inject(['subagents']"],
  'index.prompt': ['src/index.ts', "name: 'recursive:policy'"],
  'index.preExecute': ['src/index.ts', "on('tools/pre-execute'"],
  // NOTE: the register CALL is identical for both bindings, so this anchor is the
  // guard's own name CONSTANT — unique, and it is the line the two share.
  'index.guardRegister': ['src/index.ts', "const BUILTIN_GUARD_HOOK_NAME = 'builtin-tool-guard'"],
  'index.planGate': ['src/index.ts', "name: 'exit-plan-mode-gate'"],
  'index.fsObserved': ['src/index.ts', "on('fs/observed'"],
  'index.sessionEvent': ['src/index.ts', "on('session/event'"],
  'index.preStep': ['src/index.ts', "on('agent/pre-step'"],
  'index.webServer': ['src/index.ts', "disposers.push(mountRecursiveRoutesOnce("],
  'index.guardLog': ['src/index.ts', 'appendGuardDecision(root, record)'],
  'index.denyText': ['src/index.ts', 'the gate-block payload added for FU-7'],
  'index.blockGoal': ['src/index.ts', 'blockGoalOnGuardRefusal(recursive, exec, final, runId)'],

  'hooks.points': ['src/hooks.ts', 'export const HOOK_POINTS'],
  'hooks.gating': ['src/hooks.ts', 'export const GATING_POINTS'],
  'hooks.observing': ['src/hooks.ts', 'export const OBSERVING_POINTS'],
  'hooks.downgrade': ['src/hooks.ts', 'A deny from an observing point is therefore downgraded'],
  'hooks.downgradeImpl': ['src/hooks.ts', 'OBSERVE-ONLY POINTS CANNOT DENY: the message has already streamed'],
  'hooks.failure': ['src/hooks.ts', 'FAILURE DEFAULTS DIFFER BY POINT'],

  'globs.writeTools': ['src/policy-globs.ts', 'export const WRITE_TOOL_NAMES'],
  'globs.lockTools': ['src/policy-globs.ts', 'export const LOCK_TOOL_NAMES'],
  'globs.lockOrder': ['src/policy-globs.ts', 'function lockOrderRule'],
  'globs.lockedWrite': ['src/policy-globs.ts', 'function lockedWriteRule'],
  'globs.directChild': ['src/policy-globs.ts', 'function directChildName'],
  'globs.phaseOrder': ['src/policy-globs.ts', 'function phaseOrderRule'],
  'globs.memoryRead': ['src/policy-globs.ts', 'function memoryReadRule'],
  'globs.builtIn': ['src/policy-globs.ts', 'export function builtInToolPolicyRules'],
  'globs.attach': ['src/policy-globs.ts', 'export function attachPolicyPredicate'],
  'globs.tdd': ['src/policy-globs.ts', 'export function tddEvidenceVerdict'],
  'globs.phaseOrderHole': ['src/policy-globs.ts', 'THE HOLE THIS CLOSES'],
  'globs.phaseOrderAllow': ['src/policy-globs.ts', 'THE ALLOW HALF IS LOAD-BEARING'],

  'enf.mode': ['src/enforcement.ts', 'export type EnforcementMode'],
  'enf.default': ['src/enforcement.ts', 'export const DEFAULT_ENFORCEMENT_MODE'],
  'enf.evaluate': ['src/enforcement.ts', 'export function evaluateToolGuard'],
  'enf.verdictFor': ['src/enforcement.ts', 'function verdictFor'],
  'enf.coerce': ['src/enforcement.ts', 'export function coerceAskToDecision'],
  'enf.consult': ['src/enforcement.ts', 'function consultTransitionGate'],

  'err.registry': ['src/errors.ts', 'export const TOOL_ERRORS = {'],
  'err.classes': ['src/errors.ts', 'export type ToolErrorClass'],
  'err.specUnfilled': ['src/errors.ts', 'RUN_START_SPEC_UNFILLED: {'],
  'err.unanswered': ['src/errors.ts', 'RM5503 USED TO LIE'],
  'err.noChannel': ['src/errors.ts', 'RUN_START_NO_CHANNEL: {'],
  'err.pending': ['src/errors.ts', 'PENDING_WORK: {'],

  'start.module': ['src/run-start.ts', 'PHASE 0 — STARTING A RUN IS A HUMAN DECISION'],
  'start.gate': ['src/run-start.ts', 'export const RUN_START_GATE = {'],
  'start.labels': ['src/run-start.ts', 'export const RUN_START_APPROVE'],
  'start.line': ['src/run-start.ts', 'export function runStartApprovalLine'],
  'start.approval': ['src/run-start.ts', 'export function readRunStartApproval'],
  'start.valueMatch': ['src/run-start.ts', 'MATCHED ON THE VALUE, NOT ON THE LINE'],
  'start.guard': ['src/run-start.ts', 'export function runStartSpecGuard'],
  'start.notApproved': ['src/run-start.ts', 'export const RUN_START_NOT_APPROVED'],
  'start.notAGate': ['src/run-start.ts', 'WHY THIS GATE IS NOT IN'],

  'ask.gates': ['src/recursive_ask.tool.ts', 'export const ASK_GATES'],
  'ask.tdd': ['src/recursive_ask.tool.ts', "'tdd-mode': {"],
  'ask.qa': ['src/recursive_ask.tool.ts', "'qa-signoff': {"],
  'ask.gateBlock': ['src/recursive_ask.tool.ts', "'gate-block': {"],
  'ask.payload': ['src/recursive_ask.tool.ts', 'THE GATE-BLOCK REFUSAL PAYLOAD, BUILT IN ONE PLACE'],
  'ask.relayOnly': ['src/recursive_ask.tool.ts', "toolError('RELAY_ONLY_FOR_RUN_START'"],
  'ask.fixedArtifact': ['src/recursive_ask.tool.ts', 'const artifact = (isRunStartGate(gateId)'],

  'review.driver': ['src/review-round.ts', 'THE FOUR OUTCOMES THAT MATTER'],
  'review.failClosed': ['src/review-round.ts', 'THE VERDICT IS READ FROM'],
  'teams.loop': ['src/teams-loop.ts', 'createTask (pending) → claim (in_progress) → audit round'],
  'graph.why': ['src/phase-graph.ts', 'the phase dependency as a GRAPH, not a flat sequence'],
  'graph.build': ['src/phase-graph.ts', 'export function buildPhaseGraph'],
  'graph.reach': ['src/phase-graph.ts', 'export function reachableFrom'],
  'graph.next': ['src/phase-graph.ts', 'export function nextLegalPhase'],
  'graph.back': ['src/phase-graph.ts', 'export function backEdges'],
  'graph.addendum': ['src/phase-graph.ts', 'ADDENDUM edges'],
  'graph.backEdgeWhy': ['src/phase-graph.ts', 'BACK-EDGES ARE FIRST-CLASS'],
  'graph.visited': ['src/phase-graph.ts', 'The VISITED set is load-bearing'],
  'deleg.verdict': ['src/delegation.ts', 'export type DelegationVerdict'],
  'deleg.reviseDefault': ['src/delegation.ts', 'export function readRepairFromReply'],
  'closeout.report': ['src/closeout-report.ts', 'it opens no file for writing'],
  'closeout.scaffold': ['src/closeout.ts', 'export function closeoutPhase'],
  'closeout.lockedRefusal': ['src/closeout.ts', 'A CLOSEOUT MUST NOT SILENTLY UNLOCK ITS OWN ARTIFACT'],
  'closeout.prereq': ['src/closeout.ts', 'const blockers = getPrerequisiteBlockers(runDir, config.file)'],
  'training.evidence': ['src/training.ts', 'export function phase8MemoryEvidence'],
  'training.refusal': ['src/training.ts', 'export function phase8MemoryRefusal'],
  'settlement.seam': ['src/settlement.ts', "ctx.on('session/event'"],
  'policy.text': ['src/policy.ts', 'Writes to a Status: LOCKED phase doc are denied/asked; reopen explicitly to edit.'],
  'skills.phase': ['src/skills-phase.ts', 'export function registerPhaseSkills'],
  'tool.closeout': ['src/recursive_closeout.tool.ts', 'It NEVER writes the phase document'],
  'tool.closeoutPhase08': ['src/recursive_closeout.tool.ts', 'Phase 08 additionally fires the training trigger'],
  'tool.reviewRevise': ['src/recursive_review.tool.ts', 'When a round comes back REVISE the SAME child'],
  'tool.delegateNotJudge': ['src/recursive_delegate.tool.ts', 'and YOU remain the judge'],
  'tool.auditTeamApprove': ['src/recursive_audit_team.tool.ts', 'ONLY after an APPROVE verdict'],
  'tool.lockOrdering': ['src/recursive_lock.tool.ts', 'IT IS ATTACHED TO THE ORDERING REFUSAL SPECIFICALLY'],
  'tool.reopenParam': ['src/recursive_lock.tool.ts', 'reopen: { type:'],

  /* -- the memory plane, the read gate, and the cross-run training loop ---- */
  'memory.kinds': ['src/memory.ts', 'export const MEMORY_KINDS = ['],
  'memory.kindsWhy': ['src/memory.ts', '⚠ `training` IS IN THIS LIST BECAUSE IT IS THE KIND'],
  'memory.notRead': ['src/memory.ts', '`incidents/` and `archive/` stay out deliberately'],
  'memory.indexFile': ['src/memory.ts', 'export const MEMORY_INDEX_FILE'],
  'memory.planeBases': ['src/memory.ts', 'export const MEMORY_PLANE_BASES'],
  'memory.select': ['src/memory.ts', 'export function selectMemory'],
  'memory.retrieve': ['src/memory.ts', 'export function retrieveMemory'],
  'feedback.readReceipt': ['src/memory-feedback.ts', 'export function recordMemoryRead'],
  'feedback.source': ['src/memory-feedback.ts', 'export const MEMORY_READ_SOURCE'],
  'feedback.injections': ['src/memory-feedback.ts', 'export const INJECTIONS_FILE'],
  'feedback.empty': ['src/memory-feedback.ts', '`injected: false` is a SATISFIED read'],
  'feedback.settle': ['src/memory-feedback.ts', 'export function settleInjections'],
  'globs.memoryReadWhy': ['src/policy-globs.ts', 'THE MEMORY-READ GATE — the owner'],
  'globs.memoryReadRefuse': ['src/policy-globs.ts', 'WHAT IT REFUSES, exactly: a write to a PHASE-0 artifact'],
  'globs.memoryReadTrap': ['src/policy-globs.ts', 'AND THE TRAP THAT DECIDES THE WHOLE DESIGN'],
  'globs.hasMemoryRead': ['src/policy-globs.ts', 'function hasMemoryRead'],
  'rules.phase8Artifact': ['src/phase-rules.ts', 'export const PHASE8_MEMORY_ARTIFACT'],
  'rules.phase8Section': ['src/phase-rules.ts', 'export const PHASE8_MEMORY_SECTION'],
  'rules.provenanceField': ['src/phase-rules.ts', 'export const MEMORY_PROVENANCE_FIELD'],
  'training.phase8Artifact': ['src/training.ts', 'export const PHASE8_ARTIFACT'],
  'training.exit': ['src/training.ts', 'export const TRAINING_EXIT = {'],
  'training.lockedRuns': ['src/training.ts', 'export function countPhase8LockedRuns'],
  'training.gate': ['src/training.ts', 'export function trainingGate'],
  'training.anecdote': ['src/training.ts', 'ONE RUN IS NOT EVIDENCE — it is an anecdote'],
  'training.trigger': ['src/training.ts', 'export function runPhase8Trigger'],
  'training.rerun': ['src/training.ts', 'The trigger, run at the **RE-RUN** of closeout phase 08.'],
  'training.selfTrain': ['src/training.ts', 'training at the first lock would train the run on itself'],
  'training.extractorEnv': ['src/training.ts', 'export const TRAINING_EXTRACTOR_ENV'],
  'training.extractorUnset': ['src/training.ts', 'no extractor is available; set RECURSIVE_TRAINING_EXTRACTOR_CMD'],
  'training.noWriter': ['src/training.ts', 'ABSENT IS NOT SUCCESS: with no writer the groups are planned'],
  'training.domains': ['src/training.ts', "writes.push(options.write('memory/domains/'"],
  'training.taskType': ['src/training.ts', 'export function taskTypeShardPath'],
  'training.taskTypeWhy': ['src/training.ts', '`task-type` IS READ FROM THE GROUP'],
  'training.registry': ['src/training.ts', 'export function updateMemoryRegistry'],
  'training.registryLine': ['src/training.ts', 'export function registryLine'],
  'training.supersede': ['src/training.ts', 'AND A SHARD IS NEVER REMOVED HERE'],
  'training.evidenceWhy': ['src/training.ts', 'THE CHECKABLE FACT BEHIND'],
  'training.lockRefusal': ['src/training.ts', 'export function phase8MemoryLockRefusal'],
  'training.lockRefusalWhy': ['src/training.ts', 'A MISSING ARTIFACT IS NOT THIS GATE'],
  'training.refusalRemedy': ['src/training.ts', 'THE MESSAGE NAMES THE REMEDY'],
  'training.countField': ['src/training.ts', 'A lock is a FIELD, not a filename'],
  'runtime.phaseRead': ['src/runtime.ts', 'const selection = selectMemory(root, {'],
  'runtime.phaseReceipt': ['src/runtime.ts', 'recordMemoryRead(resolved.runDir, phase, {'],
  'runtime.phaseReceiptWhy': ['src/runtime.ts', 'AND RECORD THAT THE READ HAPPENED, EVEN WHEN IT RETURNED NOTHING'],
  'runtime.phasePayload': ['src/runtime.ts', 'memory: selection.injected ? renderMemorySection'],
  'runtime.rerunDetect': ['src/runtime.ts', 'const rerun = isPhase8 && existsSync('],
  'runtime.triggerCall': ['src/runtime.ts', '? runPhase8Trigger(root, runId, {'],
  'runtime.extractorSeam': ['src/runtime.ts', 'runner: spawnExtractorRunner({ cwd: root'],
  'runtime.trainingWrite': ['src/runtime.ts', 'T40 - WRITER/READER AGREEMENT'],
  'runtime.settle': ['src/runtime.ts', 'settleInjections(root, runDir, PHASE_SEQUENCE.filter'],
  'status.phases': ['src/status.ts', 'export const PHASES: PhaseDef[] = ['],
  'closeout.phaseConfig': ['src/closeout.ts', 'export const PHASE_CONFIG: Record<string, CloseoutPhaseConfig> = {'],
  'closeout.sectionBodies': ['src/closeout.ts', 'const SECTION_BODIES: Record<string, string> = {'],
  'tpl.scopeRequirements': ['src/init-templates.ts', 'Scope note: This document defines stable requirement identifiers and acceptance criteria.'],
  'tpl.scopeWorktree': ['src/init-templates.ts', 'Scope note: This document records the Phase 0 worktree context'],
  'tpl.scopeScaffold': ['src/init-templates.ts', 'Scope note: Scaffold generated by the recursive-mode plugin (R5).'],
  'plan.discovery': ['src/plan-gate.ts', 'Requirements / AS-IS / TO-BE-Plan are NON-MUTATING discovery'],
  'plan.discoveryRange': ['src/plan-gate.ts', 'Everything strictly below it (0 requirements, 1 AS-IS, 1.5 root cause,'],
  'stub.markers': ['src/runtime.ts', 'const ARTIFACT_STUB = {'],
  'lint.wildcard06': ['src/ts-lint.ts', "a !== '06-decisions-update.md'"],
  'lint.wildcard08': ['src/ts-lint.ts', "a !== '08-memory-impact.md'"],
  'lint.inputFilter': ['src/ts-lint.ts', 'return candidates.filter(a => present.has(a))'],
  /* The two facts behind JOB 1's "positive" statement and the late-set correction. */
  'lint.lateProfile': ['src/ts-lint.ts', 'LATE_PHASE_ARTIFACTS.some(a => existsSync'],
  'runtime.scaffoldLoop': ['src/runtime.ts', 'for (const file of laterPhases) {'],
  /* The SECOND optionality declaration, and the calculation that consumes it. */
  'status.optional': ['src/status.ts', "if (phase.optional && !state.exists) state.status = 'SKIPPED'"],
  'snapshot.complete': ['src/snapshot.ts', 'const mandatory = status.phases.filter(p => !p.optional)'],
}

/**
 * Anchors that legitimately appear MORE THAN ONCE, where citing the first would
 * be a half-truth. They are named here explicitly: the ambiguity guard still
 * fails on every other duplicate, so a surprise copy is still caught, but a
 * deliberate one is DECLARED and cited in full.
 */
const MULTI_HIT_ANCHORS = new Set(['policy.text'])

const sourceCache = new Map()
function sourceLines(rel) {
  if (!sourceCache.has(rel)) {
    const p = join(ROOT, ...rel.split('/'))
    if (!existsSync(p)) throw new Error('citation source missing: ' + rel)
    sourceCache.set(rel, readFileSync(p, 'utf8').split('\n'))
  }
  return sourceCache.get(rel)
}

/**
 * Resolve one anchor to `file:line`, or `file:a, file:b` for a declared
 * multi-hit anchor. Three properties matter:
 *   1. the file-relative path is ALWAYS part of the answer, so no citation can
 *      ever render as a bare line number;
 *   2. an UNDECLARED duplicate is a FAILURE, not a first-match: a second copy of a
 *      marker is a duplication symptom, and silently citing the first hides it;
 *   3. every resolved line is checked to lie inside the file it names.
 */
function anchor(key) {
  const entry = ANCHORS[key]
  if (!entry) throw new Error('unknown citation anchor: ' + key)
  const [rel, text] = entry
  const lines = sourceLines(rel)
  const hits = []
  for (let i = 0; i < lines.length; i += 1) if (lines[i].includes(text)) hits.push(i + 1)
  if (hits.length === 0) throw new Error('ANCHOR NOT FOUND — ' + key + ' ("' + text + '") in ' + rel)
  if (hits.length > 1 && !MULTI_HIT_ANCHORS.has(key)) {
    throw new Error('ANCHOR AMBIGUOUS (' + hits.length + ' hits, undeclared) — ' + key + ' ("' + text + '") in ' + rel
      + '. Either anchor on something unique, or declare it in MULTI_HIT_ANCHORS.')
  }
  return hits.map((n) => rel + ':' + n).join(', ')
}

/** `'a#1-3, b'` → `'file:1-3, file2:9'`. Ranges are checked against the real file length. */
function citeOf(spec) {
  return spec.split(',').map((raw) => {
    const part = raw.trim()
    const hash = part.indexOf('#')
    const key = hash < 0 ? part : part.slice(0, hash)
    const range = hash < 0 ? null : part.slice(hash + 1)
    const at = anchor(key)
    if (range === null) return at
    // A range needs ONE line to start from; a declared multi-hit anchor has several.
    if (at.includes(', ')) throw new Error('cannot take a line range from a multi-hit anchor: ' + spec)
    const file = at.slice(0, at.indexOf(':'))
    const start = Number(at.slice(at.indexOf(':') + 1))
    const [aRaw, bRaw] = range.split('-')
    const a = start + Number(aRaw) - 1
    const b = bRaw === undefined ? undefined : start + Number(bRaw) - 1
    if (!Number.isFinite(a)) throw new Error('bad range in citation spec: ' + spec)
    if (b !== undefined && b < a) throw new Error('backwards range in citation spec: ' + spec)
    if (b !== undefined && b > sourceLines(file).length) throw new Error('range past end of ' + file + ' in: ' + spec)
    return file + ':' + a + (b === undefined ? '' : '-' + b)
  }).join(', ')
}

/** All twelve SECTION_MAP anchors, declared by construction rather than by hand. */
const SECTION_FILES = ['00-worktree.md', '00-requirements.md', '01-as-is.md', '01.5-root-cause.md',
  '02-to-be-plan.md', '03-implementation-summary.md', '03.5-code-review.md', '04-test-summary.md',
  '05-manual-qa.md', '06-decisions-update.md', '07-state-update.md', '08-memory-impact.md']
for (const f of SECTION_FILES) ANCHORS['section.' + f] = ['src/phase-rules.ts', "  '" + f + "': ["]

/**
 * One anchor per tool, keyed by its own registered NAME. The anchor text IS the
 * `name:` literal, so a citation and the tool's identity cannot disagree — and
 * verify() re-reads each file to confirm the name it declares.
 */
const TOOL_FILES = [
  'recursive_status', 'recursive_init', 'recursive_lock', 'recursive_lint', 'recursive_closeout',
  'recursive_scratch', 'recursive_worktree', 'recursive_phase', 'recursive_review',
  'recursive_delegate', 'recursive_ask', 'recursive_preview', 'recursive_audit_team',
]
for (const tool of TOOL_FILES) ANCHORS['tool.' + tool] = ['src/' + tool + '.tool.ts', "name: '" + tool + "',"]

/** Resolved once. A typo in a key throws here, before anything renders. */
const SRC = {
  seq: citeOf('lock.sequence'),
  optional: citeOf('lock.optional'),
  lockHash: citeOf('lock.hash'),
  lockStatus: citeOf('lock.status'),
  receipts: citeOf('lock.receipts'),
  staleDownstream: citeOf('lock.staleDownstream'),
  staleAll: citeOf('lock.staleAll'),
  chainBreaks: citeOf('lock.chainBreaks'),
  validateChain: citeOf('lock.validateChain'),

  late: citeOf('rules.late'),
  audited: citeOf('rules.audited'),
  priorEvidence: citeOf('rules.priorEvidence'),
  diffAudited: citeOf('rules.diffAudited'),
  traceability: citeOf('rules.traceability'),
  auditHeadings: citeOf('rules.auditHeadings'),
  sectionMapRoot: citeOf('rules.sectionMapRoot'),
  memoryPlane: citeOf('rules.memoryPlane'),
  phase8Rule: citeOf('rules.phase8Rule'),
  memoryLocations: citeOf('rules.memoryLocations'),
  getSections: citeOf('rules.getSections'),
  reminderGate: citeOf('rules.reminderGate'),
  lintMessage: citeOf('rules.lintMessage'),
  narrowing: citeOf('rules.narrowing'),
  baseline: citeOf('rules.baseline'),
  verdictRank: citeOf('rules.verdictRank'),
  phaseNumber: citeOf('rules.phaseNumber'),
  ownMemoryPlane: citeOf('rules.ownMemoryPlane'),
  resolveFrom: citeOf('rules.resolveFrom'),

  inputMap: citeOf('lint.inputMap'),
  inputAddenda: citeOf('lint.inputAddenda'),
  effectiveInputs: citeOf('lint.effectiveInputs'),
  rereadPaths: citeOf('lint.rereadPaths'),
  lintSequence: citeOf('lint.sequence'),
  lintTdd: citeOf('lint.tddMode'),
  lintQa: citeOf('lint.qaMode'),
  lintQaSignoff: citeOf('lint.qaSignoff'),
  lintAuditContext: citeOf('lint.auditContext'),
  lintStale: citeOf('lint.staleBundle'),

  tplRequirements: citeOf('tpl.requirements'),
  tplWorktree: citeOf('tpl.worktree'),
  tplLater: citeOf('tpl.later'),

  lockArtifact: citeOf('runtime.lockArtifact'),
  blockers: citeOf('runtime.blockers'),
  quiescence: citeOf('runtime.quiescence'),
  memoryGate: citeOf('runtime.memoryGate'),
  lintGate: citeOf('runtime.lintGate'),
  lintRefusal: citeOf('runtime.lintRefusal'),
  reopen: citeOf('runtime.reopen'),
  staleInvalidate: citeOf('runtime.staleInvalidate'),

  toolsReg: citeOf('index.tools'),
  auditTeamReg: citeOf('index.auditTeam'),
  injects: citeOf('index.injects'),
  promptSection: citeOf('index.prompt'),
  preExecute: citeOf('index.preExecute'),
  guardRegister: citeOf('index.guardRegister'),
  planGate: citeOf('index.planGate'),
  fsObserved: citeOf('index.fsObserved'),
  sessionEvent: citeOf('index.sessionEvent'),
  preStep: citeOf('index.preStep'),
  webServer: citeOf('index.webServer'),
  guardLog: citeOf('index.guardLog'),
  denyText: citeOf('index.denyText'),
  blockGoal: citeOf('index.blockGoal'),

  hookPoints: citeOf('hooks.points'),
  hookGating: citeOf('hooks.gating'),
  hookObserving: citeOf('hooks.observing'),
  hookDowngrade: citeOf('hooks.downgrade'),
  hookFailure: citeOf('hooks.failure'),

  writeTools: citeOf('globs.writeTools'),
  lockTools: citeOf('globs.lockTools'),
  lockOrderRule: citeOf('globs.lockOrder'),
  lockedWriteRule: citeOf('globs.lockedWrite'),
  directChild: citeOf('globs.directChild'),
  phaseOrderRule: citeOf('globs.phaseOrder'),
  memoryReadRule: citeOf('globs.memoryRead'),
  builtInRules: citeOf('globs.builtIn'),
  attachPredicate: citeOf('globs.attach'),
  tddVerdict: citeOf('globs.tdd'),
  phaseOrderHole: citeOf('globs.phaseOrderHole'),
  phaseOrderAllow: citeOf('globs.phaseOrderAllow'),

  mode: citeOf('enf.mode'),
  modeDefault: citeOf('enf.default'),
  evaluate: citeOf('enf.evaluate'),
  verdictFor: citeOf('enf.verdictFor'),
  coerce: citeOf('enf.coerce'),
  consult: citeOf('enf.consult'),

  errRegistry: citeOf('err.registry'),
  errClasses: citeOf('err.classes'),
  errSpecUnfilled: citeOf('err.specUnfilled'),
  errUnanswered: citeOf('err.unanswered'),
  errNoChannel: citeOf('err.noChannel'),
  errPending: citeOf('err.pending'),

  startModule: citeOf('start.module'),
  startGate: citeOf('start.gate'),
  startLabels: citeOf('start.labels'),
  startLine: citeOf('start.line'),
  startApproval: citeOf('start.approval'),
  startValueMatch: citeOf('start.valueMatch'),
  startGuard: citeOf('start.guard'),
  startNotApproved: citeOf('start.notApproved'),
  startNotAGate: citeOf('start.notAGate'),

  askGates: citeOf('ask.gates'),
  askTdd: citeOf('ask.tdd'),
  askQa: citeOf('ask.qa'),
  askGateBlock: citeOf('ask.gateBlock'),
  askPayload: citeOf('ask.payload'),
  askRelayOnly: citeOf('ask.relayOnly'),
  askFixedArtifact: citeOf('ask.fixedArtifact'),

  reviewDriver: citeOf('review.driver'),
  reviewFailClosed: citeOf('review.failClosed'),
  teamsLoop: citeOf('teams.loop'),
  graphWhy: citeOf('graph.why'),
  graphBuild: citeOf('graph.build'),
  graphReach: citeOf('graph.reach'),
  graphNext: citeOf('graph.next'),
  graphBack: citeOf('graph.back'),
  graphAddendum: citeOf('graph.addendum'),
  graphBackEdgeWhy: citeOf('graph.backEdgeWhy'),
  graphVisited: citeOf('graph.visited'),
  delegVerdict: citeOf('deleg.verdict'),
  delegRevise: citeOf('deleg.reviseDefault'),
  closeoutReport: citeOf('closeout.report'),
  closeoutScaffold: citeOf('closeout.scaffold'),
  closeoutLocked: citeOf('closeout.lockedRefusal'),
  closeoutPrereq: citeOf('closeout.prereq'),
  trainingEvidence: citeOf('training.evidence'),
  trainingRefusal: citeOf('training.refusal'),
  settlementSeam: citeOf('settlement.seam'),
  policyText: citeOf('policy.text'),
  skillsPhase: citeOf('skills.phase'),
  toolCloseout: citeOf('tool.closeout'),
  toolCloseoutPhase08: citeOf('tool.closeoutPhase08'),
  toolReviewRevise: citeOf('tool.reviewRevise'),
  toolDelegateNotJudge: citeOf('tool.delegateNotJudge'),
  toolAuditTeamApprove: citeOf('tool.auditTeamApprove'),
  toolLockOrdering: citeOf('tool.lockOrdering'),
  toolReopenParam: citeOf('tool.reopenParam'),

  /* -- the memory plane ---------------------------------------------------- */
  memoryKinds: citeOf('memory.kinds'),
  memoryKindsWhy: citeOf('memory.kindsWhy'),
  memoryNotRead: citeOf('memory.notRead'),
  memoryIndexFile: citeOf('memory.indexFile'),
  memoryPlaneBases: citeOf('memory.planeBases'),
  memorySelect: citeOf('memory.select'),
  memoryRetrieve: citeOf('memory.retrieve'),
  readReceipt: citeOf('feedback.readReceipt'),
  readSource: citeOf('feedback.source'),
  injectionsFile: citeOf('feedback.injections'),
  emptyPlaneOk: citeOf('feedback.empty'),
  settleInjections: citeOf('feedback.settle'),
  memoryReadWhy: citeOf('globs.memoryReadWhy'),
  memoryReadRefuse: citeOf('globs.memoryReadRefuse'),
  memoryReadTrap: citeOf('globs.memoryReadTrap'),
  hasMemoryRead: citeOf('globs.hasMemoryRead'),
  phase8Artifact: citeOf('rules.phase8Artifact'),
  phase8Section: citeOf('rules.phase8Section'),
  provenanceField: citeOf('rules.provenanceField'),

  /* -- the cross-run training loop ----------------------------------------- */
  trainingExit: citeOf('training.exit'),
  trainingLockedRuns: citeOf('training.lockedRuns'),
  trainingGate: citeOf('training.gate'),
  trainingAnecdote: citeOf('training.anecdote'),
  trainingTrigger: citeOf('training.trigger'),
  trainingRerun: citeOf('training.rerun'),
  trainingSelfTrain: citeOf('training.selfTrain'),
  trainingExtractorEnv: citeOf('training.extractorEnv'),
  trainingExtractorUnset: citeOf('training.extractorUnset'),
  trainingNoWriter: citeOf('training.noWriter'),
  trainingDomains: citeOf('training.domains'),
  trainingTaskType: citeOf('training.taskType'),
  trainingTaskTypeWhy: citeOf('training.taskTypeWhy'),
  trainingRegistry: citeOf('training.registry'),
  trainingRegistryLine: citeOf('training.registryLine'),
  trainingSupersede: citeOf('training.supersede'),
  trainingEvidenceWhy: citeOf('training.evidenceWhy'),
  trainingLockRefusal: citeOf('training.lockRefusal'),
  trainingLockRefusalWhy: citeOf('training.lockRefusalWhy'),
  trainingRefusalRemedy: citeOf('training.refusalRemedy'),
  trainingCountField: citeOf('training.countField'),
  runtimePhaseRead: citeOf('runtime.phaseRead'),
  runtimePhaseReceipt: citeOf('runtime.phaseReceipt'),
  runtimePhaseReceiptWhy: citeOf('runtime.phaseReceiptWhy'),
  runtimePhasePayload: citeOf('runtime.phasePayload'),
  runtimeRerunDetect: citeOf('runtime.rerunDetect'),
  runtimeTriggerCall: citeOf('runtime.triggerCall'),
  runtimeExtractorSeam: citeOf('runtime.extractorSeam'),
  runtimeTrainingWrite: citeOf('runtime.trainingWrite'),
  runtimeSettle: citeOf('runtime.settle'),

  /* -- per-phase purpose, and the linkage ---------------------------------- */
  statusPhases: citeOf('status.phases'),
  closeoutPhaseConfig: citeOf('closeout.phaseConfig'),
  closeoutSectionBodies: citeOf('closeout.sectionBodies'),
  tplScopeRequirements: citeOf('tpl.scopeRequirements'),
  tplScopeWorktree: citeOf('tpl.scopeWorktree'),
  tplScopeScaffold: citeOf('tpl.scopeScaffold'),
  planDiscovery: citeOf('plan.discovery'),
  planDiscoveryRange: citeOf('plan.discoveryRange'),
  stubMarkers: citeOf('stub.markers'),
  lintWildcard06: citeOf('lint.wildcard06'),
  lintWildcard08: citeOf('lint.wildcard08'),
  inputFilter: citeOf('lint.inputFilter'),
  lintLateProfile: citeOf('lint.lateProfile'),
  scaffoldLoop: citeOf('runtime.scaffoldLoop'),
  statusOptional: citeOf('status.optional'),
  snapshotComplete: citeOf('snapshot.complete'),
}

/** The status.ts label lines for all twelve artifacts, resolved from the anchor. */
const STATUS_LABELS = citeOf('status.phases#1-13')

/** Declared SECTION_MAP list lengths — every one is re-derived from source in verify(). */
const SECTION_LENGTHS = {
  '00-worktree.md': 12, '00-requirements.md': 6, '01-as-is.md': 10, '01.5-root-cause.md': 12,
  '02-to-be-plan.md': 13, '03-implementation-summary.md': 8, '03.5-code-review.md': 10,
  '04-test-summary.md': 12, '05-manual-qa.md': 8, '06-decisions-update.md': 7,
  '07-state-update.md': 7, '08-memory-impact.md': 12,
}

/**
 * The section-map range for one artifact: its anchor's start line through the
 * declared LIST LENGTH, so the range moves with the file and is still checked
 * against it. The lengths are asserted against the parsed source in verify().
 */
function sectionsCite(file) {
  const at = citeOf('section.' + file)
  const f = at.slice(0, at.indexOf(':'))
  const start = Number(at.slice(at.indexOf(':') + 1))
  const len = SECTION_LENGTHS[file]
  if (!len) throw new Error('no declared section length for ' + file)
  const end = start + len - 1
  if (end > sourceLines(f).length) throw new Error('section range past end of ' + f + ' for ' + file)
  return f + ':' + start + '-' + end
}

/* ========================================================================== */
/* TOKENS — the single definition of the palette.                             */
/*                                                                            */
/* The CSS below is RENDERED FROM THIS OBJECT and the contrast audit READS IT, */
/* so a colour cannot be changed in one place and audited in the other. Every  */
/* value lives here once.                                                      */
/* ========================================================================== */

/* NOTE on the two *_INK values: they are SVG BOX FILLS, not text or state
   borders. A diagram region's fill owes no WCAG text contrast — what owes
   contrast is the LABEL on it, and every label is an audited pair below
   (warn on n-950 = 10.06:1, danger on n-950 = 8.55:1). They are listed as
   tokens so the "no hardcoded hex" check stays meaningful. */
const C = {
  'n-950': '#070a0c', 'n-900': '#0d1116', 'n-850': '#121820', 'n-800': '#18202a',
  'n-700': '#1f2933', 'n-600': '#5a6a80', 'n-500': '#55637a', 'n-400': '#7c8b9d',
  'n-300': '#8c9dad', 'n-200': '#adbccb', 'n-100': '#d2dce6', 'n-050': '#eaf0f6',
  acc: '#5fd0e8', 'acc-dim': '#1d4d59',
  warn: '#f0ab4d', 'warn-dim': '#5a3f14',
  danger: '#ff8877', 'danger-dim': '#5c2820',
  ok: '#7fd6a3', 'ok-dim': '#1c4632',
  violet: '#b9a7ff', 'violet-dim': '#3a3468',
  /* The SEQUENCE ORDER mark — the dotted link between adjacent nodes that carries NO
     artifact input. It is the only stroke in the chart that means "the order, not a
     dependency", so it must be visibly weaker than every edge, and it owes 3:1 as a
     non-text state mark. The first value tried was --n-700, which measured 1.25:1
     against the canvas: a mark a reader cannot see is not a mark. This one is 3.6:1
     and still reads as the quietest line in the picture. */
  'seq-dim': '#5b6e88',
  'warn-ink': '#1b1409', 'danger-ink': '#3a1310',
}

/**
 * The pairs that must satisfy WCAG, and the threshold each one owes.
 *
 * ⚠ EVERY TEXT PAIR IS HERE, and each owes 4.5:1 (WCAG 2.2 AA, 1.4.3). The 3:1
 * entries are 1.4.11 non-text contrast, and only for borders that carry STATE
 * (a tab's border, a tag's border). Decorative separators owe nothing — WCAG
 * exempts purely decorative presentation — and are listed with a threshold of 1
 * so the number is still REPORTED rather than quietly excluded. Writing a low
 * number down where nothing is owed is the point: an exemption that is stated
 * can be argued with; one that is silent cannot.
 */
const CONTRAST_REQUIREMENTS = [
  { fg: 'n-050', bg: 'n-950', need: 4.5, what: 'body text on the page canvas' },
  { fg: 'n-050', bg: 'n-900', need: 4.5, what: 'body text on a panel' },
  { fg: 'n-050', bg: 'n-850', need: 4.5, what: 'body text on a card' },
  { fg: 'n-050', bg: 'n-800', need: 4.5, what: 'text on the active tab / table head' },
  { fg: 'n-100', bg: 'n-850', need: 4.5, what: 'inline code on a card' },
  { fg: 'n-200', bg: 'n-850', need: 4.5, what: 'secondary text on a card' },
  { fg: 'n-200', bg: 'n-950', need: 4.5, what: 'pre-formatted text on the canvas' },
  { fg: 'n-300', bg: 'n-900', need: 4.5, what: 'muted text (subtitles, notes) on a panel' },
  { fg: 'n-300', bg: 'n-950', need: 4.5, what: 'muted text on the canvas' },
  { fg: 'n-400', bg: 'n-950', need: 4.5, what: 'the faintest caption — file:line citations' },
  { fg: 'n-400', bg: 'n-900', need: 4.5, what: 'faint caption inside a panel' },
  { fg: 'n-400', bg: 'n-850', need: 4.5, what: 'faint caption inside a card' },
  { fg: 'acc', bg: 'n-900', need: 4.5, what: 'accent text and links' },
  { fg: 'acc', bg: 'n-950', need: 4.5, what: 'accent text on the canvas' },
  { fg: 'acc', bg: 'n-850', need: 4.5, what: 'artifact names on a card' },
  { fg: 'warn', bg: 'n-900', need: 4.5, what: 'a DECISION label — amber' },
  { fg: 'warn', bg: 'n-950', need: 4.5, what: 'a DECISION label on the canvas / in the diagram' },
  { fg: 'warn', bg: 'n-850', need: 4.5, what: 'a DECISION label on a card' },
  { fg: 'danger', bg: 'n-900', need: 4.5, what: 'a REFUSAL label — red' },
  { fg: 'danger', bg: 'n-850', need: 4.5, what: 'a REFUSAL label on a card' },
  { fg: 'danger', bg: 'n-950', need: 4.5, what: 'a REFUSAL label in the diagram' },
  { fg: 'ok', bg: 'n-850', need: 4.5, what: 'an ABSTAIN/allow label — green' },
  { fg: 'ok', bg: 'n-900', need: 4.5, what: 'a passing label on a panel' },
  { fg: 'violet', bg: 'n-850', need: 4.5, what: 'a backward-edge label — violet' },
  { fg: 'violet', bg: 'n-900', need: 4.5, what: 'a backward-edge label on a panel' },
  { fg: 'warn-ink', bg: 'warn', need: 4.5, what: 'the skip link (dark ink on amber)' },
  { fg: 'danger-ink', bg: 'danger', need: 4.5, what: 'the focus ring drawn on a refusal surface' },
  { fg: 'n-600', bg: 'n-900', need: 3.0, what: 'a control border (tab, tag) made of the strong line' },
  { fg: 'n-600', bg: 'n-950', need: 3.0, what: 'that same control border on the canvas' },
  { fg: 'n-600', bg: 'n-850', need: 3.0, what: 'that same control border on a card' },
  { fg: 'n-500', bg: 'n-900', need: 3.0, what: 'the sequence rail dot — a state mark, not a hairline' },
  { fg: 'seq-dim', bg: 'n-950', need: 3.0, what: 'the dotted SEQUENCE-ORDER link in the overview chart — a state mark (this pair is adjacent in the order, and carries no input edge)' },
  { fg: 'n-700', bg: 'n-950', need: 1.0, what: 'the background grid line — DECORATIVE, no threshold owed' },
  { fg: 'warn-dim', bg: 'n-950', need: 1.0, what: 'the amber rule border — decorative; the label beside it is the signal' },
  { fg: 'danger-dim', bg: 'n-950', need: 1.0, what: 'the refusal rule border — decorative, same reasoning' },
  { fg: 'warn-ink', bg: 'n-950', need: 1.0, what: 'the human box fill in the diagram — a region, not a signal' },
  { fg: 'danger-ink', bg: 'n-950', need: 1.0, what: 'the refusal box fill — a region, not a signal' },
]

function srgbToLinear(channel) {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
function luminance(hex) {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b)
  const hi = Math.max(la, lb), lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}
const tone = (name) => `#${C[name].replace('#', '')}`

/* ========================================================================== */
/* FACTS — transcribed from src/, each carrying its citation                  */
/* ========================================================================== */

const REPO = 'dsh-recursive-mode'

/** `lock.ts:21` PHASE_SEQUENCE — the canonical order, and the node order of the graph. */
const PHASES = [
  {
    file: '00-requirements.md',
    c: SRC.seq,
    phaseN: '0',
    human: true,
    late: false,
    audited: false,
    optional: false,
    traceability: false,
    kind: 'Requirements spec',
    inputs: [{ doc: 'the conversation / the issue', c: SRC.tplRequirements, artifact: false }],
    outputs: [{ doc: '00-requirements.md', c: SRC.tplRequirements, artifact: true }],
    gates: [
      { t: 'HUMAN GATE — `run-start`. Nothing runs and no goal exists until recursive_ask gate=run-start records the approving label.', c: SRC.startGate, human: true, shape: 'decision' },
      { t: 'The gate refuses to be RAISED while `00-requirements.md` is still the scaffold template (RM4404), quoting the placeholder lines back.', c: SRC.startGuard, human: true, shape: 'refuse' },
      { t: 'Approving label `Start run`; withholding label `Hold`. The approving VALUE is what is matched — a recorded `Hold` is not consent.', c: SRC.startLabels + ', ' + SRC.startValueMatch, human: true, shape: 'decision' },
      { t: 'The approval is written as a durable `- Run Start: Start run` line in this very artifact.', c: SRC.startLine, human: true, shape: 'decision' },
      { t: '`syncRunGoal` refuses to create a run goal without that record, in EVERY branch that would create one.', c: SRC.startModule, human: true, shape: 'refuse' },
      { t: 'Coverage gate must read PASS; Approval gate must read PASS.', c: sectionsCite('00-requirements.md'), human: true, shape: 'gate' },
      { t: 'GUARD RULE `memory-read` — the FIRST write to a phase-0 artifact is denied until this run holds a memory READ RECEIPT for it. It reads the RECEIPT, never the artifact text, because a caller controls the text and could forge it; an empty memory plane satisfies the gate, a never-entered phase does not. `recursive_phase` is the call that records the read.', c: SRC.memoryReadRule, human: false, shape: 'refuse' },
    ],
    sections: ['TODO', 'Requirements', 'Out of Scope', 'Constraints', 'Coverage Gate', 'Approval Gate'],
    sectionsC: sectionsCite('00-requirements.md'),
    questions: [],
    refusals: ['RM4404 RUN_START_SPEC_UNFILLED — no run spec to approve', 'RM5502 RUN_START_NO_CHANNEL — no user-questions channel mounted', 'RM5503 RUN_START_UNANSWERED — the channel failed before a person answered', 'RM5504 RUN_START_ANSWER_UNUSABLE — a person answered, off-vocabulary', 'memory-read — no memory read receipt for this run, so the requirements artifact cannot be written yet'],
  },
  {
    file: '00-worktree.md',
    c: SRC.seq,
    phaseN: '0',
    human: false,
    late: false,
    audited: false,
    optional: false,
    traceability: false,
    kind: 'Isolation + diff basis',
    inputs: [
      { doc: '00-requirements.md', c: SRC.inputMap, artifact: true },
      { doc: 'current git repository state', c: SRC.tplWorktree, artifact: false },
    ],
    outputs: [{ doc: '00-worktree.md', c: SRC.tplWorktree, artifact: true }],
    gates: [
      { t: 'Shares phase number 0 with `00-requirements.md` — the phase-order guard treats both as the active phase.', c: SRC.phaseOrderRule, human: false, shape: 'gate' },
      { t: 'Supplies the executable diff basis every later audited phase reuses; the linter fails until the normalized basis matches live git state.', c: SRC.tplWorktree, human: false, shape: 'gate' },
      { t: 'Coverage + Approval gates.', c: sectionsCite('00-worktree.md'), human: false, shape: 'gate' },
    ],
    sections: ['TODO', 'Directory Selection', 'Safety Verification', 'Worktree Creation', 'Main Branch Protection', 'Project Setup', 'Test Baseline Verification', 'Worktree Context', 'Diff Basis For Later Audits', 'Traceability', 'Coverage Gate', 'Approval Gate'],
    sectionsC: sectionsCite('00-worktree.md'),
    questions: [],
    refusals: ['`write*` outside the run tree (phases 6-8 only)', 'lock-order: an earlier PRESENT artifact is not LOCKED'],
  },
  {
    file: '01-as-is.md',
    c: SRC.seq,
    phaseN: '1',
    human: false,
    late: false,
    audited: true,
    optional: true,
    traceability: true,
    priorEvidence: true,
    kind: 'AS-IS characterization',
    inputs: [{ doc: '00-requirements.md', c: SRC.inputMap, artifact: true }],
    outputs: [{ doc: '01-as-is.md', c: SRC.tplLater, artifact: true }],
    gates: [
      { t: 'AUDITED phase: requires `Audit: PASS`, `## Requirement Completion Status`, and a Delegation Decision Basis / Subagent Capability Probe marker.', c: 'src/lifecycle.ts:99-105', human: false, shape: 'gate' },
      { t: 'Coverage + Approval gates; `## Effective Inputs Re-read` is required of every phase doc.', c: 'src/lifecycle.ts:117', human: false, shape: 'gate' },
      { t: 'Reads PRIOR recursive evidence (in a profile that carries it).', c: SRC.priorEvidence, human: false, shape: 'gate' },
      { t: 'The phase baseline DENIES writes to `.recursive/memory/**`, `DECISIONS.md`, `STATE.md` in phases 1-2.', c: SRC.baseline, human: false, shape: 'refuse' },
      { t: 'Declared OPTIONAL: an absent optional phase does not stop the run.', c: SRC.optional + ', ' + SRC.graphNext, human: false, shape: 'gate' },
    ],
    sections: ['TODO', 'Reproduction Steps (Novice-Runnable)', 'Current Behavior by Requirement', 'Source Requirement Inventory', 'Relevant Code Pointers', 'Known Unknowns', 'Evidence', 'Traceability', 'Coverage Gate', 'Approval Gate'],
    sectionsC: sectionsCite('01-as-is.md'),
    sectionsExtraC: SRC.getSections,
    questions: [],
    refusals: ['phase-order: a LATER phase artifact is written while this phase is still active', 'locked-write: the target carries `Status: LOCKED`', 'lock-order: a prerequisite is not LOCKED', 'phase 1-2 memory-plane write denial'],
  },
  {
    file: '01.5-root-cause.md',
    c: SRC.seq,
    phaseN: '1',
    human: false,
    late: false,
    audited: true,
    optional: true,
    traceability: true,
    kind: 'Root-cause analysis',
    inputs: [{ doc: '01-as-is.md', c: SRC.inputMap, artifact: true }],
    outputs: [{ doc: '01.5-root-cause.md', c: SRC.tplLater, artifact: true }],
    gates: [
      { t: 'Shares phase number 1 with `01-as-is.md` — `phaseNumberForArtifact` takes the leading digits, so both are phase 1.', c: SRC.phaseNumber + ', ' + SRC.phaseOrderRule, human: false, shape: 'gate' },
      { t: 'AUDITED phase (same requirement as 01).', c: SRC.audited + ', src/lifecycle.ts:99-105', human: false, shape: 'gate' },
      { t: 'Optional; absent-and-optional is skipped by the legal-phase selector.', c: SRC.optional + ', ' + SRC.graphNext, human: false, shape: 'gate' },
      { t: 'Its presence changes what phase 2 must cite as input.', c: SRC.inputMap, human: false, shape: 'gate' },
    ],
    sections: ['TODO', 'Error Analysis', 'Reproduction Verification', 'Recent Changes Analysis', 'Evidence Gathering (Multi-Layer if applicable)', 'Data Flow Trace', 'Pattern Analysis', 'Hypothesis Testing', 'Root Cause Summary', 'Traceability', 'Coverage Gate', 'Approval Gate'],
    sectionsC: sectionsCite('01.5-root-cause.md'),
    sectionsExtraC: SRC.getSections,
    questions: [],
    refusals: ['Same guard set as 01.', 'lock-order: `01-as-is.md` present but not LOCKED'],
  },
  {
    file: '02-to-be-plan.md',
    c: SRC.seq,
    phaseN: '2',
    human: false,
    late: false,
    audited: true,
    optional: true,
    traceability: true,
    priorEvidence: true,
    kind: 'TO-BE plan',
    inputs: [
      { doc: '00-requirements.md', c: SRC.inputMap, artifact: true },
      { doc: '01-as-is.md', c: SRC.inputMap, artifact: true },
      { doc: '01.5-root-cause.md — only when present', c: SRC.inputMap, artifact: true },
    ],
    outputs: [{ doc: '02-to-be-plan.md', c: SRC.tplLater, artifact: true }],
    gates: [
      { t: 'AUDITED + `Requirement Mapping` / `Plan Drift Check` sections.', c: sectionsCite('02-to-be-plan.md') + ', src/lifecycle.ts:99-105', human: false, shape: 'gate' },
      { t: 'Diff-audited: the run diff is audited against this plan.', c: SRC.diffAudited, human: false, shape: 'gate' },
      { t: 'Reads PRIOR recursive evidence.', c: SRC.priorEvidence, human: false, shape: 'gate' },
      { t: 'PLAN GATE at the plan-mode exit: `exit_plan_mode` is DENIED while the run still waits on a discovery phase.', c: SRC.planGate, human: false, shape: 'refuse' },
      { t: 'Phase 2 memory-plane write denial (phases 1-2).', c: SRC.baseline, human: false, shape: 'refuse' },
    ],
    sections: ['TODO', 'Planned Changes by File', 'Requirement Mapping', 'Implementation Steps', 'Testing Strategy', 'Playwright Plan (if applicable)', 'Manual QA Scenarios', 'Idempotence and Recovery', 'Implementation Sub-phases', 'Plan Drift Check', 'Traceability', 'Coverage Gate', 'Approval Gate'],
    sectionsC: sectionsCite('02-to-be-plan.md'),
    sectionsExtraC: SRC.getSections,
    questions: [],
    refusals: ['`exit_plan_mode` refused by the `exit-plan-mode-gate` hook (priority 5)', 'phase-order / locked-write / lock-order', 'phase 1-2 memory-plane write denial'],
  },
  {
    file: '03-implementation-summary.md',
    c: SRC.seq,
    phaseN: '3',
    human: false,
    late: false,
    audited: true,
    optional: true,
    traceability: true,
    tdd: true,
    kind: 'Implementation + TDD evidence',
    inputs: [{ doc: '02-to-be-plan.md', c: SRC.inputMap, artifact: true }],
    outputs: [{ doc: '03-implementation-summary.md', c: SRC.tplLater, artifact: true }],
    gates: [
      { t: 'HUMAN GATE — `tdd-mode`. `recursive_ask` labels `strict` / `pragmatic` are written to the `TDD Mode` marker.', c: SRC.askTdd, human: true, shape: 'decision' },
      { t: 'TDD gate: `strict` requires RED **and** GREEN evidence paths to exist on disk.', c: 'src/lifecycle.ts:84-96', human: false, shape: 'gate' },
      { t: 'Guard rule `tdd-evidence`: the phase-3 baseline DENIES `recursive_lock*` while the artifact declares `TDD Mode: strict` without both RED and GREEN.', c: SRC.baseline + ', ' + SRC.tddVerdict, human: false, shape: 'refuse' },
      { t: '`pragmatic` requires an exception rationale (`## Pragmatic TDD Exception`).', c: 'src/lifecycle.ts:91-92', human: false, shape: 'gate' },
      { t: 'Diff-audited; reads PRIOR recursive evidence.', c: SRC.diffAudited + ', ' + SRC.priorEvidence, human: false, shape: 'gate' },
    ],
    sections: ['TODO', 'Changes Applied', 'TDD Compliance Log', 'Plan Deviations', 'Implementation Evidence', 'Traceability', 'Coverage Gate', 'Approval Gate'],
    sectionsC: sectionsCite('03-implementation-summary.md'),
    sectionsExtraC: SRC.getSections,
    questions: [{ gate: 'tdd-mode', header: 'TDD Mode', q: 'How should phase 3 handle test evidence?', opts: ['strict — RED and GREEN evidence paths are required before the phase can lock', 'pragmatic — a written rationale is accepted in place of evidence paths'], c: SRC.askTdd }],
    refusals: ['`tdd-evidence`: lock denied without RED + GREEN when `TDD Mode: strict`', 'phase-order / locked-write / lock-order', 'PENDING_WORK (RM4403): unresolved delegated work blocks the lock'],
  },
  {
    file: '03.5-code-review.md',
    c: SRC.seq,
    phaseN: '3',
    human: false,
    late: false,
    audited: true,
    optional: true,
    traceability: true,
    kind: 'Independent code review',
    inputs: [
      { doc: '02-to-be-plan.md', c: SRC.inputMap, artifact: true },
      { doc: '03-implementation-summary.md', c: SRC.inputMap, artifact: true },
    ],
    outputs: [{ doc: '03.5-code-review.md', c: SRC.tplLater, artifact: true }],
    gates: [
      { t: 'Shares phase number 3 with the implementation summary.', c: SRC.phaseNumber, human: false, shape: 'gate' },
      { t: 'Carries its own `## Verdict` section — the APPROVE / REVISE / REJECT vocabulary lives here.', c: sectionsCite('03.5-code-review.md'), human: false, shape: 'gate' },
      { t: 'AUDITED + diff-audited.', c: SRC.audited + ', ' + SRC.diffAudited, human: false, shape: 'gate' },
      { t: 'A review bundle whose recorded artifact hash no longer matches the artifact is reported STALE.', c: SRC.lintStale, human: false, shape: 'gate' },
    ],
    sections: ['TODO', 'Review Scope', 'Plan Alignment Assessment', 'Code Quality Assessment', 'Issues Found', 'Verdict', 'Review Metadata', 'Traceability', 'Coverage Gate', 'Approval Gate'],
    sectionsC: sectionsCite('03.5-code-review.md'),
    sectionsExtraC: SRC.getSections,
    questions: [],
    refusals: ['Same guard set as 03.', 'A REVISE verdict routes to a repair follow-up rather than a lock — see the loop section.'],
  },
  {
    file: '04-test-summary.md',
    c: SRC.seq,
    phaseN: '4',
    human: false,
    late: false,
    audited: true,
    optional: true,
    traceability: true,
    priorEvidence: true,
    closeout: true,
    kind: 'Test evidence',
    inputs: [
      { doc: '02-to-be-plan.md', c: SRC.inputMap, artifact: true },
      { doc: '03-implementation-summary.md', c: SRC.inputMap, artifact: true },
      { doc: '03.5-code-review.md — only when present', c: SRC.inputMap, artifact: true },
    ],
    outputs: [{ doc: '04-test-summary.md', c: SRC.closeoutScaffold + ', ' + SRC.tplLater, artifact: true }],
    gates: [
      { t: 'CLOSEOUT ENTRY — `recursive_closeout` REPORTS what this artifact is missing (required sections, Coverage/Approval gates). It never writes the phase document.', c: SRC.toolCloseout + ', ' + SRC.closeoutReport, human: false, shape: 'gate' },
      { t: 'A closeout refuses when an earlier artifact is not LOCKED, because scaffolding a receipt over a DRAFT is the defect closeout-report.ts exists to prevent.', c: SRC.closeoutPrereq, human: false, shape: 'refuse' },
      { t: 'A closeout REFUSES to run against an artifact that is already LOCKED (it must not silently unlock its own artifact).', c: SRC.closeoutLocked, human: false, shape: 'refuse' },
      { t: 'AUDITED; reads PRIOR recursive evidence; exact commands and evidence must be recorded.', c: SRC.audited + ', ' + SRC.priorEvidence, human: false, shape: 'gate' },
    ],
    sections: ['TODO', 'Pre-Test Implementation Audit', 'Environment', 'Execution Mode', 'Commands Executed (Exact)', 'Results Summary', 'Evidence and Artifacts', 'Failures and Diagnostics (if any)', 'Flake/Rerun Notes', 'Traceability', 'Coverage Gate', 'Approval Gate'],
    sectionsC: sectionsCite('04-test-summary.md'),
    sectionsExtraC: SRC.getSections,
    questions: [],
    refusals: ['closeout: unsupported phase key', 'closeout: an earlier artifact is not LOCKED', 'closeout: the artifact is already LOCKED', 'lock-order / locked-write / phase-order'],
  },
  {
    file: '05-manual-qa.md',
    c: SRC.seq,
    phaseN: '5',
    human: true,
    late: false,
    audited: false,
    optional: true,
    traceability: true,
    closeout: true,
    kind: 'Manual QA + sign-off',
    inputs: [{ doc: '02-to-be-plan.md', c: SRC.inputMap, artifact: true }],
    outputs: [{ doc: '05-manual-qa.md', c: SRC.closeoutScaffold + ', ' + SRC.tplLater, artifact: true }],
    gates: [
      { t: 'HUMAN GATE — `qa-signoff`. `recursive_ask` labels `human` / `agent-operated` / `hybrid` are written to the `QA Execution Mode` marker.', c: SRC.askQa, human: true, shape: 'decision' },
      { t: '`human` and `hybrid` REQUIRE user sign-off before the lock; the sign-off needs a meaningful `Approved by` and `Date`.', c: 'src/lifecycle.ts:108-114, ' + SRC.lintQaSignoff, human: true, shape: 'decision' },
      { t: '`agent-operated` requires a named Agent Executor and Tools Used.', c: SRC.lintQa, human: false, shape: 'gate' },
      { t: 'The QA mode must be declared at all — an undeclared mode was a lock failure. (Note the two spellings: `05-manual-qa.md` is NOT in AUDITED_PHASE_FILES, but it IS in the linter\'s AUDITED_REQUIREMENT_FILES set at ts-lint.ts:60.)', c: 'src/lifecycle.ts:110', human: false, shape: 'gate' },
      { t: 'CLOSEOUT ENTRY: report-only, with a receipt of its own.', c: SRC.toolCloseout, human: false, shape: 'gate' },
    ],
    sections: ['TODO', 'QA Execution Record', 'QA Scenarios and Results', 'Evidence and Artifacts', 'User Sign-Off', 'Traceability', 'Coverage Gate', 'Approval Gate'],
    sectionsC: sectionsCite('05-manual-qa.md'),
    questions: [{ gate: 'qa-signoff', header: 'QA sign-off', q: 'Who signs off the manual QA phase?', opts: ['human — a person runs and signs the QA checklist', 'agent-operated — the agent runs it and records the results', 'hybrid — the agent runs it; a person signs the result'], c: SRC.askQa }],
    refusals: ['`QA Execution Mode human|hybrid requires user sign-off`', 'closeout prerequisite / already-LOCKED refusals', 'lock-order / locked-write / phase-order'],
  },
  {
    file: '06-decisions-update.md',
    c: SRC.seq,
    phaseN: '6',
    human: false,
    late: true,
    audited: true,
    optional: false,
    traceability: true,
    closeout: true,
    kind: 'Decision ledger delta',
    inputs: [{ doc: 'every present artifact in the run except itself', c: SRC.inputMap, artifact: true }],
    outputs: [
      { doc: '06-decisions-update.md', c: SRC.closeoutScaffold + ', ' + SRC.tplLater, artifact: true },
      { doc: '.recursive/DECISIONS.md — the ledger this phase updates', c: SRC.closeoutScaffold, artifact: false },
    ],
    gates: [
      { t: 'LATE phase (`LATE_PHASE_ARTIFACTS`).', c: SRC.late, human: false, shape: 'gate' },
      { t: 'Phase baseline DENIES `write*` outside the run tree: the implementation is frozen in phases 6-8.', c: SRC.baseline, human: false, shape: 'refuse' },
      { t: 'Phase baseline DENIES `write*` to the memory planes in phase 6 — `.recursive/DECISIONS.md`, `STATE.md` and `.recursive/memory/**` are earned by their own phases.', c: SRC.baseline, human: false, shape: 'refuse' },
      { t: 'AUDITED + closeout report-only entry.', c: SRC.audited + ', ' + SRC.toolCloseout, human: false, shape: 'gate' },
    ],
    sections: ['TODO', 'Decisions Changes Applied', 'Rationale', 'Resulting Decision Entry', 'Traceability', 'Coverage Gate', 'Approval Gate'],
    sectionsC: sectionsCite('06-decisions-update.md'),
    sectionsExtraC: SRC.getSections,
    questions: [],
    refusals: ['phase 6: `write*` outside the run tree denied', 'phase 6: `write*` to `.recursive/DECISIONS.md|STATE.md` / `.recursive/memory/**` denied', 'lock-order / locked-write / phase-order'],
  },
  {
    file: '07-state-update.md',
    c: SRC.seq,
    phaseN: '7',
    human: false,
    late: true,
    audited: true,
    optional: false,
    traceability: true,
    priorEvidence: true,
    closeout: true,
    kind: 'State ledger delta',
    inputs: [{ doc: '06-decisions-update.md', c: SRC.inputMap, artifact: true }],
    outputs: [
      { doc: '07-state-update.md', c: SRC.closeoutScaffold + ', ' + SRC.tplLater, artifact: true },
      { doc: '.recursive/STATE.md — the ledger this phase updates', c: SRC.closeoutScaffold, artifact: false },
    ],
    gates: [
      { t: 'LATE phase.', c: SRC.late, human: false, shape: 'gate' },
      { t: 'Denies `write*` outside the run tree, and `write*` to the memory planes.', c: SRC.baseline, human: false, shape: 'refuse' },
      { t: 'AUDITED + reads PRIOR recursive evidence + closeout report-only entry.', c: SRC.audited + ', ' + SRC.priorEvidence, human: false, shape: 'gate' },
    ],
    sections: ['TODO', 'State Changes Applied', 'Rationale', 'Resulting State Summary', 'Traceability', 'Coverage Gate', 'Approval Gate'],
    sectionsC: sectionsCite('07-state-update.md'),
    sectionsExtraC: SRC.getSections,
    questions: [],
    refusals: ['phase 7: `write*` outside the run tree denied', 'phase 7: `write*` to the memory planes denied', 'lock-order / locked-write / phase-order'],
  },
  {
    file: '08-memory-impact.md',
    c: SRC.seq,
    phaseN: '8',
    human: false,
    late: true,
    audited: true,
    optional: false,
    traceability: true,
    priorEvidence: true,
    closeout: true,
    memoryGate: true,
    kind: 'Durable memory promotion',
    inputs: [
      { doc: 'every present artifact in the run except itself', c: SRC.inputMap, artifact: true },
      { doc: 'the final run diff under `.recursive/memory/`, which phase 8 OWNS', c: SRC.phase8Rule, artifact: false },
    ],
    outputs: [
      { doc: '08-memory-impact.md', c: SRC.closeoutScaffold + ', ' + SRC.tplLater, artifact: true },
      { doc: 'at least one doc under `.recursive/memory/` carrying `Source-Runs: <this-run-id>`', c: SRC.memoryPlane + ', ' + SRC.phase8Rule, artifact: false },
    ],
    gates: [
      { t: 'HARD PHASE-8 MEMORY GATE, checked at lock: the artifact must DECLARE a path under `.recursive/memory/` in `## Affected Memory Docs`, the path must EXIST, and the doc on disk must carry `Source-Runs` naming THIS run.', c: SRC.trainingEvidence + ', ' + SRC.phase8Rule, human: false, shape: 'refuse' },
      { t: 'A closed-out phase 08 also fires the training trigger.', c: SRC.toolCloseoutPhase08, human: false, shape: 'gate' },
      { t: 'The phase-8 write baseline uses a NARROWER predicate than phases 6-7: `.recursive/memory/**` is admitted, `DECISIONS.md` / `STATE.md` are NOT, and an unresolvable target stays denied.', c: SRC.baseline + ', ' + SRC.ownMemoryPlane, human: false, shape: 'refuse' },
      { t: 'Declares its own `## Run-Local Skill Usage Capture` and `## Skill Memory Promotion Review` sections.', c: sectionsCite('08-memory-impact.md'), human: false, shape: 'gate' },
    ],
    sections: ['TODO', 'Diff Basis', 'Changed Paths Review', 'Affected Memory Docs', 'Run-Local Skill Usage Capture', 'Skill Memory Promotion Review', 'Uncovered Paths', 'Router and Parent Refresh', 'Final Status Summary', 'Traceability', 'Coverage Gate', 'Approval Gate'],
    sectionsC: sectionsCite('08-memory-impact.md'),
    sectionsExtraC: SRC.getSections,
    questions: [],
    refusals: ['phase8-memory-missing: lock denied until a doc under `.recursive/memory/` carries this run\'s `Source-Runs`', 'phase 8: `write*` outside the run tree denied (except the memory plane)', 'lock-order / locked-write / phase-order'],
  },
]

/** The three-late-phase set, as its own row so the overview can call it out. */
const LATE = { files: ['06-decisions-update.md', '07-state-update.md', '08-memory-impact.md'], c: SRC.late }

/* ==========================================================================
   WHAT EACH PHASE IS FOR — one line each, SOURCED, never written
   ==========================================================================

   The owner read the first version of this page and said the graphic "lists phases
   one after another without showing ... what each phase does". This is the answer to
   that half, and the rule for it is the page's own rule: every line below is drawn
   from the repository, and the repository is quoted rather than paraphrased.

   THREE SOURCES EXIST, and they are not equally strong, so each line declares which
   ones it used:

     · `label` — the phase's own name, from `PHASES` in `src/status.ts`. The repo's
       vocabulary for the phase, and what its own artifacts are stamped with.
     · `sections` — required sections from `SECTION_MAP` in `src/phase-rules.ts`. THE
       STRONGEST EVIDENCE THERE IS for what a phase is for: a phase that must contain
       `## Root Cause Summary` and `## Hypothesis Testing` is a root-cause phase, and
       that is a fact about the linter rather than a description of it. verify()
       re-derives every named section from the parsed map, so a renamed or deleted
       section is a FAILING CHECK rather than a stale sentence.
     · `tpl` — the phase TEMPLATE's own prose, from `src/init-templates.ts`. This
       exists for exactly two phases. Every later phase's template carries the SAME
       generic line (`tplScopeScaffold`), so there is no per-phase prose in the code
       to transcribe for 01-08 — which the Phase graph view says out loud instead of
       inventing one.

   ⚠ FOR PHASES 04-08 A FOURTH SOURCE EXISTS and is NOT used as the purpose line:
   `PHASE_CONFIG[...].scopeNote` in `src/closeout.ts` describes what the CLOSEOUT
   scaffolds for that phase ("Scaffolds the audited test-summary receipt from …"),
   which is the receipt's job rather than the phase's. It is cited where it belongs —
   on the Closeout view — and not stretched to cover this. */
const PURPOSES = {
  '00-requirements.md': {
    t: 'Defines the stable requirement identifiers (R1, R2, …) and the acceptance criteria the whole run is measured against.',
    label: 'Requirements',
    sections: ['Requirements', 'Out of Scope', 'Constraints'],
    tpl: SRC.tplScopeRequirements,
    tplText: 'This document defines stable requirement identifiers and acceptance criteria.',
  },
  '00-worktree.md': {
    t: 'Records the isolation and the EXECUTABLE diff basis that every later audited phase reuses.',
    label: 'Worktree',
    sections: ['Directory Selection', 'Safety Verification', 'Diff Basis For Later Audits'],
    tpl: SRC.tplScopeWorktree,
    tplText: 'This document records the Phase 0 worktree context and the executable diff basis that all later audited phases must reuse.',
  },
  '01-as-is.md': {
    t: 'Characterises the code AS IT IS — reproduction steps, current behaviour per requirement, and the source requirement inventory — and changes nothing.',
    label: 'AS-IS',
    sections: ['Reproduction Steps (Novice-Runnable)', 'Current Behavior by Requirement', 'Source Requirement Inventory'],
    extra: SRC.planDiscovery,
  },
  '01.5-root-cause.md': {
    t: 'Establishes WHY the current behaviour is what it is, from error analysis through hypothesis testing to a root-cause summary.',
    label: 'Root Cause',
    sections: ['Error Analysis', 'Hypothesis Testing', 'Root Cause Summary'],
  },
  '02-to-be-plan.md': {
    t: 'Plans the change TO BE: the files to change, the implementation steps and testing strategy, and the mapping from each requirement to the plan.',
    label: 'TO-BE Plan',
    sections: ['Planned Changes by File', 'Implementation Steps', 'Testing Strategy', 'Requirement Mapping'],
  },
  '03-implementation-summary.md': {
    t: 'Applies the plan and records the evidence for it — changes applied, the TDD compliance log, and every deviation from the plan.',
    label: 'Implementation',
    sections: ['Changes Applied', 'TDD Compliance Log', 'Plan Deviations', 'Implementation Evidence'],
  },
  '03.5-code-review.md': {
    t: 'Reviews the implementation independently and returns a VERDICT: plan alignment, code quality, and the issues found.',
    label: 'Code Review',
    sections: ['Review Scope', 'Plan Alignment Assessment', 'Code Quality Assessment', 'Verdict'],
  },
  '04-test-summary.md': {
    t: 'Records the test evidence: the environment, the exact commands run, their results, and any failures or reruns.',
    label: 'Test Summary',
    sections: ['Commands Executed (Exact)', 'Results Summary', 'Failures and Diagnostics (if any)', 'Flake/Rerun Notes'],
  },
  '05-manual-qa.md': {
    t: 'Runs the manual QA scenarios and records what was observed, plus the sign-off the declared QA mode requires.',
    label: 'Manual QA',
    sections: ['QA Execution Record', 'QA Scenarios and Results', 'User Sign-Off'],
  },
  '06-decisions-update.md': {
    t: 'Writes the decision-ledger DELTA for the completed run, pointing at the entry it changed.',
    label: 'Decisions',
    sections: ['Decisions Changes Applied', 'Resulting Decision Entry', 'Rationale'],
  },
  '07-state-update.md': {
    t: 'Writes the state-ledger DELTA for the completed run, as the resulting state summary.',
    label: 'State',
    sections: ['State Changes Applied', 'Resulting State Summary', 'Rationale'],
  },
  '08-memory-impact.md': {
    t: 'Reviews the run\'s changed paths against the memory plane and promotes what is durable into it — the phase that turns a run into memory.',
    label: 'Memory',
    sections: ['Affected Memory Docs', 'Changed Paths Review', 'Router and Parent Refresh', 'Skill Memory Promotion Review'],
  },
}

/** Resolve one purpose's citation: the section list, the status label table, and any extra source. */
function purposeCite(p) {
  const parts = [p.sectionsC, STATUS_LABELS]
  if (p.tpl) parts.push(p.tpl)
  if (p.extra) parts.push(p.extra)
  return parts.join(', ')
}
for (const phase of PHASES) {
  const purpose = PURPOSES[phase.file]
  if (!purpose) throw new Error('no declared purpose for ' + phase.file)
  purpose.sectionsC = sectionsCite(phase.file)
  purpose.c = purposeCite(purpose)
  phase.purpose = purpose
}

/* ==========================================================================
   THE LINKAGE — the edges, DERIVED from the phase data, VERIFIED against the linter
   ==========================================================================

   `getPhaseExpectedInputArtifactNames` (src/ts-lint.ts) is the linter's own input map,
   and it is what decides which upstream artifacts a phase must cite before it can lock.
   It is therefore the only honest source for "how the phases are wired" — and it is a
   GRAPH, not a chain: five phases read more than one upstream artifact.

   THE EDGES ARE DERIVED FROM `PHASES[].inputs`, not typed in twice: the input column on
   every phase panel and the arrows on the graph view are then the same data, and a change
   to one cannot leave the other behind. verify() re-derives the whole set from
   `src/ts-lint.ts` and compares it to what is rendered, so the drawing fails the build if
   the linter's map moves.

   THREE EDGE SHAPES, and the difference is in the DRAWING as well as the data:
     · required     — the artifact is always an expected input (a solid arrow);
     · conditional  — pushed only when the source artifact is PRESENT on disk
                      (`candidates.push(…)`, a dashed arrow, labelled "when present");
     · wildcard     — "every present artifact in the run except itself": 06 and 08 read
                      the whole run, which is 11 possible sources each, and no single one
                      of them is required. Drawn as a RAIL under the row rather than as
                      eleven arrows, because eleven lines into one node is the picture
                      that stops being readable — and the rail's count is verified. */
const WILDCARD_INPUT = 'every present artifact in the run except itself'
const edgeKind = (doc) => (/ — only when present$/.test(doc) ? 'conditional'
  : doc === WILDCARD_INPUT ? 'wildcard' : 'required')
const EDGES = PHASES.flatMap((p) => p.inputs
  .filter((input) => input.artifact)
  .map((input) => ({
    from: input.doc.replace(/ — only when present$/, ''),
    to: p.file,
    kind: edgeKind(input.doc),
    c: input.c,
  })))

/** How many artifacts a wildcard input can actually name: every other member of the run. */
const WILDCARD_SOURCES = PHASES.length - 1

/** Incoming artifact count for one phase, with the wildcard counted as what it really is. */
function sourcesOf(file) {
  return EDGES.filter((edge) => edge.to === file)
    .reduce((n, edge) => n + (edge.kind === 'wildcard' ? WILDCARD_SOURCES : 1), 0)
}
const fanInOf = (file) => EDGES.filter((edge) => edge.to === file).length
const conditionalFanIn = (file) => EDGES.filter((edge) => edge.to === file && edge.kind === 'conditional').length
const hasWildcard = (file) => EDGES.some((edge) => edge.to === file && edge.kind === 'wildcard')

/** The one-line fan-in a phase node carries, in the diagram and in the table. */
function fanInText(file) {
  if (fanInOf(file) === 0) return 'no upstream artifact'
  if (hasWildcard(file)) return 'fan-in ' + WILDCARD_SOURCES + ' · all present'
  const cond = conditionalFanIn(file)
  return 'fan-in ' + sourcesOf(file) + (cond ? ' · ' + cond + ' when-present' : '')
}

/* ==========================================================================
   THE TRAINING LOOP — the cross-run cycle, as data
   ==========================================================================

   This is the part the page did not show at all, and it is the reason the plugin
   exists: a run's memory is what the NEXT run reads. Every step and every gate below
   is transcribed from `src/runtime.ts`, `src/training.ts`, `src/memory.ts`,
   `src/memory-feedback.ts` and `src/policy-globs.ts`, with the citation on the row.

   ⚠ THE THREE GATES ARE REFUSALS, NOT FOOTNOTES, and each one STOPS A DIFFERENT STEP:
     · the receipt gate  — stops the FIRST WRITE of a run (the memory-read guard rule);
     · the phase-8 gate  — stops a LOCK (phase8MemoryLockRefusal inside lockArtifact);
     · the ≥2-runs gate  — stops the EXTRACTION (trainingGate, exit 3);
     · the extractor gate — stops the EXTRACTION (exit 2), a different failure.
   A fifth thing that is not a gate is drawn as one anyway because it stops the step just
   as firmly: the FIRST lock extracts nothing, on purpose, because a run that trained on
   itself would promote its own accidents to rules. */
const TRAINING = {
  kinds: ['domains', 'patterns', 'episodes', 'training', 'skills'],
  notRead: ['incidents', 'archive'],
  steps: [
    {
      t: 'recursive_phase — PHASE ENTRY',
      lines: [
        'reads .recursive/memory/{domains,patterns,',
        'episodes,training,skills} — MEMORY_KINDS',
        'returns `memory` + `memoryReason` to the caller',
        'incidents/ and archive/ are NOT read',
      ],
      c: SRC.memoryKinds + ', ' + SRC.runtimePhaseRead + ', ' + SRC.runtimePhasePayload + ', ' + SRC.memoryNotRead,
    },
    {
      t: 'recordMemoryRead — the READ RECEIPT',
      lines: [
        'one receipt per phase, REPLACED not appended',
        'injected: false when the plane had nothing to say',
        'an EMPTY plane therefore SATISFIES the gate',
      ],
      c: SRC.readReceipt + ', ' + SRC.emptyPlaneOk + ', ' + SRC.readSource,
    },
    {
      t: 'write 00-requirements.md — GATED',
      lines: ['the FIRST phase-0 write of the run is refused', 'until the receipt above exists'],
      gate: 'receipt',
      c: SRC.memoryReadWhy + ', ' + SRC.memoryReadRefuse,
    },
    {
      t: 'phases 1 → 7, then LOCK 08-memory-impact.md — GATED',
      lines: ['refused unless this run WROTE a doc under', '.recursive/memory/ carrying Source-Runs'],
      gate: 'phase8',
      c: SRC.trainingLockRefusal + ', ' + SRC.provenanceField + ', ' + SRC.memoryGate,
    },
    {
      t: 'recursive_closeout --phase 08 — RE-RUN ONLY',
      lines: ['detected from the receipt that already exists', 'the FIRST lock extracts nothing, by design'],
      gate: 'first-lock',
      c: SRC.runtimeRerunDetect + ', ' + SRC.trainingRerun + ', ' + SRC.runtimeTriggerCall,
    },
    {
      t: 'trainingGate — ≥ 2 LOCKED runs',
      lines: ['counts runs whose phase-8 artifact carries', 'a `Status: LOCKED` FIELD'],
      gate: 'two-runs',
      c: SRC.trainingGate + ', ' + SRC.trainingCountField + ', ' + SRC.trainingLockedRuns,
    },
    {
      t: 'the EXTRACTOR — RECURSIVE_TRAINING_EXTRACTOR_CMD',
      lines: ['set from the environment; the plugin embeds none', 'spawned with stdio ignored, answering by file'],
      gate: 'extractor',
      c: SRC.trainingExtractorEnv + ', ' + SRC.runtimeExtractorSeam,
    },
    {
      t: 'writes the plane, then REGISTERS it',
      lines: [
        'memory/training/<task-type>.md',
        'memory/domains/<subsystem>.md',
        'memory/MEMORY.md — one line per shard, replaced',
      ],
      gate: 'no-writer',
      c: SRC.trainingDomains + ', ' + SRC.trainingTaskType + ', ' + SRC.trainingRegistry + ', ' + SRC.trainingRegistryLine,
    },
  ],
  gates: {
    receipt: {
      head: 'REFUSAL — guard rule `memory-read`',
      lines: [
        '"<file>: no memory read is recorded for phase 0',
        'of this run" — a DENY from the write guard,',
        'decided from the RECEIPT and never from the',
        'artifact text, which a caller could forge.',
      ],
      fix: 'Recovery: call recursive_phase once. One call.',
      c: SRC.memoryReadRefuse + ', ' + SRC.memoryReadTrap,
    },
    phase8: {
      head: 'REFUSAL — phase8-memory-missing',
      lines: [
        '"locking 08-memory-impact.md requires this run',
        'to have WRITTEN a doc under .recursive/memory/"',
        'checked IN lockArtifact: declared path, exists,',
        'and carries Source-Runs naming THIS run.',
      ],
      fix: 'A citing shard the run merely READ is not a write.',
      c: SRC.trainingLockRefusal + ', ' + SRC.trainingEvidenceWhy + ', ' + SRC.trainingRefusalRemedy,
    },
    'first-lock': {
      head: 'SKIP — not a refusal',
      lines: [
        '"phase 08 has not been re-run for <run>, so',
        'nothing is extracted yet (training at the first',
        'lock would train the run on itself)" — exit 0,',
        'writes: [].',
      ],
      fix: 'So the cycle is cross-run by construction.',
      c: SRC.trainingSelfTrain + ', ' + SRC.trainingRerun,
    },
    'two-runs': {
      head: 'STOP — exit 3 INSUFFICIENT_EVIDENCE',
      lines: [
        '"extraction needs at least two phase-8-locked',
        'runs and found N; one run is an anecdote, not',
        'evidence" — writes: [] on every failure path.',
      ],
      fix: 'Run the workflow twice before expecting training.',
      c: SRC.trainingAnecdote + ', ' + SRC.trainingExit + ', ' + SRC.trainingGate,
    },
    extractor: {
      head: 'STOP — exit 2 EXTRACTOR_UNAVAILABLE',
      lines: [
        '"no extractor is available; set',
        'RECURSIVE_TRAINING_EXTRACTOR_CMD or pass a',
        'response file. Do not claim memory updates"',
      ],
      fix: 'A configured command with no runner is exit 2 too.',
      c: SRC.trainingExtractorUnset + ', ' + SRC.trainingExit,
    },
    'no-writer': {
      head: 'NO WRITES — asserted, not promised',
      lines: [
        '"planned N group(s) … but NO writer was supplied,',
        'so no memory file was written and the plan alone',
        'is not a learning" — `writes` is EMPTY on every',
        'failure path.',
      ],
      fix: 'And with no registry reader the refresh is reported too.',
      c: SRC.trainingNoWriter + ', ' + SRC.trainingTrigger,
    },
  },
}


/* -- the DSH seams this plugin attaches to --------------------------------- */

const SEAMS = [
  { seam: '`ctx.tools.register(...)`', when: 'plugin apply, once per composition', act: 'registers 12 of the 13 `recursive_*` tools eagerly; `recursive_audit_team` only when `agentTeams` is present.', c: SRC.toolsReg, ref: false },
  { seam: '`ctx.inject([\'agentTeams\'])`', when: 'when the service appears (or immediately if already mounted)', act: 'lates the 13th tool, `recursive_audit_team`, into a catalogue that otherwise ships twelve.', c: SRC.auditTeamReg, ref: false },
  { seam: '`ctx.inject([\'subagents\'])` / `[\'llm\']` / `[\'userQuestions\']`', when: 'when each optional service appears', act: 'late-attaches the continuable-subagent seam, the LLM inventory, and the blocking human-question channel the `run-start` gate asks through.', c: SRC.injects, ref: false },
  { seam: '`systemPrompt.section({ name: \'recursive:policy\', order: 55 })`', when: 'every prompt render', act: 'renders the workspace policy + current-phase contract from the filesystem fold — read-only, zero session-event emission.', c: SRC.promptSection + ', ' + SRC.policyText, ref: false },
  { seam: '`on(\'tools/pre-execute\')`', when: 'before EVERY tool call is dispatched', act: 'resolves the root and the active run id per call, runs the `pre_trigger` hook chain, then returns the guard decision verbatim (a refusal becomes `Error: <reason>` in the caller\'s text).', c: SRC.preExecute, ref: true },
  { seam: '`on(\'fs/observed\')`', when: 'after every successful write, synchronously', act: 'OBSERVE ONLY — records a lock tamper into the guard log. Contractually cannot veto and must not throw.', c: SRC.fsObserved, ref: false },
  { seam: '`on(\'session/event\')`', when: 'every committed session event', act: 'captures a delegated child\'s settlement at delivery time and files it into the run (or adopts it when nobody filed it).', c: SRC.sessionEvent + ', ' + SRC.settlementSeam, ref: false },
  { seam: '`on(\'agent/pre-step\')`', when: 'before each agent step', act: 'repairs the scaffold once per root, then injects THIS phase\'s lint rules at most once per phase, only while the phase doc is DRAFT.', c: SRC.preStep + ', ' + SRC.reminderGate, ref: false },
  { seam: '`ctx.skills.register` / `ctx.skills.registerProvider`', when: 'plugin apply', act: 'publishes each phase\'s rules as a `recursive-phase-<slug>` skill and the packaged `recursive-mode` skill.', c: SRC.skillsPhase, ref: false },
  { seam: '`ctx.on(\'commands\')` → `/recursive`', when: 'plugin apply', act: 'the `/recursive` slash command (status, memory, and the run verbs).', c: 'src/commands.ts:265', ref: false },
  { seam: '`webServer.register` (mountOnce-global)', when: 'plugin apply, when a webServer is composed', act: 'the live board route (HTTP state + SSE). No-op headless.', c: SRC.webServer, ref: false },
]

/** The plugin's OWN hook registry: five named points mapped onto the seams above. */
const HOOKS = [
  { point: 'pre_turn', maps: '`agent/pre-step`, before `next()`', gating: true, policy: 'fail_closed', registered: [], c: SRC.hookPoints + ', ' + SRC.hookGating },
  { point: 'pre_generate', maps: 'the policy section callback', gating: true, policy: 'fail_closed', registered: [], c: SRC.hookPoints + ', ' + SRC.hookGating },
  { point: 'post_generate', maps: 'a post-step listener — OBSERVE ONLY', gating: false, policy: 'fail_open', registered: [], c: SRC.hookPoints + ', ' + SRC.hookObserving },
  { point: 'pre_trigger', maps: '`tools/pre-execute`', gating: true, policy: 'fail_closed', registered: ['`builtin-tool-guard` (priority 0, onError fail_closed)', '`exit-plan-mode-gate` (priority 5, onError fail_closed)'], c: SRC.hookPoints + ', ' + SRC.guardRegister + ', ' + SRC.planGate },
  { point: 'post_trigger', maps: '`tools/post-execute`', gating: false, policy: 'fail_open', registered: [], c: SRC.hookPoints + ', ' + SRC.hookObserving },
]

/* -- guards, with the exact reason strings --------------------------------- */

const GUARDS = [
  { k: 'guard rule `lock-order`', what: 'monotonic lock-order: an earlier phase must be locked first', on: '`recursive_lock*`', mode: 'deny; `advisory` downgrades to ask→allow-with-warning', c: SRC.lockOrderRule, modeC: SRC.verdictFor + ', ' + SRC.coerce },
  { k: 'guard rule `locked-write`', what: 'locked-artifact write denial: the target carries Status: LOCKED', on: 'the write-tool family (8 names)', mode: 'deny; advisory as above', c: SRC.lockedWriteRule + ', ' + SRC.writeTools, modeC: SRC.verdictFor },
  { k: 'guard rule `phase-order`', what: 'phase order: only one phase may be active at a time - the active phase must be locked before a later phase artifact is written', on: 'the write-tool family', mode: 'deny under `strict`; under `advisory` an ask, which the live path coerces to an allow-WITH-WARNING. ABSTAINS for the active artifact, an earlier phase, another run, and any support file.', c: SRC.phaseOrderRule, modeC: SRC.verdictFor },
  { k: 'guard rule `memory-read`', what: 'memory read gate: memory must be read before the requirements artifact that defines the run is written', on: 'the write-tool family', mode: 'deny under `strict`; advisory makes it an allow-WITH-WARNING, never a silent allow and never a block. LAST of the three rules that share the write-tool patterns, deliberately: it is the narrowest, and the other two must keep their labels on the cases they already own. Decided from the READ RECEIPT, never from the artifact text — which a caller controls and could therefore forge.', c: SRC.memoryReadRule, modeC: SRC.verdictFor },
  { k: 'guard rule `tdd-evidence`', what: 'TDD Mode: strict requires RED + GREEN evidence before locking Phase 3', on: '`recursive_lock*` in phase 3 only (a phase baseline rule)', mode: 'deny', c: SRC.baseline + ', ' + SRC.tddVerdict, modeC: '' },
  { k: 'catch-all', what: 'no deny rule matches this tool', on: '`*`', mode: 'allow — and every `deny` is listed before it, which is what makes "deny wins over allow" a fact about the list', c: SRC.builtInRules, modeC: '' },
  { k: 'phase 6/7/8 baseline', what: 'phase N is a documentation phase: writes outside the run tree are denied (the implementation is frozen)', on: '`write*`', mode: 'deny — phase 8 admits `.recursive/memory/**` through a narrower predicate; an unplaceable target stays denied', c: SRC.baseline, modeC: SRC.ownMemoryPlane },
  { k: 'phase 6/7 baseline', what: 'phase N writes no memory plane: .recursive/DECISIONS.md|STATE.md and .recursive/memory/** are written by their own phases', on: '`write*`', mode: 'deny', c: SRC.baseline, modeC: '' },
  { k: 'phase 1/2 baseline', what: 'phase N writes no memory plane: .recursive/memory/** and .recursive/DECISIONS.md|STATE.md are earned at phases 6-8', on: '`write*`', mode: 'deny', c: SRC.baseline, modeC: '' },
]

/** The lock chain, in the order lockArtifact actually applies it. */
const LOCK_CHAIN = [
  { n: '1', t: 'Artifact exists', d: '`Artifact not found: <artifact>`', c: SRC.lockArtifact },
  { n: '2', t: 'Not already locked', d: '`Artifact already LOCKED: <artifact>`', c: SRC.lockArtifact },
  { n: '3', t: 'LOCK ORDER — prerequisites', d: '`Prerequisite blockers: <a> (<STATUS>), …` and the run goal is blocked with `code: prerequisite-blockers`', c: SRC.blockers },
  { n: '4', t: 'QUIESCENCE — no unresolved delegation', d: 'RM4403 `PENDING_WORK`', c: SRC.quiescence + ', ' + SRC.errPending },
  { n: '5', t: 'PHASE-8 MEMORY GATE', d: '`locking 08-memory-impact.md requires this run to have WRITTEN a doc under .recursive/memory/: …` and the goal is blocked with `code: phase8-memory-missing`', c: SRC.memoryGate + ', ' + SRC.trainingRefusal },
  { n: '6', t: 'STANDARD — the linter, placed last', d: '`Artifact <a> does not meet the phase standard, so it was not locked: <FAIL list>`; a lint that could not run returns `passed: false`, so "not measured" is not a pass', c: SRC.lintGate },
  { n: '7', t: 'Write Status/LockedAt/LockHash + receipt', d: 'authoritative-before/after SHA-256 over LF-normalized content with `LockHash:` lines stripped', c: SRC.lockArtifact + ', ' + SRC.lockHash },
  { n: '8', t: 'Receipt written', d: '`<run>/locks/<stem>.receipt.json` — artifact_hash, locked_at, prerequisite_hashes, previous_receipt_hash, receipt_hash', c: SRC.receipts },
]

/** The backward edges. */
const LOOPS = [
  {
    n: 'B1',
    title: 'REVISE → repair follow-up to the SAME child',
    what: 'A review round that comes back REVISE delivers a repair instruction to the SAME continuable child, whose working context is intact, and the driver waits for the re-submission. The verdict is read from `reply.md` FAIL-CLOSED: prose, an empty reply or an off-vocabulary answer becomes REVISE with a repair instruction, never a false APPROVE.',
    c: SRC.reviewDriver + ', ' + SRC.reviewFailClosed + ', ' + SRC.delegRevise + ', ' + SRC.toolReviewRevise,
  },
  {
    n: 'B2',
    title: 'The teams task board: re-audit the SAME task',
    what: '`createTask` (pending) → `claim` (in_progress) → audit round → on REVISE `updateTask(edit, repair)` → re-audit the SAME task → on APPROVE `updateTask(complete)` → lock. A REJECT or the round cap RELEASES the task and fails loud: a lock NEVER happens before an APPROVE verdict.',
    c: SRC.teamsLoop + ', ' + SRC.toolAuditTeamApprove,
  },
  {
    n: 'B3',
    title: 'reopen — the run goes BACKWARDS in the sequence',
    what: '`recursive_lock` with `reopen: true` reverts a LOCKED artifact to DRAFT, invalidates every reachable downstream receipt, and re-arms the run goal. It is the ONE genuinely destructive operation, so it carries a deterministic operation id and refuses a recognised repeat.',
    c: SRC.toolReopenParam + ', ' + SRC.staleInvalidate + ', ' + SRC.reopen + ', ' + SRC.staleDownstream,
  },
  {
    n: 'B4',
    title: 'Stale downstream receipts — the graph remembers',
    what: 'A receipt records each prerequisite\'s hash at lock time. If an upstream artifact changes afterwards, the downstream phase is reported stale: `prerequisite \'<a>\' hash changed`, or `prerequisite \'<a>\' content changed since lock at <t>`, or `prerequisite \'<a>\' no longer exists`.',
    c: SRC.staleDownstream + ', ' + SRC.staleAll,
  },
  {
    n: 'B5',
    title: 'HUMAN ROUTE — `gate-block`: fix | reopen | abandon',
    what: 'A refused lock is a decision a person resolves. The refusal carries the three labels: `fix` (return to the phase and satisfy the gate), `reopen` (reopen an earlier locked artifact and repair it there), `abandon` (stop the run). The same payload is built in ONE place so the guard refusal and the tool refusal offer the same choice.',
    c: SRC.askGateBlock + ', ' + SRC.askPayload + ', ' + SRC.blockGoal,
  },
  {
    n: 'B6',
    title: 'Back-edges are first-class, and the graph is modelled as a graph',
    what: 'An `upstream-gap` addendum legitimately points at a LATER artifact — the gap was found downstream and must be closed upstream. `buildPhaseGraph` carries `addendum` edges in either direction and `backEdges()` reports them; a depth-first walk with a VISITED set is what makes reachability terminate over a cyclic graph.',
    c: SRC.graphBackEdgeWhy + ', ' + SRC.graphAddendum + ', ' + SRC.graphReach + ', ' + SRC.graphBack,
  },
  {
    n: 'B7',
    title: 'Rule 3: an early unlocked node can be blocked by a LATER one',
    what: '`nextLegalPhase` skips a LOCKED node, skips an ABSENT-and-OPTIONAL node, and then — if the first survivor has a prerequisite that is not LOCKED — returns `null`, NOT the next node. With a back-edge this is where "continue" and "blocked" give different answers, and only `null` is correct.',
    c: SRC.graphNext,
  },
]

/** The 13 tools, name + declared purpose, read from the definitions. */
const TOOLS = [
  { n: 'recursive_status', p: 'Show the folded status of a recursive-mode run: phase table, current phase, lock validity.', c: citeOf('tool.recursive_status'), reg: 'eager', note: '' },
  { n: 'recursive_init', p: 'Scaffold a new run directory (or ensure an existing one) with stub artifact headers. THIS DOES NOT START THE RUN: no goal exists until the user approves phase 0 through recursive_ask gate=run-start.', c: citeOf('tool.recursive_init'), reg: 'eager', note: 'Carries `runStartApproval` in its result — read it and ask.' },
  { n: 'recursive_lock', p: 'Lock a DRAFT artifact: writes Status: LOCKED, LockedAt, LockHash and validates prerequisites (monotonic phase gating). With `reopen: true`, reopen a locked artifact back to DRAFT (invalidates downstream receipts).', c: citeOf('tool.recursive_lock'), reg: 'eager', note: 'The gate the whole chain funnels through; its reopen parameter is cited at ' + SRC.toolReopenParam + '.' },
  { n: 'recursive_lint', p: 'Lint a run artifact for phase-specific issues (gates, TODO, traceability, diff audit). The result is bounded: when findings are clipped, `elided` says how many and how to see the rest.', c: citeOf('tool.recursive_lint'), reg: 'eager', note: 'The authority on the standard that `recursive_lock` consults.' },
  { n: 'recursive_closeout', p: 'REPORT what a closeout phase artifact is missing (Phase 4-8): it reads the artifact, lists the required sections and gates that are absent, and records a closeout receipt of its own. It NEVER writes the phase document.', c: citeOf('tool.recursive_closeout'), reg: 'eager', note: 'Phase 08 additionally fires the training trigger when it has been closed out before.' },
  { n: 'recursive_scratch', p: 'Read, write, or append the run-scoped disposable scratchpad (scratch/scratch.md or scratch/scratch.ts). Scratch is git-ignored and never citable as an Input.', c: citeOf('tool.recursive_scratch'), reg: 'eager', note: '' },
  { n: 'recursive_worktree', p: 'Create a linked git worktree for a run and/or promote a branch up the dev/stage/main chain.', c: citeOf('tool.recursive_worktree'), reg: 'eager', note: '' },
  { n: 'recursive_phase', p: 'Return the lint rules + instructions for the current phase (required sections, gates, TDD/QA notes). Call once when entering a new phase; the same rules are also auto-injected once per phase transition.', c: citeOf('tool.recursive_phase'), reg: 'eager', note: '' },
  { n: 'recursive_review', p: 'Run or resume an INDEPENDENT review of the current phase artifact with a durable continuable subagent. It reports an outcome (approved | rejected | unavailable) or that the review is still running. Never locks anything itself.', c: citeOf('tool.recursive_review'), reg: 'eager', note: 'This is the REVISE → repair edge.' },
  { n: 'recursive_delegate', p: 'Delegate the WORK of a phase to a durable continuable subagent: it produces the content and writes its submission to reply.md, and YOU remain the judge. It never writes the artifact and never locks anything.', c: citeOf('tool.recursive_delegate'), reg: 'eager', note: 'Reports submitted | reviewing | unavailable.' },
  { n: 'recursive_ask', p: 'Ask a human gate as a structured decision (tdd-mode, qa-signoff, gate-block), or ASK TO START A RUN (run-start: nothing runs, and no goal exists, until this gate is approved).', c: citeOf('tool.recursive_ask'), reg: 'eager', note: 'The gate is refused while the Phase 0 document is still the unfilled template.' },
  { n: 'recursive_preview', p: 'Show what the enforcement contract will do BEFORE it fires: the rendered policy prefix and its digest, the current phase\'s required sections and gates, the next legal transition, and the guard rule a probe tool call would match. Read-only, no model call.', c: citeOf('tool.recursive_preview'), reg: 'eager', note: '' },
  { n: 'recursive_audit_team', p: 'Advance one agentTeams Task-board transition for the recursive audit loop (create → claim → edit(REVISE) → complete(APPROVE) → release/interrupt). Complete the task (and lock the phase) ONLY after an APPROVE verdict.', c: citeOf('tool.recursive_audit_team'), reg: 'conditional', note: 'Registered only when the composition mounts ctx.agentTeams — a composition without it offers twelve tools, not thirteen. ' + SRC.auditTeamReg + '.' },
]

/** Every numbered code, with its class group and the gate it belongs to. */
const ERRORS = [
  { code: 'RM1101', k: 'input', p: 'runId is required', where: 'every run-scoped tool' },
  { code: 'RM1102', k: 'input', p: 'artifact is required', where: '`recursive_lock`, `recursive_lint`' },
  { code: 'RM1103', k: 'input', p: 'phase and runId are required', where: '`recursive_closeout`' },
  { code: 'RM1104', k: 'input', p: 'action, runId and target are all required', where: '`recursive_scratch`' },
  { code: 'RM1105', k: 'input', p: 'runId is required for create', where: '`recursive_worktree`' },
  { code: 'RM1106', k: 'input', p: 'fromBranch and toBranch are required for promote', where: '`recursive_worktree`' },
  { code: 'RM1107', k: 'input', p: 'runId is not a single directory name', where: 'init / lock / closeout / scratch / worktree / phase — refused BEFORE any directory is made' },
  { code: 'RM1141', k: 'input', p: 'the requested human gate is not one of tdd-mode, qa-signoff or gate-block', where: '`recursive_ask`' },
  { code: 'RM1142', k: 'input', p: 'the answer is not one of the labels the gate offered', where: '`recursive_ask`' },
  { code: 'RM1143', k: 'input', p: 'this gate has no default artifact, so one must be named', where: '`recursive_ask` (gate-block)' },
  { code: 'RM1144', k: 'input', p: 'probeArguments is not a JSON object', where: '`recursive_preview`' },
  { code: 'RM1150', k: 'input', p: 'relay applies only to the run-start gate', where: '`recursive_ask`' },
  { code: 'RM2201', k: 'value', p: 'target must be md or ts', where: '`recursive_scratch`' },
  { code: 'RM2202', k: 'value', p: 'action must be create | promote | status', where: '`recursive_worktree`' },
  { code: 'RM3301', k: 'workspace', p: 'this session is not attached to a registered workspace', where: 'the workspace-root resolution every tool shares' },
  { code: 'RM4401', k: 'state', p: 'no recursive run exists in this workspace', where: '`recursive_status`, `recursive_review`, `recursive_delegate`' },
  { code: 'RM4402', k: 'state', p: 'no current recursive phase could be determined', where: '`recursive_phase`, `recursive_review`, `recursive_delegate`' },
  { code: 'RM4403', k: 'state', p: 'the run has unresolved delegated work, so this phase cannot lock yet', where: 'the lock chain, step 4 (QUIESCENCE)' },
  { code: 'RM4404', k: 'state', p: 'the Phase 0 requirements document is still the unfilled template, so there is no run spec for a person to approve', where: 'the `run-start` gate (`runStartSpecGuard`)' },
  { code: 'RM5501', k: 'runtime', p: 'the recursive runtime refused the operation', where: 'the wrapper `codeRuntimeRefusal` puts around a bare thrown message' },
  { code: 'RM5502', k: 'runtime', p: 'the run-start gate needs an answer, and this composition mounts no user-questions channel', where: '`recursive_ask gate=run-start`' },
  { code: 'RM5503', k: 'runtime', p: 'the run-start question reached no decision: the mounted channel failed before a person answered it', where: '`recursive_ask gate=run-start` — relayable with `relay=true`, except cancellation/abort/timeout' },
  { code: 'RM5504', k: 'runtime', p: 'a person was asked to start this run and their answer was not one of the labels offered', where: '`recursive_ask gate=run-start` — NOT relayable' },
  { code: 'RM6601', k: 'capability', p: 'the agent-teams service is not available in this composition', where: '`recursive_audit_team`' },
]

/** Pre-step lint rules message, verbatim in shape. */
const PRESTEP = {
  lines: [
    '<system-reminder>',
    'Recursive-mode phase lint rules for THIS phase (<artifact>):',
    'Required sections: <this phase\'s list, joined by " | ">',
    'Gates: Coverage: FAIL until all checkboxes pass; Approval: FAIL until user sign-off; lock only via recursive_lock (monotonic).',
    'Audited phases: end with Audit: PASS before setting Coverage/Approval PASS; record Audit Context and Audit Verdict.',
    'TDD (phase 3): declare TDD Mode: strict|pragmatic; strict requires RED + GREEN evidence paths.',
    'QA (phase 5): declare QA Execution Mode: human|agent-operated|hybrid; human/hybrid need user sign-off.',
    'Memory write (phase 8, HARD): <the PHASE8_MEMORY_WRITE_RULE.summary sentence>',
    '</system-reminder>',
  ],
  c: SRC.lintMessage,
  gate: 'Injected at most ONCE per (root, runId, phase), and only while the phase doc\'s status is DRAFT.',
  gateC: SRC.preStep + ', ' + SRC.reminderGate,
}

/* ========================================================================== */
/* RENDER                                                                     */
/* ========================================================================== */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const cite = (c) => (c ? `<span class="cite">${esc(c)}</span>` : '')

/**
 * The badge text for the two sets whose names are NOT their meanings.
 *
 * ⚠ WHY THESE ARE CONSTANTS. Both badges used to state a WORKFLOW property while
 * actually describing a STRUCTURAL one, and the page contradicted itself as a result:
 *
 *   · `optional`, rendered 14 times (once per overview row and once per phase detail
 *     view, for the seven members of `lock.ts` `OPTIONAL_PHASES`). The set's ONLY
 *     consumer in the whole plugin is `lock.ts:262`
 *     `nextLegalPhase(graph, { optional: OPTIONAL_PHASES })`, where it means "a member
 *     that is ABSENT does not stop the chain" — a statement about the legal-phase
 *     SELECTOR, not about the phase's work. A reader is entitled to read a bare
 *     `optional` badge as "this phase is optional", and the owner did exactly that.
 *     It now says `MAY BE ABSENT`, which is the property the code implements and
 *     cannot be read as a judgement about the work. The two detail views' own gate
 *     sentences keep the code's vocabulary ("Declared OPTIONAL: an absent optional
 *     phase does not stop the run") because THAT sentence carries its scope — it is
 *     the bare badge, not the word, that was wrong.
 *   · `late phase`, rendered 3 times, for the members of `phase-rules.ts`
 *     `LATE_PHASE_ARTIFACTS`. That set's only use in shipped code is a PROFILE
 *     DETECTOR (`ts-lint.ts` returns the compat workflow profile when any of the three
 *     exists); the phase 6-8 write freeze comes from `phaseBaselineRules`, which keys
 *     on the phase NUMBER from `phaseNumberForArtifact`, not on this set. The badge
 *     now names the set and says what the set does.
 *
 * Both are constants so `--verify` can assert the EXACT rendered string rather than a
 * substring, which is what makes "the badge cannot drift back" a checked fact.
 */
const BADGE_MAY_BE_ABSENT = 'may be absent'
const BADGE_LATE_SET = 'late set · profile detector'

function tagList(p) {
  const t = []
  if (p.human) t.push('<span class="tag tag-human">human gate</span>')
  if (p.late) t.push(`<span class="tag tag-late">${BADGE_LATE_SET}</span>`)
  if (p.audited) t.push('<span class="tag tag-audited">audited</span>')
  if (p.optional) t.push(`<span class="tag tag-may-be-absent">${BADGE_MAY_BE_ABSENT}</span>`)
  if (p.tdd) t.push('<span class="tag tag-tdd">TDD gate</span>')
  if (p.memoryGate) t.push('<span class="tag tag-refuse">lock gate</span>')
  if (p.closeout) t.push('<span class="tag tag-closeout">closeout</span>')
  if (p.artifactInputsOnly) t.push('<span class="tag">artifact inputs only</span>')
  return t.join(' ')
}

/** One phase row on the overview: inputs → artifact → gates, with a loop rail on the left. */
function phaseRow(p, i) {
  const loopIds = []
  if (p.tdd) loopIds.push('B5')
  if (p.sections.length) loopIds.push('B4')
  if (p.audited || p.closeout) loopIds.push('B1')
  if (p.memoryGate) loopIds.push('B2')

  return `
      <article class="step${p.human ? ' step-human' : ''}" id="ov-${esc(p.file.replace(/[^a-z0-9]+/gi, '-'))}">
        <div class="rail" aria-hidden="true"><span class="rail-dot"></span></div>
        <div class="step-body">
          <header class="step-head">
            <div class="step-id">
              <span class="step-num">${esc(p.phaseN)}</span>
              <span class="step-artifact">${esc(p.file)}</span>
            </div>
            <div class="step-tags">${tagList(p)}</div>
            <div class="step-kind">${esc(p.kind)}${cite(p.c)}</div>
          </header>
          <p class="step-purpose"><span class="g-shape">PURPOSE</span><span>${esc(p.purpose.t)}</span>${cite(p.purpose.c)}</p>
          <div class="io">
            <div class="io-col">
              <h4>reads <span class="io-sub">input docs</span></h4>
              <ul>${p.inputs.map((x) => `<li><span class="doc${x.artifact ? ' doc-artifact' : ''}">${esc(x.doc)}</span>${cite(x.c)}</li>`).join('')}</ul>
            </div>
            <div class="io-col">
              <h4>writes <span class="io-sub">output doc</span></h4>
              <ul>${p.outputs.map((x) => `<li><span class="doc${x.artifact ? ' doc-artifact' : ' doc-notartifact'}">${esc(x.doc)}</span>${cite(x.c)}</li>`).join('')}</ul>
            </div>
          </div>
          <div class="gates">
            <h4>gates &amp; hooks at this step</h4>
            <ul class="gate-list">
              ${p.gates.map((g) => `<li class="g g-${esc(g.shape)}${g.human ? ' g-human' : ''}"><span class="g-shape">${g.human ? 'DECISION' : g.shape === 'refuse' ? 'REFUSAL' : 'AUTO'}</span><span class="g-text">${g.t}${cite(g.c)}</span></li>`).join('')}
            </ul>
          </div>
          ${loopIds.length ? `<div class="loop-note">can be sent back: ${[...new Set(loopIds)].map((id) => `<a href="#loop-${id}">${id}</a>`).join(' · ')}</div>` : ''}
        </div>
      </article>`
}

const phaseDetail = (p, i) => {
  const id = 'phase-' + p.file.replace(/[^a-z0-9]+/gi, '-')
  const extraNote = p.sectionsExtraC
    ? `<p class="note">The list above is the canonical parity list. In a STRICT workflow profile an audited phase gets the audit headings APPENDED${p.priorEvidence ? ', plus `Prior Recursive Evidence Reviewed`' : ''} — rendered by <code>getArtifactRequiredSections</code>. ${cite(p.sectionsExtraC)}</p>`
    : ''
  return `
  <section class="panel" id="panel-${id}" role="tabpanel" aria-labelledby="tab-${id}" tabindex="0" hidden>
    <div class="panel-head">
      <h2><span class="h-num">phase ${esc(p.phaseN)}</span> ${esc(p.file)}</h2>
      <p class="lede">${esc(p.kind)} — artifact ${i + 1} of ${PHASES.length} in <code>PHASE_SEQUENCE</code>.${cite(p.c)}</p>
      <p class="lede" style="margin-top:var(--sp-2)"><b>What it is for:</b> ${esc(p.purpose.t)}${cite(p.purpose.c)}</p>
      <p class="note" style="margin-top:var(--sp-2)">Reads ${fanInOf(p.file) === 0 ? 'no upstream artifact — it is where a run starts' : sourcesOf(p.file) + ' upstream artifact' + (sourcesOf(p.file) === 1 ? '' : 's') + (hasWildcard(p.file) ? ' (the wildcard input: every present artifact except itself)' : '')} ${cite(EDGES.filter((edge) => edge.to === p.file).map((edge) => edge.c).filter((c, j, all) => all.indexOf(c) === j).join(', '))}</p>
      <div class="step-tags">${tagList(p)}</div>
    </div>

    <div class="detail-grid">
      <section class="card">
        <h3>Required sections <span class="h-count">${p.sections.length}</span></h3>
        <ol class="sections">${p.sections.map((s) => `<li><code>## ${esc(s)}</code></li>`).join('')}</ol>
        ${extraNote}
        <p class="cite-line">${cite(p.sectionsC)}</p>
      </section>

      <section class="card">
        <h3>Gates</h3>
        <ul class="gate-list">
          ${p.gates.filter((g) => g.shape !== 'refuse').map((g) => `<li class="g g-${esc(g.shape)}${g.human ? ' g-human' : ''}"><span class="g-shape">${g.human ? 'DECISION' : 'AUTO'}</span><span class="g-text">${g.t}${cite(g.c)}</span></li>`).join('') || '<li class="g"><span class="g-text">No phase-specific gate recorded beyond the universal ones.</span></li>'}
        </ul>
      </section>

      <section class="card">
        <h3>Inputs — what this phase reads</h3>
        <ul class="io-list">${p.inputs.map((x) => `<li><span class="doc${x.artifact ? ' doc-artifact' : ''}">${esc(x.doc)}</span>${cite(x.c)}</li>`).join('')}</ul>
        <p class="note">The expected-input list is the linter's own: <code>getPhaseExpectedInputArtifactNames</code> names the input artifacts it requires this phase's <code>Inputs:</code> header and <code>## Effective Inputs Re-read</code> section to cite — and only those that exist on disk are demanded. ${cite(SRC.inputMap)}</p>
        <p class="cite-line">${cite(SRC.effectiveInputs)} <span class="unv">Note: the linter also demands that every addendum attached to an expected input be cited, which is checked at <code>ts-lint.ts:691-705</code>.</span></p>
      </section>

      <section class="card">
        <h3>Output artifact</h3>
        <ul class="io-list">${p.outputs.map((x) => `<li><span class="doc${x.artifact ? ' doc-artifact' : ' doc-notartifact'}">${esc(x.doc)}</span>${cite(x.c)}</li>`).join('')}</ul>
        <p class="note">Scaffolded by <code>recursive_init</code> with a header block (<code>Run:</code>, <code>Phase:</code>, <code>Status: DRAFT</code>, <code>Workflow version:</code>, <code>Inputs:</code>, <code>Outputs:</code>, <code>Scope note:</code>) and every required section as an empty heading, with <code>Coverage: FAIL</code> and <code>Approval: FAIL</code> at the end. ${cite(SRC.tplLater)}</p>
      </section>

      <section class="card card-wide">
        <h3>What can REFUSE this phase</h3>
        <ul class="refuse-list">${p.refusals.map((r) => `<li><span class="g-shape g-shape-refuse">REFUSAL</span><span>${esc(r)}</span></li>`).join('')}</ul>
        <p class="note">The guard refuses BEFORE dispatch at the <code>tools/pre-execute</code> seam; the tool refuses again inside <code>lockArtifact</code>. Both describe the same violation on purpose — one refusal, two layers that agree. ${cite(SRC.preExecute + ', ' + SRC.blockers)}</p>
      </section>

      <section class="card card-wide">
        <h3>Human questions attached to this phase</h3>
        ${p.questions.length === 0
      ? `<p class="note">None. <code>recursive_ask</code>&#39;s three workflow gates belong to phases 3 (<code>tdd-mode</code>) and 5 (<code>qa-signoff</code>), plus <code>gate-block</code>, which any refused transition can raise.${cite(SRC.askGates)}</p>`
      : p.questions.map((q) => `
          <div class="ask">
            <div class="ask-head"><code>gate: ${esc(q.gate)}</code><span class="ask-header">${esc(q.header)}</span></div>
            <p class="ask-q">${esc(q.q)}</p>
            <ul class="ask-opts">${q.opts.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>
            ${cite(q.c)}
          </div>`).join('')}
        ${p.file === '00-requirements.md' ? `<div class="ask"><div class="ask-head"><code>gate: run-start</code><span class="ask-header">Start run</span></div><p class="ask-q">Approve phase 0 and start this run? Approving creates an armed goal the harness will keep driving.</p><ul class="ask-opts"><li>Start run — record the approval and arm the run goal</li><li>Hold — leave the spec inert: no run goal, no autonomous rounds</li></ul>${cite(SRC.startGate)}</div>` : ''}
      </section>

      <section class="card card-wide">
        <h3>Start here at this phase — the pre-step injection</h3>
        <pre class="pre">${PRESTEP.lines.map(esc).join('\n')}</pre>
        <p class="note">${esc(PRESTEP.gate)} ${cite(PRESTEP.c)} ${cite(PRESTEP.gateC)}</p>
      </section>
    </div>
  </section>`
}

function render() {
  // The charts are CHARTED before the page is built: each one lays itself out, each one
  // carries its own width into its own wrapper (`--dg-w`), and each one ships the
  // manifest the checker re-reads. TWO charts now, one engine: the overview IS the graph.
  const dgOverview = chart({
    id: 'overview',
    label: `The workflow as a graph: the twelve phase artifacts of PHASE_SEQUENCE in order, with all ${EDGES.length} directed input edges drawn between them. A solid arrow is a required input the linter expects; a dashed arrow is one of the ${EDGES.filter((e) => e.kind === 'conditional').length} conditional inputs, pushed only when the source artifact is present; a dotted link carries no input edge at all, so two adjacent pairs are marked as sequence order only and the difference between the order and a real dependency is visible. A thick arrow comes off the rail under the row: that is the wildcard input, every present artifact except itself, which phases 06 and 08 read. A dashed node border and its own fan-in line mark the ${PHASES.filter((p) => sourcesOf(p.file) > 1).length} phases that read more than one upstream artifact. Amber diamonds above a node mark the ${PHASES.filter((p) => p.human).length} places a person must answer, and a hatched band under a node marks a place a guard rule can refuse. Violet arcs run BACKWARDS: a reopen and a REVISE verdict re-enter a node to the LEFT of their source, and the same arc closes the cross-run loop below the row, where the memory this run writes is read by the NEXT run's phase entry. The same information is given as tables in the views below.`,
    draw: drawOverview,
  })
  const dgTraining = chart({
    id: 'learning-loop',
    label: 'Learning loop: the cross-run memory cycle. A run reads the memory plane at phase entry, records a read receipt, has its first phase-0 write gated on that receipt, must write a memory doc before phase 8 can lock, and then - only on a re-run, only with at least two locked runs, and only with an extractor configured - extracts training shards that the NEXT run reads. Each step carries the refusal, skip or exit code that can stop it. The same steps are given as a table below.',
    draw: drawTraining,
  })

  const tabs = [
    { id: 'overview', label: 'Overview', sub: 'the graph' },
    { id: 'start', label: 'Phase 0', sub: 'the human gate' },
    ...PHASES.map((p) => ({ id: 'phase-' + p.file.replace(/[^a-z0-9]+/gi, '-'), label: p.file.replace(/\.md$/, ''), sub: 'phase ' + p.phaseN })),
    { id: 'hooks', label: 'Hooks & seams', sub: 'where it attaches' },
    { id: 'guards', label: 'Guards & refusals', sub: 'what says no' },
    { id: 'loops', label: 'Backward loops', sub: 'REVISE / repair' },
    { id: 'training', label: 'Learning loop', sub: 'cross-run memory' },
    { id: 'closeout', label: 'Closeout & receipts', sub: 'the chain' },
    { id: 'notes', label: 'Notes & caveats', sub: 'the prose, moved' },
    { id: 'tools', label: 'Tools', sub: '13 definitions' },
    { id: 'codes', label: 'Error codes', sub: 'RM####' },
    { id: 'verify', label: 'Verification', sub: 'what is checked' },
  ]

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>recursive-mode — the workflow, extracted from the source</title>
<meta name="description" content="A tabbed, citation-carrying map of the recursive-mode workflow: phase sequence, per-phase gates, DSH hooks, lock chain and the backward loops.">
<style>
/* Each chart writes its OWN width into the wrapper it is drawn in (the --dg-w custom
   property, set inline on div.diagram[data-diagram] below), so three charts can coexist
   at three different widths and no chart is ever scaled by the box it lands in — it
   SCROLLS instead. */
:root{ --dg-min:600px; }
/* ==========================================================================
   TOKENS — primitive → semantic. Dark canvas, one accent per MEANING, and no
   meaning carried by colour alone: every gate also carries a word and a shape.
   ========================================================================== */
/* Tokens — rendered from the C object above, so the contrast audit reads exactly
   what ships. Primitive → semantic; one accent per MEANING, and no meaning is
   carried by colour alone (every gate also carries a word and a shape). */
:root{
${Object.entries(C).map(([k, v]) => `  --${k}:${v};`).join('\n')}

  --bg:var(--n-950); --surface:var(--n-900); --surface-2:var(--n-850);
  --surface-3:var(--n-800); --line:var(--n-700); --line-strong:var(--n-600);
  --fg:var(--n-050); --fg-2:var(--n-200); --fg-muted:var(--n-300);
  --fg-faint:var(--n-400);
  --accent:var(--acc); --accent-line:var(--acc-dim);

  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono","Courier New",monospace;

  /* Fluid type: one clamp per step so nothing needs a breakpoint to stay legible. */
  --fs-3xs:0.6875rem; --fs-2xs:0.75rem; --fs-xs:0.8125rem; --fs-sm:0.875rem;
  --fs-base:clamp(0.9rem, 0.88rem + 0.12vw, 0.9375rem);
  --fs-lg:clamp(1rem, 0.97rem + 0.16vw, 1.0625rem);
  --fs-xl:clamp(1.125rem, 1.06rem + 0.3vw, 1.25rem);
  --fs-2xl:clamp(1.25rem, 1.1rem + 0.7vw, 1.5rem);
  --fs-3xl:clamp(1.4rem, 1.2rem + 1vw, 1.875rem);

  --sp-1:0.25rem; --sp-2:0.5rem; --sp-3:0.75rem; --sp-4:1rem; --sp-5:1.25rem;
  --sp-6:1.5rem; --sp-8:2rem; --sp-10:2.5rem; --sp-12:3rem;

  /* -------- radii, concentric by nesting level -----------------------------
     outer = inner + padding. Three steps, because three levels exist:
       L1  .panel / .diagram   r 8   , padding 24
       L2  .card  / .subcard   r 4   , padding 16   (8 > 4: the nested corner
                                       is visibly tighter, never equal)
       L3  code / .cite / .tag r 2   , padding  1-8
     An EQUAL radius on parent and child is the pattern this avoids: it is what
     makes a nested surface look pinched. Non-nested controls (.chip, .tab,
     .legend, .tablewrap, .ask, .loop, .pre) may share L2 — they do not sit
     inside a rounded, padded parent, so concentricity does not apply to them. */
  --r-1:2px; --r-2:4px; --r-3:8px; --r-pill:999px;
}
@media (prefers-color-scheme: light){ :root{ color-scheme: dark; } }

*,*::before,*::after{ box-sizing:border-box; }
html{ -webkit-text-size-adjust:100%; scroll-padding-top:9rem; }
body{
  margin:0; background:var(--bg); color:var(--fg);
  font-family:var(--mono); font-size:var(--fs-base); line-height:1.55;
  font-variant-ligatures:none;
  -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
  background-image:
    linear-gradient(var(--n-900) 1px, transparent 1px),
    linear-gradient(90deg, var(--n-900) 1px, transparent 1px);
  background-size:64px 64px, 64px 64px;
  background-position:-1px -1px;
}
a{ color:var(--accent); text-underline-offset:2px; }
a:hover{ color:var(--fg); }
code{ font-family:var(--mono); font-size:0.96em; color:var(--n-100); background:var(--n-850); border:1px solid var(--line); border-radius:var(--r-1); padding:0 0.28em; }
h1,h2,h3,h4{ margin:0; font-weight:600; line-height:1.25; letter-spacing:-0.01em; text-wrap:balance; }
p{ margin:0; text-wrap:pretty; }
li{ text-wrap:pretty; }
ul,ol{ margin:0; padding:0; list-style:none; }
/* Digits that must not shift the layout when they change. */
.tnum, .chip b, .seq, .h-count, .step-num, .lede{ font-variant-numeric:tabular-nums; }
:focus-visible{ outline:2px solid var(--warn); outline-offset:2px; border-radius:var(--r-1); }

/* ---- skip link ---------------------------------------------------------- */
.skip{ position:absolute; left:-9999px; top:0; z-index:50; background:var(--warn); color:var(--warn-ink); padding:var(--sp-2) var(--sp-4); font-weight:600; border-radius:0 0 var(--r-1) 0; }
.skip:focus{ left:0; }

/* ---- shell ------------------------------------------------------------- */
.wrap{ max-width:1340px; margin:0 auto; padding:0 var(--sp-5) var(--sp-12); }
header.masthead{ border-bottom:1px solid var(--line-strong); padding:var(--sp-8) 0 var(--sp-5); margin-bottom:var(--sp-5); }
.masthead-top{ display:flex; flex-wrap:wrap; gap:var(--sp-3) var(--sp-5); align-items:baseline; justify-content:space-between; }
h1{ font-size:var(--fs-2xl); letter-spacing:-0.02em; }
h1 .tick{ color:var(--accent); }
.mast-sub{ color:var(--fg-muted); font-size:var(--fs-xs); margin-top:var(--sp-2); max-width:88ch; }
.mast-meta{ display:flex; flex-wrap:wrap; gap:var(--sp-2); margin-top:var(--sp-4); }
.chip{ font-size:var(--fs-3xs); border:1px solid var(--line-strong); border-radius:var(--r-2); padding:0 var(--sp-2); color:var(--fg-muted); background:var(--surface); white-space:nowrap; }
.chip b{ color:var(--fg); font-weight:600; }
.chip-acc{ border-color:var(--accent-line); color:var(--accent); }
.chip-warn{ border-color:var(--warn-dim); color:var(--warn); }
.chip-ok{ border-color:var(--ok-dim); color:var(--ok); }

/* ---- tabs (ARIA tablist; roving tabindex; arrow keys) -------------------
   The strip is styleable, not just clickable: a 44px minimum height (touch), a
   visible focus ring, and at narrow widths it SCROLLS in one row instead of
   wrapping into a tall block that pushes the panel below the fold. scroll-padding
   keeps a keyboard-focused tab fully in view, and overscroll-behavior stops the
   scroll from chaining to the page. */
.tabstrip{ position:sticky; top:0; z-index:20; background:linear-gradient(var(--bg) 80%, transparent); padding:var(--sp-3) 0 var(--sp-4); border-bottom:1px solid var(--line); margin-bottom:var(--sp-6); }
.tabstrip-label{ font-size:var(--fs-3xs); color:var(--fg-faint); text-transform:uppercase; letter-spacing:0.14em; margin-bottom:var(--sp-2); }
[role="tablist"]{
  display:flex; gap:var(--sp-1);
  overflow-x:auto; overscroll-behavior-inline:contain;
  scroll-padding-inline:var(--sp-2); scroll-snap-type:x proximity;
  padding-bottom:var(--sp-1);
  scrollbar-width:thin; scrollbar-color:var(--n-600) transparent;
}
[role="tablist"]::-webkit-scrollbar{ height:6px; }
[role="tablist"]::-webkit-scrollbar-thumb{ background:var(--n-600); border-radius:var(--r-pill); }
[role="tab"]{
  appearance:none; background:var(--surface); color:var(--fg-muted);
  border:1px solid var(--line-strong); border-radius:var(--r-2);
  font-family:inherit; font-size:var(--fs-2xs); line-height:1.2;
  padding:var(--sp-2) var(--sp-3); cursor:pointer; text-align:left;
  display:flex; flex-direction:column; gap:2px; justify-content:center;
  min-height:44px; flex:0 0 auto; scroll-snap-align:start;
  transition-property:background-color, border-color, color, box-shadow;
  transition-duration:120ms; transition-timing-function:ease-out;
}
[role="tab"]:hover{ background:var(--surface-3); color:var(--fg); border-color:var(--n-500); }
[role="tab"]:active{ background:var(--n-700); }
[role="tab"][aria-selected="true"]{ background:var(--n-800); color:var(--fg); border-color:var(--accent); box-shadow:inset 0 -2px 0 var(--accent); }
[role="tab"][aria-selected="true"] .tsub{ color:var(--accent); }
.tlabel{ white-space:nowrap; }
.tsub{ font-size:var(--fs-3xs); color:var(--fg-faint); white-space:nowrap; }

/* ---- panels ------------------------------------------------------------- */
.panel{ background:var(--surface); border:1px solid var(--line); border-radius:var(--r-3); padding:var(--sp-6); }
.panel[hidden]{ display:none; }
.js .panel{ display:none; }
.js .panel.is-active{ display:block; }
.panel-head{ border-bottom:1px solid var(--line); padding-bottom:var(--sp-4); margin-bottom:var(--sp-5); }
.panel-head h2{ font-size:var(--fs-xl); display:flex; flex-wrap:wrap; gap:var(--sp-3); align-items:baseline; }
.h-num{ font-size:var(--fs-2xs); color:var(--accent); border:1px solid var(--accent-line); border-radius:var(--r-1); padding:0 var(--sp-2); }
.lede{ color:var(--fg-muted); font-size:var(--fs-xs); margin-top:var(--sp-2); max-width:92ch; }
h3{ font-size:var(--fs-sm); color:var(--fg); margin-bottom:var(--sp-3); display:flex; align-items:baseline; gap:var(--sp-2); }
.h-count{ font-size:var(--fs-3xs); color:var(--fg-faint); font-weight:400; }

/* ---- citations ---------------------------------------------------------- */
/* A citation is a file:line — long, unbreakable-looking, and it used to carry
   white-space:nowrap. THAT was a layout defect, not a style: a nowrap inline box
   whose text is wider than its column cannot shrink, so it pushed its own card wider
   than the grid track, the card overflowed, and the ink of the overflowing citation
   landed on top of the next card's heading and code spans (measured: 12 text-on-text
   collisions at 1440px across the phase and verification views). It breaks normally
   now, and overflow-wrap:anywhere is the last resort that keeps a 40-character path
   inside its column even when there is no space to break on. */
.cite{ display:inline-block; font-size:var(--fs-3xs); color:var(--fg-faint); background:var(--n-850); border:1px solid var(--line); border-radius:var(--r-1); padding:0 var(--sp-1); margin-left:var(--sp-2); max-width:100%; overflow-wrap:anywhere; vertical-align:baseline; }
.cite-line{ margin-top:var(--sp-3); }
.note{ font-size:var(--fs-2xs); color:var(--fg-muted); margin-top:var(--sp-3); }
.unv{ color:var(--warn); }
.note code, .lede code{ font-size:0.94em; }

/* ---- tags --------------------------------------------------------------- */
.tag{ font-size:var(--fs-3xs); border:1px solid var(--line-strong); border-radius:var(--r-pill); padding:0 var(--sp-2); color:var(--fg-muted); white-space:nowrap; }.tag-human{ border-color:var(--warn); color:var(--warn); }
.tag-late{ border-color:var(--violet); color:var(--violet); }
.tag-audited{ border-color:var(--accent-line); color:var(--accent); }
.tag-refuse{ border-color:var(--danger-dim); color:var(--danger); }
.tag-tdd{ border-color:var(--ok-dim); color:var(--ok); }
/* Three marker meanings, three classes. They shared one class before, which is
   exactly how a STRUCTURAL marker came to look like a statement about the WORK: the
   bare phase badge and the graph's edge markers ("when present", "wildcard") were the
   same visual class. .tag-may-be-absent is the phase badge; .tag-shape marks a
   shape of the data (a conditional input, a wildcard input, a conditionally
   registered tool) and never a phase. The distinction is a dashed vs a dotted BORDER, so it
   survives without colour — and --verify asserts that no .tag-optional class and
   no bare optional badge survives in the output at all. */
.tag-may-be-absent{ border-style:dashed; }
.tag-shape{ border-style:dotted; color:var(--fg-2); }
.tag-closeout{ border-color:var(--n-400); color:var(--fg-2); }
.step-tags{ display:flex; flex-wrap:wrap; gap:var(--sp-1); }
.step-tags .tag{ margin-top:var(--sp-1); }

/* ---- overview: the sequence -------------------------------------------- */
.flow{ display:flex; flex-direction:column; }
.legend{ display:flex; flex-wrap:wrap; gap:var(--sp-4); border:1px solid var(--line); background:var(--surface-2); border-radius:var(--r-2); padding:var(--sp-4); margin-bottom:var(--sp-6); font-size:var(--fs-2xs); color:var(--fg-muted); }
.legend div{ display:flex; align-items:center; gap:var(--sp-2); }
.swatch{ width:14px; height:14px; border:1px solid var(--line-strong); display:inline-block; flex:none; }
.sw-human{ background:var(--warn); border-color:var(--warn); }
.sw-auto{ background:var(--n-800); }
.sw-refuse{ background:repeating-linear-gradient(45deg,var(--danger) 0 2px,transparent 2px 5px); border-color:var(--danger); }
.sw-loop{ background:var(--violet); border-color:var(--violet); }
.sw-late{ background:var(--n-800); border-color:var(--violet); }
/* The MAY BE ABSENT marker as a SWATCH: the same dashed BORDER the tag carries, so
   the legend key and the badge it explains are one shape. Colour is not the signal —
   a filled swatch (member of the late set) versus a dashed outline (may be absent). */
.sw-absent{ background:transparent; border-color:var(--n-300); border-style:dashed; }

/* WHY minmax(0,1fr) AND NOT 1fr: a bare 1fr track has an automatic minimum of
   min-content, so ONE unbreakable string — a 40-character file path in a citation —
   makes the track wider than its share and the grid overflows its own box. The
   measured result was a card 491px wide inside a 401px track, with its citation
   painted across the neighbouring card. minmax(0,1fr) lets the track shrink and the
   text wrap instead. Same reason for every min-width:0 in this sheet: it is what
   lets a flex item be narrower than its longest word. */
.step{ display:grid; grid-template-columns:var(--sp-8) minmax(0,1fr); gap:0; }
.rail{ position:relative; }
.rail::before{ content:""; position:absolute; left:50%; top:0; bottom:0; width:1px; background:var(--line-strong); transform:translateX(-50%); }
.rail-dot{ position:absolute; left:50%; top:var(--sp-5); width:9px; height:9px; transform:translate(-50%,-50%) rotate(45deg); background:var(--n-850); border:1px solid var(--n-500); }
.step-human .rail-dot{ background:var(--warn); border-color:var(--warn); }
.step-body{ border:1px solid var(--line); border-left:2px solid var(--n-600); background:var(--surface-2); border-radius:0 var(--r-2) var(--r-2) 0; padding:var(--sp-4) var(--sp-4) var(--sp-4) var(--sp-5); margin-bottom:var(--sp-3); min-width:0; }
.step-human .step-body{ border-left-color:var(--warn); background:linear-gradient(90deg, rgba(240,179,87,0.055), transparent 40%), var(--surface-2); }
.step-head{ display:flex; flex-wrap:wrap; gap:var(--sp-2) var(--sp-4); align-items:baseline; justify-content:space-between; border-bottom:1px solid var(--line); padding-bottom:var(--sp-2); margin-bottom:var(--sp-3); }
.step-id{ display:flex; align-items:baseline; gap:var(--sp-3); min-width:0; flex-wrap:wrap; }
.step-num{ font-size:var(--fs-lg); color:var(--accent); font-weight:600; min-width:2ch; }
.step-artifact{ font-size:var(--fs-sm); color:var(--fg); font-weight:600; }
.step-kind{ font-size:var(--fs-3xs); color:var(--fg-faint); min-width:0; overflow-wrap:anywhere; }
/* The purpose line: one sentence per phase, sourced, with the sections it was read
   from cited beside it. Grid so the PURPOSE badge lines up with the gate badges. */
.step-purpose{ display:grid; grid-template-columns:5.5rem minmax(0,1fr); gap:var(--sp-2) var(--sp-3); align-items:start; font-size:var(--fs-2xs); color:var(--fg-2); margin:0 0 var(--sp-3); padding:var(--sp-2) 0; border-top:1px dotted var(--n-700); border-bottom:1px dotted var(--n-700); }
.step-purpose .g-shape{ border-color:var(--accent-line); color:var(--accent); }
.step-purpose .cite{ grid-column:2; }

.io{ display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:var(--sp-4); }
.io h4, .gates h4{ font-size:var(--fs-3xs); text-transform:uppercase; letter-spacing:0.12em; color:var(--fg-faint); font-weight:600; margin-bottom:var(--sp-2); }
.io-col{ min-width:0; }
.io-sub{ text-transform:none; letter-spacing:0; color:var(--n-500); }
.io ul li, .io-list li{ font-size:var(--fs-2xs); color:var(--fg-2); padding:var(--sp-1) 0; border-bottom:1px dotted var(--n-700); }
.io ul li:last-child, .io-list li:last-child{ border-bottom:0; }
.doc{ color:var(--n-100); }
.doc-artifact{ color:var(--accent); }
.doc-notartifact{ color:var(--fg-muted); font-style:italic; }
.gates{ margin-top:var(--sp-4); border-top:1px solid var(--line); padding-top:var(--sp-3); }
.gate-list li{ display:grid; grid-template-columns:5.5rem minmax(0,1fr); gap:var(--sp-3); align-items:start; font-size:var(--fs-2xs); color:var(--fg-2); padding:var(--sp-2) 0; border-bottom:1px dotted var(--n-700); }
.gate-list li:last-child{ border-bottom:0; }
.g-shape{ font-size:var(--fs-3xs); letter-spacing:0.08em; border:1px solid var(--line-strong); border-radius:var(--r-1); padding:0 var(--sp-1); text-align:center; color:var(--fg-muted); }
.g-human .g-shape{ border-color:var(--warn); color:var(--warn); background:rgba(240,179,87,0.08); }
.g-refuse .g-shape{ border-color:var(--danger); color:var(--danger); background:repeating-linear-gradient(45deg, rgba(255,139,122,0.16) 0 2px, transparent 2px 5px); }
.g-human .g-text{ color:var(--fg); }
.loop-note{ margin-top:var(--sp-3); font-size:var(--fs-3xs); color:var(--violet); }
.loop-note a{ color:var(--violet); }

/* ---- two-column rails (phase 0) ---------------------------------------- */
/* minmax(min(280px,100%),1fr) — the inner min() is what stops the track from
   demanding 280px in a container narrower than that (a 320px card in a 300px space
   is an overflow, not a layout). */
.rail-pair{ display:grid; grid-template-columns:repeat(auto-fit, minmax(min(280px,100%),1fr)); gap:var(--sp-4); }
.subcard{ border:1px solid var(--line); border-radius:var(--r-2); background:var(--surface-2); padding:var(--sp-4); }
.subcard h3{ font-size:var(--fs-2xs); text-transform:uppercase; letter-spacing:0.1em; color:var(--fg-faint); }
.subcard .pre{ margin-top:var(--sp-2); }

/* ---- detail cards ------------------------------------------------------- */
.detail-grid{ display:grid; grid-template-columns:repeat(auto-fit, minmax(min(320px,100%),1fr)); gap:var(--sp-4); align-items:start; }
.card{ border:1px solid var(--line); border-radius:var(--r-2); background:var(--surface-2); padding:var(--sp-4); min-width:0; }
.card-wide{ grid-column:1 / -1; }
.sections{ counter-reset:s; }
.sections li{ counter-increment:s; font-size:var(--fs-2xs); padding:var(--sp-1) 0 var(--sp-1) var(--sp-6); position:relative; border-bottom:1px dotted var(--n-700); }
.sections li::before{ content:counter(s) "."; position:absolute; left:0; color:var(--fg-faint); font-size:var(--fs-3xs); }
.sections li:last-child{ border-bottom:0; }
.refuse-list li{ display:grid; grid-template-columns:5.5rem minmax(0,1fr); gap:var(--sp-3); align-items:start; font-size:var(--fs-2xs); color:var(--fg-2); padding:var(--sp-2) 0; border-bottom:1px dotted var(--n-700); }
.refuse-list li:last-child{ border-bottom:0; }
.g-shape-refuse{ border-color:var(--danger); color:var(--danger); background:repeating-linear-gradient(45deg, rgba(255,139,122,0.16) 0 2px, transparent 2px 5px); }
.pre{ background:var(--n-950); border:1px solid var(--line); border-left:2px solid var(--accent-line); border-radius:var(--r-2); padding:var(--sp-3); font-size:var(--fs-3xs); color:var(--n-200); overflow-x:auto; white-space:pre; line-height:1.6; margin:0; }

.ask{ border:1px solid var(--warn-dim); border-left:2px solid var(--warn); border-radius:var(--r-2); padding:var(--sp-3); margin-top:var(--sp-3); background:rgba(240,179,87,0.045); }
.ask-head{ display:flex; flex-wrap:wrap; gap:var(--sp-3); align-items:baseline; font-size:var(--fs-2xs); }
.ask-header{ color:var(--warn); font-weight:600; }
.ask-q{ font-size:var(--fs-2xs); color:var(--fg-2); margin-top:var(--sp-2); }
.ask-opts{ margin-top:var(--sp-2); }
.ask-opts li{ font-size:var(--fs-2xs); color:var(--fg-muted); padding:var(--sp-1) 0 var(--sp-1) var(--sp-5); position:relative; }
.ask-opts li::before{ content:"▸"; position:absolute; left:var(--sp-2); color:var(--warn); }

/* ---- tables ------------------------------------------------------------- */
.tablewrap{ overflow-x:auto; border:1px solid var(--line); border-radius:var(--r-2); }
table{ border-collapse:collapse; width:100%; font-size:var(--fs-2xs); min-width:640px; }
caption{ text-align:left; font-size:var(--fs-3xs); color:var(--fg-faint); padding:var(--sp-3) var(--sp-4) 0; }
th,td{ text-align:left; padding:var(--sp-2) var(--sp-3); border-bottom:1px solid var(--line); vertical-align:top; }
thead th{ position:sticky; top:0; background:var(--n-800); color:var(--fg); font-size:var(--fs-3xs); text-transform:uppercase; letter-spacing:0.08em; font-weight:600; }
tbody tr:last-child td{ border-bottom:0; }
tbody tr:hover{ background:var(--n-850); }
td .cite{ margin-left:var(--sp-1); }
.seq{ display:inline-block; min-width:2ch; color:var(--accent); }
.k-input{ color:var(--accent); } .k-value{ color:var(--violet); } .k-workspace{ color:var(--fg-muted); }
.k-state{ color:var(--warn); } .k-runtime{ color:var(--danger); } .k-capability{ color:var(--ok); }

/* ---- lock chain --------------------------------------------------------- */
.chain{ counter-reset:c; }
.chain li{ counter-increment:c; display:grid; grid-template-columns:2.5rem minmax(0,1fr); gap:var(--sp-3); padding:var(--sp-3) 0; border-bottom:1px solid var(--line); font-size:var(--fs-2xs); }
.chain li:last-child{ border-bottom:0; }
.chain li::before{ content:counter(c); grid-row:1; color:var(--accent); border:1px solid var(--accent-line); border-radius:var(--r-2); height:1.6em; display:grid; place-items:center; font-size:var(--fs-3xs); }
.chain .ct{ color:var(--fg); font-weight:600; display:block; }
.chain .cd{ color:var(--fg-muted); display:block; margin-top:var(--sp-1); overflow-wrap:anywhere; }

/* ---- loop cards --------------------------------------------------------- */
.loop{ border:1px solid var(--violet-dim); border-left:2px solid var(--violet); border-radius:var(--r-2); background:linear-gradient(90deg, rgba(185,167,255,0.05), transparent 30%), var(--surface-2); padding:var(--sp-4); margin-bottom:var(--sp-3); min-width:0; }
.loop h3{ color:var(--violet); font-size:var(--fs-sm); flex-wrap:wrap; }
.loop .lid{ font-size:var(--fs-3xs); border:1px solid var(--violet); color:var(--violet); border-radius:var(--r-1); padding:0 var(--sp-1); margin-right:var(--sp-2); }
.loop p{ font-size:var(--fs-2xs); color:var(--fg-2); margin-top:var(--sp-2); overflow-wrap:anywhere; }

/* ---- diagram ------------------------------------------------------------
   THE CHARTS ARE SVGs IN AN EXPLICIT SET OF BANDS, and the custom property each
   wrapper carries — --dg-w, written by the generator's chart() into the wrapper's own
   inline style — is the interface to them: the svg keeps its OWN coordinate system and
   its text stays at its declared size instead of being scaled by whatever box it lands
   in. Below --dg-w the wrapper SCROLLS HORIZONTALLY — one strip, exactly the mechanism
   the tab strip already uses at every width — so a narrow viewport never squeezes a
   chart, and nothing inside it can be painted outside the box that holds it. */
.diagram{ border:1px solid var(--line); border-radius:var(--r-2); background:var(--n-950); padding:var(--sp-4); overflow-x:auto; overscroll-behavior-inline:contain; scrollbar-width:thin; scrollbar-color:var(--n-600) transparent; }
.diagram svg{ display:block; width:var(--dg-w); min-width:var(--dg-w); height:auto; }
.dg-box-strip{ fill:none; stroke:var(--n-600); stroke-width:1; stroke-dasharray:3 3; }
.dg-box{ fill:var(--n-850); stroke:var(--n-500); stroke-width:1; }
.dg-box-human{ fill:var(--warn-ink); stroke:var(--warn); }
.dg-box-refuse{ fill:var(--danger-ink); stroke:var(--danger); }
/* A phase that reads MORE THAN ONE upstream artifact: a dashed border, which is a SHAPE
   difference — the node's own third line states the count in words as well, so nothing
   here is carried by colour. */
.dg-box-fan{ fill:var(--n-800); stroke:var(--n-300); stroke-width:1; stroke-dasharray:4 2; }
/* The wildcard rail: one edge with eleven possible sources, drawn as a rail. */
.dg-box-rail{ fill:var(--n-800); stroke:var(--n-400); stroke-width:1; stroke-dasharray:1 3; }
/* A step that a gate can stop: the same fill, with the border the refusal column uses. */
.dg-box-gate{ fill:var(--n-850); stroke:var(--warn); stroke-width:1; stroke-dasharray:4 2; }
/* Text styles for the diagram, EMITTED FROM DG_TEXT so the size the boxes were
   computed at and the size the glyphs are drawn at are the same number. The checker
   re-reads these four declarations and re-derives the fit from them. */
${Object.entries(DG_TEXT).map(([k, v]) => `.${k}{ fill:${v.fill}; font-family:var(--mono); font-size:${v.size}px; }`).join('\n')}
.dg-line{ stroke:var(--n-500); stroke-width:1; fill:none; }
.dg-line-acc{ stroke:var(--accent); stroke-width:1; fill:none; }
.dg-line-warn{ stroke:var(--warn); stroke-width:1; fill:none; }
.dg-line-loop{ stroke:var(--violet); stroke-width:1; fill:none; stroke-dasharray:4 3; }
/* CONDITIONAL edge: dashed, and the legend and the edge table say which ones. The dash
   is the signal — a colour-blind reader loses nothing. */
.dg-line-cond{ stroke:var(--n-300); stroke-width:1; fill:none; stroke-dasharray:5 4; }
/* WILDCARD edge: twice as thick as every other edge. */
.dg-line-wide{ stroke:var(--n-400); stroke-width:2; fill:none; }
/* SEQUENCE ORDER, NOT AN INPUT: the dotted link between two adjacent nodes that the
   linter's input map does NOT connect. It is the only mark in the chart that says
   "adjacent" rather than "depends on", so it is the quietest stroke here and it is
   dotted rather than dashed — a third pattern, not a variant of the conditional one. */
.dg-line-seq{ stroke:var(--seq-dim); stroke-width:1; fill:none; stroke-dasharray:1 3; }
.dg-head{ fill:var(--n-500); }
.dg-head-acc{ fill:var(--accent); }
.dg-head-warn{ fill:var(--warn); }
.dg-head-loop{ fill:var(--violet); }
.dg-head-cond{ fill:var(--n-300); }
.dg-head-wide{ fill:var(--n-400); }
.dg-head-seq{ fill:var(--seq-dim); }
/* The human-decision marker above a node: an amber diamond, the same rotated square the
   overview rail uses for a human step, so "a person decides here" is ONE shape page-wide. */
.dg-mark{ fill:var(--warn); }
/* A legend swatch: a region, not a signal — its meaning is the label drawn beside it. */
.dg-legend{ fill:var(--n-850); stroke:var(--n-400); stroke-width:1; }
.dg-legend-cond{ fill:none; stroke:var(--n-300); stroke-width:1; stroke-dasharray:5 4; }
.dg-legend-seq{ fill:none; stroke:var(--seq-dim); stroke-width:1; stroke-dasharray:1 3; }
.dg-legend-rail{ fill:var(--n-800); stroke:var(--n-400); stroke-width:1; stroke-dasharray:1 3; }
.dg-legend-wide{ fill:none; stroke:var(--n-400); stroke-width:2; }
.dg-legend-refuse{ fill:var(--danger-ink); stroke:var(--danger); stroke-width:1; }

/* ---- misc --------------------------------------------------------------- */
footer.colophon{ border-top:1px solid var(--line-strong); margin-top:var(--sp-8); padding-top:var(--sp-5); font-size:var(--fs-3xs); color:var(--fg-faint); }
footer.colophon p{ margin-bottom:var(--sp-2); max-width:100ch; }
.kv{ display:grid; grid-template-columns:auto 1fr; gap:var(--sp-1) var(--sp-4); font-size:var(--fs-2xs); }
.kv dt{ color:var(--fg-faint); } .kv dd{ margin:0; color:var(--fg-2); }
.callout{ border:1px solid var(--warn-dim); border-left:2px solid var(--warn); background:rgba(240,179,87,0.05); border-radius:var(--r-2); padding:var(--sp-4); margin-bottom:var(--sp-5); font-size:var(--fs-2xs); color:var(--fg-2); }
.callout strong{ color:var(--warn); }
.ok-line{ color:var(--ok); }
.bad-line{ color:var(--danger); }

/* Below ~820px the two-column I/O grid and the label-column gate lists stop
   fitting, so both collapse to a single column. Type is already fluid via clamp,
   so no font-size override is needed here — a fixed override at one breakpoint is
   what makes text lurch at 819px. The tab strip needs no rule either: it is a
   single scrollable row at every width. */
@media (max-width:820px){
  .wrap{ padding:0 var(--sp-4) var(--sp-10); }
  .panel{ padding:var(--sp-4); }
  /* minmax(0,1fr) here too: a single-column grid whose item is a long citation is the
     same overflow risk as a multi-column one, just easier to miss. */
  .io{ grid-template-columns:minmax(0,1fr); }
  .step{ grid-template-columns:var(--sp-6) minmax(0,1fr); }
  .gate-list li, .refuse-list li{ grid-template-columns:minmax(0,1fr); gap:var(--sp-1); }
  .g-shape{ justify-self:start; }
  .masthead-top{ flex-direction:column; }
}
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{ animation-duration:0.001ms !important; animation-iteration-count:1 !important; transition-duration:0.001ms !important; scroll-behavior:auto !important; }
}
@media print{
  .tabstrip{ position:static; } .js .panel{ display:block !important; }
  body{ background:#fff; color:#000; }
}
</style>
</head>
<body>
<a class="skip" href="#tab-overview">Skip to the workflow overview</a>
<div class="wrap">

<header class="masthead">
  <div class="masthead-top">
    <div>
      <h1><span class="tick">▚</span> recursive-mode — the workflow</h1>
      <p class="mast-sub">Twelve phase artifacts wired by ${EDGES.length} directed edges, five DSH lifecycle seams, two hook points that can actually refuse, three human gates, a lock chain with seven refusals, and the cross-run learning loop that carries one run's memory into the next. Every factual block below carries the <code>file:line</code> it was transcribed from.</p>
    </div>
  </div>
  <div class="mast-meta">
    <span class="chip chip-acc"><b>12</b> phase artifacts</span>
    <span class="chip"><b>${EDGES.length}</b> artifact edges</span>
    <span class="chip"><b>13</b> tools (12 without agentTeams)</span>
    <span class="chip"><b>8</b> guard rules</span>
    <span class="chip chip-warn"><b>3</b> human gates + run-start</span>
    <span class="chip"><b>5</b> hook points</span>
    <span class="chip"><b>${TRAINING.kinds.length}</b> memory kinds read</span>
    <span class="chip"><b>24</b> RM#### codes</span>
    <span class="chip">source: <b>${esc(REPO)}</b></span>
  </div>
</header>

<nav class="tabstrip" aria-label="Workflow views">
  <p class="tabstrip-label" id="tabstrip-hint">Views — use ← → Home End to move between tabs</p>
  <div role="tablist" aria-labelledby="tabstrip-hint">
${tabs.map((t, i) => `    <button role="tab" id="tab-${t.id}" aria-controls="panel-${t.id}" aria-selected="${i === 0 ? 'true' : 'false'}" tabindex="${i === 0 ? '0' : '-1'}"><span class="tlabel">${esc(t.label)}</span><span class="tsub">${esc(t.sub)}</span></button>`).join('\n')}
  </div>
</nav>

<main id="main">

<!-- ===================== OVERVIEW — THE GRAPH ===================== -->
<section class="panel is-active" id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" tabindex="0">
  <div class="panel-head">
    <h2>The workflow, as a graph</h2>
    <p class="lede">Twelve phase artifacts in <code>PHASE_SEQUENCE</code> order, and every one of the ${EDGES.length} directed input edges between them, drawn. The whole graph is on this screen — twelve phases on two rows, every edge drawn between them, and the picture's own legend at the bottom. ${cite(SRC.seq + ', ' + SRC.inputMap)}</p>
    <p class="note">The facts this view used to carry as prose — what the <span class="tag tag-may-be-absent">${BADGE_MAY_BE_ABSENT}</span> badge means, the two optionality declarations, what the drawing deliberately leaves out — are in <a href="#tab-notes">Notes &amp; caveats</a>, and the per-phase detail is on the <a href="#tab-overview">twelve phase views</a>.</p>
  </div>

  ${dgOverview.markup}

  <h2 style="font-size:var(--fs-lg);margin:var(--sp-8) 0 var(--sp-4)">What each phase is FOR</h2>
  <p class="lede" style="margin-bottom:var(--sp-4)">One line per phase, and every line is sourced rather than written: the phase's own label from <code>PHASES</code> in <code>src/status.ts</code>, plus the required sections that phase must contain in <code>SECTION_MAP</code> — the strongest evidence in the repository for what a phase is for. ${cite(SRC.statusPhases + ', ' + SRC.sectionMapRoot)} <code>--verify</code> re-derives every named section from the parsed map, so a renamed section fails the build instead of leaving a stale sentence on the page.</p>
  <div class="tablewrap">
    <table>
      <caption>The purpose line, its label, and the required sections it was read from. The two Phase 0 purposes additionally quote their template's own Scope note, which exists for those two phases only. ${cite(SRC.tplScopeRequirements + ', ' + SRC.tplScopeWorktree)}</caption>
      <thead><tr><th>Phase</th><th>Label</th><th>What it is for</th><th>Read from</th></tr></thead>
      <tbody>
        ${PHASES.map((p) => `        <tr><td><code>${esc(p.file)}</code></td><td>${esc(p.purpose.label)}</td><td>${esc(p.purpose.t)}${p.purpose.tplText ? ` <span class="note">Template Scope note: “${esc(p.purpose.tplText)}”</span>` : ''}${cite(p.purpose.c)}</td><td>${p.purpose.sections.map((s) => `<code>## ${esc(s)}</code>`).join('<br>')}</td></tr>`).join('\n')}
      </tbody>
    </table>
  </div>
  <p class="note">⚠ <b>For phases 01-08 there is no per-phase PROSE in the repository to transcribe.</b> Every later-phase template carries the same generic line — <code>${esc('Scope note: Scaffold generated by the recursive-mode plugin (R5). Fill every required section before lint.')}</code> — so the section lists and the labels above are the sourcing, and this page says that instead of inventing a description. ${cite(SRC.tplScopeScaffold)}</p>

  <h2 style="font-size:var(--fs-lg);margin:var(--sp-8) 0 var(--sp-4)">Where the chain becomes a graph</h2>
  <p class="lede" style="margin-bottom:var(--sp-4)">${PHASES.filter((p) => sourcesOf(p.file) > 1).length} of the twelve phases read more than one upstream artifact. That is the difference between a sequence and a dependency graph, and it is why <code>src/phase-graph.ts</code> models the phases as a graph at all. ${cite(SRC.graphWhy)}</p>
  <div class="tablewrap">
    <table>
      <caption>The multi-source phases, with the artifact count each one is expected to re-read. ${cite(SRC.inputMap)}</caption>
      <thead><tr><th>Phase</th><th>Reads</th><th>Which artifacts</th><th>Source</th></tr></thead>
      <tbody>
        ${PHASES.filter((p) => sourcesOf(p.file) > 1).map((p) => `        <tr><td><code>${esc(p.file)}</code></td><td class="tnum">${sourcesOf(p.file)}${hasWildcard(p.file) ? ' <span class="tag">wildcard</span>' : ''}</td><td>${EDGES.filter((e) => e.to === p.file).map((e) => `<code>${esc(e.from === WILDCARD_INPUT ? 'every present artifact except itself' : e.from)}</code>${e.kind === 'conditional' ? ' <span class="tag tag-shape">when present</span>' : e.kind === 'wildcard' ? ' <span class="tag tag-shape">wildcard</span>' : ''}`).join('<br>')}</td><td>${cite([...new Set(EDGES.filter((e) => e.to === p.file).map((e) => e.c))].join(', '))}</td></tr>`).join('\n')}
      </tbody>
    </table>
  </div>
  <p class="note">The full set: <b>${EDGES.length} directed edges</b> — ${EDGES.filter((e) => e.kind === 'required').length} required, ${EDGES.filter((e) => e.kind === 'conditional').length} conditional, ${EDGES.filter((e) => e.kind === 'wildcard').length} wildcard — derived from <code>getPhaseExpectedInputArtifactNames</code> and drawn arrow by arrow in the <a href="#graph-edges">Phase graph</a> view. <code>00-requirements.md</code> is the graph's root and has no upstream artifact edge at all: the run starts at the conversation. ${cite(SRC.inputMap + ', ' + SRC.inputFilter)}</p>

  <h2 style="font-size:var(--fs-lg);margin:var(--sp-8) 0 var(--sp-4)">The twelve artifacts, in order</h2>

  <div class="rail-pair" style="margin-bottom:var(--sp-5)">
    <div class="subcard" style="border-left:2px solid var(--accent)">
      <h3>Index 0 — the spec</h3>
      <p class="note" style="margin-top:0"><code>00-requirements.md</code> is the one artifact that carries a HUMAN decision before anything else can happen. It is index 0 of twelve. ${cite(SRC.seq)}</p>
    </div>
    <div class="subcard" style="border-left:2px solid var(--warn)">
      <h3>Index 1 — the isolation</h3>
      <p class="note" style="margin-top:0"><code>00-worktree.md</code> shares phase <b>number</b> 0 but is a separate artifact, and supplies the executable diff basis every later audited phase reuses. ${cite(SRC.seq + ', ' + SRC.tplWorktree)}</p>
    </div>
  </div>

  <div class="flow">
${PHASES.map(phaseRow).join('\n')}
  </div>

  <h2 style="font-size:var(--fs-lg);margin:var(--sp-8) 0 var(--sp-4)">Two phases that SHARE a number</h2>
  <div class="tablewrap">
    <table>
      <caption>${cite(SRC.phaseNumber + ', ' + SRC.phaseOrderRule)} — <code>phaseNumberForArtifact</code> reads the LEADING DIGITS of the file name, so the pair below is ONE phase as far as the ordering guard is concerned.</caption>
      <thead><tr><th>Sharing</th><th>Artifacts</th><th>Consequence</th></tr></thead>
      <tbody>
        <tr><td><span class="seq">0</span></td><td><code>00-requirements.md</code> · <code>00-worktree.md</code></td><td>The phase-order rule ABSTAINS for either while phase 0 is active, so both are writable.</td></tr>
        <tr><td><span class="seq">1</span></td><td><code>01-as-is.md</code> · <code>01.5-root-cause.md</code></td><td>The leading digits of <code>01.5-root-cause.md</code> are <code>01</code> → <code>Number("01") = 1</code>. Same phase.</td></tr>
        <tr><td><span class="seq">3</span></td><td><code>03-implementation-summary.md</code> · <code>03.5-code-review.md</code></td><td>Same phase; the TDD-evidence baseline therefore applies to a lock of EITHER.</td></tr>
      </tbody>
    </table>
  </div>

  <h2 style="font-size:var(--fs-lg);margin:var(--sp-8) 0 var(--sp-4)">The late-phase set, and the separate rule that actually freezes phases 6-8</h2>
  <p class="lede" style="margin-bottom:var(--sp-4)"><code>LATE_PHASE_ARTIFACTS</code> is a three-member set declared separately from the sequence — and its one use in the shipped code is a <b>profile detector</b>, not a gate: the linter returns the compat workflow profile when any of the three artifacts exists on disk. ${cite(LATE.c + ', ' + SRC.lintLateProfile)}</p>
  <p class="lede" style="margin-bottom:var(--sp-4)">The freeze those three phases are known for comes from a DIFFERENT mechanism that keys on the phase <b>number</b>: <code>phaseBaselineRules</code> derives it with <code>phaseNumberForArtifact</code> and denies <code>write*</code> for phase 6, 7 or 8 — narrower than a path scope, so it bites without blocking the phase's own artifact edits. Phase 8 carries one carve-out: <code>.recursive/memory/**</code> is admitted, because phase 8's whole job is that plane and a blanket denial made the hard requirement unsatisfiable. ${cite(SRC.baseline + ', ' + SRC.phaseNumber + ', ' + SRC.ownMemoryPlane)}</p>
  <ul class="io-list" style="border:1px solid var(--line);border-radius:var(--r-2);padding:var(--sp-3) var(--sp-4);background:var(--surface-2)">
    ${LATE.files.map((f) => `<li><span class="doc doc-artifact">${esc(f)}</span>${cite(LATE.c)}</li>`).join('')}
  </ul>

  <h2 style="font-size:var(--fs-lg);margin:var(--sp-8) 0 var(--sp-4)">Where a step can be refused, at a glance</h2>
  <div class="tablewrap">
    <table>
      <caption>${cite(SRC.builtInRules + ', ' + SRC.baseline)} — the rules that can stop a call. "On" is the tool pattern the rule is scoped to.</caption>
      <thead><tr><th>Rule</th><th>What it says</th><th>On</th><th>Source</th></tr></thead>
      <tbody>
        ${GUARDS.map((g) => `<tr><td><code>${esc(g.k)}</code></td><td>${esc(g.what)}</td><td><code>${esc(g.on)}</code></td><td>${cite(g.c)}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>

  <h2 style="font-size:var(--fs-lg);margin:var(--sp-8) 0 var(--sp-4)">Automatic vs human — the whole decision surface</h2>
  <div class="tablewrap">
    <table>
      <caption>A complete list of the places a PERSON must decide. Everything else in this workflow is automatic or a mechanical refusal. ${cite(SRC.startGate + ', ' + SRC.askGates)}</caption>
      <thead><tr><th>#</th><th>Decision</th><th>Labels</th><th>Recorded in</th><th>Source</th></tr></thead>
      <tbody>
        <tr><td><span class="seq">1</span></td><td><b>Start run or Hold</b> — decides whether a run exists at all. Approving arms a goal the harness then drives.</td><td><code>Start run</code> | <code>Hold</code></td><td><code>00-requirements.md</code> as <code>- Run Start: …</code></td><td>${cite(SRC.startLabels + ', ' + SRC.startLine)}</td></tr>
        <tr><td><span class="seq">2</span></td><td><b>TDD Mode</b> — how phase 3 must evidence its tests.</td><td><code>strict</code> | <code>pragmatic</code></td><td>The artifact's <code>TDD Mode</code> field</td><td>${cite(SRC.askTdd)}</td></tr>
        <tr><td><span class="seq">3</span></td><td><b>QA sign-off</b> — who signs the manual QA phase.</td><td><code>human</code> | <code>agent-operated</code> | <code>hybrid</code></td><td>The artifact's <code>QA Execution Mode</code> field</td><td>${cite(SRC.askQa)}</td></tr>
        <tr><td><span class="seq">4</span></td><td><b>Gate block</b> — how a blocked transition is resolved. Raised WITH the refusal, so the choice travels with the problem.</td><td><code>fix</code> | <code>reopen</code> | <code>abandon</code></td><td>The artifact's <code>Gate Resolution</code> field</td><td>${cite(SRC.askGateBlock + ', ' + SRC.blockGoal)}</td></tr>
        <tr><td><span class="seq">5</span></td><td><b>QA sign-off evidence</b> — for <code>human</code>/<code>hybrid</code> the lock additionally requires a meaningful <code>Approved by</code> and <code>Date</code> in <code>## User Sign-Off</code>.</td><td>a name + a date</td><td><code>05-manual-qa.md</code></td><td>${cite('src/lifecycle.ts:108-114, ' + SRC.lintQaSignoff)}</td></tr>
      </tbody>
    </table>
  </div>

  <h2 style="font-size:var(--fs-lg);margin:var(--sp-8) 0 var(--sp-4)">The lock chain — what a lock actually checks, in order</h2>
  <ol class="chain">
    ${LOCK_CHAIN.map((s) => `<li><div><span class="ct">${esc(s.t)}</span><span class="cd">${esc(s.d)} ${cite(s.c)}</span></div></li>`).join('\n    ')}
  </ol>
  <p class="note">The order is load-bearing and stated in the source: lock order stays FIRST, so a run that is both out of order and below standard still reports ORDERING; the linter stays LAST, its documented invariant. ${cite(SRC.lintGate)} A lock is refused, never silently downgraded — <code>lockArtifact</code> has no mode input and the lock chain has never been advisory-gated. ${cite(SRC.memoryGate)}</p>

  <h2 style="font-size:var(--fs-lg);margin:var(--sp-8) 0 var(--sp-4)">Strict vs advisory</h2>
  <div class="tablewrap">
    <table>
      <caption>${cite(SRC.mode + ', ' + SRC.modeDefault + ', ' + SRC.verdictFor + ', ' + SRC.coerce)} — the mode is <code>strict</code> by default, and it decides only what the GUARD does with a policy verdict. The lock chain is unaffected either way.</caption>
      <thead><tr><th>Mode</th><th>What a policy <code>deny</code> becomes</th><th>What an <code>ask</code> becomes</th></tr></thead>
      <tbody>
        <tr><td><code>strict</code> <span class="tag tag-tdd">default</span></td><td><code>deny</code> — and when the refusal was decided from real ordering blockers it also carries the <code>fix | reopen | abandon</code> ask.</td><td><code>deny</code>: <code>ask under strict enforcement denies</code></td></tr>
        <tr><td><code>advisory</code></td><td><code>ask</code> (reason preserved), then coerced to an <strong>allow with a warning</strong> so an advisory pass is never silent.</td><td><code>allow</code> + <code>warn</code>: <code>ask under advisory enforcement allows</code></td></tr>
      </tbody>
    </table>
  </div>

  <div class="callout" style="margin-top:var(--sp-5)">
    <strong>A refusal does not surface as a tool error.</strong> A <code>tools/pre-execute</code> deny becomes <code>content: [{ type: 'text', text: 'Error: ' + reason }]</code> and every other field of the decision is dropped — which is why the gate-block ask has to be RENDERED INTO THE SENTENCE to reach the caller at all. ${cite(SRC.denyText)}
  </div>
</section>

<!-- ===================== NOTES &amp; CAVEATS ===================== -->
<section class="panel" id="panel-notes" role="tabpanel" aria-labelledby="tab-notes" tabindex="0" hidden>
  <div class="panel-head">
    <h2>Notes &amp; caveats</h2>
    <p class="lede">The facts that used to sit ABOVE the overview chart as prose, moved here on purpose: the chart is the overview now, and a sentence that explains what a picture should show is a sign the picture was wrong. Nothing was dropped — each block below landed here, or in a phase view, or nowhere it was needed. ${cite(SRC.inputMap + ', ' + SRC.seq)}</p>
  </div>

  <div class="callout">
    <strong>Reading the shapes, not the colours.</strong> Every gate on this page carries a word — <b>DECISION</b>, <b>REFUSAL</b> or <b>AUTO</b> — and a border treatment, and every mark in the overview chart carries a word beside it, so nothing here depends on colour alone. The human steps are also the only cards with a filled amber rail dot, and in the chart they are the only ones with an amber diamond above them. ${cite(SRC.seq)}
  </div>

  <div class="callout">
    <strong>All twelve artifacts are MANDATORY work. Nothing here is an optional phase.</strong>
    Every phase row carries a <span class="tag tag-may-be-absent">${BADGE_MAY_BE_ABSENT}</span> badge, and it is worth stating plainly what that badge does <em>not</em> mean: it does not mean the phase is optional. It is the property of one SET — <code>lock.ts</code> <code>OPTIONAL_PHASES</code>, whose only use in the plugin is <code>nextLegalPhase(graph, { optional: OPTIONAL_PHASES })</code>, i.e. "a member that is ABSENT does not stop the legal-phase selector". That is a statement about a fallback query, not about the work.
    <br><br>
    <b>The positive fact, which the plugin enforces end to end:</b> <code>recursive_init</code> scaffolds <b>all twelve</b> artifacts in one call — the two Phase 0 templates and then every later phase — so a scaffolded run has no missing phase to skip. ${cite(SRC.scaffoldLoop)} All twelve then lock <b>in sequence</b>: <code>PHASE_SEQUENCE</code> is the canonical order and the lock chain refuses out of order. ${cite(SRC.seq + ', ' + SRC.lockArtifact)} And a normal run produces twelve: the seven <em>may-be-absent</em> phases are written and locked exactly like the other five, because the scaffold writes them and the sequence locks them — being able to be ABSENT is not the same as being permitted to be absent.
    <br><br>
    <span class="unv">⚠ Stated precisely, because this is the whole point of the badge change:</span> the seven <em>may-be-absent</em> phases are the seven members of <code>OPTIONAL_PHASES</code>, and their badge means only that an <b>absent</b> one will not block the chain. Whether a phase's WORK is optional is not a property any code in this repo declares, and this page no longer implies one.
    <br><br>
    <span class="unv">⚠ AND THIS IS A REAL INCONSISTENCY IN THE REPOSITORY, reported rather than smoothed over.</span> There are <b>two independent optionality declarations</b> and they disagree. <code>lock.ts</code> <code>OPTIONAL_PHASES</code> has seven members, and it is what the legal-phase selector uses; <code>status.ts</code> carries its own <code>optional:</code> flag on the twelve-row status table and marks only <b>two</b> — <code>01.5-root-cause.md</code> and <code>03.5-code-review.md</code>. That second flag is load-bearing in two places: a missing phase is reported <code>SKIPPED</code> from it, and <code>snapshot.ts</code> computes a run's <code>complete</code> state by requiring every phase where <code>!p.optional</code>. So five of these seven phases are treated as <b>required</b> by the run-completion calculation while the selector treats them as skippable. Both readings are honest; they are just not the same reading, and a reader deserves to know which one is speaking. ${cite(SRC.statusPhases + ', ' + SRC.statusOptional + ', ' + SRC.snapshotComplete + ', ' + SRC.optional)}
  </div>

  <div class="callout">
    <strong>Why the workflow is a graph and not a chain.</strong> Three queries in the plugin are graph operations being run over a linear array: <code>getStaleDownstreamPhases</code> is a REACHABILITY query, <code>getPrerequisites</code> is an IN-EDGE query, and <code>getNextLegalPhase</code> is a topological walk. An array can answer all three only while the dependency happens to be linear — and the moment an artifact depends on something LATER than itself, the array model answers <em>wrongly</em> rather than not at all. ${cite(SRC.graphWhy)}
    <br><br>
    Two of the ${EDGES.length} edges cross a phase boundary the sequence order alone would not suggest: <code>03.5-code-review.md</code> reads <code>03-implementation-summary.md</code> (the SAME phase number 3), and <code>05-manual-qa.md</code> reads <code>02-to-be-plan.md</code> — three nodes back. Neither is a BACKWARD edge in the graph sense: every one of the ${EDGES.length} input edges runs forward in <code>PHASE_SEQUENCE</code>, which the generator ASSERTS before it draws one, because the lane routing cannot represent an edge that runs backwards. The backwards movement in this workflow comes from the two loops, not from an input edge. ${cite(SRC.inputMap + ', ' + SRC.seq)}
  </div>

  <div class="callout">
    <strong>How to read the chart's own marks.</strong> A <b>solid</b> arrow is a REQUIRED input. A <b>dashed</b> arrow is CONDITIONAL: the linter pushes that artifact only when it exists on disk (<code>present.has(…)</code>), so the edge is real but optional. A <b>thick</b> arrow comes off the rail under the row: that input is <em>every present artifact in the run except itself</em>, which is why phases 06 and 08 have eleven possible sources and no single required one. A <b>dotted</b> link is the SEQUENCE ORDER and carries no input edge at all — two adjacent pairs have none, and drawing them as solid arrows would claim an edge the linter does not declare. A node with a <b>dashed border</b> reads more than one upstream artifact, and every node states its own fan-in in words. ${cite(SRC.inputMap + ', ' + SRC.inputFilter + ', ' + SRC.lintWildcard06 + ', ' + SRC.lintWildcard08)}
    <br><br><b>The twelve phases are on TWO rows, and the whole graph is on screen at once.</b> Row 1 reads left to right and row 2 right to left, joined at the boundary by a thick <b>spine</b> arrow — the same 03-implementation-summary → 03.5-code-review edge the linter declares, drawn as the one stroke that fits in a single column. The chart is 1128 units wide, so it does not scroll sideways at any window from 1280px up; below that the wrapper still scrolls in one strip rather than squeezing twelve artifact names, which cannot be abbreviated without losing the names the rest of this page cites. Every arrow in it is also a row in the table below, and the table is the complete form.
  </div>

  <h3 id="graph-edges">Every edge, in full</h3>
  <div class="tablewrap">
    <table>
      <caption>All ${EDGES.length} declared input edges, from → to. This table is the accessible equivalent of the overview chart: no edge exists in the picture that is not a row here, and no row here is missing from the picture. ${cite(SRC.inputMap)}</caption>
      <thead><tr><th>#</th><th>From</th><th>To</th><th>Kind</th><th>Source</th></tr></thead>
      <tbody>
        ${EDGES.map((e, i) => `        <tr><td><span class="seq">${i + 1}</span></td><td><code>${esc(e.from)}</code></td><td><code>${esc(e.to)}</code></td><td>${e.kind === 'required' ? 'required' : e.kind === 'conditional' ? '<span class="tag tag-shape">conditional — when present</span>' : '<span class="tag tag-shape">wildcard — every present artifact</span>'}</td><td>${cite(e.c)}</td></tr>`).join('\n')}
      </tbody>
    </table>
  </div>

  <h3 style="margin-top:var(--sp-6)">The fan-in, per phase</h3>
  <div class="tablewrap">
    <table>
      <caption>How many upstream artifacts each phase is expected to re-read. ${WILDCARD_SOURCES} is the wildcard's real count: every other member of the run. ${cite(SRC.inputMap + ', ' + SRC.lintSequence)}</caption>
      <thead><tr><th>Phase</th><th>Fan-in</th><th>Kind</th><th>Source</th></tr></thead>
      <tbody>
        ${PHASES.map((p) => `        <tr><td><code>${esc(p.file)}</code></td><td class="tnum">${fanInOf(p.file) === 0 ? '0' : sourcesOf(p.file)}</td><td>${fanInOf(p.file) === 0 ? 'the root — the run starts at the conversation' : hasWildcard(p.file) ? 'wildcard' : conditionalFanIn(p.file) > 0 ? `${conditionalFanIn(p.file)} of them conditional` : 'required only'}</td><td>${cite(SRC.inputMap)}</td></tr>`).join('\n')}
      </tbody>
    </table>
  </div>

  <h3 style="margin-top:var(--sp-6)">What the chart deliberately does NOT draw, and what could not be sourced</h3>
  <ul class="refuse-list">
    <li><span class="g-shape g-shape-refuse">NOT DRAWN</span><span><b>The two human gates that are not a node's own decision — <code>tdd-mode</code> and <code>qa-signoff</code> are attached to a phase, not to a separate step, so they are drawn as a marker above the phase they belong to rather than as a box of their own.</b> <code>recursive_ask</code>'s three workflow gates belong to phases 3 (<code>tdd-mode</code>) and 5 (<code>qa-signoff</code>), plus <code>gate-block</code>, which any refused transition can raise. ${cite(SRC.askGates + ', ' + SRC.askTdd + ', ' + SRC.askQa)}</span></li>
    <li><span class="g-shape g-shape-refuse">NOT DRAWN</span><span><b>The refusal marks are the RULES, not the phases.</b> The hatched band under a node names the guard rule and the tool pattern it fires on; the phase's own refusal list is on its phase view. A phase with no mark can still be refused by the lock chain — <code>lock-order</code> and the linter are not node-local. ${cite(SRC.builtInRules + ', ' + SRC.lintGate)}</span></li>
    <li><span class="g-shape g-shape-refuse">UNVERIFIED</span><span><b>A per-phase PROSE description of each phase's job, for phases 01-08.</b> The repository does not contain one. <code>laterPhaseContent</code> writes the same generic Scope note for every later phase — <code>${esc('Scaffold generated by the recursive-mode plugin (R5). Fill every required section before lint.')}</code> — so the purpose lines on this page are built from the phase LABEL and its REQUIRED SECTIONS, which is what the code actually states, plus the two Phase 0 templates' own Scope notes. Nothing was written to fill the gap. ${cite(SRC.tplScopeScaffold)}</span></li>
    <li><span class="g-shape g-shape-refuse">UNVERIFIED</span><span><b>Whether a real run's artifacts actually CITE the artifacts the map expects.</b> This page draws what the linter DEMANDS. It makes no claim about any particular run's <code>Inputs:</code> header — the check that reads it (<code>lint_effective_input_addenda</code>) reports per run, and no run was examined here. ${cite(SRC.effectiveInputs)}</span></li>
    <li><span class="g-shape g-shape-refuse">UNVERIFIED</span><span><b>Addendum edges.</b> <code>src/phase-graph.ts</code> adds edges for addenda attached to a phase, and this drawing does not include them: they are per-run files rather than a fixed part of the workflow, so there is nothing in <code>src/</code> to fix their number. ${cite(SRC.graphAddendum)}</span></li>
  </ul>
</section>

<!-- ===================== PHASE 0 GATE ===================== -->
<section class="panel" id="panel-start" role="tabpanel" aria-labelledby="tab-start" tabindex="0" hidden>
  <div class="panel-head">
    <h2>Phase 0 — the one gate that decides whether there is a run</h2>
    <p class="lede">Starting a run is a human decision, not a side effect of scaffolding. This view is the mechanism in full, because it is the only place the workflow can be stopped before it begins. ${cite(SRC.startModule)}</p>
  </div>

  <div class="detail-grid">
    <section class="card">
      <h3>The defect this closes</h3>
      <p class="note" style="margin-top:0"><code>recursive_init</code> scaffolded a run and the plugin then CREATED AND ARMED a goal for it in the same breath. A goal is not a label: creating one returns an ARMED view and the harness immediately begins driving autonomous goal rounds. Asking for a run spec was therefore enough to start an unattended run. ${cite(SRC.startModule)}</p>
    </section>
    <section class="card">
      <h3>What is withheld</h3>
      <p class="note" style="margin-top:0">The GOAL — the object that makes the harness drive rounds. The scaffold, the Phase 0 artifacts and every later phase document are still created. A run that is scaffolded and never approved is a spec: <em>readable, editable, lockable, and inert.</em> ${cite(SRC.startModule)}</p>
    </section>

    <section class="card card-wide">
      <h3>The gate, as data</h3>
      <div class="ask">
        <div class="ask-head"><code>gate id: run-start</code><span class="ask-header">Start run</span></div>
        <p class="ask-q">Approve phase 0 and start this run? Approving creates an armed goal the harness will keep driving.</p>
        <ul class="ask-opts">
          <li><b>Start run</b> — record the approval and arm the run goal.</li>
          <li><b>Hold</b> — leave the spec inert: no run goal, no autonomous rounds.</li>
        </ul>
        ${cite(SRC.startGate)}
      </div>
      <p class="note">Deliberately NOT in <code>ASK_GATE_IDS</code>. Those three are the WORKFLOW's gates; starting a run is a different kind of decision, and their membership is asserted as exactly three — so widening the workflow's gate list cannot quietly widen what may start a run. ${cite(SRC.startNotAGate)}</p>
    </section>

    <section class="card card-wide">
      <h3>The route, in order — the channel first, the relay only as a named fallback</h3>
      <ol class="chain">
        <li><div><span class="ct">Ordering guard — refuse to ASK at all</span><span class="cd"><code>runStartSpecGuard</code> runs BEFORE the question is put to anybody. It refuses when <code>00-requirements.md</code> is missing, and when it still classifies as the template scaffold — quoting the placeholder lines and their line numbers verbatim in the refusal (RM4404). A missing artifact is refused too: the gate's own question has no referent without it. ${cite(SRC.startGuard)}</span></div></li>
        <li><div><span class="ct">The mounted human channel is asked</span><span class="cd">When the composition mounts <code>ctx.userQuestions</code> — the harness's own blocking human channel, the same one plan-mode's exit uses — the question is PUT TO THE PERSON and only their selection is recorded. A caller-supplied answer cannot stand in for it. ${cite(SRC.startModule)}</span></div></li>
        <li><div><span class="ct">The value is the decision</span><span class="cd">The approving label is written into the Phase 0 requirements document, and the gate REFUSES an answer that is not one of the labels it offered. An unoffered answer is a transcription error wearing the shape of a decision. ${cite(SRC.startModule)}</span></div></li>
        <li><div><span class="ct">Matched on the VALUE, never on the line's presence</span><span class="cd"><code>readRunStartApproval</code> reads the field's VALUE, so a recorded <code>- Run Start: Hold</code> is refused — a check for "is there a Run Start line?" would read a refusal as consent, the one mistake this module exists to prevent. ${cite(SRC.startValueMatch + ', ' + SRC.startApproval)}</span></div></li>
        <li><div><span class="ct">Relay — the named fallback</span><span class="cd">Only when the channel cannot deliver the question. Then <code>relay=true</code> with an explicit answer records it, and the result reports <code>source: "relayed"</code> rather than as a person's own selection. A failure meaning the question was <b>cancelled, aborted or timed out is NEVER relayable</b> (RM5503); a channel that answered off-vocabulary ends the call (RM5504) and no relayed answer can replace a decision the person actually made; a composition with NO channel at all falls back to the relayed answer unconditionally (RM5502). ${cite(SRC.startNotApproved + ', ' + SRC.errNoChannel + ', ' + SRC.errUnanswered)}</span></div></li>
        <li><div><span class="ct">The goal cannot exist without it</span><span class="cd"><code>syncRunGoal</code> refuses to create a goal for a run whose approval record is absent, in EVERY branch that would create one — not only the "no goal yet" branch, because a single unguarded branch is how the defect existed. ${cite(SRC.startModule)}</span></div></li>
      </ol>
    </section>

    <section class="card card-wide">
      <h3>The two shape differences from every other gate</h3>
      <div class="rail-pair">
        <div class="subcard">
          <h3>relay is run-start only</h3>
          <p class="note" style="margin-top:var(--sp-2)">The other three gates never consult the channel, so accepting <code>relay</code> there would report a fallback that did not happen. Passing it is refused (RM1150). ${cite(SRC.askRelayOnly)}</p>
        </div>
        <div class="subcard">
          <h3>the artifact is fixed</h3>
          <p class="note" style="margin-top:var(--sp-2)">Every other gate keeps its per-gate default and its override; run-start is ALWAYS recorded in <code>00-requirements.md</code>, because letting a caller aim the approval elsewhere is how an approval ends up in a file no reader looks at. ${cite(SRC.askFixedArtifact)}</p>
        </div>
      </div>
    </section>
  </div>
</section>

${PHASES.map(phaseDetail).join('\n')}

<!-- ===================== HOOKS ===================== -->
<section class="panel" id="panel-hooks" role="tabpanel" aria-labelledby="tab-hooks" tabindex="0" hidden>
  <div class="panel-head">
    <h2>Hooks &amp; seams — where this plugin attaches</h2>
    <p class="lede">Two layers: the DSH <b>seams</b> the plugin subscribes to, and the plugin's own named <b>hook points</b>, which map onto three of them. Only two hook bindings are registered, and both are GATING. ${cite(SRC.hookPoints)}</p>
  </div>

  <h3>The five hook points</h3>
  <div class="tablewrap">
    <table>
      <caption>${cite(SRC.hookPoints + ', ' + SRC.hookGating)} — <code>HOOK_POINTS</code>, its mapping onto DSH seams, and which points may stop work.</caption>
      <thead><tr><th>Point</th><th>Maps onto</th><th>May stop?</th><th>Failure default</th><th>Registered bindings</th></tr></thead>
      <tbody>
        ${HOOKS.map((h) => `<tr><td><code>${esc(h.point)}</code></td><td>${esc(h.maps)}</td><td>${h.gating ? '<b>GATING</b>' : 'observe only'}</td><td><code>${esc(h.policy)}</code></td><td>${h.registered.length ? h.registered.map((r) => esc(r)).join('<br>') : '<span style="color:var(--fg-faint)">none</span>'}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>

  <div class="callout" style="margin-top:var(--sp-5)">
    <strong>An observing point cannot deny, and the registry ENFORCES it.</strong> <code>post_generate</code> and <code>post_trigger</code> run after the model message has already streamed, so a deny there could not un-send it — a veto that vetoes nothing. A deny from an observing point is downgraded to <code>continue</code> and REPORTED as an annotation, so the attempt is visible rather than silently ignored or silently obeyed. ${cite(SRC.hookDowngrade)}
  </div>
  <div class="callout">
    <strong>Failure defaults differ by point, on purpose.</strong> A gating point that cannot decide must not proceed (<code>fail_closed</code>); an observing point that fails must not break the turn it was only watching (<code>fail_open</code>). Getting this backwards in either direction is the classic hook bug: one bricks the run, the other hides the failure. ${cite(SRC.hookFailure)}
  </div>

  <h3 style="margin-top:var(--sp-6)">The DSH seams, with what each does</h3>
  <div class="tablewrap">
    <table>
      <caption>Every attachment point the plugin registers, and when it fires. ${cite(SRC.toolsReg + ', ' + SRC.preExecute)}</caption>
      <thead><tr><th>Seam</th><th>Fires</th><th>What it does</th><th>Source</th></tr></thead>
      <tbody>
        ${SEAMS.map((s) => `<tr><td><code>${s.seam}</code></td><td>${esc(s.when)}</td><td>${esc(s.act)}</td><td>${cite(s.c)}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>

  <h3 style="margin-top:var(--sp-6)">What fires at a normal step</h3>
  <ol class="chain">
    <li><div><span class="ct">1 · <code>agent/pre-step</code></span><span class="cd">The scaffold is repaired once per root, then THIS phase's lint rules are injected — at most once per <code>(root, runId, phase)</code>, and only while the phase doc's status is <code>DRAFT</code>. The listener delegates first so later listeners keep veto power. ${cite(SRC.preStep + ', ' + SRC.reminderGate)}</span></div></li>
    <li><div><span class="ct">2 · the model asks for a tool</span><span class="cd"><code>tools/pre-execute</code> resolves the root from the session cwd and the active run id FROM THE FILESYSTEM, deliberately with no cache — a run created moments ago must be visible immediately, and a cached run id would silently reintroduce the empty-runId bug. ${cite(SRC.preExecute)}</span></div></li>
    <li><div><span class="ct">3 · the <code>pre_trigger</code> chain runs</span><span class="cd"><code>exit-plan-mode-gate</code> at priority 5 runs BEFORE <code>builtin-tool-guard</code> at priority 0, so a workflow-shaped refusal is the reason the caller sees rather than something the generic guard restates. ${cite(SRC.guardRegister + ', ' + SRC.planGate)}</span></div></li>
    <li><div><span class="ct">4 · the decision is logged and returned verbatim</span><span class="cd">EVERY decision is logged, allows included, so the rolling trace shows what the guard decided and why. The guard's own object is returned verbatim — that is what keeps the pinned guard contract byte-identical. ${cite(SRC.guardLog)}</span></div></li>
    <li><div><span class="ct">5 · <code>fs/observed</code></span><span class="cd">After a successful write, a lock tamper is recorded. Synchronous, observe-only, and contractually forbidden from throwing. ${cite(SRC.fsObserved)}</span></div></li>
    <li><div><span class="ct">6 · <code>session/event</code></span><span class="cd">A delegated child's settlement is captured at DELIVERY time, not by scanning session history — synchronous reads of arbitrary history are deprecated and lint-enforced. ${cite(SRC.sessionEvent + ', ' + SRC.settlementSeam)}</span></div></li>
  </ol>
</section>

<!-- ===================== GUARDS ===================== -->
<section class="panel" id="panel-guards" role="tabpanel" aria-labelledby="tab-guards" tabindex="0" hidden>
  <div class="panel-head">
    <h2>Guards &amp; refusals — what says no, and where</h2>
    <p class="lede">A refusal happens at two layers, and both describe the same violation: the GUARD refuses pre-dispatch at <code>tools/pre-execute</code>, and the TOOL refuses again inside <code>lockArtifact</code>. ${cite(SRC.blockGoal)}</p>
  </div>

  <h3>The built-in rule list</h3>
  <div class="tablewrap">
    <table>
      <caption>${cite(SRC.builtInRules)} — built in this order. Every <code>deny</code> precedes the catch-all <code>allow</code>, which is what makes "deny wins over allow" a fact about the list rather than a hope. Predicates ABSTAIN (<code>null</code>) when their condition does not apply, so a matched-but-clean write falls through to the allow.</caption>
      <thead><tr><th>Rule</th><th>Reason (verbatim)</th><th>Tool pattern</th><th>Mode behaviour</th><th>Source</th></tr></thead>
      <tbody>
        ${GUARDS.map((g) => `<tr><td><code>${esc(g.k)}</code></td><td>${esc(g.what)}</td><td><code>${esc(g.on)}</code></td><td>${esc(g.mode)}${g.modeC ? cite(g.modeC) : ''}</td><td>${cite(g.c)}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>

  <h3 style="margin-top:var(--sp-6)">Narrowing is mechanical, not a convention</h3>
  <p class="note">A phase baseline rule whose verdict is ranked ABOVE the strictest global verdict for the same pattern is DROPPED before it can be evaluated — so no per-phase baseline can turn a global <code>deny</code> into an <code>allow</code>. The rank order is <code>deny &lt; ask &lt; allow</code>, lower being stricter, and that ordering IS the narrowing rule. No baseline rule uses the bare catch-all <code>*</code>, because such a rule would outrank every specific global rule at once — including <code>recursive_lock*</code> — and deny the phase its own tools. ${cite(SRC.verdictRank + ', ' + SRC.narrowing)}</p>

  <h3 style="margin-top:var(--sp-6)">The phase-order rule's four outcomes</h3>
  <div class="tablewrap">
    <table>
      <caption>${cite(SRC.phaseOrderRule)} — scope is a DIRECT CHILD of the active run directory, which is what keeps the rule off support files: <code>evidence/</code>, <code>scratch/</code>, <code>addenda/</code>, <code>subagents/</code> and a plain <code>&lt;run&gt;/notes.md</code> are not phases.</caption>
      <thead><tr><th>Target relative to the active phase</th><th>Verdict</th><th>Why</th></tr></thead>
      <tbody>
        <tr><td>the ACTIVE artifact, or one sharing its phase number</td><td><span class="tag tag-tdd">ABSTAIN → allowed</span></td><td>The active artifact stays writable at every phase. This allow half is load-bearing: an enforcement rule in this area was once the bug, denying the run's OWN artifacts in every phase. ${cite(SRC.phaseOrderRule + ', ' + SRC.phaseOrderAllow)}</td></tr>
        <tr><td>an EARLIER phase</td><td><span class="tag tag-tdd">ABSTAIN</span></td><td>Such an artifact is LOCKED by construction, so the locked-write rule above decides it and its label is preserved. ${cite(SRC.phaseOrderRule)}</td></tr>
        <tr><td>a LATER phase</td><td><span class="tag tag-refuse">DENY</span></td><td>Working ahead. The hole this closed: ordering enforced on <code>recursive_lock</code> ONLY let an agent write <code>08-memory-impact.md</code> while the run sat at phase 0 — and a live run did exactly that, twelve artifacts written out of order with not one locked. ${cite(SRC.phaseOrderRule + ', ' + SRC.phaseOrderHole)}</td></tr>
        <tr><td>no active phase / another run / a support file / a non-<code>.md</code></td><td><span class="tag">ABSTAIN</span></td><td>Never guess a phase; another run's tree is a different question. ${cite(SRC.phaseOrderRule)}</td></tr>
      </tbody>
    </table>
  </div>

  <h3 style="margin-top:var(--sp-6)">The memory-read rule — the narrowest of the three</h3>
  <p class="note">Three rules carry the SAME write-tool patterns, and the engine decides equally specific rules by FILE ORDER: <code>locked-write</code>, then <code>phase-order</code>, then <code>memory-read</code>. That order is the precedence, and it is why an out-of-order write is never reported as a memory refusal. ${cite(SRC.builtInRules)}</p>
  <div class="tablewrap">
    <table>
      <caption>${cite(SRC.memoryReadRule)} — a write to a PHASE-0 artifact is denied while the run holds no memory read receipt for it. Every other target abstains.</caption>
      <thead><tr><th>Target</th><th>Verdict</th><th>Why</th></tr></thead>
      <tbody>
        <tr><td><code>00-requirements.md</code> / <code>00-worktree.md</code>, unlocked, with NO read receipt</td><td><span class="tag tag-refuse">DENY</span></td><td>The first write to a phase-0 artifact is gated on memory having been read. The gate is decided from the RECEIPT, never from the artifact text — a caller controls the text and could forge it.</td></tr>
        <tr><td>the same, when an empty memory plane matched nothing</td><td><span class="tag tag-tdd">ABSTAIN</span></td><td><code>recordMemoryRead</code> writes a receipt on every phase entry with <code>injected: false</code> when nothing matched, so an EMPTY PLANE SATISFIES the gate while a never-entered phase does not — and the two cannot be confused, because one of them has a row.</td></tr>
        <tr><td>a target of the same phase number greater than 0</td><td><span class="tag">ABSTAIN</span></td><td>Only phase 0 opens a run.</td></tr>
        <tr><td>a LATER phase's artifact / a LOCKED target / not a direct child of the run</td><td><span class="tag">ABSTAIN</span></td><td>The other rules own those cases, and a completed run is not re-gated. Keeping the gate off the general write path is asserted by a spec that walks the run's support files and shows they stay writable.</td></tr>
      </tbody>
    </table>
  </div>

  <h3 style="margin-top:var(--sp-6)">Every numbered code</h3>
  <div class="tablewrap">
    <table>
      <caption>${cite(SRC.errClasses + ', ' + SRC.errRegistry)} — <code>RM&lt;group&gt;&lt;serial&gt;</code>, where the THIRD character is the class group: 1 input, 2 value, 3 workspace, 4 state, 5 runtime, 6 capability. A test asserts the third character matches the entry's own class, so the grouping cannot drift. Every error renders as ONE sentence: <code>&lt;code&gt; &lt;class&gt;: &lt;problem&gt; - &lt;detail&gt;. Next: &lt;the exact call that resolves it&gt;.</code></caption>
      <thead><tr><th>Code</th><th>Class</th><th>Problem</th><th>Belongs to</th></tr></thead>
      <tbody>
        ${ERRORS.map((e) => `<tr><td><code>${esc(e.code)}</code></td><td class="k-${esc(e.k)}">${esc(e.k)}</td><td>${esc(e.p)}</td><td>${esc(e.where)}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>
</section>

<!-- ===================== LOOPS ===================== -->
<section class="panel" id="panel-loops" role="tabpanel" aria-labelledby="tab-loops" tabindex="0" hidden>
  <div class="panel-head">
    <h2>The backward loop — seven places the flow is not a straight line</h2>
    <p class="lede">This is a real property of the workflow, not a caveat. A review that comes back REVISE sends work BACK; a reopen moves the run backwards in the sequence; and the phase dependency is modelled as a GRAPH precisely because an artifact can depend on something LATER than itself. ${cite(SRC.graphWhy)}</p>
  </div>

  ${LOOPS.map((l) => `
  <article class="loop" id="loop-${esc(l.n)}">
    <h3><span class="lid">${esc(l.n)}</span>${esc(l.title)}</h3>
    <p>${esc(l.what)}</p>
    <p>${cite(l.c)}</p>
  </article>`).join('')}

  <h3 style="margin-top:var(--sp-6)">Why the graph model exists at all</h3>
  <p class="note">Three queries in the plugin are graph operations being run over a linear array: <code>getStaleDownstreamPhases</code> is a REACHABILITY query, <code>getPrerequisites</code> is an IN-EDGE query, and <code>getNextLegalPhase</code> is a topological walk. An array can answer all three only while the dependency happens to be linear — and the moment an artifact depends on something LATER than itself, the array model answers <em>wrongly</em> rather than not at all. ${cite(SRC.graphWhy)}</p>
  <p class="note">It is a hand-rolled graph deliberately: the item's own note records that Effect ships a stable, runtime-free <code>Graph</code> doing exactly this, and adopting it would trade the plugin's zero-dependency posture and its parity goldens for a few hundred lines it does not need. ${cite(SRC.graphWhy)}</p>
  <p class="note"><span class="unv">⚠ Not verified here:</span> whether a back-edge occurs in practice depends on an addendum being filed with a forward citation. The code supports it and reports it; this page does not claim any particular run produced one.</p>
</section>

<!-- ===================== LEARNING LOOP ===================== -->
<section class="panel" id="panel-training" role="tabpanel" aria-labelledby="tab-training" tabindex="0" hidden>
  <div class="panel-head">
    <h2>The learning loop — how one run's work reaches the next</h2>
    <p class="lede">This is the cycle the whole plugin exists for, and it is a CROSS-RUN cycle: no single run can close it. A run READS the memory plane when it enters a phase; it must WRITE its own memory before phase 8 can lock; and on a re-run — with at least two locked runs and an extractor configured — it extracts training shards that the NEXT run's phase entry reads. ${cite(SRC.memoryKinds + ', ' + SRC.trainingTrigger)}</p>
  </div>

  <div class="callout">
    <strong>The back edge is the point.</strong> Everything else here is a step; the reason the steps exist is that the arrow at the bottom travels back to the top <em>in a different run</em>. That is why the plugin has a memory plane at all, and it is the part a row of phase boxes cannot show.
  </div>

  ${dgTraining.markup}

  <h3 id="training-steps" style="margin-top:var(--sp-6)">Every step, and what stops it</h3>
  <div class="tablewrap">
    <table>
      <caption>The eight steps in the order a run reaches them, with the gate that can stop each one. This table is the accessible equivalent of the cycle above: no step is drawn that is not a row here. ${cite(SRC.memoryKinds + ', ' + SRC.readReceipt)}</caption>
      <thead><tr><th>#</th><th>Step</th><th>What it does</th><th>What can stop it</th><th>Source</th></tr></thead>
      <tbody>
        ${TRAINING.steps.map((s, i) => {
    const gate = s.gate === 'receipt' ? 'the receipt gate: the guard rule <code>memory-read</code> denies the write'
      : s.gate === 'phase8' ? 'the phase-8 lock gate: <code>phase8-memory-missing</code>'
        : s.gate === 'first-lock' ? 'a SKIP, not a refusal: the first lock extracts nothing (exit 0, no writes)'
          : s.gate === 'two-runs' ? 'the evidence gate: exit 3 <code>INSUFFICIENT_EVIDENCE</code>'
            : s.gate === 'extractor' ? 'the capability gate: exit 2 <code>EXTRACTOR_UNAVAILABLE</code>'
              : s.gate === 'no-writer' ? 'no writer or no registry reader: the writes list stays EMPTY'
                : '<span style="color:var(--fg-faint)">nothing — this step cannot be refused</span>'
    return `        <tr><td><span class="seq">${i + 1}</span></td><td><code>${esc(s.t)}</code></td><td>${s.lines.map(esc).join('<br>')}</td><td>${gate}</td><td>${cite(s.c)}</td></tr>`
  }).join('\n')}
      </tbody>
    </table>
  </div>

  <h3 style="margin-top:var(--sp-6)">What the phase-entry read covers — and what it deliberately does not</h3>
  <div class="rail-pair">
    <div class="subcard" style="border-left:2px solid var(--accent)">
      <h3>Read: <code>MEMORY_KINDS</code></h3>
      <ul class="io-list">
        ${TRAINING.kinds.map((k) => `<li><code>.recursive/memory/${esc(k)}/</code></li>`).join('\n        ')}
      </ul>
      <p class="note">Five kinds, in the order the scaffold creates them, and <code>training</code> is one of them — which is what closes the loop: the shard the trigger writes is a kind the loader READS. ${cite(SRC.memoryKinds + ', ' + SRC.memoryKindsWhy)}</p>
    </div>
    <div class="subcard" style="border-left:2px solid var(--danger)">
      <h3>NOT read, deliberately</h3>
      <ul class="io-list">
        ${TRAINING.notRead.map((k) => `<li><code>.recursive/memory/${esc(k)}/</code></li>`).join('\n        ')}
      </ul>
      <p class="note"><code>archive/</code> is historical by the router's own definition, and widening retrieval to <code>incidents/</code> is a separate ranking decision that the change which added <code>training</code> did not make. So the plane is read SELECTIVELY, and the two omissions are stated in the source rather than left implicit. ${cite(SRC.memoryNotRead)}</p>
    </div>
  </div>

  <h3 style="margin-top:var(--sp-6)">The gates, as refusals</h3>
  <div class="tablewrap">
    <table>
      <caption>${TRAINING.steps.filter((s) => s.gate).length} of the ${TRAINING.steps.length} steps can be stopped, and the five stops are not the same kind of thing: two are hard refusals, one is a deliberate skip, and two are exit codes that leave <code>writes</code> empty. ${cite(SRC.trainingExit)}</caption>
      <thead><tr><th>Gate</th><th>Stops</th><th>What it says</th><th>Exit</th><th>Source</th></tr></thead>
      <tbody>
        ${TRAINING.steps.filter((s) => s.gate).map((s) => {
    const g = TRAINING.gates[s.gate]
    const exit = s.gate === 'two-runs' ? '3' : s.gate === 'extractor' ? '2' : '0'
    return `        <tr><td><code>${esc(g.head)}</code></td><td><code>${esc(s.t)}</code></td><td>${g.lines.map(esc).join('<br>')}<br><span class="note">${esc(g.fix)}</span></td><td class="tnum">${exit}${s.gate === 'receipt' || s.gate === 'phase8' ? '<br><span class="note">deny / refusal</span>' : ''}</td><td>${cite(g.c)}</td></tr>`
  }).join('\n')}
      </tbody>
    </table>
  </div>

  <h3 style="margin-top:var(--sp-6)">The read that becomes evidence: the receipt</h3>
  <p class="note">The phase-entry read is not merely performed, it is RECORDED, and the phase-0 write gate is decided from the record rather than from the artifact text — a caller controls the text and could forge it. <code>recordMemoryRead</code> writes one receipt per phase entry, REPLACED rather than appended while the phase is still draft, into <code>&lt;run&gt;/${esc('memory-injections.json')}</code> beside the shard rows. ${cite(SRC.readReceipt + ', ' + SRC.injectionsFile)}</p>
  <p class="note">⚠ And the trap that decides the whole design: <code>recordInjection</code> only writes a row when a shard was SELECTED, so on an empty plane a gate keyed on "a record exists" would refuse forever in a fresh workspace. The receipt is therefore written on every phase entry with <code>injected: false</code> when nothing matched — <b>an empty plane SATISFIES the gate, a never-entered phase does not</b>, and the two cannot be confused because one of them has a row. ${cite(SRC.memoryReadTrap + ', ' + SRC.emptyPlaneOk + ', ' + SRC.readSource)}</p>
  <p class="note">The selection itself is a ranking, not a scan: the query is the run's own <code>00-requirements.md</code> plus its changed paths, the phase in play reweights entries that declare it, and the feedback counters from earlier runs are handed to the ranker as evidence about retrieval. ${cite(SRC.runtimePhaseRead + ', ' + SRC.memorySelect + ', ' + SRC.memoryRetrieve + ', ' + SRC.settleInjections)}</p>

  <h3 style="margin-top:var(--sp-6)">What is NOT verified here</h3>
  <ul class="refuse-list">
    <li><span class="g-shape g-shape-refuse">UNVERIFIED</span><span><b>That any run in this workspace has passed the two-locked-runs gate.</b> The page states what <code>trainingGate</code> requires and what it returns; it does not claim a run reached it, and it did not count the runs on disk. The threshold is a fact about the code; the count is a fact about a workspace. ${cite(SRC.trainingAnecdote)}</span></li>
    <li><span class="g-shape g-shape-refuse">UNVERIFIED</span><span><b>That an extractor is configured anywhere.</b> <code>RECURSIVE_TRAINING_EXTRACTOR_CMD</code> is read from the environment at closeout time; this page is generated without reading the environment, and the plugin deliberately embeds no extractor. Unset is exit 2, with an empty <code>writes</code> list. ${cite(SRC.trainingExtractorEnv + ', ' + SRC.trainingExtractorUnset)}</span></li>
    <li><span class="g-shape g-shape-refuse">UNVERIFIED</span><span><b>That the shards improve a later run.</b> The loop's READ half is <code>MEMORY_KINDS</code> including <code>training</code>, and the source states that the loop closes because of it. Whether a given shard changes what an agent does is not measured here, and no page can claim it from the code. ${cite(SRC.memoryKindsWhy)}</span></li>
  </ul>
</section>

<!-- ===================== CLOSEOUT ===================== -->
<section class="panel" id="panel-closeout" role="tabpanel" aria-labelledby="tab-closeout" tabindex="0" hidden>
  <div class="panel-head">
    <h2>Closeout &amp; receipts</h2>
    <p class="lede">Two things share the word "closeout" in this repo and they behave differently: a <b>scaffolder</b> that writes stub receipts, and a <b>linter</b> that only reports. The shipped tool is the linter. ${cite(SRC.closeoutReport)}</p>
  </div>

  <div class="callout">
    <strong>The design, in the owner's words.</strong> <em>"closeout.ts is supposed to verify whether the phase artifact docs contain the scaffold information or not, then tell the agent to add it if not. It is not supposed to just insert section titles into the docs. It is like a linter checking if the agent missed anything. It is not supposed to edit files by itself."</em> ${cite(SRC.closeoutReport)}
  </div>

  <div class="rail-pair">
    <div class="subcard">
      <h3>closeout-report.ts — REPORT ONLY</h3>
      <p class="note" style="margin-top:var(--sp-2)">Opens no file for writing. The previous implementation composed a stub receipt over the phase artifact, and a probe showed what that costs: against a DRAFT <code>05-manual-qa.md</code> it RETURNED SUCCESS while the agent's real QA content was GONE. A closeout runs BEFORE a phase locks, so that was the ordinary case, not an edge. ${cite(SRC.closeoutReport)}</p>
      <p class="note">It reports three finding kinds — <code>missing-artifact</code>, <code>missing-section</code>, <code>gate-not-passing</code> — plus the advisory prerequisite list, which is NOT a refusal. ${cite(SRC.closeoutReport)}</p>
    </div>
    <div class="subcard" style="border-left:2px solid var(--danger)">
      <h3>closeout.ts — the scaffolder, and its two refusals</h3>
      <p class="note" style="margin-top:var(--sp-2)">Refuses when an earlier artifact is not LOCKED (<code>Prerequisite blockers: …</code>), and — since FU-8 — refuses when the artifact it would write is ALREADY LOCKED. That second one was a measured defect: a closeout after the phase had locked rewrote the file to <code>Status: DRAFT</code> while its RECEIPT still said LOCKED, leaving a run whose file and receipt disagree. It refuses rather than skipping quietly, and names the remedy, because a silent skip would look like a successful closeout that changed nothing. ${cite(SRC.closeoutPrereq + ', ' + SRC.closeoutLocked)}</p>
    </div>
  </div>

  <h3 style="margin-top:var(--sp-6)">The receipt, and what verifying the chain checks</h3>
  <p class="note">A receipt records <code>artifact</code>, <code>artifact_path</code>, <code>artifact_hash</code>, <code>locked_at</code>, <code>prerequisite_hashes</code>, <code>previous_receipt_hash</code> and <code>receipt_hash</code>, at <code>&lt;run&gt;/locks/&lt;stem&gt;.receipt.json</code>. ${cite(SRC.receipts)}</p>
  <p class="note">The verification is READ-ONLY deliberately — the chain is evidence, and a verification that rewrites what it verifies is worthless. Four things are checked, and one thing is explicitly NOT claimed: <code>previous_receipt_hash</code> chains to the SAME artifact's previous receipt, and there is exactly one receipt file per artifact, so the receipt it names has been overwritten and its LINKAGE cannot be verified from disk. Rather than assert a linkage it cannot prove, it checks receipt integrity, prerequisite agreement, gaps, and well-formedness of the previous-hash field. ${cite(SRC.validateChain)}</p>
  <div class="tablewrap" style="margin-top:var(--sp-4)">
    <table>
      <caption>${cite(SRC.chainBreaks)} — the four break kinds a chain verification can report.</caption>
      <thead><tr><th>Break kind</th><th>What it means</th></tr></thead>
      <tbody>
        <tr><td><code>receipt-hash-mismatch</code></td><td>The stored <code>receipt_hash</code> does not match the hash recomputed from the receipt's own fields. The detail goes further and separates the two causes a reader cares about: the ARTIFACT was edited after locking, or the RECEIPT was edited after writing. ${cite(SRC.validateChain)}</td></tr>
        <tr><td><code>prerequisite-hash-mismatch</code></td><td>An upstream artifact changed after this one locked — the phase is stale. ${cite(SRC.validateChain)}</td></tr>
        <tr><td><code>missing-prerequisite-receipt</code></td><td>This receipt cites a prerequisite that has no receipt at all. ${cite(SRC.validateChain)}</td></tr>
        <tr><td><code>malformed-previous-hash</code></td><td>The field is not a sha256 hex digest or null — checked even when the integrity check already failed, because a tampered field is exactly when a malformed one is worth naming too. ${cite(SRC.validateChain)}</td></tr>
      </tbody>
    </table>
  </div>

  <h3 style="margin-top:var(--sp-6)">The lock-status vocabulary</h3>
  <div class="tablewrap">
    <table>
      <caption>${cite(SRC.lockStatus)} — the classifier every other guard reads.</caption>
      <thead><tr><th>Status</th><th>Condition</th></tr></thead>
      <tbody>
        <tr><td><code>MISSING</code></td><td>No file, or the file cannot be read.</td></tr>
        <tr><td><code>DRAFT</code></td><td>The file exists but carries no <code>Status: LOCKED</code> line.</td></tr>
        <tr><td><code>STALE_LOCK</code></td><td>LOCKED, but <code>LockHash</code> or <code>LockedAt</code> is missing, or the stored hash does not equal the hash recomputed from the content.</td></tr>
        <tr><td><code>LOCKED</code></td><td>LOCKED and the stored hash matches the recomputed one.</td></tr>
      </tbody>
    </table>
  </div>
  <p class="note">The hash is SHA-256 hex over UTF-8 bytes of the content LF-normalized with every <code>LockHash:</code> line STRIPPED — which is what lets the lock fields be written without invalidating the hash they carry. ${cite(SRC.lockHash)}</p>
</section>

<!-- ===================== TOOLS ===================== -->
<section class="panel" id="panel-tools" role="tabpanel" aria-labelledby="tab-tools" tabindex="0" hidden>
  <div class="panel-head">
    <h2>The thirteen tools</h2>
    <p class="lede">Thirteen tool FILES ship; twelve are registered eagerly. <code>recursive_audit_team</code> is registered only when the composition mounts <code>ctx.agentTeams</code> — and it needed a late-attach path, because a live verification pass found the service mounted AFTER the plugin applied, so the plugin shipped 13 tool files and offered 12. ${cite(SRC.auditTeamReg)}</p>
  </div>
  <div class="tablewrap">
    <table>
      <caption>Name and declared purpose, read from the tool definitions. ${cite(SRC.toolsReg)}</caption>
      <thead><tr><th>#</th><th>Tool</th><th>Declared purpose</th><th>Source</th></tr></thead>
      <tbody>
        ${TOOLS.map((t, i) => `<tr><td><span class="seq">${i + 1}</span></td><td><code>${esc(t.n)}</code>${t.reg === 'conditional' ? '<br><span class="tag tag-shape">registered only when agentTeams is mounted</span>' : ''}</td><td>${esc(t.p)}${t.note ? `<br><span class="note" style="display:block;margin-top:var(--sp-2)">${t.note}</span>` : ''}</td><td>${cite(t.c)}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>
</section>

<!-- ===================== CODES ===================== -->
<section class="panel" id="panel-codes" role="tabpanel" aria-labelledby="tab-codes" tabindex="0" hidden>
  <div class="panel-head">
    <h2>Error codes</h2>
    <p class="lede">All ${ERRORS.length} entries of the <code>TOOL_ERRORS</code> registry. Every <code>recursive_*</code> tool error must come from here: a tool that invents its own sentence is a tool whose refusals cannot be grepped. ${cite(SRC.errRegistry)}</p>
  </div>
  <div class="tablewrap">
    <table>
      <caption>${cite(SRC.errRegistry)} — the third character is the class group, and a test asserts it matches the entry's own class.</caption>
      <thead><tr><th>Code</th><th>Class</th><th>Problem</th><th>Belongs to</th></tr></thead>
      <tbody>
        ${ERRORS.map((e) => `<tr><td><code>${esc(e.code)}</code></td><td class="k-${esc(e.k)}">${esc(e.k)}</td><td>${esc(e.p)}</td><td>${esc(e.where)}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>
  <p class="note" style="margin-top:var(--sp-4)">Two codes deserver a second look because they encode a defect rather than a syntax error: <code>RM4404</code> exists because <code>recursive_ask gate=run-start</code> used to raise "start this run or hold?" over a Phase 0 document that was still the scaffold <code>recursive_init</code> wrote, and nothing put that document in front of the person either; and <code>RM5503</code> used to LIE — its text asserted "so no person was asked" for EVERY cause, so a gate that failed 22.9 s into a call prescribed, in its <code>Next:</code> clause, the very call that had just failed. ${cite(SRC.errSpecUnfilled + ', ' + SRC.errUnanswered)}</p>
</section>

<!-- ===================== VERIFICATION ===================== -->
<section class="panel" id="panel-verify" role="tabpanel" aria-labelledby="tab-verify" tabindex="0" hidden>
  <div class="panel-head">
    <h2>Verification — what is checked, and what is not</h2>
    <p class="lede">This page is generated by <code>scripts/gen-workflow-map.mjs</code>. Run it with <code>--verify</code> and it re-reads <code>src/</code> and re-derives every claim-bearing list below, failing loudly on a mismatch instead of shipping a plausible diagram.</p>
  </div>

  <h3>Checked mechanically against <code>src/</code></h3>
  <div class="tablewrap">
    <table>
      <caption>Each check reads the source file and compares a derived value to the fact rendered on this page.</caption>
      <thead><tr><th>Check</th><th>Derived from</th></tr></thead>
      <tbody>
        <tr><td>The twelve artifact names, IN ORDER</td><td><code>src/lock.ts</code> — <code>PHASE_SEQUENCE</code></td></tr>
        <tr><td>The late-phase set (3 members, same order)</td><td><code>src/phase-rules.ts</code> — <code>LATE_PHASE_ARTIFACTS</code></td></tr>
        <tr><td>The audited-phase set (9 members)</td><td><code>src/phase-rules.ts</code> — <code>AUDITED_PHASE_FILES</code></td></tr>
        <tr><td>The optional-phase set (7 members)</td><td><code>src/lock.ts</code> — <code>OPTIONAL_PHASES</code></td></tr>
        <tr><td>Every phase's required sections, in order</td><td><code>src/phase-rules.ts</code> — <code>SECTION_MAP</code></td></tr>
        <tr><td>The audit headings (9) and the input-artifact map</td><td><code>src/phase-rules.ts</code> — <code>AUDIT_REQUIRED_HEADINGS</code>; <code>src/ts-lint.ts</code> — <code>getPhaseExpectedInputArtifactNames</code></td></tr>
        <tr><td>The thirteen tool names</td><td><code>src/recursive_*.tool.ts</code> — the registered <code>name:</code> literals</td></tr>
        <tr><td>Every RM#### code and its class group</td><td><code>src/errors.ts</code> — <code>TOOL_ERRORS</code></td></tr>
        <tr><td>The guard rule labels, <b>in built-in rule order</b>, and the reason strings</td><td><code>src/policy-globs.ts</code> — <code>builtInToolPolicyRules</code>; <code>src/phase-rules.ts</code> — <code>phaseBaselineRules</code></td></tr>
        <tr><td>The five hook points and their gating/observing split</td><td><code>src/hooks.ts</code> — <code>HOOK_POINTS</code>, <code>GATING_POINTS</code>, <code>OBSERVING_POINTS</code></td></tr>
        <tr><td>Both <code>pre_trigger</code> bindings and their priorities; the guard's own hook-name constant</td><td><code>src/index.ts</code> — the two <code>hooks.register</code> calls and <code>BUILTIN_GUARD_HOOK_NAME</code></td></tr>
        <tr><td>The DSH seam event strings</td><td><code>src/index.ts</code> — the <code>.on('…')</code> call sites and <code>ctx.tools.register</code></td></tr>
        <tr><td>The run-start gate id, both labels, and that <code>relay</code> is refused for every other gate</td><td><code>src/run-start.ts</code>, <code>src/recursive_ask.tool.ts</code></td></tr>
        <tr><td>Every human-gate id and its option labels</td><td><code>src/recursive_ask.tool.ts</code> — <code>ASK_GATES</code></td></tr>
        <tr><td>Every conditional input ("only when present") is the one the linter actually pushes</td><td><code>src/ts-lint.ts</code> — <code>candidates.push(…)</code> inside <code>getPhaseExpectedInputArtifactNames</code></td></tr>
        <tr><td><b>Citation coverage.</b> A citation cannot be satisfied by coincidence: each one is resolved from a NAMED ANCHOR searched in its own file, an anchor that is missing, ambiguous, or moved is a hard failure, an undeclared duplicate anchor fails rather than silently citing the first hit, and every rendered citation is re-checked to be inside the file it names and within that file's length.</td><td>the generator's <code>ANCHORS</code> table against <code>src/</code></td></tr>
        <tr><td>Each phase panel carries at least 8 citations, and the page renders a substantial number in total</td><td>the generated HTML</td></tr>
        <tr><td><b>Every WCAG contrast pair is MEASURED</b>, not asserted: ${CONTRAST_REQUIREMENTS.length} foreground/background pairs read from the palette object that also renders the CSS, each against the threshold it owes (4.5:1 for text, 3:1 for non-text state borders). Purely decorative presentation is listed too, with the exemption STATED — an exemption that is written down can be argued with; a silent one cannot.</td><td>the palette object in the generator</td></tr>
        <tr><td>No hardcoded hex anywhere in the stylesheet — every colour is a declared token value, so the audited palette IS the shipped palette</td><td>the generated HTML</td></tr>
        <tr><td>The radius ladder is strictly increasing (outer &gt; inner), every radius token used is declared and every declared one is used, and no dangling token remains</td><td>the generated HTML</td></tr>
        <tr><td>Accessibility affordances the accessibility skill requires: a <code>:focus-visible</code> style, a skip link, <code>prefers-reduced-motion</code>, ≥44px tab hit areas, <code>text-wrap</code>, tabular numerals, font smoothing, exact transition properties, no <code>transition: all</code> declaration, and a text label on every gate so colour is never the only signal</td><td>the generated HTML</td></tr>
        <tr><td>The tab strip scrolls in ONE row and does not wrap (checked against the parsed <code>[role="tablist"]</code> rule, not against a substring anywhere in the sheet)</td><td>the generated HTML</td></tr>
        <tr><td>Every <code>id</code> a tab's <code>aria-controls</code> names exists, every panel is a <code>tabpanel</code> labelled by its own tab, every panel is addressed by exactly one tab, and the roving tabindex is complete (one <code>0</code>, the rest <code>-1</code>, one <code>aria-selected="true"</code>)</td><td>the generated HTML itself</td></tr>
        <tr><td><b>The ${EDGES.length} directed edges</b>, re-derived from <code>getPhaseExpectedInputArtifactNames</code> — the required, the conditional (<code>candidates.push</code>) and the two wildcard filters, including that each wildcard excludes its own artifact and that <code>00-requirements.md</code> has no upstream edge at all. The fan-in rendered on every node is checked against the same derivation, so the Phase graph view fails the build if the linter's map moves.</td><td><code>src/ts-lint.ts</code> — the whole function body</td></tr>
        <tr><td><b>Every phase's purpose line.</b> Each one carries the label <code>PHASES</code> gives that artifact, and names at least two required sections that are still in <code>SECTION_MAP</code>; the two Phase 0 lines are checked to quote their template's Scope note verbatim, no line may be a closeout scope note lifted as-is, and the page asserts that the later-phase template carries ONE generic Scope note — which is why 01-08 have no per-phase prose to transcribe.</td><td><code>src/status.ts</code>, <code>src/phase-rules.ts</code>, <code>src/init-templates.ts</code>, <code>src/closeout.ts</code></td></tr>
        <tr><td><b>The learning loop:</b> the five kinds the phase-entry read covers, the two it deliberately does not, the read RECEIPT written on every phase entry, the phase-0 write gate being decided from that receipt, the phase-8 lock gate being called from <code>lockArtifact</code> and matching <code>Source-Runs</code>, the re-run being detected from an existing receipt, the ORDER of the trigger's three gates (evidence → re-run → extractor), the strict-2 comparison, both exit codes, the extractor's environment variable, and the shard path the trigger writes.</td><td><code>src/memory.ts</code>, <code>src/memory-feedback.ts</code>, <code>src/policy-globs.ts</code>, <code>src/training.ts</code>, <code>src/runtime.ts</code></td></tr>
        <tr><td><b>Every chart's own manifest, re-read from the markup:</b> the overview draws exactly one run per derived edge (by label, so a missing arrow is a failure rather than a smaller picture) and one node per phase, and the learning loop draws every step and every gate that can stop one.</td><td>the generated HTML itself</td></tr>
        <tr><td><b>The merge itself, asserted in the negative:</b> there is NO second <code>phase-graph</code> chart and NO <code>Phase graph</code> tab any more, and all twelve phase detail views still exist — so the sixteen edges cannot drift back onto a tab of their own while the overview keeps a picture of its own, and the merge cannot have removed reference material.</td><td>the generated HTML itself</td></tr>
        <tr><td><b>The overview IS the graph — one check per interaction type, each counted from the drawing's own manifest:</b> twelve nodes, all sixteen edges as runs, five dashed fan-in nodes, three human-decision markers with their diamonds, twelve refusal bands, the wildcard rail (with the assertion that it spans the twelve-node row) and its two thick stubs, the four dotted sequence-order links AND the seven spine arrows (checked against each other, so a dotted link cannot be drawn over a pair that has a real input edge), the two back-edge arcs with their arrowheads on the earlier node, and the cross-run return.</td><td>the manifest the chart ships, against expectations written out in <code>check-workflow-map.mjs</code> rather than imported from this generator</td></tr>
        <tr><td><b>The prose is gone and the facts are not.</b> No callout sits above the overview chart, the prologue is a heading plus at most two short paragraphs, the moved caveats are reachable in one line, and the strings the Notes view is supposed to carry are all still on the page.</td><td>the generated HTML itself</td></tr>
        <tr><td>The tab count equals 1 overview + 12 phases + 1 learning loop + 1 Notes view + 7 other views</td><td>the generated HTML itself</td></tr>
      </tbody>
    </table>
  </div>
  <h3 style="margin-top:var(--sp-6)">The measured contrast audit</h3>
  <p class="note">Rendered from the same computation <code>--verify</code> runs, so the numbers on this page ARE the audit rather than a summary of it. "Exempt" is a stated decision, not a silent omission: WCAG sets no threshold for purely decorative presentation, and every one of those rows is a region fill, a divider, or a rule border whose meaning is carried by a label beside it.</p>
  <div class="tablewrap">
    <table>
      <caption>${CONTRAST_REQUIREMENTS.length} foreground/background pairs. Text owes 4.5:1 (WCAG 2.2 AA, 1.4.3); a border that carries STATE owes 3:1 (1.4.11).</caption>
      <thead><tr><th>Pair</th><th>Ratio</th><th>Needed</th><th>What it is</th></tr></thead>
      <tbody>
        ${CONTRAST_REQUIREMENTS.map((r) => {
    const ratio = Math.round(contrast(tone(r.fg), tone(r.bg)) * 100) / 100
    const pass = ratio >= r.need
    const verdict = r.need <= 1 ? '<span class="tag">exempt</span>' : pass ? '<span class="tag tag-tdd">PASS</span>' : '<span class="tag tag-refuse">FAIL</span>'
    return `        <tr><td><code>${esc(r.fg)}</code> on <code>${esc(r.bg)}</code></td><td class="tnum">${ratio.toFixed(2)}:1 ${verdict}</td><td class="tnum">${r.need.toFixed(1)}:1</td><td>${esc(r.what)}</td></tr>`
  }).join('\n')}
      </tbody>
    </table>
  </div>
  <p class="note">Run <code>node scripts/gen-workflow-map.mjs --verify</code> to see every check reported one per line, with this table printed above them. A single failure exits non-zero and writes NOTHING, so this page cannot ship in a state where a fact on it has stopped being true.</p>

  <h3 style="margin-top:var(--sp-6)">NOT verified — stated rather than filled in</h3>
  <ul class="refuse-list">
    <li><span class="g-shape g-shape-refuse">MEASURED ELSEWHERE</span><span><b>The rendered pixels — measured in a separate headless pass, NOT by this generator.</b> Two charts now ship, and both were rendered in headless Chromium (the Playwright build on this machine) at <b>eight viewport widths</b> — 360, 480, 600, 768, 820, 1024, 1440 and 1920 px — with every panel un-hidden, and the glyph boxes were compared pairwise: <b>0 text-on-text overlaps</b> in both charts and across the whole page at every width (text-NODE rects via a DOM Range, so a <code>&lt;code&gt;</code> inside a paragraph is not miscounted as an overlap with its own parent), <b>0</b> labels crossing a card they do not belong to, every chart rendering at <b>scale 1.0000</b> (never rescaled by its box), and <b>no horizontal page overflow at any width</b> (the page measures 15 px NARROWER than the viewport, from the scrollbar). ⚠ THAT PASS MEASURED THE ONE-ROW CHART, WHICH WAS 2854 UNITS WIDE AND SCROLLED SIDEWAYS. The two-row chart was re-measured the same way at 1280x900 and 1440x900: the overview renders at its own 1128 units, <b>its wrapper reports scrollWidth === clientWidth at both widths</b> (it no longer scrolls sideways at all above 1280), the page still has no horizontal overflow, and the overview's manifest carries <b>0 text-on-text overlaps</b> — a relation the generator now REFUSES to emit rather than one this pass had to look for, because two lane labels were once laid on the same point while every invariant stayed green. The worst measured label overhang was <b>+0.04 px and 0.00 px</b> (overview, learning loop) — measured against the reserved box with the real glyph advance of <b>0.5493 em</b> against the declared 0.602. ⚠ THE HARNESS FOR THIS PASS IS NOT PART OF THIS REPOSITORY (it is a throwaway CDP script, kept out of the tree) and <code>--verify</code> does not re-run it, so treat these as a dated measurement rather than a standing check — which is why the generator and the two checkers carry the arithmetic invariants instead.</span></li>
    <li><span class="g-shape g-shape-refuse">MEASURED, AND NOT WHAT YOU MIGHT EXPECT</span><span><b>The two back-edge arrowheads are 8x5 units, and at the chart's own scale that is 8x5 pixels.</b> They are verified as GEOMETRY — the manifest places each one on its target node's bottom edge, one column gap to the left, and <code>check-workflow-map.mjs</code> fails if either moves — but a reader looking at the whole chart sees the violet arcs and their labels rather than the two arrowheads. That is a fact about the size of an arrowhead on a 1128-unit canvas, not a defect, and it is written down here rather than discovered by the owner.</span></li>
    <li><span class="g-shape g-shape-refuse">UNVERIFIED</span><span><b>Keyboard and screen-reader behaviour.</b> The tablist's roles, <code>aria-selected</code>, roving tabindex and <code>aria-controls</code> targets are asserted against the markup, and the arrow-key handler is present in the source — but no assistive technology ran this page, so "the arrow keys work" and "the tab order reads correctly" are NOT demonstrated here.</span></li>
    <li><span class="g-shape g-shape-refuse">UNVERIFIED</span><span><b>Per-phase "inputs" beyond the artifact list.</b> The scaffold writes a generic <code>- (list upstream artifacts re-read for this phase)</code> placeholder for every later phase, so there is no per-phase PROSE list of inputs in the code to transcribe. What IS in the code is <code>getPhaseExpectedInputArtifactNames</code>, and that is what the input column shows — plus the file-level sources a phase names (git state, DECISIONS.md, STATE.md, the memory plane). ${cite(SRC.tplLater + ', ' + SRC.inputMap)}</span></li>
    <li><span class="g-shape g-shape-refuse">UNVERIFIED</span><span><b>Which hooks fire in a given real session.</b> The page states which seam each listener attaches to and what it does; it does not claim a particular live run took a particular path, and it makes no claim about run outcomes.</span></li>
    <li><span class="g-shape g-shape-refuse">UNVERIFIED</span><span><b>Whether any addendum back-edge exists in the current workspace.</b> <code>backEdges()</code> can report one; nothing on this page asserts that one has occurred.</span></li>
    <li><span class="g-shape g-shape-refuse">UNVERIFIED</span><span><b>The source tree was MOVING while this page was generated.</b> <code>src/policy-globs.ts</code>, <code>src/runtime.ts</code> and <code>src/recursive_phase.tool.ts</code> were being edited by another agent at the time. This is exactly why citations are resolved from anchors at generate time rather than typed in: an earlier draft of this page carried line numbers that the other agent's edit INVALIDATED, and they would have shipped wrong. Every citation here was resolved from the current file contents. If the tree moves again, run the generator again — <code>--verify</code> will fail loudly on any anchor that no longer resolves.</span></li>
    <li><span class="g-shape g-shape-refuse">UNVERIFIED</span><span><b>Anything about the plugin's runtime behaviour.</b> This page is a map of the CODE. It reports what the sources say the workflow does; it does not demonstrate that a live run follows it. Nothing here is evidence about a run.</span></li>
  </ul>

  <h3 style="margin-top:var(--sp-6)">Regenerating</h3>
  <pre class="pre">node scripts/gen-workflow-map.mjs            # write workflow-map/recursive-mode-workflow.html
node scripts/gen-workflow-map.mjs --verify   # re-derive the facts from src/, write nothing
node scripts/gen-workflow-map.mjs --out elsewhere.html</pre>
</section>

</main>

<footer class="colophon">
  <p><b>Provenance.</b> Generated from the <code>${esc(REPO)}</code> working tree. Every <code>file:line</code> caption on this page names the source it was transcribed from; the paths are relative to the repository root. No claim on this page was invented to fill a gap — where the code does not say something, the page says so in the Verification view.</p>
  <p><b>Scope.</b> Read-only with respect to <code>src/</code> and <code>tests/</code>. The generator writes exactly one file.</p>
  <p><b>Self-contained.</b> One HTML file: inline CSS, inline JS, no CDN, no external font, no build step. The type is a system monospace stack. No animation is used; a <code>prefers-reduced-motion</code> rule is present for the two colour transitions that do exist.</p>
</footer>
</div>

<script>
(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('js');

  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute('aria-controls')); });
  if (tabs.length === 0) return;

  function select(index, focus) {
    if (index < 0) index = tabs.length - 1;
    if (index >= tabs.length) index = 0;
    tabs.forEach(function (tab, i) {
      var on = i === index;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      var panel = panels[i];
      if (!panel) return;
      panel.hidden = !on;
      panel.classList.toggle('is-active', on);
    });
    if (focus) tabs[index].focus();
    // Keep the deep link in step with the view, so a tab is shareable and the
    // back button works, without a router or a dependency.
    var id = tabs[index].id.replace(/^tab-/, '');
    if (history.replaceState) history.replaceState(null, '', '#' + id);
  }

  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { select(i, false); });
    tab.addEventListener('keydown', function (event) {
      var k = event.key;
      if (k === 'ArrowRight' || k === 'ArrowDown') { event.preventDefault(); select(i + 1, true); }
      else if (k === 'ArrowLeft' || k === 'ArrowUp') { event.preventDefault(); select(i - 1, true); }
      else if (k === 'Home') { event.preventDefault(); select(0, true); }
      else if (k === 'End') { event.preventDefault(); select(tabs.length - 1, true); }
    });
  });

  // Open the tab named in the hash, falling back to the overview.
  var wanted = (location.hash || '').replace(/^#/, '');
  var start = 0;
  if (wanted) {
    for (var i = 0; i < tabs.length; i += 1) {
      if (tabs[i].id === 'tab-' + wanted) { start = i; break; }
    }
  }
  select(start, false);

  // An in-page link to a panel (a loop reference from the overview) should open
  // the view that holds it rather than leaving the reader on the overview.
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[href^="#"]') : null;
    if (!link) return;
    var target = document.getElementById(link.getAttribute('href').slice(1));
    if (!target) return;
    var panel = target.closest('.panel');
    if (!panel) return;
    var index = panels.indexOf(panel);
    if (index < 0) return;
    select(index, false);
    // Let the browser do the scroll after the panel is shown.
    window.requestAnimationFrame(function () {
      target.scrollIntoView({ block: 'start', behavior: 'auto' });
    });
  });
})();
</script>
</body>
</html>
`
}

/* ==========================================================================
   THE DIAGRAM — LAYOUT BY ARITHMETIC, NOT BY EYE
   ==========================================================================

   WHY THIS IS NOT A HAND-PLACED SVG ANY MORE. It was one, and it shipped four
   collisions that a reader saw in a browser and the author could not see at all,
   because nothing in the file ever compared two coordinates:

     1. the phase-0 gate card ended at y=84 while the strip heading was drawn at
        y=88 — a 6px overlap of heading text across the card's lower third;
     2. the twelve nodes were 62 user units wide against labels measuring 61-63, so
        each label overran its own box and landed on its neighbour's, and nodes
        8-11 sat at x=690..900, INSIDE the hook column that starts at x=668;
     3. the backward-edge arc ran at y=268 and its REVISE label at y=264 — the same
        band as the prose line at y=262, so the label was painted across a sentence;
     4. the hook channel cards (y=38..138) and the sequence row (y=96..136) occupied
        the same horizontal band in the same x-range: the grey panel sliced the amber
        one.

   Every one of those is a coordinate that was never checked against another
   coordinate. So the diagram is CHARTED before it is drawn: `diagram()` reserves a box
   for every element it is about to emit — cards, text, rules, arrowheads — and THROWS
   if two reserved boxes of ink intersect. The page cannot be generated with the defect
   in it, and the width of every text box comes from a declared per-character metric
   rather than from a guess, so "does this label fit?" is arithmetic, not opinion.

   Two rules make that worth anything:
     · INK MAY NOT OVERLAP INK, except that a box may CONTAIN text and a box may
       contain another box. Everything else is a hard failure at build time.
     · NOTHING IS PLACED WITHOUT A RESERVED BOX — there is no escape hatch that writes
       coordinates without recording them, because an unrecorded coordinate is exactly
       how the four defects above got in.
   ========================================================================== */

/* ==========================================================================
   WHERE A GUARD RULE CAN STOP A PHASE — the second shape, per phase
   ==========================================================================

   The refusal surface of this workflow is not one thing per phase: the four built-in guard rules fire
   on tool-name patterns, and the phase baselines fire on the phase NUMBER. A rule that names phases
   is drawn as a band under each of them; a rule that names a tool pattern alone (`recursive_lock*`,
   the write-tool family) is drawn under EVERY phase, because there is no phase where a lock or a
   write cannot be attempted. That is why the picture shows a band under all twelve, and why the list
   below is short: what varies per phase is WHICH named rule bites there.

   ⚠ WHY THIS IS NOT THE GUARDS TABLE. The table says what each rule says. This says WHERE it bites,
   as a position on the chart — and the two are checked against each other in `check-workflow-map`,
   where the per-rule zone sums have to match what the page renders. */
const REFUSAL_MARKS = [
  { rule: 'lock-order', short: 'lock order', nodes: PHASES.map((p) => p.file) },
  { rule: 'locked-write', short: 'locked write', nodes: PHASES.map((p) => p.file) },
  { rule: 'phase-order', short: 'phase order', nodes: PHASES.map((p) => p.file) },
  { rule: 'memory-read', short: 'memory read', nodes: ['00-requirements.md'] },
  { rule: 'tdd-evidence', short: 'tdd-evidence', nodes: ['03-implementation-summary.md'] },
  { rule: 'phase 1/2 baseline', short: 'no memory plane', nodes: ['01-as-is.md', '01.5-root-cause.md', '02-to-be-plan.md'] },
  { rule: 'phase 6/7 baseline', short: 'frozen', nodes: ['06-decisions-update.md', '07-state-update.md'] },
  { rule: 'phase 6/7/8 baseline', short: 'frozen + memory', nodes: ['08-memory-impact.md'] },
]

/**
 * The words ONE refusal band prints, derived from the table above rather than written twice: the
 * NARROWEST rules that bite there. The three built-in rules that fire on a tool pattern alone bite
 * under every phase, so naming them in every band would say nothing — what varies per phase is the
 * named baseline, and a phase where no baseline bites says `any lock or write` instead. `verify()`
 * re-derives this per phase and refuses a band whose words disagree with the table, which is what
 * makes the band a checked fact rather than a caption.
 */
function refusalBandText(file) {
  const names = REFUSAL_MARKS.filter((r) => r.nodes.includes(file) && r.nodes.length < PHASES.length)
    .map((r) => r.short).join(' · ')
  return names === '' ? 'any lock or write' : names
}

/* ==========================================================================
   THE CHARTS — LAYOUT BY ARITHMETIC, NOT BY EYE
   ==========================================================================

   WHY THIS IS NOT A HAND-PLACED SVG. It was one, and it shipped four collisions that a
   reader saw in a browser and the author could not see at all, because nothing in the
   file ever compared two coordinates:

     1. the phase-0 gate card ended at y=84 while the strip heading was drawn at y=88 —
        a 6px overlap of heading text across the card's lower third;
     2. the twelve nodes were 62 user units wide against labels measuring 61-63, so each
        label overran its own box and landed on its neighbour's, and nodes 8-11 sat at
        x=690..900, INSIDE the hook column that starts at x=668;
     3. the backward-edge arc ran at y=268 and its REVISE label at y=264 — the same band
        as the prose line at y=262, so the label was painted across a sentence;
     4. the hook channel cards (y=38..138) and the sequence row (y=96..136) occupied the
        same horizontal band in the same x-range: the grey panel sliced the amber one.

   Every one of those is a coordinate that was never checked against another coordinate.
   So a chart is CHARTED before it is drawn: `makeEngine()` reserves a box for every
   element about to be emitted — cards, text, rules, arrowheads — and THROWS if two
   reserved boxes of ink intersect. The page cannot be generated with the defect in it,
   and the width of every text box comes from a declared per-character metric rather
   than from a guess, so "does this label fit?" is arithmetic, not opinion.

   Two rules make that worth anything:
     · INK MAY NOT OVERLAP INK, except that a box may CONTAIN text and a box may contain
       another box. Everything else is a hard failure at build time.
     · NOTHING IS PLACED WITHOUT A RESERVED BOX — there is no escape hatch that writes
       coordinates without recording them, because an unrecorded coordinate is exactly
       how the four defects above got in.

   ⚠ THREE CHARTS NOW, AND THEY ALL GO THROUGH THE SAME ENGINE. The overview, the phase
   graph and the learning loop each call `chart()`, and each one ships its OWN manifest
   in `data-layout` with its own wrapper width, so `check-workflow-map.mjs` re-derives
   every invariant for every chart rather than for the first one it finds. A new graphic
   that bypassed `reserve()` could not be emitted at all: there is no other way to write
   into the SVG body. The linkage arrows and the training loop's cycle are therefore
   covered by the intersection check exactly as the phase strip is. */

/**
 * The four diagram text styles, as ONE declaration used by BOTH the layout arithmetic
 * below and the stylesheet that draws them. That is the point: the sheet used to say
 * 9px for `dg-t-sm` while the diagram's own boxes were computed at 9.5px, so the rule
 * "every label fits its box" was true of a font nobody rendered. One declaration
 * removes the class of defect, and `check-workflow-map.mjs` re-reads the emitted CSS
 * and fails if the two ever disagree again.
 */
const DG_TEXT = {
  'dg-t-a': { size: 11, fill: 'var(--accent)' },
  'dg-t-h': { size: 10, fill: 'var(--warn)' },
  'dg-t': { size: 11, fill: 'var(--n-200)' },
  'dg-t-sm': { size: 9.5, fill: 'var(--n-400)' },
}

/**
 * The declared advance width of ONE monospace character, as a fraction of the font
 * size. MEASURED, not assumed: Chromium reports 0.5498 em for this page's whole stack
 * (ui-monospace → Consolas on Windows, Menlo on macOS, Liberation Mono on Linux) and
 * 0.6001 em for Courier New, which is in the stack as the last resort. Both SVG text
 * and `code` in this page render in that stack, so this is the widest width the
 * renderer can produce for a character, rounded UP rather than to the nearest
 * thousandth: laying out against the widest member of the stack makes the fit a
 * guarantee rather than a hope. `check-workflow-map.mjs` re-runs this arithmetic
 * against the emitted markup, and a headless Chromium re-measures the real glyphs
 * against the same boxes, so a metric that stops being true is a failing check rather
 * than a silent clip.
 */
const CHAR_W = 0.602
/** Reserved box height of one text line, as a multiple of the font size. */
const TEXT_LH = 1.4

function makeEngine() {
  /* ---- the chart's own geometry ---------------------------------------- */
  const GUTTER = 48     // left column: nothing is drawn in it except the return arc
  const PAD = 8         // between a box edge and the text inside it
  const LINE_PAD = 2.5  // half the reserved height of a rule

  const CLS = { a: 'dg-t-a', h: 'dg-t-h', t: 'dg-t', s: 'dg-t-sm' }
  const FS = Object.fromEntries(Object.entries(DG_TEXT).map(([k, v]) => [k, v.size]))

  const tw = (s, fs) => String(s).length * CHAR_W * fs
  // Rounded to hundredths, because the geometry is: an unrounded line height makes two
  // adjacent lines "intersect" by 1e-13 of a unit, and a layout rule that fires on
  // floating-point noise is a rule that gets switched off.
  const lh = (fs) => Math.round(fs * TEXT_LH * 100) / 100
  const round = (n) => Math.round(n * 100) / 100

  const boxes = []      // every reserved box, in emission order
  const contains = []   // [container index, contained index] — the only allowed overlaps
  const svgParts = []   // the SVG body

  const bounds = (b) => [b.x, b.y, b.x + b.w, b.y + b.h]
  const holds = (outer, inner) => {
    const [ox0, oy0, ox1, oy1] = bounds(outer)
    const [ix0, iy0, ix1, iy1] = bounds(inner)
    return ix0 >= ox0 && iy0 >= oy0 && ix1 <= ox1 && iy1 <= oy1
  }

  /**
   * The one gate every element passes through: reserve a box, or throw.
   *
   * THE INVARIANT. Two reserved boxes may overlap in exactly two ways, and both are
   * structural rather than accidental:
   *   · a container CONTAINS its contents (a card and the text inside it, the strip
   *     and its twelve nodes) — the outer box holds the inner one completely;
   *   · a rule or an arrowhead may touch the edge of the box it belongs to, which the
   *     2.5-unit rule padding allows.
   * ANY other intersection — a partial one, i.e. "these two are in the same band and
   * neither holds the other" — is the defect this refuses to emit. A cross-band
   * partial overlap is precisely what all four reported defects were.
   */
  function reserve(box, kind, label, inside) {
    // ROUND ON ENTRY, THEN TEST. Rounding after the test makes the rule disagree with
    // the manifest it prints: two boxes could pass as "touching" while both reporting
    // the same edge. The geometry that is CHECKED is the geometry that is EMITTED.
    const b = { x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h), kind, label }
    // `inside` is one index or a list of them: every stroke this one is allowed to overlap, each
    // of which becomes its own declared pair. See the array note at the declaration below.
    const declared = inside === undefined ? [] : (Array.isArray(inside) ? inside : [inside])
    if (!(b.w > 0) || !(b.h > 0)) {
      throw new Error('diagram: ' + kind + ' "' + label + '" has an empty box: ' + JSON.stringify(b))
    }
    for (let i = 0; i < boxes.length; i++) {
      const o = boxes[i]
      const ix = Math.min(b.x + b.w, o.x + o.w) - Math.max(b.x, o.x)
      const iy = Math.min(b.y + b.h, o.y + o.h) - Math.max(b.y, o.y)
      // EPS: boxes that merely TOUCH are not an overlap, and two adjacent rows
      // computed from a repeated addition can differ by a thousandth of a unit. The
      // four defects this rule exists for were 4-14 units deep, so the tolerance
      // cannot hide one: it is three orders of magnitude below the smallest of them.
      const EPS = 0.05
      if (ix <= EPS || iy <= EPS) continue
      /**
       * ⚠ A TEXT BOX IS NOT A CONTAINER, AND THIS IS THE ONE HOLE THE ORIGINAL RULE HAD.
       * "A box may contain another box" is what lets a card hold its own label and the strip
       * hold its twelve nodes. But when BOTH boxes are text, containment is not a structure —
       * it is one LABEL drawn through another, which is illegible on the page and which the
       * engine used to wave through: two lane labels were laid at the same point and every
       * check stayed green while the two names printed on top of each other. Text may be held
       * by a box or a rule; it may never be held by other text.
       */
      if (kind === 'text' && o.kind === 'text') {
        throw new Error('diagram: TEXT ON TEXT — "' + label + '" ' + JSON.stringify([b.x, b.y, b.w, b.h])
          + ' is drawn over "' + o.label + '" ' + JSON.stringify([o.x, o.y, o.w, o.h])
          + ' by ' + round(ix) + 'x' + round(iy) + ' units: a label is not a container')
      }
      const nested = holds(o, b) || holds(b, o)
      if (nested) {
        // Declared in [contained, container] order, whichever way round it is: a box
        // that already holds this one (the label drawn before its card, the strip's own
        // children) makes this box the contained one.
        contains.push(holds(o, b) ? [boxes.length, i] : [i, boxes.length])
        continue
      }
      if (inside !== undefined && declared.includes(i) && (kind === 'rule' || kind === 'ink')) {
        // A rule or an arrowhead sharing an index with the rule it joins: the arc's
        // corner. Declared with the neighbour as the container, so the exemption is a
        // fact in the manifest and not a hole in the check.
        //
        // ⚠ THIS APPLIES TO INK AS WELL AS RULES, because an arrowhead is INK and it has
        // to touch the line it terminates. An ink box is a RECTANGLE around a triangle, so
        // its corners reach past the glyph: an arrowhead at the end of a horizontal run
        // therefore overlaps that run's reserved box by a few units even though the drawn
        // triangle only MEETS it at one point. `check-workflow-map.mjs` already accepts
        // exactly this relation (`meets`, within one stroke width of 5 units) and refuses
        // any other declared containment, so the exemption cannot hide a real defect — it
        // is the same two rules the checker re-derives from the manifest.
        //
        // ⚠ AND ONE STROKE MAY HAVE TO DECLARE MORE THAN ONE RELATION, which is why `inside`
        // takes an array. The run that leaves the bundle trunk and crosses another lane overlaps
        // BOTH — the trunk it starts from and the arrival stub it passes through. A single index
        // could state one of those facts and the engine would refuse the other as an undeclared
        // intersection, i.e. it would refuse the picture instead of the defect. Every index in
        // the array becomes its own pair in the manifest, and the checker re-derives each pair
        // on its own, so the array widens what can be DECLARED without widening what is allowed.
        contains.push([boxes.length, i])
        continue
      }
      throw new Error(
        'diagram: OVERLAP — ' + kind + ' "' + label + '" ' + JSON.stringify([b.x, b.y, b.w, b.h]) +
        ' intersects ' + o.kind + ' "' + o.label + '" ' + JSON.stringify([o.x, o.y, o.w, o.h]) +
        ' by ' + round(ix) + 'x' + round(iy) + ' units — neither box contains the other')
    }
    boxes.push(b)
    return boxes.length - 1
  }

  function textEl(x, lineTop, fontCls, raw, inside) {
    const s = String(raw)
    const fs = FS[fontCls]
    const t = round(lineTop)
    reserve({ x, y: t, w: tw(s, fs), h: lh(fs) }, 'text', s, inside)
    // The baseline is a ROUNDED offset, not `fs*1.1` in floating point: the checker
    // re-derives it from the manifest, and a value it cannot re-derive is a value it
    // cannot check. One rounding, on the finished number.
    const baseline = round(t + round(fs * 1.1 * 100) / 100)
    svgParts.push(`<text class="${fontCls}" x="${round(x)}" y="${baseline}">${esc(s)}</text>`)
  }

  function card(x, y, w, h, klass, label) {
    const i = reserve({ x, y, w, h }, 'box', label)
    svgParts.push(`<rect class="${klass}" x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="1"/>`)
    return i
  }

  function rule(x, y, w, h, klass, label, inside) {
    const i = reserve({ x, y, w, h }, 'rule', label, inside)
    svgParts.push(`<path class="${klass}" d="M${round(x)} ${round(y)} L${round(x + w)} ${round(y + h)}"/>`)
    return i
  }

  const ruleH = (x, y, w, klass, label, inside) => rule(x, y - LINE_PAD, w, LINE_PAD * 2, klass, label, inside)
  const ruleV = (x, y, h, klass, label, inside) => rule(x - LINE_PAD, y, LINE_PAD * 2, h, klass, label, inside)

  function head(pts, polyCls, label, inside) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
    reserve({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }, 'ink', label, inside)
    svgParts.push(`<polygon class="${polyCls}" points="${pts.map((p) => round(p[0]) + ',' + round(p[1])).join(' ')}"/>`)
  }

  /** Greedy word wrap, in CHARACTERS, so the reserved box is exact by construction. */
  function wrap(s, fs, maxW) {
    const lim = Math.max(4, Math.floor(maxW / (CHAR_W * fs)))
    const out = []
    for (const para of String(s).split('\n')) {
      let line = ''
      for (const word of para.split(/\s+/)) {
        const cand = line ? line + ' ' + word : word
        if (cand.length <= lim) { line = cand; continue }
        if (line) out.push(line)
        line = word
      }
      if (line) out.push(line)
    }
    return out
  }

  /** A block of prose: each wrapped line in its OWN reserved row. */
  function para(x, top, maxW, fontCls, s) {
    const fs = FS[fontCls]
    const step = lh(fs)
    let y = round(top)
    for (const line of wrap(s, fs, maxW)) { textEl(x, y, fontCls, line); y = round(y + step) }
    return y
  }

  /**
   * A CARD AND ITS TEXT, with the card's height DERIVED from the rows it holds rather
   * than chosen. That is what makes the arrow geometry below safe: a box is as tall as
   * its own content, so a stub computed from its bottom edge cannot land inside it.
   * Rows are strings (the default class) or `{ cls, s }`.
   */
  function block(x, y, w, klass, rows, opts = {}) {
    const pad = opts.pad === undefined ? PAD : opts.pad
    const gap = opts.gap === undefined ? 1 : opts.gap
    const norm = rows.map((r) => (typeof r === 'string' ? { cls: opts.cls || CLS.s, s: r } : r))
    let h = pad * 2
    norm.forEach((r, i) => { h += lh(FS[r.cls]) + (i < norm.length - 1 ? gap : 0) })
    h = round(h)
    const i = card(x, y, w, h, klass, opts.label || norm[0].s)
    let ty = round(y + pad)
    for (const r of norm) {
      textEl(x + pad, ty, r.cls, r.s, i)
      ty = round(ty + lh(FS[r.cls]) + gap)
    }
    return { i, h, bottom: round(y + h) }
  }

  /** The same, with each row word-wrapped to the card's own width first. */
  function blockPara(x, y, w, klass, rows, opts = {}) {
    const flat = []
    for (const r of rows) {
      const cls = typeof r === 'string' ? (opts.cls || CLS.s) : r.cls
      const s = typeof r === 'string' ? r : r.s
      for (const line of wrap(s, FS[cls], w - 2 * PAD)) flat.push({ cls, s: line })
    }
    return block(x, y, w, klass, flat, opts)
  }

  return {
    GUTTER, PAD, LINE_PAD, CLS, FS, tw, lh, round, boxes, contains, svgParts,
    reserve, textEl, card, rule, ruleH, ruleV, head, wrap, para, block, blockPara,
  }
}

/**
 * Draw one chart through the engine and wrap it in its own scrollable box. `draw(api)`
 * returns `{ width, height }`, or `{ x, y, width, height }` when the chart's own layout
 * extends ABOVE and LEFT of its node row — which the merged overview does, because the
 * lanes that carry the backwards and cross-run edges are drawn above and below it. In
 * that case the viewBox carries the origin, so the emitted SVG still begins at (0,0)
 * while the manifest keeps absolute coordinates the checker can compare directly.
 * The manifest is built from the boxes the engine actually reserved, so what the
 * checker re-reads is what was emitted.
 */
function chart(spec) {
  const api = makeEngine()
  const size = spec.draw(api)
  const ox = size.x === undefined ? 0 : size.x
  const oy = size.y === undefined ? 0 : size.y
  /* NOTHING IS DRAWN OUTSIDE THE FRAME. The viewBox is derived from what was reserved
     rather than from a chosen number, and this assertion is what makes that true: a lane
     that ran past the top of the frame would be CLIPPED by the svg, silently — the defect
     class this whole engine exists to refuse. */
  for (const b of api.boxes) {
    if (b.x < ox - 3 || b.y < oy - 3 || b.x + b.w > ox + size.width + 3 || b.y + b.h > oy + size.height + 3) {
      throw new Error('chart ' + spec.id + ': ' + b.kind + ' "' + b.label + '" falls outside the frame '
        + JSON.stringify([ox, oy, size.width, size.height]) + ' at ' + JSON.stringify([b.x, b.y, b.w, b.h]))
    }
  }
  const manifest = {
    v: 1,
    charW: CHAR_W,
    lineHeight: TEXT_LH,
    viewBox: [ox, oy, size.width, size.height],
    fit: api.boxes.filter((b) => b.kind === 'text').map((b) => [b.label, b.x, b.y, b.w, b.h]),
    boxes: api.boxes.map((b) => [b.kind, b.x, b.y, b.w, b.h, b.label]),
    // The declared overlaps, by index pair: [inside, container]. A box that CONTAINS
    // another is an overlap by construction, so the relation is exported rather than
    // left for the checker to re-infer — an inferred exception is not a checked one.
    contains: api.contains,
  }
  return {
    id: spec.id,
    width: size.width,
    height: size.height,
    markup: `
  <div class="diagram" id="dg-${spec.id}" data-diagram="${spec.id}" role="img" aria-label="${esc(spec.label)}" style="--dg-w:${size.width}px" data-layout="${esc(JSON.stringify(manifest)).replace(/\n/g, ' ')}">
    <svg viewBox="${ox} ${oy} ${size.width} ${size.height}" width="${size.width}" height="${size.height}" preserveAspectRatio="xMinYMin meet">
${api.svgParts.map((s) => '      ' + s).join('\n')}
    </svg>
  </div>`,
  }
}

/* ---- CHART 1: the overview — THE WHOLE GRAPH, ON THE VIEW A READER OPENS ---- */

/**
 * ⚠ TWO ROWS OF SIX, AND THIS IS THE ONE THING THE PREVIOUS VERSION GOT WRONG.
 *
 * The overview used to be twelve nodes in ONE row. It was 2854 units wide inside a reading
 * column that measures 1141-1216 units, so a reader opening the page saw five of the twelve
 * phases and had to scroll sideways to discover the other seven. Every invariant in this file
 * was green while that shipped, because nothing ever compared the chart's width with the width
 * of the box it lands in. THE WHOLE POINT OF AN OVERVIEW IS TO SEE THE WHOLE WORKFLOW, so the
 * sequence wraps onto two rows of six, and the chart is 1128 units wide — narrower than the
 * 1141 units the page gives it at a 1280px window (measured in headless Chromium, not derived
 * from the token arithmetic) and narrower than the 1216 it gives it at 1440.
 *
 * HOW THE WRAP READS. Row 1 runs left to right (00-requirements .. 03-implementation-summary)
 * and row 2 runs RIGHT TO LEFT (03.5-code-review .. 08-memory-impact), the way a wrapped line
 * of text snakes back on itself. That is not a decoration: it is the only arrangement of
 * six-plus-six in which the row boundary lands on a pair that can be drawn as ONE VERTICAL
 * ARROW. The last phase of row 1 and the first of row 2 are joined by a real derived input edge
 * (a spine edge, not a sequence-order pair), so the wrap is a short solid arrow straight down a
 * single column — and the reader is told two things at once: where the sequence continues, and
 * that the continuation is a dependency rather than an accident of layout.
 *
 * The alternative — both rows reading left to right — was worked out on paper and refused by
 * arithmetic. The wrap edge would then run from column 5 of row 1 to column 0 of row 2, and a
 * run long enough to cross the whole canvas passes over the source stubs of every other edge
 * (which descend from row 1) AND the target stubs of every other edge (which descend into row
 * 2), so it is crossed by all of them: four crossings instead of one.
 *
 * ⚠ AND THERE IS EXACTLY ONE CROSSING, DECLARED RATHER THAN HIDDEN. 02-to-be-plan reads the
 * code review (column 4 of row 1 -> column 5 of row 2) and 03-implementation-summary reads the
 * test summary (column 5 -> column 4): the two arrows swap columns, so they cross, like two
 * one-way streets between the same pair of junctions. The bridge is declared to the engine
 * (`reserve(..., inside)`) and re-derived by `check-workflow-map.mjs`, which accepts a declared
 * pair only when it is a real containment or a touch within ONE stroke width — so the
 * declaration cannot hide a collision, it can only state "these two strokes meet, here, on
 * purpose". Every other pair of edges in this chart is drawn without crossing anything.
 *
 * WHAT THE LAYOUT KEEPS FROM THE ONE-ROW VERSION. Every one of the ${EDGES.length} directed edges is still
 * drawn, one run each, in the same five shapes: a solid arrow for a required input, a dashed one
 * for a conditional input, a dotted one for sequence order with no input edge at all, a thick one
 * off the wildcard rail, and a violet arc for the two BACKWARD edges. The wildcard rail still
 * spans the node row exactly. The dashed fan-in border still marks the phases that read more than
 * one upstream artifact, and every node still states its own fan-in in words.
 *
 * WHAT MOVED, AND WHY. The human-decision markers used to float in a band 196 units above the
 * node row, and the refusal bands sat 134 units below their own node — a detached strip that read
 * as a legend rather than as a mark on a phase. Both are attached now: the amber marker sits
 * three units above the node it annotates, and the hatched refusal band is the node's own next
 * line, three units under its bottom edge. The vertical extent follows the content.
 * `OVERVIEW_LIMITS` below states the width, height and empty-space budgets, and both `--verify`
 * and `check-workflow-map.mjs` assert them against the emitted manifest.
 */
function drawOverview(api) {
  const { PAD, LINE_PAD, CLS, FS, tw, lh, round, card, textEl, ruleH, ruleV, head, block } = api

  /* ======================= 1. THE GRID =================================== */
  const GUTTER = 40           // the left margin: the cross-run return arc lives in it, and nothing else
  const COLS = 6
  const NODE_GAP = 22         // the arrow between two adjacent boxes lives in this gap
  const HEAD_L = 8            // the arrowhead, along the line
  const SEQ_HALF = 4          // the arrowhead, across the line
  const ANNOT_GAP = 3         // the refusal band sits this close under its node
  const MARK_GAP = 3          // the human marker sits this close above its node
  const LANE_STEP = 22        // one lane's run plus the label row under it
  const LABEL_H = lh(FS[CLS.s])
  const humanCol = (file) => (file === '05-manual-qa.md' ? 'qa-signoff'
    : file === '03-implementation-summary.md' ? 'tdd-mode' : 'run-start')

  const short = (file) => file.replace(/\.md$/, '')
  const idxOf = Object.fromEntries(PHASES.map((p, i) => [p.file, i]))
  const rowOf = (i) => Math.floor(i / COLS)
  /**
   * WHICH CANVAS COLUMN A PHASE SITS IN. Row 1 is written left to right; row 2 is written back
   * the other way, so 03.5-code-review — the first phase of row 2 — lands in the SAME column as
   * 03-implementation-summary, the last of row 1, and the row boundary is one vertical arrow
   * rather than a run across the canvas. See the header for why that is a forced choice.
   */
  const colOf = (i) => (rowOf(i) === 0 ? i % COLS : COLS - 1 - (i % COLS))

  /* The two lines every node carries under its name, and the widest of them, which is what sets
     the node's width. The name itself may wrap at a hyphen; these two may not, because they are
     the rows that make the twelve boxes a grid rather than a ragged shelf. */
  const phaseLine = (p) => 'phase ' + p.phaseN + ' — ' + PURPOSES[p.file].label
  const OTHER_W = Math.max(...PHASES.map((p) => Math.max(tw(phaseLine(p), FS[CLS.s]), tw(fanInText(p.file), FS[CLS.s]))))
  const NODE_W = Math.ceil(OTHER_W + 2 * PAD)
  const NAME_SLOT = round(lh(FS[CLS.t]) + 1)
  const NODE_H = round(6 + 2 * NAME_SLOT + lh(FS[CLS.s]) + 1 + lh(FS[CLS.s]) + 6)
  const PITCH = NODE_W + NODE_GAP
  const colX = (c) => round(GUTTER + c * PITCH)
  const nodeX = (i) => colX(colOf(i))
  const nodeRight = (i) => round(nodeX(i) + NODE_W)
  const rowW = COLS * NODE_W + (COLS - 1) * NODE_GAP
  const GRID_R = round(GUTTER + rowW)
  /**
   * THE RIGHT-HAND CHANNEL IS NOT DECORATION. The reopen arc leaves the last node of row 2
   * through its right edge and climbs back to row 1 in this margin, which is the one vertical
   * line on the canvas that crosses nothing at all: everything else is inside the grid.
   *
   * ⚠ 19 UNITS OUT, NOT 9, AND THE NINE WAS A READABILITY DEFECT RATHER THAN A COLLISION. At
   * `GRID_R + 9` the riser's own stroke ran 6.5 units from the right edge of BOTH nodes in
   * column 5 — one of which it attaches to and one of which it does not. Nothing overlapped, so
   * five rounds of intersection checks stayed green, and a reader looking at the picture read the
   * violet arc as belonging to 03-implementation-summary, the node it only passes. The
   * `PROXIMITY_MIN` invariant below is the number that refuses that: a run may come no closer
   * than 14 units to a node box it does not attach to, and 19 out clears it by 5.5.
   */
  const RISER_X = round(GRID_R + 19)
  const W = Math.ceil(GRID_R + 24)

  /** The node's name, split at a hyphen when it cannot fit on one line. */
  const NAME_W = NODE_W - 2 * PAD
  const nameLinesOf = (file) => {
    const n = short(file)
    if (tw(n, FS[CLS.t]) <= NAME_W) return [n]
    for (let k = n.lastIndexOf('-'); k > 0; k = n.lastIndexOf('-', k - 1)) {
      const a = n.slice(0, k), b = n.slice(k + 1)
      if (tw(a, FS[CLS.t]) <= NAME_W && tw(b, FS[CLS.t]) <= NAME_W) return [a, b]
    }
    throw new Error('overview chart: the node label "' + n + '" does not fit in ' + NAME_W
      + ' units and cannot be split at a hyphen — widen the grid or shorten the name')
  }
  const NAMES = Object.fromEntries(PHASES.map((p) => [p.file, nameLinesOf(p.file)]))
  for (const p of PHASES) {
    if (NAMES[p.file].length > 2) throw new Error('overview chart: ' + p.file + ' needs more than two name lines')
    if (p.human && NAMES[p.file].length > 1) throw new Error('overview chart: ' + p.file + ' has both a human marker and a two-line name')
  }

  /* ======================= 2. THE EDGES, CLASSIFIED ====================== */
  /* The LABEL vocabulary is the derived edge kind, exactly as it was: an edge between two
     adjacent phases is a `spine`, anything else is a `lane`, and the wildcard branch is a
     `wildcard stub`. Both checkers build the sixteen expected labels from the linter's own input
     map and compare them with what the chart says it drew, so the drawing may change shape but
     the words may not. */
  const spine = []
  const lanes = []
  const wild = []
  for (const edge of EDGES) {
    if (edge.kind === 'wildcard') { wild.push(edge); continue }
    const s = idxOf[edge.from], t = idxOf[edge.to]
    if (s === undefined || t === undefined) throw new Error('overview chart: unknown edge endpoint ' + edge.from + ' -> ' + edge.to)
    if (!(s < t)) throw new Error('overview chart: edge ' + edge.from + ' -> ' + edge.to + ' does not run forward in PHASE_SEQUENCE')
    if (t - s === 1) spine.push(edge)
    else lanes.push(edge)
  }
  const seqOnly = []
  for (let i = 0; i + 1 < PHASES.length; i++) {
    if (!spine.some((e) => idxOf[e.from] === i)) seqOnly.push(i)
  }
  if (seqOnly.length !== 4) {
    throw new Error('overview chart: expected exactly 4 adjacent pairs with no input edge, got ' + seqOnly.length
      + ' — spine: ' + spine.map((e) => e.from + '->' + e.to).join(', '))
  }
  /* ⚠ THE PHYSICAL CLASSIFICATION, ALSO ASSERTED. The canvas has two rows, so every edge is
     either inside one row or across the boundary — and the counts below are facts about this
     edge set on a six-plus-six grid, not preferences. If the source ever grows an edge that
     breaks one of them, the generator stops instead of drawing a picture whose arithmetic no
     longer holds. */
  const sameRow = (e) => rowOf(idxOf[e.from]) === rowOf(idxOf[e.to])
  const crossSpines = spine.filter((e) => !sameRow(e))
  const rowSpines = spine.filter(sameRow)
  const crossLanes = lanes.filter((e) => !sameRow(e))
  const rowLanes = lanes.filter(sameRow)
  if (PHASES.length !== 2 * COLS) throw new Error('overview chart: the grid is ' + COLS + ' columns and the run is ' + PHASES.length + ' phases')
  if (crossSpines.length !== 1 || rowSpines.length !== 6) {
    throw new Error('overview chart: expected exactly one spine edge across the row boundary and six inside the rows, got '
      + crossSpines.length + ' + ' + rowSpines.length)
  }
  if (rowLanes.length !== 3 || crossLanes.length !== 4) {
    throw new Error('overview chart: expected 3 lanes inside a row and 4 across the boundary, got ' + rowLanes.length + ' + ' + crossLanes.length)
  }
  const wrap = crossSpines[0]
  if (idxOf[wrap.from] !== COLS - 1 || idxOf[wrap.to] !== COLS) {
    throw new Error('overview chart: the row boundary must fall on the spine edge ' + PHASES[COLS - 1].file
      + ' -> ' + PHASES[COLS].file + ', not on ' + wrap.from + ' -> ' + wrap.to)
  }
  const laneOf = (from, to) => {
    const e = lanes.find((x) => x.from === from && x.to === to)
    if (!e) throw new Error('overview chart: no lane ' + from + ' -> ' + to)
    return e
  }
  const L02 = laneOf(PHASES[0].file, PHASES[2].file)   // 00-requirements -> 01-as-is
  const L04 = laneOf(PHASES[0].file, PHASES[4].file)   // 00-requirements -> 02-to-be-plan
  const L24 = laneOf(PHASES[2].file, PHASES[4].file)   // 01-as-is -> 02-to-be-plan
  const L46 = laneOf(PHASES[4].file, PHASES[6].file)   // 02-to-be-plan -> 03.5-code-review
  const L47 = laneOf(PHASES[4].file, PHASES[7].file)   // 02-to-be-plan -> 04-test-summary
  const L48 = laneOf(PHASES[4].file, PHASES[8].file)   // 02-to-be-plan -> 05-manual-qa
  const L57 = laneOf(PHASES[5].file, PHASES[7].file)   // 03-implementation-summary -> 04-test-summary
  void crossLanes

  /* ======================= 3. THE VERTICAL STACK ========================= */
  /* Every band is measured from the one above it, so the height of the chart follows its
     content: nothing sits at a chosen y, and a band that grows pushes the rest down. */
  const MARK_H = round(LABEL_H + 2)                       // the amber marker, one text line tall
  const MARK_BAND = round(MARK_H + MARK_GAP)              // the strip above a row a marker may occupy
  const ANNOT_H = Math.round(2 * PAD + LABEL_H)           // the refusal band, one text line tall
  const TOP_LEVELS = 4                                   // 0->2, 2->4, 0->4, and the reopen's return run
  const MID_LEVELS = 3                                   // 4->6, 4->8, 5->7 (the other two cross vertically)

  let y = 0
  const titleY = y
  y = round(y + lh(FS[CLS.a]) + 8)

  const topTop = y
  const topY = (k) => round(topTop + (TOP_LEVELS - 1 - k) * LANE_STEP)
  y = round(topTop + TOP_LEVELS * LANE_STEP + 10)

  const rowATop = round(y + MARK_BAND)
  const rowABottom = round(rowATop + NODE_H)
  const annotATop = round(rowABottom + ANNOT_GAP)
  y = round(annotATop + ANNOT_H + 8)

  const midTop = y
  const midY = (k) => round(midTop + k * LANE_STEP)
  y = round(midTop + MID_LEVELS * LANE_STEP + 8)

  const rowBTop = round(y + MARK_BAND)
  const rowBBottom = round(rowBTop + NODE_H)
  const annotBTop = round(rowBBottom + ANNOT_GAP)
  y = round(annotBTop + ANNOT_H + 8)

  /* ⚠ THE REVISE LOOP LIVES BETWEEN ROW 2 AND THE WILDCARD RAIL, and both of its verticals stand
     in the FREE COLUMN at the right-hand end of a node — the part of the node's own footprint
     that its refusal band does not occupy. That is what keeps the loop from crossing the rail at
     all: it never goes below it. */
  const reviseShelfY = round(y + 14)
  y = round(reviseShelfY + 16)

  const railTop = y
  const railH = Math.round(2 * PAD + lh(FS[CLS.t]) + 1 + lh(FS[CLS.s]) + 1 + lh(FS[CLS.s]))
  y = round(railTop + railH + 14)

  /* ======================= 4. TWO HELPERS THAT NEED THE METRIC =========== */
  /**
   * Is this candidate box free of everything reserved so far? ⚠ NO CONTAINMENT EXEMPTION HERE,
   * and that is deliberately stricter than the engine's rule. The engine allows a box inside a box
   * — that is how a card holds its label — but a LABEL inside another LABEL is not a structure, it
   * is one name printed through another. A search that treated containment as free laid two lane
   * labels at the same point and every invariant stayed green, so the search is stricter than the
   * gate: a candidate must not touch anything at all.
   */
  const fitsHere = (box) => api.boxes.every((o) => {
    const ix = Math.min(box.x + box.w, o.x + o.w) - Math.max(box.x, o.x)
    const iy = Math.min(box.y + box.h, o.y + o.h) - Math.max(box.y, o.y)
    return ix <= 0.05 || iy <= 0.05
  })
  /**
   * THE FIRST x WHERE A ONE-LINE LABEL FITS, solved rather than guessed. It returns null when
   * there is no slot: an edge's label is decoration on top of the mark that carries the meaning,
   * and a label that cannot fit is dropped rather than drawn over a stroke. The four cross-row
   * labels are required (they name the shortest, least obvious edges in the picture) and they
   * throw instead.
   */
  const putLabel = (text, yTop, from, to, must) => {
    const w = tw(text, FS[CLS.s])
    for (let x = round(from); x + w <= to; x = round(x + 2)) {
      if (fitsHere({ x, y: yTop, w, h: LABEL_H })) { textEl(x, yTop, CLS.s, text); return x }
    }
    if (must) {
      const blockers = api.boxes.filter((o) => o.y < yTop + LABEL_H && yTop < o.y + o.h && o.x < to && from < o.x + o.w)
        .map((o) => o.label + ' ' + JSON.stringify([o.x, o.y, o.w, o.h]))
      throw new Error('overview chart: no free slot for the label "' + text + '" between ' + round(from) + ' and ' + round(to)
        + ' at y=' + yTop + ' — blocked by: ' + blockers.slice(0, 6).join(' | '))
    }
    return null
  }
  /**
   * The same search, running LEFTWARD from an anchor: a label for a stroke that stands on the
   * label's right (the bundle trunk) has to be right-aligned against it, or the nearest stroke to
   * the label is whichever neighbour happens to be closer than the one it names.
   */
  const putLabelRight = (text, yTop, rightX, must) => {
    const w = tw(text, FS[CLS.s])
    for (let x = round(rightX - w); x >= GUTTER; x = round(x - 2)) {
      if (fitsHere({ x, y: yTop, w, h: LABEL_H })) { textEl(x, yTop, CLS.s, text); return x }
    }
    if (must) {
      throw new Error('overview chart: no free slot for the label "' + text + '" ending at ' + round(rightX)
        + ' at y=' + yTop + ' — the trunk has no clear space to its left')
    }
    return null
  }

  /* ======================= 5. THE NODES ================================== */
  /**
   * THE FREE COLUMN UNDER A NODE. A refusal band is as wide as its own label, and everything that
   * has to pass a node's bottom edge — a lane on its way down, a wildcard stub on its way up, a
   * back edge re-entering — travels in the strip to the right of it. The strip is measured per
   * node, and a node whose label leaves too little room is a build failure rather than a stroke
   * drawn through a hatched band.
   */
  const bandText = refusalBandText
  const annotW = (file) => Math.ceil(tw(bandText(file), FS[CLS.s]) + 2 * PAD)
  const freeFrom = (i) => round(nodeX(i) + annotW(PHASES[i].file))
  const columnAt = (i, back, what) => {
    const x = round(nodeRight(i) - back)
    if (!(round(x - LINE_PAD - 1) >= freeFrom(i))) {
      throw new Error('overview chart: no free column for ' + what + ' under node ' + PHASES[i].file
        + ' — the refusal band leaves only ' + round(nodeRight(i) - freeFrom(i)) + ' units')
    }
    return x
  }
  const freeX = (i, k) => columnAt(i, 11 + 12 * k, 'a column under ' + PHASES[i].file)
  const needColumn = (i, k, what) => columnAt(i, 11 + 12 * k, what)

  PHASES.forEach((p, i) => {
    const x = nodeX(i)
    const top = rowOf(i) === 0 ? rowATop : rowBTop
    const multi = sourcesOf(p.file) > 1
    const node = card(x, top, NODE_W, NODE_H, multi ? 'dg-box dg-box-fan' : 'dg-box', 'node ' + p.file)
    const names = NAMES[p.file]
    /* The name slot is two lines tall for every node, because one name in the run needs two; a
       one-line name is CENTRED in that slot rather than pinned to its top, so the eleven short
       names do not read as eleven labels with a gap under them. */
    const nameY = names.length === 1 ? round(top + 6 + NAME_SLOT / 2) : round(top + 6)
    names.forEach((line, k) => {
      textEl(round(x + PAD), round(nameY + k * NAME_SLOT), CLS.t, line, node)
    })
    textEl(round(x + PAD), round(top + 6 + 2 * NAME_SLOT), CLS.s, phaseLine(p), node)
    textEl(round(x + PAD), round(top + 6 + 2 * NAME_SLOT + lh(FS[CLS.s]) + 1), CLS.s, fanInText(p.file), node)

    /* THE HUMAN-DECISION MARKER, three units above the node it annotates — not in a band of its
       own, which is where it used to float. It is a card of its own so that the legend's swatch
       and this box are the same shape, and so the diamond inside it is a declared containment
       rather than ink painted over a border. */
    if (p.human) {
      const gate = humanCol(p.file)
      const w = Math.ceil(17 + tw(gate, FS[CLS.s]) + 5)
      const mx = round(x + (NODE_W - w) / 2)
      const mTop = round(top - MARK_GAP - MARK_H)
      const m = card(mx, mTop, w, MARK_H, 'dg-box-human', 'human decision marker ' + p.file)
      head([[round(mx + 4), round(mTop + MARK_H / 2)], [round(mx + 9), round(mTop + 2)],
        [round(mx + 14), round(mTop + MARK_H / 2)], [round(mx + 9), round(mTop + MARK_H - 2)]],
      'dg-mark', 'decision diamond ' + p.file, m)
      textEl(round(mx + 17), round(mTop + 1), CLS.s, gate, m)
    }

    /* THE REFUSAL BAND — the node's own next line, and it names the NARROWEST rule that bites
       there, which is why the picture reads as a refusal surface rather than as twelve identical
       hatched strips: three built-in rules fire on a tool pattern alone and bite everywhere, and
       the named baselines bite where the phase number selects them. */
    const annotTop = rowOf(i) === 0 ? annotATop : annotBTop
    const band = card(x, annotTop, annotW(p.file), ANNOT_H, 'dg-box-refuse', 'refusal band ' + p.file)
    textEl(round(x + PAD), round(annotTop + (ANNOT_H - LABEL_H) / 2), CLS.s, bandText(p.file), band)
  })

  /* ======================= 6. THE WILDCARD RAIL ========================== */
  /* ⚠ THE RAIL IS RESERVED BEFORE ANY VERTICAL STUB THAT CROSSES IT, because the only overlap the
     engine allows is a declared one and a declaration can only name a box that exists. The rail
     spans the node row EXACTLY — both checkers assert that — and its own text is placed against
     its right-hand edge, where the two phases it describes are. */
  const rail = card(GUTTER, railTop, rowW, railH, 'dg-box-rail', 'the wildcard input rail')
  const railLines = [
    [CLS.t, 'EVERY PRESENT ARTIFACT EXCEPT ITSELF — the wildcard input, declared by ' + wild.length + ' phases'],
    [CLS.s, 'RUN_ARTIFACT_SEQUENCE.filter(a => present.has(a) && a !== thisFile) — ' + WILDCARD_SOURCES + ' possible sources, and NO single one of them is required'],
    [CLS.s, 'Drawn as ONE rail with ' + wild.length + ' thick arrows rather than as ' + (wild.length * WILDCARD_SOURCES) + ' lines, because a bundle of eleven into one node is the picture that stops being readable.'],
  ]
  const railTextX = round(GUTTER + rowW - Math.max(...railLines.map(([cls, s]) => tw(s, FS[cls]))) - PAD)
  let railY = round(railTop + PAD)
  for (const [cls, s] of railLines) {
    textEl(railTextX, railY, cls, s, rail)
    railY = round(railY + lh(FS[cls]) + 1)
  }

  /* THE WILDCARD STUBS — one thick arrow per phase that reads the wildcard, rising from the rail's
     top edge into the node's own bottom edge, in the free column beside its refusal band. Row 2's
     wildcard phases are 06-decisions-update and 08-memory-impact. */
  for (const edge of wild) {
    const i = idxOf[edge.to]
    if (rowOf(i) !== 1) throw new Error('overview chart: the wildcard stub into ' + edge.to + ' is not in row 2, where the rail is')
    const x = needColumn(i, 0, 'the wildcard stub into ' + edge.to)
    head([[x, rowBBottom], [round(x - SEQ_HALF), round(rowBBottom + HEAD_L)], [round(x + SEQ_HALF), round(rowBBottom + HEAD_L)]],
      'dg-head-wide', 'wildcard head ' + edge.to)
    ruleV(x, round(rowBBottom + HEAD_L), round(railTop - rowBBottom - HEAD_L), 'dg-line-wide', 'wildcard stub ' + edge.to)
  }

  /* ======================= 7. ROW 1's THREE LANES ======================== */
  /**
   * The three lanes inside row 1 keep the shape the one-row chart already used: a stub up from the
   * source node's top edge, a run in its own level of the band above the row, a stub down into the
   * target's top edge, and an arrowhead. `graphBands` SOLVES the level order from the edges' own
   * intervals so that no run crosses another; it is handed the three lanes and must fit them in
   * one band, which is asserted below rather than assumed.
   */
  const toLane = (edge) => ({ edge, s: colOf(idxOf[edge.from]), t: colOf(idxOf[edge.to]) })
  const [topBand, topSpare] = graphBands([toLane(L02), toLane(L04), toLane(L24)])
  if (topSpare.length !== 0 || topBand.length !== 3) {
    throw new Error('overview chart: row 1 needs exactly one routing band above it, got ' + topBand.length + ' + ' + topSpare.length)
  }
  /* SOURCE side: the farther lane attaches LEFTMOST, so its long stub rises clear of every nearer
     run. TARGET side: the farther lane attaches RIGHTMOST, so the nearer edge's run ends before
     that stub comes down. Both directions are needed; the engine refuses either mistake.
     ⚠ THE STEP IS A READABILITY NUMBER, NOT A GAP-FILLER. Two stubs 12 units apart draw two
     5-unit strokes 7 units apart, which a reader sees as one doubled line; `CHANNEL_MIN` below
     refuses anything under 12, so the source side steps 25 and the target side 30. */
  const SOURCE_STEP = 25
  const ARRIVE_STEP = 30
  /* ⚠ AND AN ARRIVAL DOES NOT LAND ON THE CORNER OF THE NODE IT POINTS AT. Every one of the
     three arrival stubs used to land 6 units inside its target's left edge, which is where the
     gap between two nodes is: the arrowhead read as pointing at the boundary rather than at the
     phase. `LAND_MARGIN` below is the number that refuses that, and 20 is what this band has
     room for (the longest arrival run is 641 units against a 155-unit label). */
  const ARRIVE_MARGIN = 20
  const attach = (file, side, list, step, margin) => {
    const base = side === 'out' ? round(nodeRight(idxOf[file]) - 6) : round(nodeX(idxOf[file]) + margin)
    const sorted = [...list].sort((a, b) => (side === 'out' ? b.dist - a.dist : a.dist - b.dist))
    sorted.forEach((e, j) => { e[side] = round(side === 'out' ? base - (sorted.length - 1 - j) * step : base + j * step) })
  }
  topBand.forEach((e, k) => { e.dist = k })
  attach(PHASES[0].file, 'out', topBand.filter((e) => e.edge.from === PHASES[0].file), SOURCE_STEP, 0)
  attach(PHASES[2].file, 'out', topBand.filter((e) => e.edge.from === PHASES[2].file), SOURCE_STEP, 0)
  attach(PHASES[2].file, 'in', topBand.filter((e) => e.edge.to === PHASES[2].file), ARRIVE_STEP, ARRIVE_MARGIN)
  attach(PHASES[4].file, 'in', topBand.filter((e) => e.edge.to === PHASES[4].file), ARRIVE_STEP, ARRIVE_MARGIN)

  let laneLabelsDrawn = 0
  for (const e of topBand) {
    const yy = topY(e.dist)
    const xs = e.out, xt = e.in
    const dash = e.edge.kind === 'conditional'
    const line = dash ? 'dg-line-cond' : 'dg-line'
    const headCls = dash ? 'dg-head-cond' : 'dg-head'
    /**
     * ⚠ WHERE A RUN ENDS: ON ITS OWN TARGET STUB, NOT SHORT OF IT.
     *
     * This is the defect the owner saw as "the lines connecting phases are somewhat broken", and
     * it was both a break and a silence. The run used to stop `HEAD_L` short of its target stub
     * — on the theory that the arrowhead covers the join, which is false: the arrowhead is at the
     * NODE's top edge, one stub-length away — and it was additionally trimmed short of every
     * FOREIGN arrowhead whose x lay to its right. For the outermost of the three lanes the
     * foreign head it hit first was 01-as-is's, 375 units short of its own arrival: the run ended
     * in mid-air above x=403, and the arrival stub at x=820 hung off nothing. Two strokes, one
     * edge, and every count-based check green, because a box labelled `lane 00-requirements.md ->
     * 02-to-be-plan.md` existed and had the right words in it.
     *
     * The run now ends ON the stub's own reserved box, so the corner is a real join: the run's
     * box and the stub's box overlap by exactly the 2.5 units of `LINE_PAD` and the overlap is
     * DECLARED (`inside = run`), which is the same allowance the engine already makes for every
     * other corner in this chart. `TRACE` below re-derives the whole polyline from the emitted
     * manifest and refuses any edge whose strokes do not reach its target.
     */
    const run = ruleH(xs, yy, round(xt - xs), line, 'lane ' + e.edge.from + ' -> ' + e.edge.to)
    ruleV(xs, yy, round(rowATop - yy), line, 'stub out ' + e.edge.from, run)
    const stubT = ruleV(xt, yy, round(rowATop - HEAD_L - yy), line, 'stub in ' + e.edge.to, run)
    head([[xt, rowATop], [round(xt - SEQ_HALF), round(rowATop - HEAD_L)], [round(xt + SEQ_HALF), round(rowATop - HEAD_L)]],
      headCls, 'lane arrow ' + e.edge.to, stubT)
    /* ⚠ ONE LABEL PER RUN, NAMING BOTH OF ITS ENDPOINTS. The label used to name the SOURCE only,
       so the two lanes out of 00-requirements printed the same word twice and a reader had to
       trace pixels to tell them apart — the same defect as the three `02-to-be-plan` labels in
       the band between the rows. `from → to` is unique for every lane in the chart by
       construction (each edge is one pair), which is what `LABEL_*` below asserts. */
    const label = short(e.edge.from) + ' → ' + short(e.edge.to) + (dash ? ' · when present' : '')
    if (putLabel(label, round(yy + LINE_PAD + 1), round(xs + 2), round(xt - 2)) !== null) laneLabelsDrawn++
  }

  /* ======================= 8. THE ROW BOUNDARY =========================== */
  /**
   * ⚠ THE WRAP IS ONE VERTICAL ARROW, AND IT IS A REAL EDGE RATHER THAN A SEQUENCE MARK. It leaves
   * the bottom of the last node of row 1 in the free column beside that node's refusal band and
   * lands on the top edge of the first node of row 2, in the same canvas column. Because both ends
   * are in one column there is no run at all: this is the one edge in the chart whose whole drawing
   * is a single stroke, and it is the reason the rows are drawn in opposite directions.
   */
  const WRAP_X = needColumn(idxOf[wrap.from], 1, 'the row-boundary spine out of ' + wrap.from)
  const wrapArrival = needColumn(idxOf[wrap.to], 1, 'the row-boundary spine into ' + wrap.to)
  if (WRAP_X !== wrapArrival) throw new Error('overview chart: the row boundary is not a single column')
  /* ⚠ THE WRAP LANDS 23 UNITS INSIDE ITS TARGET, NOT 11, and the nine was the same defect the
     reopen arc had: an arrowhead 11 units from a node's right edge, with the neighbouring column
     22 units away on the other side of that edge, reads as ambiguous. `needColumn(…, 1)` puts it
     at 1081 of a node that ends at 1104 — 23 in, against LAND_MARGIN's 16. */
  if (!(nodeRight(idxOf[wrap.to]) - WRAP_X >= LAND_MARGIN)) {
    throw new Error('overview chart: the row-boundary spine lands in the corner of ' + wrap.to)
  }
  const wrapDash = wrap.kind === 'conditional'
  const wrapRun = ruleV(WRAP_X, rowABottom, round(rowBTop - HEAD_L - rowABottom),
    wrapDash ? 'dg-line-cond' : 'dg-line', 'spine ' + wrap.from + ' -> ' + wrap.to)
  head([[WRAP_X, rowBTop], [round(WRAP_X - SEQ_HALF), round(rowBTop - HEAD_L)], [round(WRAP_X + SEQ_HALF), round(rowBTop - HEAD_L)]],
    wrapDash ? 'dg-head-cond' : 'dg-head', 'spine head ' + wrap.to, wrapRun)

  /* ======================= 9. THE FOUR CROSS-ROW LANES =================== */
  /**
   * ⚠ THE LEVELS BELOW ARE SOLVED, AND EVERY ALTERNATIVE WAS REFUSED BY ARITHMETIC RATHER THAN BY
   * TASTE. A run in the band between the rows is crossed by:
   *   · any SOURCE stub inside its x-span that reaches DEEPER than the run (stubs descend from
   *     row 1 down to their own level), and
   *   · any TARGET stub inside its x-span that STARTS ABOVE the run (stubs descend from their own
   *     level into row 2).
   * Solving the four lanes against those two rules, and against the three x-positions each node's
   * free strip allows, gives — from the row downwards:
   *
   *   level 0   03-implementation-summary -> 04-test-summary  (column 5 -> 4)
   *   level 1   02-to-be-plan -> 05-manual-qa                 (column 4 -> 3)
   *   level 2   02-to-be-plan -> 03.5-code-review             (column 4 -> 5)
   *
   * and the two remaining cross-row edges need no level at all, because both of their ends are in
   * ONE column: 02-to-be-plan -> 04-test-summary (column 4 -> 4) and the row-boundary spine drawn
   * above (column 5 -> 5).
   *
   * ⚠ LEVELS 0 AND 2 ARE THE ONE PAIR THAT CANNOT BE SEPARATED: their arrows swap columns, so they
   * cross like two one-way streets between the same two junctions. That single bridge is DECLARED
   * to the engine — named on the level-2 run, which is reserved after the level-0 target stub it
   * meets — and re-derived by `check-workflow-map.mjs`, which accepts a declared pair only when it
   * is a real containment or a touch within ONE stroke width. Every other pair, including all the
   * pairs the naive interval rule calls "nested", is clean.
   */
  /**
   * ⚠ THE THREE EDGES OUT OF 02-TO-BE-PLAN LEAVE THE NODE AS ONE LABELLED BUNDLE, AND THIS IS
   * THE ONE STRUCTURAL CHANGE IN THE CHART. The arithmetic forces it:
   *
   *   · 02-to-be-plan reads three upstream artifacts AND is read by three downstream ones, so
   *     THREE of its four outgoing edges cross the row boundary;
   *   · its refusal band ("no memory plane") is 102 units wide, which leaves a free strip 51.5
   *     units wide under the node — the only place a stub may leave its bottom edge;
   *   · three stubs in 51.5 units is a pitch of at most 26, which draws three 5-unit strokes
   *     9-15 units apart. All three carried the same label. That is the tangle: not a collision,
   *     which the engine refuses, but three parallel lines a reader could not tell apart.
   *
   * So the notation the WILDCARD RAIL already uses is applied in the other direction. The rail
   * bundles eleven SOURCES into one node; this bundles one node into three TARGETS. One trunk
   * leaves 02-to-be-plan's bottom edge in the middle of its free strip; each edge leaves the
   * trunk at its own level, with its own label naming where it goes and its own arrowhead on its
   * own target. Every junction is labelled, so nothing is chosen by guesswork — the reader reads
   * where the line goes instead of tracing which of three parallel lines it might be.
   *
   * The trunk's own label is `bundle …` and names all three edges, so the sharing is DECLARED
   * rather than implied: `TRACE` below re-derives each of the three from the emitted manifest, and
   * a shared stroke is not an exemption from that check but a fact it reads.
   *
   * AND THE CROSSINGS. Exactly one pair in this band cannot be separated, and it is one pair
   * whatever the routing: 02-to-be-plan -> 03.5-code-review runs LEFT to RIGHT (column 4 -> the
   * row-2 column 5) while 03-implementation-summary -> 04-test-summary runs RIGHT to LEFT
   * (column 5 -> the row-2 column 4) — they swap columns, so one of them must cross the other
   * somewhere. The old chart had that crossing too, but it sat among three near-parallel
   * unlabelled stubs and a label 36 units from the stroke it named. Here it is the only crossing
   * in the band, it is a clean orthogonal X, and both strokes carry their own words. The levels
   * below are still SOLVED rather than chosen: for e above f, the lower edge's source stub must
   * not fall inside the upper edge's run, and the upper edge's target stub must not fall inside
   * the lower edge's run. Level 0 (03-implementation-summary's lane) is checked against every
   * level below it; the trunk is checked against every run; the row-boundary spine is checked
   * against all of them. Both `--verify` and `check-workflow-map.mjs` re-derive them.
   */
  const TRUNK_X = columnAt(idxOf[L47.from], 48, 'the bundle trunk out of ' + L47.from)
  const X57 = columnAt(idxOf[L57.from], 43, 'the lane out of ' + L57.from)
  /* Every arrival lands at least LAND_MARGIN inside the node it points at, measured from both of
     that node's vertical edges: an arrowhead in the corner reads as pointing at the boundary
     between two phases, which is exactly how the reopen arc was misread. */
  const T48 = round(nodeX(idxOf[L48.to]) + 27)
  const T46 = round(nodeX(idxOf[L46.to]) + 75)
  const T57 = round(nodeRight(idxOf[L57.to]) - 30)
  for (const [x, i, what] of [[T46, idxOf[L46.to], L46.to], [T48, idxOf[L48.to], L48.to], [T57, idxOf[L57.to], L57.to]]) {
    if (!(x >= nodeX(i) && x <= nodeRight(i))) throw new Error('overview chart: the arrival of ' + what + ' is not on its own node')
    if (!(x - nodeX(i) >= LAND_MARGIN && nodeRight(i) - x >= LAND_MARGIN)) {
      throw new Error('overview chart: the arrival of ' + what + ' at ' + x + ' lands in the corner of ' + PHASES[i].file
        + ' (' + round(x - nodeX(i)) + ' / ' + round(nodeRight(i) - x) + ' units from its edges, need ' + LAND_MARGIN + ')')
    }
  }
  /* ⚠ THE COORDINATE FACTS THE LEVEL ORDER RESTS ON, ASSERTED. Each would otherwise be a stroke
     drawn through another stroke that only a reader would notice.
       1. THE TRUNK IS OUTSIDE THE LEVEL-0 RUN. The trunk crosses the whole band, so it is outside
          03-implementation-summary's run only if TRUNK_X < T57 — and that is also what keeps the
          straight-down lane out of that run's x-span, which is why the two cross nowhere.
       2. THE TRUNK IS RIGHT OF THE REFUSAL BAND under its own node (which `columnAt` enforces).
       3. THE LEVEL-2 RUN SPANS THE LEVEL-0 ARRIVAL, so the one crossing is the declared one and
          not a stroke through a stroke the engine would have refused.
       4. THE ARRIVALS ARE IN CHANNEL ORDER AND APART: the trunk, then the level-0 arrival, then
          the level-2 arrival, each at least CHANNEL_MIN units from the next. */
  if (!(TRUNK_X < T57)) throw new Error('overview chart: the bundle trunk would fall inside the level-0 run')
  if (!(T57 < T46)) throw new Error('overview chart: the two cross-row arrivals are not in channel order')
  for (const [a, b, why] of [[TRUNK_X, T57, 'the trunk and the level-0 arrival'], [T57, T46, 'the level-0 and level-2 arrivals']]) {
    if (!(b - a >= CHANNEL_MIN)) throw new Error('overview chart: ' + why + ' are only ' + round(b - a) + ' units apart, need ' + CHANNEL_MIN)
  }
  if (!(T46 < X57)) throw new Error('overview chart: the level-2 arrival is not left of the lane it must be crossed by')

  /* THE TRUNK, drawn first: it carries 02-to-be-plan -> 04-test-summary to its own arrowhead and
     the other two edges leave it at their own levels, so it has to exist before either can join.
     ⚠ THE DASH IS READ OFF THE EDGE, never written in: which of these four runs is conditional is a
     fact about the linter's input map, and a hardcoded `dg-line` would draw a required stroke over
     a conditional edge without any check noticing. */
  const dashLine = (e) => (e.kind === 'conditional' ? 'dg-line-cond' : 'dg-line')
  const dashHead = (e) => (e.kind === 'conditional' ? 'dg-head-cond' : 'dg-head')
  const bundleId = 'bundle ' + L47.from + ' -> ' + [L46.to, L47.to, L48.to].join(' + ')
  const trunk = ruleV(TRUNK_X, rowABottom, round(rowBTop - HEAD_L - rowABottom), dashLine(L47), bundleId)
  head([[TRUNK_X, rowBTop], [round(TRUNK_X - SEQ_HALF), round(rowBTop - HEAD_L)], [round(TRUNK_X + SEQ_HALF), round(rowBTop - HEAD_L)]],
    dashHead(L47), 'lane arrow ' + L47.to, trunk)

  /* LEVEL 1: 02-to-be-plan -> 05-manual-qa, leaving the trunk to the left. */
  const l48Run = ruleH(T48, midY(1), round(TRUNK_X - T48), dashLine(L48), 'lane ' + L48.from + ' -> ' + L48.to, trunk)
  const l48StubT = ruleV(T48, midY(1), round(rowBTop - HEAD_L - midY(1)), dashLine(L48), 'stub cross in ' + L48.to, l48Run)
  head([[T48, rowBTop], [round(T48 - SEQ_HALF), round(rowBTop - HEAD_L)], [round(T48 + SEQ_HALF), round(rowBTop - HEAD_L)]],
    dashHead(L48), 'lane arrow ' + L48.to, l48StubT)

  /* LEVEL 0: 03-implementation-summary -> 04-test-summary, arriving between the trunk and the
     level-2 run. Drawn before level 2 because level 2's run declares the crossing against THIS
     arrival's stub, and a declaration can only name a box that already exists. */
  const l57Run = ruleH(T57, midY(0), round(X57 - T57), dashLine(L57), 'lane ' + L57.from + ' -> ' + L57.to)
  ruleV(X57, rowABottom, round(midY(0) - rowABottom), dashLine(L57), 'stub cross out ' + L57.from, l57Run)
  const l57StubT = ruleV(T57, midY(0), round(rowBTop - HEAD_L - midY(0)), dashLine(L57), 'stub cross in ' + L57.to, l57Run)
  head([[T57, rowBTop], [round(T57 - SEQ_HALF), round(rowBTop - HEAD_L)], [round(T57 + SEQ_HALF), round(rowBTop - HEAD_L)]],
    dashHead(L57), 'lane arrow ' + L57.to, l57StubT)

  /* LEVEL 2, AND THE ONE CROSSING: 02-to-be-plan -> 03.5-code-review leaves the trunk to the
     right, and its run meets the level-0 arrival's stub 5 units into the level-2 band. Both
     relations are declared — the trunk it leaves, and the stub it crosses — because the engine
     permits a stroke to overlap only what the drawing says it overlaps. */
  const l46Run = ruleH(TRUNK_X, midY(2), round(T46 - TRUNK_X), dashLine(L46), 'lane ' + L46.from + ' -> ' + L46.to, [trunk, l57StubT])
  const l46StubT = ruleV(T46, midY(2), round(rowBTop - HEAD_L - midY(2)), dashLine(L46), 'stub cross in ' + L46.to, l46Run)
  head([[T46, rowBTop], [round(T46 - SEQ_HALF), round(rowBTop - HEAD_L)], [round(T46 + SEQ_HALF), round(rowBTop - HEAD_L)]],
    dashHead(L46), 'lane arrow ' + L46.to, l46StubT)

  /**
   * ⚠ FOUR LABELS, FOUR LINES, AND NO TWO OF THEM THE SAME WORDS. The old band printed
   * `02-to-be-plan` three times — twice on the same row — so a reader standing at the crossing
   * could not tell which line either label named. Each label now names the endpoint the reader
   * cannot see from where the label sits, and each is placed beside its own stroke: the trunk and
   * the level-1 run name both of their ends, the two short runs name the one end their own run is
   * too short to spell out. `LABEL` below asserts that each run's nearest label names its own
   * destination and lies inside the run it names, and that no two of the texts are the same words.
   */
  const trunkLabel = '→ ' + short(L47.to)
  const l48Label = short(L48.from) + ' → ' + short(L48.to)
  const l46Label = '→ ' + short(L46.to)
  const l57Label = '← ' + short(L57.from)
  const placed = [
    putLabelRight(trunkLabel, round(rowBTop - HEAD_L - LABEL_H - 2), round(TRUNK_X - 2), true) !== null,
    putLabel(l48Label, round(midY(1) + LINE_PAD + 1), round(T48 + 2), round(TRUNK_X - 2), true) !== null,
    putLabel(l46Label, round(midY(2) + LINE_PAD + 1), round(TRUNK_X + 2), round(T46 - 2), true) !== null,
    putLabel(l57Label, round(midY(0) + LINE_PAD + 1), round(T57 + 2), round(X57 - 2), true) !== null,
  ].filter(Boolean)
  if (placed.length !== 4) throw new Error('overview chart: only ' + placed.length + ' of the four cross-row lane labels were placed')

  /* ======================= 10. THE IN-ROW MARKS ========================== */
  /**
   * A solid arrow in the gap between two adjacent phases that really do have an input edge, and a
   * dotted one between the four adjacent pairs that do not. Row 2's arrows point LEFT, because that
   * is the direction row 2 reads; what separates the two marks is the SHAPE, and the legend says so,
   * exactly as it did when every arrow pointed the same way. The row boundary is skipped here: it
   * was drawn above as a single vertical stroke.
   */
  let spineMarks = 0
  let seqMarks = 0
  for (let i = 0; i + 1 < PHASES.length; i++) {
    if (i === idxOf[wrap.from]) continue
    if (rowOf(i) !== rowOf(i + 1)) throw new Error('overview chart: the only row boundary is ' + wrap.from + ' -> ' + wrap.to)
    const a = colOf(i), b = colOf(i + 1)
    if (Math.abs(a - b) !== 1) throw new Error('overview chart: adjacent phases ' + PHASES[i].file + ' and ' + PHASES[i + 1].file + ' are not in adjacent columns')
    const rightward = b > a
    const edge = spine.find((e) => idxOf[e.from] === i)
    const dotted = !edge
    const yTop = rowOf(i) === 0 ? rowATop : rowBTop
    const cym = round(yTop + NODE_H / 2)
    const start = rightward ? round(nodeRight(i) + 2) : round(nodeX(i) - 2)
    const tip = rightward ? round(nodeX(i + 1) - 2) : round(nodeRight(i + 1) + 2)
    const w = round(Math.abs(tip - start) - HEAD_L)
    if (!(w > 0)) throw new Error('overview chart: no room for the arrow between ' + PHASES[i].file + ' and ' + PHASES[i + 1].file)
    const from = rightward ? start : round(start - w)
    const dash = edge && edge.kind === 'conditional'
    const klass = dotted ? 'dg-line-seq' : dash ? 'dg-line-cond' : 'dg-line'
    const headCls = dotted ? 'dg-head-seq' : dash ? 'dg-head-cond' : 'dg-head'
    const label = dotted
      ? 'sequence link ' + PHASES[i].file + ' -> ' + PHASES[i + 1].file
      : 'spine ' + PHASES[i].file + ' -> ' + PHASES[i + 1].file
    const run = ruleH(from, cym, w, klass, label)
    const points = rightward
      ? [[tip, cym], [round(tip - HEAD_L), round(cym - SEQ_HALF)], [round(tip - HEAD_L), round(cym + SEQ_HALF)]]
      : [[tip, cym], [round(tip + HEAD_L), round(cym - SEQ_HALF)], [round(tip + HEAD_L), round(cym + SEQ_HALF)]]
    head(points, headCls, (dotted ? 'sequence head ' : 'spine head ') + PHASES[i + 1].file, run)
    if (dotted) seqMarks++; else spineMarks++
  }
  if (spineMarks !== 6 || seqMarks !== 4) {
    throw new Error('overview chart: expected 6 spine arrows and 4 sequence links in the gaps, drew ' + spineMarks + ' + ' + seqMarks)
  }

  /* ======================= 11. THE TWO BACKWARD EDGES ==================== */
  /**
   * ⚠ BOTH BACK EDGES ARE SHORT LOOPS HERE, AND THAT IS A GAIN RATHER THAN A COMPROMISE. In a
   * single-row chart a backward edge has to travel the whole width of the canvas to re-enter a node
   * to its left. With two rows, 04-test-summary -> 03.5-code-review is a hop between two
   * neighbouring columns of row 2, and 03.5-code-review -> 02-to-be-plan is a hop from the last
   * column of row 2 to the neighbouring column of row 1 — the two shortest backward hops the
   * topology allows. Each is drawn the way it always was: OUT of the source's bottom or right edge,
   * along a shelf of its own, and back UP into the target's own free column.
   */
  /* REVISE: row 2 column 4 -> row 2 column 5. The loop lives between row 2 and the rail, so it
     crosses neither the rail nor any lane. */
  const reviseTo = idxOf['03.5-code-review.md']
  const reviseFrom = idxOf['04-test-summary.md']
  const RV_DROP = needColumn(reviseFrom, 0, 'the REVISE drop')
  const RV_UP = needColumn(reviseTo, 0, 'the REVISE entry')
  if (!(RV_UP > RV_DROP)) throw new Error('overview chart: the REVISE loop would run backwards')
  const rvDrop = ruleV(RV_DROP, rowBBottom, round(reviseShelfY - rowBBottom), 'dg-line-loop', 'revise drop 03.5-code-review.md')
  const rvShelf = ruleH(RV_DROP, reviseShelfY, round(RV_UP - RV_DROP), 'dg-line-loop', 'revise shelf 03.5-code-review.md', rvDrop)
  const rvRiser = ruleV(RV_UP, round(rowBBottom + HEAD_L), round(reviseShelfY - rowBBottom - HEAD_L), 'dg-line-loop', 'revise riser 03.5-code-review.md', rvShelf)
  head([[RV_UP, rowBBottom], [round(RV_UP - SEQ_HALF), round(rowBBottom + HEAD_L)], [round(RV_UP + SEQ_HALF), round(rowBBottom + HEAD_L)]],
    'dg-head-loop', 'revise head 03.5-code-review.md', rvRiser)
  /* The loop's own name, placed to the LEFT of its drop: to the right of the drop is the entry
     riser, and the run of clear space between the two is 170 units against a label that needs 183.
     The left side of the drop is empty for 800 units, so the label goes where it fits. */
  const rvLabel = 'REVISE → repair, then re-submit'
  putLabel(rvLabel, round(reviseShelfY - LABEL_H - 4), round(RV_DROP - 8 - tw(rvLabel, FS[CLS.s])), round(RV_DROP - 8), true)

  /* REOPEN: row 2 column 5 -> row 1 column 4. OUT of the source's right edge, UP the right-hand
     channel — the one vertical line on this canvas that crosses nothing — then LEFT along the top
     band and DOWN into the target's top edge, in the free part of its own footprint. */
  const reopenTo = idxOf['02-to-be-plan.md']
  const reopenFrom = idxOf['03.5-code-review.md']
  const RO_TOP = topY(3)
  /**
   * ⚠ THE DROP LANDS IN THE MIDDLE OF THE NODE IT MEANS, AND THAT IS THE WHOLE POINT OF THE ARC.
   * It used to come down at `nodeX + 148`, i.e. 11 units inside 02-to-be-plan's right edge, with
   * the shelf and riser wrapping around 03-implementation-summary's column on the way in. Nothing
   * overlapped — the engine was satisfied, and both checkers counted the three strokes and the
   * arrowhead and called the arc drawn — but a reader looking at the picture read the violet line
   * as pointing at 03-implementation-summary, the phase it passes and does not touch. The centre
   * of the target is the one landing on that edge that cannot be misread: 79.5 units from either
   * vertical edge, against LAND_MARGIN's 16.
   */
  const RO_DOWN = round(nodeX(reopenTo) + NODE_W / 2)
  const roMid = round(rowBTop + NODE_H / 2)
  const roOut = ruleH(nodeRight(reopenFrom), roMid, round(RISER_X - nodeRight(reopenFrom)), 'dg-line-loop', 'reopen out 02-to-be-plan.md')
  const roRiser = ruleV(RISER_X, RO_TOP, round(roMid - RO_TOP), 'dg-line-loop', 'reopen riser 02-to-be-plan.md', roOut)
  const roShelf = ruleH(RO_DOWN, RO_TOP, round(RISER_X - RO_DOWN), 'dg-line-loop', 'reopen shelf 02-to-be-plan.md', roRiser)
  const roDrop = ruleV(RO_DOWN, RO_TOP, round(rowATop - HEAD_L - RO_TOP), 'dg-line-loop', 'reopen drop 02-to-be-plan.md', roShelf)
  head([[RO_DOWN, rowATop], [round(RO_DOWN - SEQ_HALF), round(rowATop - HEAD_L)], [round(RO_DOWN + SEQ_HALF), round(rowATop - HEAD_L)]],
    'dg-head-loop', 'reopen head 02-to-be-plan.md', roDrop)
  /* The reopen arc's own name, placed just LEFT of its drop — the same rule the REVISE loop's
     label follows. Searching from the gutter put it at the far left of the frame, 800 units from
     the violet stroke it names, which is a label that has to be traced rather than read. */
  const roLabel = 'reopen → back to DRAFT, downstream receipts invalidated'
  putLabel(roLabel, round(RO_TOP + 4), round(RO_DOWN - 8 - tw(roLabel, FS[CLS.s])), round(RO_DOWN - 8), true)

  /* ======================= 12. THE CROSS-RUN BAND ======================== */
  /* THE ONE EDGE THAT LEAVES THIS RUN, unchanged in shape and in words: three cards edge to edge —
     the write, the plane it lands in, and the next run's phase entry that reads it — with an arc
     that leaves the last card and lands inside the first, at the point the loop actually re-enters
     the workflow. */
  const crossCardW = Math.ceil(Math.max(
    tw('writes the plane, then REGISTERS it', FS[CLS.s]),
    tw('memory/training/<task-type>.md  +  MEMORY.md', FS[CLS.s]),
    tw('MEMORY PLANE — .recursive/memory/', FS[CLS.s]),
    tw('training/ is ONE of the 5 kinds read', FS[CLS.s]),
  ) + 2 * PAD + 4)
  const crossCardW2 = Math.ceil(Math.max(
    tw('RUN N+1 — recursive_phase at phase entry', FS[CLS.t]),
    tw('...returns the shards that match this run', FS[CLS.s]),
  ) + 2 * PAD + 4)
  const crossCards = [
    { w: crossCardW, klass: 'dg-box', t: 'writes the plane, then REGISTERS it', rows: ['memory/training/<task-type>.md  +  MEMORY.md'] },
    { w: crossCardW, klass: 'dg-box-rail', t: 'MEMORY PLANE — .recursive/memory/', rows: ['training/ is ONE of the 5 kinds read'] },
    { w: crossCardW2, klass: 'dg-box', t: 'RUN N+1 — recursive_phase at phase entry', rows: ['...returns the shards that match this run'] },
  ]
  const crossBoxH = Math.max(
    Math.round(2 * PAD + lh(FS[CLS.s]) + 1 + lh(FS[CLS.s])),
    Math.round(2 * PAD + lh(FS[CLS.t]) + 1 + lh(FS[CLS.s])),
  )
  const crossTop = y
  let ccx = GUTTER
  for (const c of crossCards) {
    block(ccx, crossTop, c.w, c.klass,
      [{ cls: c.w === crossCardW2 ? CLS.t : CLS.s, s: c.t }].concat(c.rows.map((s) => ({ cls: CLS.s, s }))),
      { label: 'cross-run card: ' + c.t.slice(0, 28), pad: PAD, gap: 1 })
    ccx = round(ccx + c.w)
  }
  const retRiser = round(GUTTER - 22)
  const retY = round(crossTop + PAD + lh(FS[CLS.s]) / 2)
  /**
   * ⚠ THE FOOT COMES BACK TO THE CARD'S OWN BOTTOM CORNER, NOT TO A POINT 26 UNITS BELOW IT. It
   * used to stop at the card's x with a y 26 units past the card's bottom edge, which left the
   * outer end of the arc hanging in space — the one segment on this canvas that touched nothing at
   * either end. The arc now brackets the card's left edge exactly: out of its bottom-left corner,
   * down the gutter, and back into its left edge with the arrowhead. `TRACE` walks it end to end.
   */
  const retFootY = round(crossTop + crossBoxH)
  const retDrop = ruleV(retRiser, retY, round(retFootY - retY), 'dg-line-loop', 'cross-run return drop')
  ruleH(round(retRiser + LINE_PAD + 1), retFootY, round(GUTTER - retRiser - LINE_PAD - 1), 'dg-line-loop', 'cross-run return foot', retDrop)
  const retRun = ruleH(retRiser, round(retY - 2 * LINE_PAD), round(GUTTER - retRiser), 'dg-line-loop', 'cross-run return run', retDrop)
  head([[GUTTER, round(retY + LINE_PAD)], [round(GUTTER - HEAD_L), round(retY - LINE_PAD)], [round(GUTTER - HEAD_L), round(retY + LINE_PAD)]],
    'dg-head-loop', 'cross-run return head', retRun)
  textEl(round(retRiser + 2), round(retFootY + 8), CLS.s, 'ACROSS RUNS — the arrow leaves the run and lands at the NEXT one\'s phase entry')

  /* ======================= 13. THE LEGEND ================================ */
  /* THE PICTURE'S OWN KEY, in shape and word rather than in colour: two rows for the marks on the
     nodes, two for the connections, and two lines of footnote. Every row is measured against the
     frame as it is drawn — a legend that hid its own last word was a real defect on this page, and
     the guard that caught it is kept. */
  let ly = round(retFootY + 28)
  const legendRow = (t, items, yy) => {
    if (t) textEl(GUTTER, yy, CLS.h, t)
    let lx = t ? round(GUTTER + tw(t, FS[CLS.h]) + 26) : GUTTER
    const swW = 20, swH = 11
    for (const [klass, label] of items) {
      const sw = card(lx, round(yy - 1), swW, swH, klass, 'legend swatch: ' + label)
      textEl(round(lx + swW + 6), yy, CLS.s, label, sw)
      lx = round(lx + swW + 6 + tw(label, FS[CLS.s]) + 24)
    }
  }
  legendRow('NODES', [
    ['dg-legend', 'the phase, in PHASE_SEQUENCE order'],
    ['dg-legend-rail', 'may be absent (OPTIONAL_PHASES)'],
    ['dg-legend-refuse', 'a guard rule can refuse here'],
    ['dg-box-human', 'a person must answer'],
  ], ly)
  ly = round(ly + lh(FS[CLS.h]) + 10)
  legendRow('EDGES', [
    ['dg-legend', 'required input'],
    ['dg-legend-cond', 'conditional — source present'],
    ['dg-legend-wide', 'wildcard — every present artifact'],
  ], ly)
  ly = round(ly + lh(FS[CLS.h]) + 10)
  legendRow('', [
    ['dg-legend-seq', 'sequence order only: no input edge'],
    ['dg-legend-rail', 'reads MORE THAN ONE upstream artifact'],
  ], ly)
  ly = round(ly + lh(FS[CLS.s]) + 8)
  const footer1 = 'Violet arcs run BACKWARDS: reopen and REVISE re-enter a node EARLIER in the sequence than their source — against the direction their row reads. The same arc closes the CROSS-RUN loop below.'
  const footer2 = 'Row 1 reads left to right, row 2 right to left. Shape, word and count carry every distinction; colour carries none of them. Every arrow is an entry in the linter\'s own expected-input map.'
  textEl(GUTTER, ly, CLS.s, footer1)
  ly = round(ly + lh(FS[CLS.s]) + 4)
  textEl(GUTTER, ly, CLS.s, footer2)
  ly = round(ly + lh(FS[CLS.s]))

  /* ======================= 14. THE TITLE AND THE FRAME =================== */
  const TITLE = 'THE WORKFLOW AS A GRAPH — ' + PHASES.length + ' phase artifacts, ' + EDGES.length + ' directed edges, all of them drawn here'
  textEl(GUTTER, titleY, CLS.a, TITLE)
  void laneLabelsDrawn

  /* ⚠ NOTHING MAY RUN PAST THE FRAME. The chart is a fixed-width picture in a wrapper that scrolls
     below the width it was drawn for, so anything wider than the frame is clipped by the wrapper's
     own edge. Each of these is therefore a BUILD FAILURE rather than a clipped word on the page —
     the legend's last word was once measured hanging off this frame. */
  const frameR = round(GRID_R + 24)
  for (const [what, text, cls] of [
    ['the first footer note', footer1, CLS.s],
    ['the second footer note', footer2, CLS.s],
    ['the title', TITLE, CLS.a],
    ['the first rail line', railLines[0][1], CLS.t],
    ['the second rail line', railLines[1][1], CLS.s],
    ['the third rail line', railLines[2][1], CLS.s],
  ]) {
    const wide = round(GUTTER + tw(text, cls))
    if (wide > frameR) throw new Error('overview chart: ' + what + ' is ' + round(wide - frameR) + ' units wider than the frame')
  }
  /* The frame ends BELOW the last line of text, not at its top: the height is derived from the last
     row the chart drew plus its own line height, so the last line cannot fall off the bottom edge.
     Both dimensions are derived — a chart that grows cannot quietly grow past its column. */
  return { x: 0, y: 0, width: W, height: Math.ceil(ly + 2 * LINE_PAD) }
}

/**
 * ⚠ THE WIDTH AND THE EMPTY SPACE ARE INVARIANTS, NOT MEASUREMENTS SOMEBODY ONCE TOOK.
 *
 * The overview was 2854 units wide in a 1141-unit column for a whole round, and every check in
 * this file passed, because no check compared the chart with the box it lands in. These are the
 * numbers that would have failed, and both `--verify` and `check-workflow-map.mjs` assert them
 * against the emitted manifest (neither imports them from the other).
 *
 *   · MIN_VIEWPORT_W — 1280 CSS px: the narrowest desktop window this page claims to support.
 *     At that width the reading column gives the chart 1141 units of SVG space (measured in
 *     headless Chromium at 1280x900, not derived from the token arithmetic); at 1440, where the
 *     column is at its 1340px cap, it gives 1216. The chart must be under the SMALLER one.
 *   · WIDTH_BUDGET — 1130 units: the 1141 measured at the minimum viewport, less 11 units of
 *     slack so that a change to a padding token cannot silently push the chart into a scroll.
 *   · HEIGHT_BUDGET — 780 units: the chart is read as ONE picture in a 1440x900 window, and 900
 *     less the sticky tab strip (108px) and a 12px margin leaves 780 for the drawing.
 *   · MAX_EMPTY_BAND — 48 units: the tallest run of the frame's height that holds no ink at all.
 *     The defect this catches is the one a reader sees: a marker floating alone in a band, or a
 *     strip of annotations detached from the nodes it belongs to. The old chart had a 140-unit
 *     hole under its title and a 70-unit one above its node row.
 */
const OVERVIEW_LIMITS = { MIN_VIEWPORT_W: 1280, WIDTH_BUDGET: 1130, HEIGHT_BUDGET: 780, MAX_EMPTY_BAND: 48 }

/**
 * ⚠ THE READABILITY BUDGETS — THE NUMBERS THE MISSING INVARIANT NEEDS, AND THEY ARE NOT COLLISION
 * NUMBERS.
 *
 * Every geometric rule this file had was about COLLISION: `reserve()` throws when two reserved
 * boxes intersect, and the structural checker re-derives the same rule from the manifest. A chart
 * can satisfy all of it and still be unfollowable, and this one did. The owner looked at the
 * rendered picture and said "the lines connecting phases or showing phase interactions are
 * somewhat broken" — and measured off the shipped manifest that was literally true: THREE of the
 * sixteen drawn edges were not connected from their source node to their target node at all, by
 * 6.5 units on two of them and by 375 on the third. Nothing noticed, because the checks counted
 * LABELS: a box reading `lane 00-requirements.md -> 02-to-be-plan.md` existed, so the edge counted
 * as drawn, whether or not its strokes reached each other.
 *
 * These three numbers are about READING rather than about colliding, and both `--verify` and
 * `check-workflow-map.mjs` assert every drawn stroke against them:
 *
 *   · LAND_MARGIN — 16 units. An arrowhead that lands on a node's TOP edge must land at least this
 *     far inside that node from both of its vertical edges. A head in the corner is ambiguous with
 *     the neighbouring column, and the reopen arc was the proof: it came down 11 units inside
 *     02-to-be-plan, having wrapped around 03-implementation-summary on the way in, and was read as
 *     pointing at the wrong phase. 16 is what this canvas affords — the arrival ports sit 20, 23,
 *     26, 27 and 30 units in, and no head is nearer than 20 to a corner.
 *   · CHANNEL_MIN — 12 units between two PARALLEL strokes that belong to DIFFERENT edges. Two
 *     5-unit strokes 7 units apart are one doubled line to the eye. The strip under 02-to-be-plan
 *     held four strokes at gaps of 7, 7, 7 and 9 units, and that is the tangle in numbers.
 *   · PROXIMITY_MIN — 14 units from any edge stroke to a node box it does not attach to. "Passing
 *     through the gap is what looks broken": the reopen riser ran 6.5 units from the right edge of
 *     03-implementation-summary and 6.5 from 03.5-code-review's, attached to neither, and the arc
 *     read as belonging to the node it merely passed.
 */
const READABILITY = { LAND_MARGIN: 16, CHANNEL_MIN: 12, PROXIMITY_MIN: 14 }
const { LAND_MARGIN, CHANNEL_MIN, PROXIMITY_MIN } = READABILITY

/**
 * The tallest run of the frame's own height that holds no reserved ink, computed from the boxes
 * the engine actually reserved. This is deliberately NOT the bounding box of the drawing — a
 * bounding box cannot see a hole in the middle of it, which is exactly how a chart with 24% of
 * its height empty passed every check for a round.
 */
function emptyBandOf(L) {
  const [ox, oy, w, h] = L.viewBox
  const spans = L.boxes
    .map((b) => [Math.max(oy, b[2]), Math.min(oy + h, b[2] + b[4])])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0])
  let worst = 0, reach = oy
  for (const [a, b] of spans) {
    if (a > reach) worst = Math.max(worst, a - reach)
    reach = Math.max(reach, b)
  }
  return { worst: Math.round(Math.max(worst, oy + h - reach) * 100) / 100, width: w, height: h }
}

/* ---- ORDERING THE LANES — no arrow crosses another ------------------------ */

/**
 * ORDER THE LANE EDGES SO THAT NO ARROW CROSSES ANOTHER.
 *
 * An edge routed in a lane is drawn as: a stub from its source node's edge, a horizontal
 * run in its own lane, and a stub into its target node. Two such edges CROSS exactly when
 * one edge's stub lands inside the other's run, and that happens precisely when one edge's
 * [source, target] interval interleaves the other's. So the sufficient condition used here
 * is:
 *
 *     U may sit above L  ⟺  U starts at or after L ends (to the right of it)
 *                          OR  U contains L (starts at or before it and ends at or after it)
 *
 * — and this SEARCHES for an order that satisfies it for every pair, at two depths: lanes
 * above the node row and lanes below it (an interleaving that cannot be ordered inside one
 * band is moved to the other, and the two bands never meet). If three bands were ever
 * needed the generator THROWS rather than drawing a crossing; and the engine's own
 * intersection check is the backstop, so a mistake here fails the build instead of
 * shipping a tangle.
 */
function graphBands(edges) {
  const above = (u, l) => (u.s >= l.t) || (u.s <= l.s && u.t >= l.t)
  const comparable = (a, b) => above(a, b) || above(b, a)
  // 1. greedy band assignment: the first band in which this edge is COMPARABLE with
  //    every edge already there. Two bands exist (above and below the row).
  const bands = [[], []]
  for (const e of edges) {
    const fit = bands.findIndex((band) => band.every((o) => comparable(o, e)))
    if (fit < 0) throw new Error('overview chart: the edge set needs a third routing band, which is not drawn')
    bands[fit].push(e)
  }
  // 2. inside a band, order bottom → top by repeatedly taking an edge that every
  //    remaining edge may sit above.
  return bands.map((band) => {
    const left = [...band]
    const order = []
    while (left.length > 0) {
      const at = left.findIndex((x) => left.every((u) => u === x || above(u, x)))
      if (at < 0) throw new Error('overview chart: a routing band could not be ordered without a crossing')
      order.push(left[at])
      left.splice(at, 1)
    }
    // Guard against the case the greedy cannot see: the bottom-first rule is necessary
    // but not sufficient on its own, so every pair is checked once more, in the order
    // the lanes will be drawn.
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        if (!above(order[j], order[i])) {
          throw new Error('overview chart: lane order would cross — ' + order[i].edge.from + ' and ' + order[j].edge.from)
        }
      }
    }
    return order
  })
}

/* ---- CHART 2: the training loop — the cross-run cycle -------------------- */

function drawTraining(api) {
  const { GUTTER, PAD, LINE_PAD, CLS, FS, tw, lh, round, textEl, card, rule, ruleH, ruleV, head, para, block, blockPara } = api

  const STEP_W = 470
  const GATE_W = 430
  const COL_GAP = 72
  const colA = GUTTER
  const colB = round(colA + STEP_W + COL_GAP)
  const W = Math.ceil(colB + GATE_W + 24)

  let y = 0
  textEl(colA, y, CLS.a, 'THE LEARNING LOOP — one run writes memory, the NEXT run reads it')
  y += lh(FS[CLS.a]) + 8
  y = para(colA, y, W - 2 * GUTTER, CLS.s,
    'Every box below is one call or one file, in the order a run reaches it. The boxes on the right are the places a step STOPS: two are hard refusals, one is a skip, and two are exit codes with an empty `writes` list. Nothing here is a summary — each box names the function or the field it was read from.')
  y += 14

  const flowTop = round(y)
  /* ---- the rows ---------------------------------------------------------- */
  const rows = []
  let ry = flowTop
  TRAINING.steps.forEach((step, i) => {
    const stepRows = [{ cls: CLS.t, s: step.t }].concat(step.lines.map((s) => ({ cls: CLS.s, s })))
    const gate = step.gate ? TRAINING.gates[step.gate] : null
    // The card heights are computed from the rows first, because the ROW's height, the
    // vertical arrow between rows and the horizontal gate arrow are all derived from
    // them — never chosen.
    const stepH = Math.round(PAD * 2 + stepRows.reduce((h, r) => h + lh(FS[r.cls]), 0) + (stepRows.length - 1))
    let gateH = 0
    let gateRows = []
    if (gate) {
      gateRows = [{ cls: CLS.h, s: gate.head }].concat(gate.lines.map((s) => ({ cls: CLS.s, s }))).concat([{ cls: CLS.s, s: gate.fix }])
      gateH = Math.round(PAD * 2 + gateRows.reduce((h, r) => h + lh(FS[r.cls]), 0) + (gateRows.length - 1))
    } else if (i === 0) {
      gateRows = [{ cls: CLS.h, s: 'MEMORY_KINDS — read at every phase entry' }]
        .concat(TRAINING.kinds.map((k) => ({ cls: CLS.s, s: '  ' + k + '/' })))
        .concat([{ cls: CLS.s, s: '5 kinds, in the order the scaffold creates them.' }])
      gateH = Math.round(PAD * 2 + gateRows.reduce((h, r) => h + lh(FS[r.cls]), 0) + (gateRows.length - 1))
    } else if (i === 1) {
      gateRows = [{ cls: CLS.h, s: 'NOT read, deliberately' }]
        .concat(TRAINING.notRead.map((k) => ({ cls: CLS.s, s: '  ' + k + '/' })))
        .concat([{ cls: CLS.s, s: 'archive/ is historical by the router\x27s own' }, { cls: CLS.s, s: 'definition, and widening retrieval to incidents/' }, { cls: CLS.s, s: 'is a separate ranking decision.' }])
      gateH = Math.round(PAD * 2 + gateRows.reduce((h, r) => h + lh(FS[r.cls]), 0) + (gateRows.length - 1))
    }
    const rowH = Math.max(stepH, gateH)
    rows.push({ step, i, stepRows, gateRows, stepH, gateH, rowH, top: ry })
    ry = round(ry + rowH + 26)
  })
  const flowBottom = round(ry - 26)

  /* ---- draw each row ----------------------------------------------------- */
  rows.forEach((row, i) => {
    const stepCls = row.step.gate ? 'dg-box dg-box-gate' : 'dg-box'
    block(colA, row.top, STEP_W, stepCls, row.stepRows, { label: 'step ' + (i + 1) + ': ' + row.step.t })
    if (row.gateRows.length > 0) {
      const gateCls = row.step.gate ? 'dg-box dg-box-refuse' : 'dg-box'
      // The label distinguishes a GATE (a box that can stop the step) from the two
      // ASIDES that share the column: the kinds that ARE read and the two that are not.
      // verify() counts the gates by that label, so a gate that stopped being drawn
      // would fail the build rather than quietly disappear.
      block(colB, row.top, GATE_W, gateCls, row.gateRows, { label: (row.step.gate ? 'gate for step ' : 'aside for step ') + (i + 1) })
      // The connector: step -> the box that can stop it, at a y inside BOTH boxes.
      const cy = round(row.top + Math.min(row.stepH, row.gateH) / 2)
      const run = ruleH(round(colA + STEP_W + 10.5), cy, round(colB - 16 - (colA + STEP_W + 10.5)), 'dg-line-warn', 'gate link ' + (i + 1))
      head([[colB, cy], [colB - 8, cy - 4], [colB - 8, cy + 4]], 'dg-head-warn', 'gate arrow ' + (i + 1), run)
    }
    // the arrow down to the next row
    if (i < rows.length - 1) {
      const x = round(colA + STEP_W / 2)
      const from = round(row.top + row.rowH)
      const to = round(rows[i + 1].top)
      const stub = ruleV(x, from, to - 8 - from, 'dg-line', 'flow arrow ' + (i + 1))
      head([[x, to], [x - 4, to - 8], [x + 4, to - 8]], 'dg-head', 'flow head ' + (i + 1), stub)
    }
  })

  /* ---- the back edge: the loop closes ACROSS RUNS ------------------------ */
  const yFirst = round(rows[0].top + rows[0].stepH / 2)
  const yLast = round(rows[rows.length - 1].top + rows[rows.length - 1].stepH / 2)
  const riser = ruleV(14, yFirst, yLast - yFirst, 'dg-line-loop', 'cross-run riser')
  ruleH(14, yFirst, round(GUTTER - 8 - 14), 'dg-line-loop', 'cross-run top run', riser)
  head([[GUTTER, yFirst], [GUTTER - 8, yFirst - 4], [GUTTER - 8, yFirst + 4]], 'dg-head-loop', 'cross-run arrowhead')
  ruleH(14, yLast, round(GUTTER - 6 - 14), 'dg-line-loop', 'cross-run bottom run', riser)

  y = round(flowBottom + 26)
  textEl(colA, y, CLS.a, 'THE BACK EDGE — ACROSS RUNS, which is the whole point of the cycle')
  y += lh(FS[CLS.a]) + 6
  y = para(colA, y, W - 2 * GUTTER, CLS.s,
    'Run N writes `memory/training/<task-type>.md` and registers it in `memory/MEMORY.md`. Run N+1\'s FIRST call — `recursive_phase`, at phase entry — reads the memory plane, and `training` is one of the five kinds it reads. So the shard run N extracted is offered to run N+1, and the arrow above travels from the bottom box back to the top one.')
  y = para(colA, y, W - 2 * GUTTER, CLS.s,
    'It is a CYCLE, not a pipeline: nothing in a single run can close it. One locked run is an anecdote, so the extractor does not run until a SECOND run has locked its own phase 8 — and that is the gate that stops this step, drawn on the step it stops.')
  y = para(colA, y, W - 2 * GUTTER, CLS.s,
    'The write half and the read half agree by construction: `MEMORY_KINDS` in src/memory.ts carries `training` precisely because the trigger writes it, and the comment there records what went wrong when it did not — the writer\'s own output was unreachable by the reader.')

  return { width: W, height: Math.ceil(y + 16) }
}


/* VERIFY                                                                     */
/* ========================================================================== */

function readRepo(rel) {
  const p = join(ROOT, ...rel.split('/'))
  if (!existsSync(p)) throw new Error('missing source file: ' + rel)
  return readFileSync(p, 'utf8')
}

/** Parse a `[...]` or `new Set([...])` array literal of single-quoted strings. */
function stringList(src, startMarker, { set = false, typed = false } = {}) {
  const at = src.indexOf(startMarker)
  if (at < 0) throw new Error('marker not found: ' + startMarker)
  let open, close
  if (typed) {
    // `export const X: readonly HookPoint[] = ['` — the literal starts after the LAST `[`
    // of the declaration, but a type annotation may itself contain `[]`, so anchor on `= [`.
    open = src.indexOf('= [', at)
    close = src.indexOf(']', open)
  } else {
    open = set ? src.indexOf('([', at) : src.indexOf('[', at)
    close = src.indexOf(']', open)
  }
  if (open < 0 || close < 0) throw new Error('array literal not found after: ' + startMarker)
  return [...src.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** Parse `'file.md': [ 'a', 'b', ... ],` entries out of SECTION_MAP. */
function sectionMap(src) {
  const at = src.indexOf('const SECTION_MAP: Record<string, string[]> = {')
  if (at < 0) throw new Error('SECTION_MAP not found')
  const end = src.indexOf('\n}', at)
  const body = src.slice(at, end)
  const out = {}
  for (const m of body.matchAll(/'([^']+\.md)':\s*\[([\s\S]*?)\]/g)) {
    out[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1])
  }
  return out
}

/** Two-decimal rounding, for a comparison whose values come out of a manifest. */
const round2 = (n) => Math.round(n * 100) / 100

function verify(html) {
  const problems = []
  const ok = []
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a === e) ok.push(label)
    else problems.push(label + '\n      expected: ' + e + '\n      actual:   ' + a)
  }

  const lockSrc = readRepo('src/lock.ts')
  const rulesSrc = readRepo('src/phase-rules.ts')
  const errorsSrc = readRepo('src/errors.ts')
  const hooksSrc = readRepo('src/hooks.ts')
  const startSrc = readRepo('src/run-start.ts')
  const indexSrc = readRepo('src/index.ts')
  const globsSrc = readRepo('src/policy-globs.ts')
  const lintSrc = readRepo('src/ts-lint.ts')

  // 1. sequence
  check('PHASE_SEQUENCE: 12 artifacts, same order', stringList(lockSrc, 'export const PHASE_SEQUENCE'), PHASES.map((p) => p.file))
  check('LATE_PHASE_ARTIFACTS', stringList(rulesSrc, 'export const LATE_PHASE_ARTIFACTS'), LATE.files)
  check('AUDITED_PHASE_FILES', stringList(rulesSrc, 'export const AUDITED_PHASE_FILES = new Set(', { set: true }), PHASES.filter((p) => p.audited).map((p) => p.file))
  check('OPTIONAL_PHASES', stringList(lockSrc, 'export const OPTIONAL_PHASES = new Set(', { set: true }), PHASES.filter((p) => p.optional).map((p) => p.file))

  /* 1b. JOB 1 — THE MISLEADING `optional` BADGE, AS CHECKED FACTS.
     ------------------------------------------------------------------------
     The owner found this by eye: the page printed a bare `optional` badge 14 times
     for the seven members of `OPTIONAL_PHASES`, and read correctly as "these seven
     phases are optional work". The set's only consumer is `nextLegalPhase(…,
     { optional })`, i.e. "an ABSENT member does not stop the selector". There was
     nothing on the page to contradict the badge, and nothing in `--verify` to catch
     it, which is why it shipped. These three checks are that missing contradiction:

       (a) the badge text never contains the bare word, so the class of defect
           cannot be reintroduced by rewording one string;
       (b) the rendered SET is exactly the seven the code declares — derived from the
           source, not asserted in prose, and divided between the two render sites
           (overview row and phase detail view), so a phase cannot silently gain or
           lose the badge;
       (c) the page states the POSITIVE fact — that all twelve are scaffolded by one
           call and lock in sequence — because a reader must not come away thinking
           seven phases are optional and five are real. (c) is checked as (i) the
           scaffold loop in `runtime.ts` names exactly the ten later phases, (ii) it
           plus the two Phase 0 templates is PHASE_SEQUENCE in order, and (iii) the
           rendered page says so. */
  check('the may-be-absent badge text carries its own scope and never says the bare word',
    [BADGE_MAY_BE_ABSENT, BADGE_LATE_SET].filter((s) => /(?<![-\w])optional(?![-\w])/i.test(s)), [])
  check('the words `optional` and `late phase` are never rendered as a standalone badge anymore',
    [
      ...html.matchAll(/<span class="tag[^"]*">([^<]*)<\/span>/g),
    ].map((m) => m[1].trim()).filter((s) => s === 'optional' || s === 'late phase'), [])
  /* THE ATTRIBUTION IS BY NEAREST PRECEDING ARTIFACT NAME, within a bounded window.
     Measured distances in the rendered page: 118-135 units in an overview row (the
     `step-artifact` span sits immediately before `step-tags`) and 622-681 in a phase
     detail view (the badge is after the panel heading, which names the artifact).
     720 covers both with room to spare, and NEAREST-wins rather than last-wins: a
     larger window would otherwise pick up the PREVIOUS phase's heading and attribute
     the badge to the wrong artifact. One badge on the page is inside the explanatory
     callout and belongs to no phase; it is counted separately below rather than
     silently skipped, so the three populations are each asserted: the phase badges
     (the set, and the two render sites), the prose badge (exactly the one the callout
     draws), and the total. */
  const badgeWindow = 720
  const badgeAll = [...html.matchAll(new RegExp('<span class="tag tag-may-be-absent">' + BADGE_MAY_BE_ABSENT + '</span>', 'g'))]
  const badgeOf = []
  const badgeProse = []
  for (const m of badgeAll) {
    const before = html.slice(0, m.index)
    const nearest = PHASES
      .map((p) => ({ file: p.file, at: before.lastIndexOf(p.file) }))
      .filter((c) => c.at >= 0 && before.length - c.at <= badgeWindow)
      .sort((a, b) => b.at - a.at)[0]
    if (nearest) badgeOf.push(nearest.file)
    else badgeProse.push(m.index)
  }
  check('every may-be-absent badge on the page is accounted for: phase-attributed + prose',
    badgeOf.length + badgeProse.length, badgeAll.length)
  /* ⚠ TWO PROSE BADGES NOW, AND THEY ARE EXACTLY TWO BECAUSE THE PROSE MOVED. The badge used to be
     explained in a callout ON the overview, where the chart had to sit underneath it; the
     explanation is now in the Notes view, and the overview keeps a ONE-LINE signpost to it that also
     draws the badge so a reader meets the mark beside its name. So the count is asserted as one per
     view rather than as a single badge anywhere, which is the version of this check that a future
     round cannot satisfy by moving the essay back over the picture. */
  check('exactly TWO may-be-absent badges are prose — one signpost on the overview, one explanation in Notes',
    badgeProse.length, 2)
  check('the overview\'s prose badge sits in the panel that also renders the chart',
    html.slice(0, badgeProse[0]).lastIndexOf('id="panel-overview"') > html.slice(0, badgeProse[0]).lastIndexOf('id="panel-notes"'), true)
  check('the explanation\'s prose badge sits in the Notes view',
    html.slice(0, badgeProse[1]).lastIndexOf('id="panel-notes"') > html.slice(0, badgeProse[1]).lastIndexOf('id="panel-tools"'), true)
  check('the set the may-be-absent badge DESCRIBES is exactly the set the code declares',
    [...new Set(badgeOf)].sort(), PHASES.filter((p) => p.optional).map((p) => p.file).sort())
  check('every may-be-absent phase carries the badge at BOTH render sites (overview row + detail view)',
    PHASES.filter((p) => p.optional).map((p) => p.file).filter((f) => badgeOf.filter((b) => b === f).length !== 2), [])
  check('no phase OUTSIDE the declared set carries the badge',
    badgeOf.filter((b) => !PHASES.filter((p) => p.optional).some((p) => p.file === b)), [])
  {
    const scaffold = [...(readRepo('src/runtime.ts').match(/const laterPhases = \[([\s\S]*?)\]/) || ['', ''])[1]
      .matchAll(/'([^']+\.md)'/g)].map((m) => m[1])
    check('recursive_init names every later phase in ONE literal scaffold list', scaffold, PHASES.slice(2).map((p) => p.file))
    check('the scaffold list plus the two Phase 0 templates IS PHASE_SEQUENCE, so recursive_init writes all twelve in order',
      ['00-requirements.md', '00-worktree.md', ...scaffold], PHASES.map((p) => p.file))
    check('the page states the positive fact rather than leaving the badge to speak for itself',
      /All twelve artifacts are MANDATORY work/.test(html) && /scaffolds <b>all twelve<\/b>/.test(html), true)
  }
  /* (d) THE SECOND DECLARATION, CHECKED RATHER THAN MERELY MENTIONED. `status.ts` carries
     its own `optional:` flag, and the page now says that it disagrees with `lock.ts`. A
     sentence like that is worth nothing unless the disagreement is re-derived, so the
     flag is parsed out of the status table and compared: if the two declarations are ever
     reconciled, THIS CHECK FAILS and the paragraph must be rewritten rather than left
     asserting a split that no longer exists. */
  {
    const statusFile = readRepo('src/status.ts')
    const rows = (statusFile.match(/export const PHASES: PhaseDef\[\] = \[([\s\S]*?)\n\]/) || ['', ''])[1]
    const statusOnly = [...rows.matchAll(/file: '([^']+)', optional: true/g)].map((m) => m[1])
    check('status.ts declares its own optional set, and it is the TWO the page names',
      statusOnly, ['01.5-root-cause.md', '03.5-code-review.md'])
    check('the two optionality declarations DISAGREE — which is what the page reports',
      PHASES.filter((p) => p.optional).filter((p) => !statusOnly.includes(p.file)).map((p) => p.file),
      ['01-as-is.md', '02-to-be-plan.md', '03-implementation-summary.md', '04-test-summary.md', '05-manual-qa.md'])
    check('the run-completion calculation consumes the status.ts flag, not the lock.ts set',
      /const mandatory = status\.phases\.filter\(p => !p\.optional\)/.test(readRepo('src/snapshot.ts')), true)
    check('the page SAYS the two declarations disagree, and cites both',
      /two independent optionality declarations/.test(html) && /optionality declarations<\/b> and they disagree/.test(html), true)
  }
  check('TRACEABILITY_REQUIRED_FILES', stringList(rulesSrc, 'export const TRACEABILITY_REQUIRED_FILES = new Set(', { set: true }), PHASES.filter((p) => p.traceability).map((p) => p.file))
  check('AUDIT_REQUIRED_HEADINGS: 9 entries', stringList(rulesSrc, 'export const AUDIT_REQUIRED_HEADINGS'), ['Audit Context', 'Effective Inputs Re-read', 'Earlier Phase Reconciliation', 'Subagent Contribution Verification', 'Worktree Diff Audit', 'Gaps Found', 'Repair Work Performed', 'Requirement Completion Status', 'Audit Verdict'])

  // 2. sections, per phase — and the declared range LENGTHS, so the citation
  // rendered on the page ends where the real list ends.
  const sm = sectionMap(rulesSrc)
  for (const p of PHASES) check('SECTION_MAP[' + p.file + ']', sm[p.file], p.sections)
  check('declared section lengths match the parsed source',
    SECTION_FILES.filter((f) => (sm[f] || []).length !== SECTION_LENGTHS[f]),
    [])
  check('the rendered section range ends on the list it cites',
    SECTION_FILES.filter((f) => {
      // `src/phase-rules.ts:A-B` — the range's SPAN must equal the parsed list length.
      const span = sectionsCite(f).split(':').pop()
      const [a, b] = span.split('-').map(Number)
      return b - a + 1 !== (sm[f] || []).length
    }),
    [])

  // 3. input artifact map. Two shapes exist in the source: a braced `{ candidates = [...] }`
  // body, and a one-line `else if (...) candidates = ['…']` — so the `{` and the
  // newline are both optional. A conditional push (a "when present" extra) is read
  // as data on the phase it belongs to, never guessed.
  const inputMap = {}
  // NOTE the leading `\}?`: an `else if` branch in this file closes the previous
  // braced branch on its OWN line (`  } else if (…`), so a regex anchored on `^if`
  // silently skipped every branch that followed a braced one — two phases went
  // missing from the map while the check still "passed" on a subset.
  for (const m of lintSrc.matchAll(/^\s*\}?\s*(?:else )?if \(fileName === '([^']+)'\) ?\{?\s*candidates = \[([^\]]*)\]/gm)) {
    inputMap[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1])
  }
  const inputExtras = {}
  {
    const body = (lintSrc.match(/export function getPhaseExpectedInputArtifactNames[\s\S]*?\n\}/) || [''])[0]
    let current = ''
    for (const line of body.split('\n')) {
      const decl = line.match(/fileName === '([^']+)'/)
      if (decl) current = decl[1]
      const push = line.match(/candidates\.push\('([^']+)'\)/)
      if (push && current) {
        if (!inputExtras[current]) inputExtras[current] = []
        inputExtras[current].push(push[1])
      }
    }
  }
  check('the linter declares inputs for the phases that have upstream artifacts',
    Object.keys(inputMap).sort(),
    PHASES.slice(1).filter((p) => p.file !== '06-decisions-update.md' && p.file !== '08-memory-impact.md').map((p) => p.file).sort())
  for (const [file, list] of Object.entries(inputMap)) {
    const p = PHASES.find((x) => x.file === file)
    const expected = p.inputs.filter((i) => i.artifact && !/ — only when present$/.test(i.doc)).map((i) => i.doc)
    check('inputs for ' + file + ' (declared candidates)', list, expected)
  }
  check('the "when present" extras are the ones the page marks as conditional',
    Object.values(inputExtras).flat().sort(),
    PHASES.flatMap((p) => p.inputs.filter((i) => / — only when present$/.test(i.doc)).map((i) => i.doc.replace(/ — only when present$/, ''))).sort())
  check('the input map is the whole declaration body, not a prefix',
    Object.keys(inputMap).length, 9)
  check('the two "all present artifacts except itself" phases are exactly 06 and 08',
    /fileName === '06-decisions-update\.md'\) candidates = RUN_ARTIFACT_SEQUENCE\.filter/.test(lintSrc) &&
    /fileName === '08-memory-impact\.md'\) candidates = RUN_ARTIFACT_SEQUENCE\.filter/.test(lintSrc), true)

  /* 3b. THE LINKAGE — the edge set drawn on the Phase graph view, re-derived from the
     linter's own input map. This is the check that makes the drawing fail the build
     when src/ moves: the arrows are not a reading of the map, they ARE the map. */
  const runSeq = stringList(lintSrc, 'export const RUN_ARTIFACT_SEQUENCE = [')
  const derivedEdges = []
  for (const [file, list] of Object.entries(inputMap)) for (const from of list) derivedEdges.push({ from, to: file, kind: 'required' })
  for (const [file, list] of Object.entries(inputExtras)) for (const from of list) derivedEdges.push({ from, to: file, kind: 'conditional' })
  const wildcardBranches = [...lintSrc.matchAll(/fileName === '([^']+)'\) candidates = RUN_ARTIFACT_SEQUENCE\.filter\(a => present\.has\(a\) && a !== '([^']+)'\)/g)]
    .map((m) => ({ file: m[1], excluded: m[2] }))
  for (const w of wildcardBranches) derivedEdges.push({ from: WILDCARD_INPUT, to: w.file, kind: 'wildcard' })
  const edgeKey = (e) => e.from + ' | ' + e.to + ' | ' + e.kind
  check('THE EDGE SET, re-derived from getPhaseExpectedInputArtifactNames',
    derivedEdges.map(edgeKey).sort(), EDGES.map(edgeKey).sort())
  check('every wildcard branch excludes the artifact it belongs to',
    wildcardBranches.filter((w) => w.file !== w.excluded).map((w) => w.file), [])
  check('the wildcard source count is the run minus the artifact itself',
    WILDCARD_SOURCES, runSeq.length - 1)
  check('00-requirements.md has NO upstream artifact edge — the run starts at the conversation',
    EDGES.filter((e) => e.to === PHASES[0].file), [])
  check('every edge endpoint is one of the twelve phase artifacts (or the wildcard)',
    [...new Set(EDGES.flatMap((e) => [e.from, e.to]))].filter((f) => f !== WILDCARD_INPUT && !PHASES.some((p) => p.file === f)), [])
  check('the rendered fan-in per phase, re-derived from the linter',
    PHASES.map((p) => p.file + '=' + sourcesOf(p.file)),
    PHASES.map((p) => {
      const concrete = (inputMap[p.file] || []).length + (inputExtras[p.file] || []).length
      const wild = wildcardBranches.some((w) => w.file === p.file)
      return p.file + '=' + (concrete + (wild ? runSeq.length - 1 : 0))
    }))
  check('the rendered edge counts by kind',
    ['required', 'conditional', 'wildcard'].map((k) => k + '=' + EDGES.filter((e) => e.kind === k).length),
    ['required=' + (Object.values(inputMap).flat().length), 'conditional=' + (Object.values(inputExtras).flat().length), 'wildcard=' + wildcardBranches.length])

  /* 3c. WHAT EACH PHASE IS FOR — the label and the required sections, re-derived. */
  const statusSrc = readRepo('src/status.ts')
  const purposeLabels = Object.fromEntries([...statusSrc.matchAll(/label: 'Phase [^']*\(([^)]+)\)', file: '([^']+)'/g)].map((m) => [m[2], m[1]]))
  check('every phase purpose carries the label src/status.ts gives that artifact',
    PHASES.map((p) => p.file + '=' + p.purpose.label),
    PHASES.map((p) => p.file + '=' + purposeLabels[p.file]))
  check('every section a purpose names is still a REQUIRED section of that phase',
    PHASES.flatMap((p) => p.purpose.sections.filter((s) => !(sm[p.file] || []).includes(s)).map((s) => p.file + ' -> ' + s)), [])
  check('every purpose names at least two required sections, so no line is unsourced',
    PHASES.filter((p) => p.purpose.sections.length < 2).map((p) => p.file), [])
  const tplSrc = readRepo('src/init-templates.ts')
  check('both phase-0 purpose lines quote their template Scope note verbatim',
    PHASES.filter((p) => p.purpose.tplText && !tplSrc.includes(p.purpose.tplText)).map((p) => p.file), [])
  check('the later-phase template carries ONE generic Scope note — which is why 01-08 have no per-phase prose to transcribe',
    (tplSrc.match(/Scope note: Scaffold generated by the recursive-mode plugin \(R5\)\. Fill every required section before lint\./g) || []).length, 1)
  const closeoutScopeNotes = [...readRepo('src/closeout.ts').matchAll(/scopeNote: '([^']+)'/g)].map((m) => m[1])
  check('no purpose line is a closeout scope note lifted as-is (they describe the RECEIPT, not the phase)',
    PHASES.filter((p) => closeoutScopeNotes.includes(p.purpose.t)).map((p) => p.file), [])

  /* 3d. THE LEARNING LOOP — every step and every gate, re-read from the modules. */
  const memorySrc = readRepo('src/memory.ts')
  const feedbackSrc = readRepo('src/memory-feedback.ts')
  const trainingSrc = readRepo('src/training.ts')
  const runtimeSrc = readRepo('src/runtime.ts')
  check('MEMORY_KINDS, in the source order', stringList(memorySrc, 'export const MEMORY_KINDS = ['), TRAINING.kinds)
  check('the kinds NOT read are named in the source and are NOT in MEMORY_KINDS',
    TRAINING.notRead.filter((k) => !memorySrc.includes('`' + k + '/`') || TRAINING.kinds.includes(k)), [])
  check('the read is recorded on EVERY phase entry, receipt included',
    /recordMemoryRead\(resolved\.runDir, phase, \{/.test(runtimeSrc), true)
  check('an empty plane SATISFIES the read gate',
    /`injected: false` is a SATISFIED read/.test(feedbackSrc), true)
  check('the read-receipt marker cannot collide with a shard',
    (feedbackSrc.match(/MEMORY_READ_SOURCE = '([^']+)'/) || [])[1], 'memory-read:attempt')
  check('the phase-0 gate is decided from the RECEIPT, never from the artifact text',
    /function hasMemoryRead\(runDir: string\)/.test(readRepo('src/policy-globs.ts')) &&
    /readMemoryReads\(runDir\)\.some/.test(readRepo('src/policy-globs.ts')), true)
  check('the phase-8 lock gate is CALLED from lockArtifact',
    /const memoryRefusal = phase8MemoryLockRefusal\(root, runId, artifact\)/.test(runtimeSrc), true)
  check('the provenance field the phase-8 gate matches',
    (rulesSrc.match(/MEMORY_PROVENANCE_FIELD = '([^']+)'/) || [])[1], 'Source-Runs')
  check('the phase-8 artifact the lock gate guards',
    (rulesSrc.match(/PHASE8_MEMORY_ARTIFACT = '([^']+)'/) || [])[1], '08-memory-impact.md')
  check('a lock is a FIELD, not a filename',
    /A lock is a FIELD, not a filename/.test(trainingSrc), true)
  check('the re-run is detected from the receipt that ALREADY EXISTS',
    /const rerun = isPhase8 && existsSync\(join\(runDir, 'locks', '08-memory-impact\.receipt\.json'\)\)/.test(runtimeSrc), true)
  check('the trigger is called with the production runner and its writer/reader seams',
    /\? runPhase8Trigger\(root, runId, \{/.test(runtimeSrc) &&
    /runner: spawnExtractorRunner\(\{ cwd: root/.test(runtimeSrc) &&
    /readText: \(relativePath\) => \{/.test(runtimeSrc), true)
  check('THE ORDER OF THE TRIGGER GATES: evidence, then re-run, then extractor', (() => {
    const body = trainingSrc.slice(trainingSrc.indexOf('export function runPhase8Trigger'))
    const at = ['const gate = trainingGate(locked)', 'if (options.rerun !== true)', 'options.extractorAvailable ?? resolveExtractor(process.env) !== null']
      .map((needle) => body.indexOf(needle))
    return at.every((n) => n >= 0) && at[0] < at[1] && at[1] < at[2]
  })(), true)
  check('the two-runs gate is a strict comparison against 2',
    /if \(lockedRuns < 2\) \{/.test(trainingSrc) && trainingSrc.includes('one run is an anecdote, not evidence'), true)
  check('the two exit codes of the training trigger',
    [2, 3].map((n) => (trainingSrc.match(new RegExp('(INSUFFICIENT_EVIDENCE|EXTRACTOR_UNAVAILABLE): ' + n)) || [])[1]).filter(Boolean), ['EXTRACTOR_UNAVAILABLE', 'INSUFFICIENT_EVIDENCE'])
  check('the extractor is named by an environment variable and never embedded',
    (trainingSrc.match(/TRAINING_EXTRACTOR_ENV = '([^']+)'/) || [])[1], 'RECURSIVE_TRAINING_EXTRACTOR_CMD')
  check('the training shard the trigger writes', /return 'memory\/training\/' \+ mode \+ '\.md'/.test(trainingSrc), true)
  check('the registry the written shards are announced in',
    (memorySrc.match(/MEMORY_INDEX_FILE = '([^']+)'/) || [])[1], '.recursive/memory/MEMORY.md')
  check('the group shards land under the memory plane the reader looks in',
    /writes\.push\(options\.write\('memory\/domains\//.test(trainingSrc), true)

  /* 3e. THE CHARTS — the manifests the page ships, re-read from the markup.
     A fact about the DRAWING is still a fact: if the merged overview lost an arrow, or the loop lost
     a step, these counts would move. ⚠ THE MERGE IS ITSELF ASSERTED: `phase-graph` must NOT be a
     chart any more. The whole brief was that the sixteen edges stop living on a second tab, and the
     cheapest way for that to regress is for someone to add the tab back "for reference" while the
     overview quietly keeps its own picture. */
  const dec = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
  const layoutOf = (view) => {
    const at = html.indexOf('data-diagram="' + view + '"')
    if (at < 0) throw new Error('chart not rendered: ' + view)
    const open = html.indexOf('data-layout="', at)
    const raw = html.slice(open + 'data-layout="'.length, html.indexOf('"', open + 'data-layout="'.length))
    return JSON.parse(dec(raw))
  }
  check('two charts are rendered, each with its own manifest — the overview and the learning loop',
    [...html.matchAll(/data-diagram="([a-z-]+)"/g)].map((m) => m[1]), ['overview', 'learning-loop'])
  check('there is NO separate phase-graph chart any more: the edges live on the overview',
    /data-diagram="phase-graph"/.test(html), false)
  check('there is no Phase graph TAB either — the merge removed the view, not just its chart',
    /id="tab-graph"/.test(html), false)
  check('every phase still has its own detail view, so the merge removed no reference material',
    PHASES.map((p) => 'phase-' + p.file.replace(/[^a-z0-9]+/gi, '-')).filter((id) => !html.includes('id="panel-' + id + '"')), [])
  const overviewLayout = layoutOf('overview')
  const labels = overviewLayout.boxes.map((b) => b[5])
  const expectedRuns = EDGES.map((e) => {
    if (e.kind === 'wildcard') return 'wildcard stub ' + e.to
    const i = PHASES.findIndex((p) => p.file === e.from)
    const j = PHASES.findIndex((p) => p.file === e.to)
    /* ⚠ ONE EDGE, ONE RUN, AND THE RUN OF THE BUNDLE TRUNK IS THE TRUNK. 02-to-be-plan's three
       cross-row edges share one stroke — the edge that goes straight down owns it, the other two
       leave it at their own levels — so this expects that stroke's `bundle` label where the other
       fifteen expect their own `lane`/`spine` label. The sharing is not an exemption from being
       checked: the bundle names its three members and TRACE re-derives all three from the ink. */
    if (i === 4 && e.to === PHASES[7].file) return 'bundle ' + e.from + ' -> ' + [PHASES[6].file, PHASES[7].file, PHASES[8].file].join(' + ')
    return (j - i === 1 ? 'spine ' : 'lane ') + e.from + ' -> ' + e.to
  })
  const drawnRuns = labels.filter((l) => /^(lane|spine|bundle) .+ -> .+$/.test(l) || /^wildcard stub /.test(l))
  check('THE OVERVIEW DRAWS EXACTLY ONE RUN PER DERIVED EDGE, AND EVERY EDGE IS DRAWN',
    drawnRuns.slice().sort(), expectedRuns.slice().sort())

  /* ==========================================================================
     THE READABILITY INVARIANTS — THE PROPERTY NO CHECK EVER HELD
     ==========================================================================

     Every geometric rule this file had was about COLLISION: `reserve()` throws when two reserved
     boxes intersect, and the structural checker re-derives the same rule from the manifest. A
     chart can satisfy all of it and still be unfollowable, and this one was. The owner looked at
     the rendered picture and said the lines connecting phases were "somewhat broken", and measured
     off the shipped manifest that was LITERALLY true — three of the sixteen drawn edges were not
     connected from their source node to their target node at all:

       · 00-requirements.md -> 02-to-be-plan.md    the run ended at x=403, 417 units short of its
                                                   own arrival stub at x=820: two strokes, one edge;
       · 00-requirements.md -> 01-as-is.md         the run stopped 6.5 units short of its stub;
       · 01-as-is.md -> 02-to-be-plan.md           the same 6.5-unit notch.

     Nothing noticed, because the checks counted LABELS: the box reading `lane 00-requirements.md
     -> 02-to-be-plan.md` existed and had the right words in it, so the edge counted as drawn.
     These checks are what would have failed. Every one of them is re-derived from the EMITTED
     manifest and the EMITTED svg, so a drawing that stops matching its own words fails here
     rather than shipping.

     ⚠ AND THEY ARE BOOLEAN-SHAPED ON PURPOSE. Nine checks in this file and in
     `check-workflow-map.mjs` used to hand `check()` a NUMBER where its label promised a property —
     `check('… are dashed', laneRunCount, expectedCount)` passes for any count that matches, and a
     count that matches says nothing about a dash. Each one below compares what its own label
     says it compares and reports the FAILING BOXES, not a total. */
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const OVBOX = overviewLayout.boxes.map((b, i) => ({ i, kind: b[0], x: b[1], y: b[2], w: b[3], h: b[4], label: String(b[5]) }))
  const gaps = (a, b) => ({
    dx: Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), 0),
    dy: Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h), 0),
  })
  /** Touching within one stroke width — the same relation the checker calls `meets`. */
  const ovFit = (a, b, tol = 5) => { const g = gaps(a, b); return g.dx <= tol && g.dy <= tol }
  const ovDist = (a, b) => { const g = gaps(a, b); return Math.hypot(g.dx, g.dy) }
  const byLabel = (l) => OVBOX.filter((b) => b.label === l)
  const oneBox = (l) => byLabel(l)[0]
  const NODES_L = OVBOX.filter((b) => /^node /.test(b.label))
  const RAIL_BOX = 'the wildcard input rail'
  /* The emitted svg, element by element, in the same order the boxes were reserved. The mapping is
     asserted below: a class read off the wrong element would be a check about nothing. */
  const ovAt = html.indexOf('data-diagram="overview"')
  const ovSvg = html.slice(ovAt, html.indexOf('</svg>', ovAt))
  const cls = {
    rule: [...ovSvg.matchAll(/<path class="([^"]+)"/g)].map((m) => m[1]),
    ink: [...ovSvg.matchAll(/<polygon class="([^"]+)"/g)].map((m) => m[1]),
    box: [...ovSvg.matchAll(/<rect class="([^"]+)"/g)].map((m) => m[1]),
    text: [...ovSvg.matchAll(/<text class="([^"]+)"/g)].map((m) => m[1]),
  }
  const clsOf = {}
  {
    let r = 0, k = 0, b = 0, t = 0
    for (const x of OVBOX) clsOf[x.i] = cls[x.kind === 'rule' ? 'rule' : x.kind === 'ink' ? 'ink' : x.kind === 'box' ? 'box' : 'text'][
      x.kind === 'rule' ? r++ : x.kind === 'ink' ? k++ : x.kind === 'box' ? b++ : t++]
  }
  check('every emitted element is matched to its reserved box, so a class read below is read off the right stroke',
    [cls.rule.length, cls.ink.length, cls.box.length, cls.text.length],
    ['rule', 'ink', 'box', 'text'].map((k) => OVBOX.filter((x) => (x.kind === k)).length))

  /* THE CONNECTIONS: the sixteen derived edges, the two back edges, the four sequence links and
     the cross-run return. Each one names its source, its target, the stroke that is its own RUN,
     and every stroke that may appear in its chain. */
  const bundlePat = new RegExp('^bundle ' + escRe(PHASES[4].file) + ' -> ')
  const CONN = []
  for (const e of EDGES) {
    const i = PHASES.findIndex((p) => p.file === e.from)
    const j = PHASES.findIndex((p) => p.file === e.to)
    if (e.kind === 'wildcard') {
      CONN.push({
        id: e.from + ' -> ' + e.to, from: RAIL_BOX, to: 'node ' + e.to, family: 'wildcard', run: null,
        strokes: [new RegExp('^wildcard stub ' + escRe(e.to) + '$'), new RegExp('^wildcard head ' + escRe(e.to) + '$')],
      })
      continue
    }
    const word = j - i === 1 ? 'spine' : 'lane'
    const own = new RegExp('^' + word + ' ' + escRe(e.from) + ' -> ' + escRe(e.to) + '$')
    /* 02-to-be-plan's three cross-row edges share one trunk: it IS the run of the edge that goes
       straight down, and it is part of the chain of the other two. */
    const shared = [4, 6, 7, 8].includes(i) && j - i > 1 ? [bundlePat] : []
    /* ⚠ AN ADJACENT EDGE HAS NO STUBS. Its whole drawing is one stroke in the gap between the two
       boxes plus its arrowhead — so listing `stub out <from>` among its strokes would pull in the
       source stubs of the LANES that leave the same node, and the check would then report a chain
       in three pieces for an edge that is drawn perfectly. That was a false alarm in the first
       draft of this check, and it is the reason the stroke list is built from the SHAPE of the
       drawing rather than from the edge's endpoints alone. */
    const stubPats = j - i === 1 ? [] : [
      new RegExp('^stub (out|cross out) ' + escRe(e.from) + '$'),
      new RegExp('^stub (in|cross in) ' + escRe(e.to) + '$'),
    ]
    CONN.push({
      id: e.from + ' -> ' + e.to, from: 'node ' + e.from, to: 'node ' + e.to, family: e.kind,
      run: j - i > 1 && i === 4 && e.to === PHASES[7].file ? [bundlePat] : [own],
      strokes: [own, ...shared, ...stubPats, new RegExp('^' + word + ' (arrow|head) ' + escRe(e.to) + '$')],
    })
  }
  for (const side of [0, 1]) {
    const from = side === 0 ? '03.5-code-review.md' : '04-test-summary.md'
    const to = side === 0 ? '02-to-be-plan.md' : '03.5-code-review.md'
    const word = side === 0 ? 'reopen' : 'revise'
    CONN.push({
      id: word.toUpperCase() + ' ' + from + ' -> ' + to, from: 'node ' + from, to: 'node ' + to, family: word,
      run: [new RegExp('^' + word + ' (out|shelf) ')],
      strokes: [new RegExp('^' + word + ' (out|shelf|riser|drop) '), new RegExp('^' + word + ' head ')],
    })
  }
  for (let i = 0; i + 1 < PHASES.length; i++) {
    if (EDGES.some((e) => e.from === PHASES[i].file && e.to === PHASES[i + 1].file)) continue
    CONN.push({
      id: 'sequence ' + PHASES[i].file + ' -> ' + PHASES[i + 1].file, from: 'node ' + PHASES[i].file, to: 'node ' + PHASES[i + 1].file,
      family: 'sequence', run: [new RegExp('^sequence link ' + escRe(PHASES[i].file) + ' -> ' + escRe(PHASES[i + 1].file) + '$')],
      strokes: [new RegExp('^sequence link ' + escRe(PHASES[i].file) + ' -> ' + escRe(PHASES[i + 1].file) + '$'),
        new RegExp('^sequence head ' + escRe(PHASES[i + 1].file) + '$')],
    })
  }
  const CROSS_CARD = OVBOX.find((b) => /^cross-run card: writes/.test(b.label))
  CONN.push({
    id: 'CROSS-RUN return into the next run', from: CROSS_CARD.label, to: CROSS_CARD.label, family: 'cross-run',
    run: [new RegExp('^cross-run return (run|foot)$')],
    strokes: [new RegExp('^cross-run return (run|drop|foot|head)$')],
  })

  /* ---- 1. TRACE: one continuous polyline, source stub to target head ---------------------- */
  const traceOf = (c) => {
    const start = c.from === RAIL_BOX ? oneBox(RAIL_BOX) : oneBox(c.from)
    const target = oneBox(c.to)
    const members = OVBOX.filter((b) => c.strokes.some((p) => p.test(b.label)))
    const seen = new Set()
    const queue = members.filter((m) => start && ovFit(start, m))
    for (const m of queue) seen.add(m.i)
    while (queue.length > 0) {
      const cur = queue.pop()
      for (const m of members) if (!seen.has(m.i) && ovFit(cur, m)) { seen.add(m.i); queue.push(m) }
    }
    const chain = members.filter((m) => seen.has(m.i))
    const reaches = Boolean(target) && chain.some((m) => ovFit(m, target))
    const headAt = target ? chain.filter((m) => m.kind === 'ink' && ovFit(m, target)).length : 0
    const stray = members.filter((m) => !seen.has(m.i))
    return { chain, reaches, headAt, stray, start, target }
  }
  const TRACED = CONN.map((c) => ({ c, t: traceOf(c) }))
  check('TRACE: every drawn connection is ONE continuous polyline from its source to its target and ends in an arrowhead on the target — the sixteen derived edges, the two violet back edges, the four sequence links and the cross-run return ('
    + TRACED.length + ' connections). A run that stops short of its own arrival, or an arrival that hangs off nothing, fails here',
    TRACED.filter(({ t }) => !(t.chain.length > 0 && t.reaches && t.headAt >= 1)).map(({ c, t }) => c.id
      + ' — reaches its target=' + t.reaches + ', arrowheads on target=' + t.headAt
      + ', strokes reachable from the source: ' + t.chain.map((s) => s.label).join(' + ')),
    [])
  /* ⚠ AND NO STROKE IS LEFT OUT OF EVERY CHAIN. A segment that belongs to no connection's chain is
     an orphan even when it is drawn, and this is the accounting that catches the other half of a
     break: the arrival stub that hangs in mid-air because its run stopped 375 units short of it.
     Text and cards are not strokes; only ink that draws a line is accounted for here. */
  const claimed = new Set(TRACED.flatMap(({ t }) => t.chain.map((m) => m.i)))
  const EDGE_STROKE = /^(lane|spine|bundle|stub|wildcard|sequence|reopen|revise|cross-run) /
  const isStroke = (b) => (b.kind === 'rule' || b.kind === 'ink') && EDGE_STROKE.test(b.label)
  check('NO ORPHAN SEGMENT: every stroke that draws part of a connection belongs to some traced chain',
    OVBOX.filter((b) => isStroke(b) && !claimed.has(b.i)).map((b) => b.label + ' @' + b.x + ',' + b.y),
    [])

  /* ---- 2. LANDING MARGIN: an arrowhead points at a phase, not at its boundary --------------- */
  const onTopEdge = OVBOX.filter((b) => b.kind === 'ink').flatMap((h) => {
    const tipX = round2(h.x + h.w / 2), tipY = round2(h.y + h.h)
    return OVBOX.filter((n) => /^node /.test(n.label) && Math.abs(tipY - n.y) <= 5 && tipX >= n.x - 5 && tipX <= n.x + n.w + 5)
      .map((n) => ({ label: h.label, node: n.label.slice(5), tipX, left: round2(tipX - n.x), right: round2(n.x + n.w - tipX) }))
  })
  check('LAND_MARGIN: every arrowhead that lands on a node box lands at least ' + LAND_MARGIN
    + ' units inside it from BOTH of its vertical edges, so it points at a phase and not at the boundary it shares with the next one ('
    + onTopEdge.length + ' heads land on a node box)',
    onTopEdge.filter((h) => h.left < LAND_MARGIN || h.right < LAND_MARGIN)
      .map((h) => h.label + ' lands ' + h.tipX + ' on ' + h.node + ' — ' + h.left + ' / ' + h.right + ' units from its edges'),
    [])

  /* ---- 3. PROXIMITY: no run loiters beside a node it does not attach to ---------------------
     ⚠ THE EXEMPTION IS BY CONNECTION, NOT BY TOUCH. An arrival stub stops one arrowhead-length
     above its target so that the HEAD can land on the node's edge — the stub itself touches
     nothing, and a rule keyed on touching would call every arrival stub in the chart a loiterer.
     What the rule is for is a stroke running ALONGSIDE a node that is not on its own edge, which is
     the shape a reader reads as "this line belongs to that box". A stroke under RUN_MIN long is a
     connector or an arrowhead, not a run, and the in-row gap arrows (10 units, in a 22-unit gap)
     are exempt for that reason. */
  const RUN_MIN = 24
  const nodeOf = (l) => (l.startsWith('node ') ? l.slice(5) : null)
  /* ⚠ THE EXEMPTION IS BY STROKE, NOT BY CONNECTION. The bundle trunk is one stroke shared by
     three connections, and the node it lands on (04-test-summary) is an endpoint of only one of
     them — so a rule that asked "is this node on this connection" once per connection reported the
     trunk as loitering beside its own target twice. Each stroke is exempt from the union of the
     endpoints of every connection it belongs to. */
  const strokeEnds = new Map()
  for (const { c } of TRACED) {
    const ends = [nodeOf(c.from), nodeOf(c.to)].filter(Boolean)
    for (const pat of c.strokes) for (const b of OVBOX.filter((x) => isStroke(x) && pat.test(x.label))) {
      strokeEnds.set(b.i, new Set([...(strokeEnds.get(b.i) || []), ...ends]))
    }
  }
  const PROX = OVBOX.filter((b) => isStroke(b) && Math.max(b.w, b.h) >= RUN_MIN)
    .flatMap((s) => NODES_L.filter((n) => !(strokeEnds.get(s.i) || new Set()).has(n.label.slice(5)))
      .map((n) => ({ d: Math.round(ovDist(s, n) * 100) / 100, s: s.label, n: n.label.slice(5) })))
    .filter((x) => x.d < PROXIMITY_MIN)
  check('PROXIMITY: no edge stroke longer than ' + RUN_MIN + ' units passes within ' + PROXIMITY_MIN
    + ' units of a node box that is not on its own connection — a run beside a box it does not attach to is a line a reader reads as belonging to that box',
    PROX.map((p) => p.s + ' passes ' + p.d + ' units from ' + p.n),
    [])

  /* ---- 4. CHANNEL SEPARATION: no two edges draw parallel strokes closer than CHANNEL_MIN ----- */
  const owner = (l) => {
    const m = l.match(/^(?:lane|spine|bundle) (.+?) -> /)
    if (m) return m[1]
    const v = l.match(/^(reopen|revise) /)
    if (v) return v[1]
    const st = l.match(/^stub (?:cross )?(?:out|in) (.+)$/)
    if (st) return 'stub-of ' + st[1]
    return l
  }
  const parallels = []
  {
    const strokes = OVBOX.filter((b) => b.kind === 'rule' && EDGE_STROKE.test(b.label))
    for (let a = 0; a < strokes.length; a++) {
      for (let b = a + 1; b < strokes.length; b++) {
        const A = strokes[a], B = strokes[b]
        /* "parallel" = both taller than wide (verticals) or both wider than tall (horizontals) */
        const vert = (s) => s.h > s.w * 2, horiz = (s) => s.w > s.h * 2
        if (!((vert(A) && vert(B)) || (horiz(A) && horiz(B)))) continue
        const ovl = vert(A) ? Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y) : Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x)
        if (ovl <= 0) continue
        const gap = vert(A) ? Math.max(A.x - (B.x + B.w), B.x - (A.x + A.w)) : Math.max(A.y - (B.y + B.h), B.y - (A.y + A.h))
        if (gap < 0 || gap >= CHANNEL_MIN) continue
        /* two strokes of the SAME edge are that edge's own corner, not two channels */
        if (owner(A.label) === owner(B.label)) continue
        parallels.push({ gap: round2(gap), a: A.label, b: B.label })
      }
    }
  }
  check('CHANNEL: two parallel strokes belonging to DIFFERENT edges are never closer than ' + CHANNEL_MIN
    + ' units, so no line reads as a doubled neighbour of another',
    parallels.map((p) => 'gap ' + p.gap + ': ' + p.a + ' | ' + p.b),
    [])

  /* ---- 5. LABELS: one per run, unique, inside its own run, nearest to its own run ----------- */
  const texts = OVBOX.filter((b) => b.kind === 'text')
  /* ⚠ ONLY THE ARROW LABELS COMPETE FOR A RUN. A node's own name row, its `fan-in` line and the
     words inside a refusal band are all text boxes too, and the first draft of this check measured
     them against the runs — so the trunk's "nearest label" was the word `04-test-summary` printed
     inside the node it lands on. A run label is the one kind of text this chart writes with an
     arrow in it, which is also what makes the convention checkable. */
  const runTexts = texts.filter((t) => /→|←/.test(t.label))
  const runBoxes = OVBOX.filter((b) => /^(lane|spine|bundle) .+ -> .+$/.test(b.label))
  const laneRuns = runBoxes.filter((b) => /^(lane|bundle) /.test(b.label))
  const nearestRun = (t) => runBoxes.map((r) => ({ r, d: ovDist(t, r) })).sort((a, b) => a.d - b.d)[0]
  /** A horizontal run holds its label along its width; a vertical run holds it along its height. */
  const insideRun = (t, run) => (run.w >= run.h
    ? t.x >= run.x - 0.01 && t.x + t.w <= run.x + run.w + 0.01
    : t.y >= run.y - 0.01 && t.y + t.h <= run.y + run.h + 0.01)
  check('LABEL: every lane run carries its own words — the label nearest to each run names the phase that run leads to and sits inside the run it names, so a label can never be read against the wrong stroke',
    laneRuns.flatMap((run) => {
      /* The bundle trunk's own destination is the edge that goes straight down (02 -> 04); the
         other two members leave it at their own levels and carry their own labels. */
      const to = run.label.startsWith('bundle ') ? PHASES[7].file
        : (run.label.match(/-> ([^ ]+?)(?: \+.*)?$/) || [])[1]
      const from = run.label.startsWith('bundle ') ? PHASES[4].file
        : (run.label.match(/^(?:lane|spine) (.+?) ->/) || [])[1]
      /* A label answers the question the reader has at that stroke: where does this line go, or —
         when the run is too short to spell out both ends — where did it come from. */
      const names = (t) => t.label.endsWith('→ ' + String(to).replace(/\.md$/, ''))
        || t.label.startsWith('← ' + String(from).replace(/\.md$/, ''))
      const mine = runTexts.filter((t) => nearestRun(t).r === run)
      const named = mine.filter(names)
      const inside = named.filter((t) => insideRun(t, run))
      if (named.length === 1 && inside.length === 1) return []
      return [run.label + ' — ' + mine.length + ' label(s) nearest to it, ' + named.length + ' naming "→ '
        + String(to).replace(/\.md$/, '') + '" or "← ' + String(from).replace(/\.md$/, '') + '", '
        + inside.length + ' inside its own span'
        + (mine.length ? ' (' + mine.map((t) => JSON.stringify(t.label) + '@' + t.x + ',' + t.y).join(', ') + ')' : '')]
    }),
    [])
  check('LABEL: the only words the chart may print more than once are its per-node data rows — every label that names a run is unique in the chart, so a repeated label can never leave a reader guessing which stroke it names',
    texts.map((t) => t.label).filter((l, i, all) => all.indexOf(l) !== i
      && !/^(fan-in \d|no upstream artifact|no memory plane|any lock or write|memory read|frozen|frozen \+ memory|tdd-evidence|run-start|qa-signoff|phase \d+ — |the wildcard input rail|writes the plane)/.test(l)),
    [])

  check('the overview draws one node per phase',
    labels.filter((l) => /^node /.test(l)).length, PHASES.length)
  /* The interaction types, each asserted as the SHAPE that carries it — this is the check that
     would fail if the picture went back to being twelve boxes in a row.
     ⚠ EVERY ONE OF THESE USED TO COMPARE A NUMBER WITH A NUMBER and never look at the drawing.
     `check('MULTI-INPUT is a shape: one dashed-border node …', PHASES.filter(…).length, 5)` compares
     the derived count with the literal 5: both sides come out of PHASES and EDGES, so the emitted
     class could have been `dg-box` on all twelve nodes and the check would still have passed. The
     rewritten checks read the CLASS off the emitted rect for each node BY INDEX, and report the
     phases whose mark is missing rather than a total. */
  const nodeClass = (f) => clsOf[oneBox('node ' + f).i]
  check('MULTI-INPUT is a shape: the phases that read more than one artifact carry the dashed fan-in border, and no other phase does',
    PHASES.filter((p) => (sourcesOf(p.file) > 1) !== /dg-box-fan/.test(nodeClass(p.file)))
      .map((p) => p.file + ' reads ' + sourcesOf(p.file) + ' and is drawn ' + nodeClass(p.file)),
    [])
  check('every node states its own fan-in in words, and the words agree with the linter: the row is inside its own node box and says what sourcesOf() derives',
    PHASES.filter((p) => {
      const n = oneBox('node ' + p.file)
      return !OVBOX.some((t) => t.kind === 'text' && t.label === fanInText(p.file)
        && t.x >= n.x && t.x + t.w <= n.x + n.w && t.y >= n.y && t.y + t.h <= n.y + n.h)
    }).map((p) => p.file + ' has no "' + fanInText(p.file) + '" row inside its box'),
    [])
  check('HUMAN DECISION is a shape: one amber marker per phase a person must answer, drawn directly above that phase and carrying its own diamond',
    PHASES.filter((p) => p.human).flatMap((p) => {
      const n = oneBox('node ' + p.file)
      const m = oneBox('human decision marker ' + p.file)
      if (!m) return [p.file + ' has no marker']
      const bad = []
      if (clsOf[m.i] !== 'dg-box-human') bad.push('its marker is class ' + clsOf[m.i])
      if (!(m.y + m.h <= n.y && n.y - (m.y + m.h) <= 8)) bad.push('its marker is not directly above the node')
      if (!(m.x >= n.x && m.x + m.w <= n.x + n.w)) bad.push('its marker is not over its own column')
      const d = oneBox('decision diamond ' + p.file)
      if (!d || clsOf[d.i] !== 'dg-mark' || !(d.x >= m.x && d.x + d.w <= m.x + m.w)) bad.push('its diamond is missing or outside the marker')
      return bad.map((b) => p.file + ': ' + b)
    }),
    [])
  check('no phase that no person answers carries a human marker',
    OVBOX.filter((b) => /^human decision marker /.test(b.label))
      .map((b) => b.label.slice('human decision marker '.length)).filter((f) => !PHASES.some((p) => p.human && p.file === f)),
    [])
  /* The rendered refusal bands: one per PHASE, and each one under ITS OWN phase. */
  /* ⚠ THE OLD VERSION OF THIS CHECK COMPARED A CONSTANT WITH A LITERAL. Its second element was
     `REFUSAL_MARKS.filter((r) => r.nodes.length > 0).length` against `8` — both of them declared in
     this file, neither of them read off the page, so the check could not fail unless somebody
     edited the constant. The band is asserted here as GEOMETRY (a band under its own node, touching
     nothing else) and as CONTENT (the words the band prints are the rules that select that phase). */
  check('REFUSAL is a shape: one band under each of the twelve phases, under that phase and not another, and the rule words it prints are the ones that select it',
    PHASES.flatMap((p) => {
      const n = oneBox('node ' + p.file)
      const b = oneBox('refusal band ' + p.file)
      if (!b) return [p.file + ' has no refusal band']
      const bad = []
      if (clsOf[b.i] !== 'dg-box-refuse') bad.push('its band is class ' + clsOf[b.i])
      if (Math.abs(b.x - n.x) > 0.01) bad.push('its band does not start at its own node')
      if (!(b.y >= n.y + n.h && b.y - (n.y + n.h) <= 8)) bad.push('its band is not directly under it')
      const text = OVBOX.find((t) => t.kind === 'text' && t.x >= b.x && t.x + t.w <= b.x + b.w && t.y >= b.y && t.y + t.h <= b.y + b.h)
      if (!text || text.label !== refusalBandText(p.file)) bad.push('its band prints ' + JSON.stringify(text ? text.label : null))
      return bad.map((x) => p.file + ': ' + x)
    }),
    [])
  check('every refusal band names only rules the code declares, and every declared rule that bites somewhere names at least one band',
    [...new Set(REFUSAL_MARKS.map((r) => r.rule))].filter((r) => !REFUSAL_MARKS.some((x) => x.rule === r && x.nodes.length > 0))
      .concat(REFUSAL_MARKS.filter((r) => r.nodes.some((f) => !PHASES.some((p) => p.file === f))).map((r) => r.rule)),
    [])
  /* ⚠ THE CHECK BELOW USED TO COMPARE TWO COUNTS AND NEVER READ A DASH. Its label promised
     "CONDITIONAL edges are dashed"; its assertion was `labels.filter(/^lane /).length ===
     EDGES.filter(non-adjacent).length`, which passes with every conditional edge drawn SOLID, and
     passes again if no stroke in the chart carries the dash class at all. It is now asserted edge
     by edge, against the class on the emitted stroke — looked up by the box index so the class is
     read off the right path. */
  const runOf = (e) => {
    const i = PHASES.findIndex((p) => p.file === e.from)
    const j = PHASES.findIndex((p) => p.file === e.to)
    const word = j - i === 1 ? 'spine' : 'lane'
    return OVBOX.find((b) => b.label === word + ' ' + e.from + ' -> ' + e.to)
      || OVBOX.find((b) => /^bundle /.test(b.label) && b.label.includes(' ' + e.to))
  }
  const headOf = (e) => {
    const i = PHASES.findIndex((p) => p.file === e.from)
    const j = PHASES.findIndex((p) => p.file === e.to)
    const word = j - i === 1 ? 'spine' : 'lane'
    return OVBOX.find((b) => b.kind === 'ink' && b.label === word + (word === 'spine' ? ' head ' : ' arrow ') + e.to)
  }
  check('CONDITIONAL edges are dashed and REQUIRED edges are not: the class on the emitted run stroke and on its arrowhead matches the edge kind, edge by edge',
    EDGES.filter((e) => e.kind !== 'wildcard').flatMap((e) => {
      const want = e.kind === 'conditional' ? 'dg-line-cond' : 'dg-line'
      const wantHead = e.kind === 'conditional' ? 'dg-head-cond' : 'dg-head'
      const run = runOf(e)
      const head = headOf(e)
      const bad = []
      if (!run) bad.push('no run stroke')
      else if (clsOf[run.i] !== want) bad.push('run "' + run.label + '" is ' + clsOf[run.i] + ', expected ' + want)
      if (!head) bad.push('no arrowhead of its own shape')
      else if (clsOf[head.i] !== wantHead) bad.push('head "' + head.label + '" is ' + clsOf[head.i] + ', expected ' + wantHead)
      return bad.map((b) => e.from + ' -> ' + e.to + ' (' + e.kind + '): ' + b)
    }),
    [])
  check('CONDITIONAL: exactly the two conditional edges in the linter carry the dash, and no other stroke in the overview does',
    OVBOX.filter((b) => b.kind === 'rule' && /^dg-line-cond$/.test(clsOf[b.i]))
      .map((b) => b.label).filter((l) => !EDGES.some((e) => e.kind === 'conditional' && runOf(e) === OVBOX.find((x) => x.label === l))),
    [])
  check('WILDCARD is a shape: a thick stub into each wildcard phase, rising from the rail to that node\'s own bottom edge, and a rail exactly as wide as the row',
    EDGES.filter((e) => e.kind === 'wildcard').flatMap((e) => {
      const stub = oneBox('wildcard stub ' + e.to)
      const head = oneBox('wildcard head ' + e.to)
      const n = oneBox('node ' + e.to)
      const bad = []
      if (!stub || !head) return [e.to + ': no stub or no head']
      if (clsOf[stub.i] !== 'dg-line-wide') bad.push('the stub is class ' + clsOf[stub.i])
      if (clsOf[head.i] !== 'dg-head-wide') bad.push('the head is class ' + clsOf[head.i])
      if (!ovFit(head, n)) bad.push('its head does not land on ' + e.to)
      if (!ovFit(stub, oneBox(RAIL_BOX))) bad.push('its stub does not rise from the rail')
      if (!(stub.x >= n.x && stub.x + stub.w <= n.x + n.w)) bad.push('its stub rises outside the node it feeds')
      return bad.map((b) => e.to + ': ' + b)
    }).concat((() => {
      const rail = oneBox(RAIL_BOX)
      const left = Math.min(...NODES_L.map((n) => n.x)), right = Math.max(...NODES_L.map((n) => n.x + n.w))
      return Math.abs(rail.x - left) > 1 || Math.abs(rail.x + rail.w - right) > 1
        ? ['the rail spans ' + rail.x + '..' + round2(rail.x + rail.w) + ' against the row ' + left + '..' + right] : []
    })()),
    [])
  /* ⚠ THIS ONE PROMISED "THEY ARE THEIR OWN SHAPE" AND COUNTED FOUR LABELS. The dot is the whole
     point of the shape — a dotted link claims SEQUENCE ORDER WITHOUT A DEPENDENCY, and a dotted
     link drawn solid would say the opposite of what the page means. So the class is read off each
     link's own stroke, and the pairs it is drawn on are compared with the edge set in BOTH
     directions: a dotted link over a pair that HAS an input edge would claim the order and the
     dependency are the same thing, which is the mistake the shape exists to prevent. */
  const seqPairs = PHASES.slice(0, -1)
    .map((p, i) => [p.file, PHASES[i + 1].file])
    .filter(([a, b]) => !EDGES.some((e) => e.from === a && e.to === b))
  check('SEQUENCE-ORDER links are their own DOTted shape, drawn on exactly the adjacent pairs that have no input edge, and named for both ends',
    seqPairs.flatMap(([a, b]) => {
      const run = oneBox('sequence link ' + a + ' -> ' + b)
      const head = oneBox('sequence head ' + b)
      const bad = []
      if (!run) bad.push('no link')
      else if (clsOf[run.i] !== 'dg-line-seq') bad.push('the link is class ' + clsOf[run.i])
      if (!head) bad.push('no arrowhead')
      else if (clsOf[head.i] !== 'dg-head-seq') bad.push('the head is class ' + clsOf[head.i])
      return bad.map((x) => a + ' -> ' + b + ': ' + x)
    }).concat(OVBOX.filter((b) => b.kind === 'rule' && clsOf[b.i] === 'dg-line-seq')
      .filter((b) => !seqPairs.some(([a, c]) => b.label === 'sequence link ' + a + ' -> ' + c))
      .map((b) => 'a dotted link is drawn where the pair HAS an input edge: ' + b.label)),
    [])
  check('a SPINE mark is drawn in the gap of every adjacent pair that does have an input edge',
    PHASES.slice(0, -1).map((p, i) => [p.file, PHASES[i + 1].file])
      .filter(([a, b]) => EDGES.some((e) => e.from === a && e.to === b))
      .flatMap(([a, b]) => {
        const run = oneBox('spine ' + a + ' -> ' + b)
        const head = oneBox('spine head ' + b)
        if (run && head) return []
        return [a + ' -> ' + b + ': ' + (run ? '' : 'no spine run ') + (head ? '' : 'no arrowhead')]
      }),
    [])
  /* ⚠ EVERY RULE THE BANDS NAME IS RE-DERIVED FROM THE SOURCE THAT DECLARES IT. The refusal marks
     are a transcription, and a transcription is exactly what this generator exists to keep honest:
     the four built-in rules are read off `builtInToolPolicyRules` (whose `label:` literals are
     already checked above), and the phase baselines off `phaseBaselineRules` — so a rule that is
     renamed in the source fails here instead of leaving a band naming a rule that no longer exists. */
  check('every rule the refusal bands name is a label the code actually declares',
    [...globsSrc.matchAll(/label: '([a-z-]+)'/g)].map((m) => m[1]).concat(
      /label: 'tdd-evidence'/.test(rulesSrc) ? ['tdd-evidence'] : [],
      /phaseBaselineRules/.test(rulesSrc) ? ['phase 1/2 baseline', 'phase 6/7 baseline', 'phase 6/7/8 baseline'] : [],
    ), ['lock-order', 'locked-write', 'phase-order', 'memory-read', 'tdd-evidence',
      'phase 1/2 baseline', 'phase 6/7 baseline', 'phase 6/7/8 baseline'])
  check('the refusal bands name only rules that are in that list',
    REFUSAL_MARKS.filter((r) => !['lock-order', 'locked-write', 'phase-order', 'memory-read', 'tdd-evidence',
      'phase 1/2 baseline', 'phase 6/7 baseline', 'phase 6/7/8 baseline'].includes(r.rule)).map((r) => r.rule), [])
  /* AND THE ONE RULE WHOSE NAME DIFFERS BETWEEN THE TWO: the guards table splits the late-phase
     baseline in two predicates, while the bands name the phases each one bites on. That is a fact
     about the guards table, so it is asserted rather than smoothed over. */
  check('the guards table declares the late-phase baseline as TWO rules, which is why the bands name phases',
    GUARDS.filter((g) => /baseline/.test(g.k)).map((g) => g.k),
    ['phase 6/7/8 baseline', 'phase 6/7 baseline', 'phase 1/2 baseline'])
  /* ⚠ THIS CHECK COUNTED TWO HEADS AND CALLED IT "POINT AT NODES EARLIER IN THE SEQUENCE". The
     labels it counted contain the answer (`reopen head 02-to-be-plan.md`), but the assertion only
     asked how MANY there were — so a head drawn anywhere, or attached to any node, passed. It is
     now read off the geometry: the head's tip must touch the node it names, and that node must come
     EARLIER in PHASE_SEQUENCE than the node the arc left. */
  const backEdges = [
    { word: 'reopen', from: '03.5-code-review.md', to: '02-to-be-plan.md' },
    { word: 'revise', from: '04-test-summary.md', to: '03.5-code-review.md' },
  ]
  check('BACK-EDGE is a shape: two arcs, each of them a run, a riser and a drop that land on the node the arc names, entering it EARLIER in PHASE_SEQUENCE than the node it left',
    backEdges.flatMap(({ word, from, to }) => {
      const bad = []
      const head = oneBox(word + ' head ' + to)
      const n = oneBox('node ' + to)
      const src = oneBox('node ' + from)
      if (!head) bad.push('no entry arrowhead')
      else {
        if (clsOf[head.i] !== 'dg-head-loop') bad.push('its head is class ' + clsOf[head.i])
        if (!ovFit(head, n)) bad.push('its head does not touch ' + to)
      }
      if (!(PHASES.findIndex((p) => p.file === to) < PHASES.findIndex((p) => p.file === from))) {
        bad.push('it does not run backwards at all')
      }
      const parts = OVBOX.filter((b) => b.kind === 'rule' && new RegExp('^' + word + ' (out|shelf|riser|drop) ').test(b.label))
      /* The reopen leaves its source through the source's right edge and the revise leaves through
         the source's bottom edge, so the reopen is four strokes and the revise three; what both
         must do is leave the node they name and enter the node they name. */
      if (parts.length < 3) bad.push('it is drawn in ' + parts.length + ' strokes, not at least 3')
      if (!parts.some((p) => ovFit(p, src))) bad.push('none of its strokes leaves ' + from)
      /* The arc's last stroke stops one arrowhead-length short of the node so that the HEAD can
         land on the edge — the head is the stroke that enters, and TRACE above walks the rest.
         Rounded to the manifest's own precision before comparing: 416.8 - 344.4 - 72.4 is
         8.000000000000057 in binary floating point, and a rule that fires on that is a rule that
         gets switched off. */
      if (!parts.some((p) => round2(ovDist(p, n)) <= 8)) bad.push('no stroke of it comes within an arrowhead-length of ' + to
        + ' (' + parts.map((p) => p.label + ' d=' + round2(ovDist(p, n))).join(', ') + ')')
      return bad.map((x) => word + ': ' + x)
    }),
    [])
  check('CROSS-RUN is a shape: a return run, a return drop, a return foot and an arrowhead that lands back on the run it leaves',
    (() => {
      const card = OVBOX.find((b) => /^cross-run card: writes/.test(b.label))
      const head = oneBox('cross-run return head')
      const foot = oneBox('cross-run return foot')
      const bad = []
      if (!head || !ovFit(head, card)) bad.push('the return arrowhead does not land on the card the run leaves')
      if (!foot || !ovFit(foot, card)) bad.push('the return foot does not leave that card')
      return bad
    })(),
    [])
  check('the cross-run band draws the three steps of the cycle, edge to edge',
    labels.filter((l) => /^cross-run card: /.test(l)).length, 3)
  /* ==========================================================================
     THE COMPOSITION BUDGETS — the invariants that would have caught the defects a
     reader saw and no check did.
     ==========================================================================

     The overview shipped 2854 units wide inside a column that measures 1141 units at a
     1280px window, so a reader opening the page saw five of the twelve phases; it also
     carried a 148-unit band of empty height under its title, with the run-start marker
     floating alone in it, and the refusal bands sat 134 units below their own nodes.
     Every check in this file passed, because nothing compared the chart's SIZE with the
     box it lands in, or its ink with its own frame. These four numbers do, and they are
     stated here rather than computed from the layout, so a future edit that widens the
     chart fails a test instead of shipping a slice of the workflow:

       ·  units of width at a px viewport — the SVG space the page
         gives a chart is 1141 units at 1280 (measured in headless Chromium, not derived
         from the token arithmetic) and 1216 at 1440, where the reading column is capped;
         the budget is the smaller of the two less a margin;
       ·  units of height — a 1440x900 window less the 108px sticky tab strip and a
         12px margin, which is what "the whole graph in ONE screenshot" means in numbers;
       ·  units for the tallest run of the frame that holds no ink at all — a
         band taller than this is a mark floating in space or a strip detached from the
         node it annotates, which is exactly what a reader reported twice;
       · and the frame may not be padded: its height must stay within 5% of the height of
         the drawing's own bounding box. */
  const ovEmpty = emptyBandOf(overviewLayout)
  const ovInk = overviewLayout.boxes.reduce((acc, b) => [Math.min(acc[0], b[2]), Math.max(acc[1], b[2] + b[4])],
    [Infinity, -Infinity])
  check('THE OVERVIEW FITS THE COLUMN IT IS READ IN — ' + OVERVIEW_LIMITS.WIDTH_BUDGET + ' units at a '
    + OVERVIEW_LIMITS.MIN_VIEWPORT_W + 'px viewport (this chart: ' + overviewLayout.viewBox[2] + ')',
    overviewLayout.viewBox[2] <= OVERVIEW_LIMITS.WIDTH_BUDGET, true)
  check('THE OVERVIEW IS ONE PICTURE IN A 1440x900 WINDOW — under ' + OVERVIEW_LIMITS.HEIGHT_BUDGET
    + ' units tall (this chart: ' + overviewLayout.viewBox[3] + ')',
    overviewLayout.viewBox[3] <= OVERVIEW_LIMITS.HEIGHT_BUDGET, true)
  check('THE OVERVIEW HAS NO EMPTY BAND TALLER THAN ' + OVERVIEW_LIMITS.MAX_EMPTY_BAND + ' UNITS — measured '
    + ovEmpty.worst + ' (the shipped chart had 148.3, under its title)',
    ovEmpty.worst <= OVERVIEW_LIMITS.MAX_EMPTY_BAND, true)
  check('the overview frame is not padded: its height is within 5% of the drawing it holds',
    overviewLayout.viewBox[3] <= round2((ovInk[1] - ovInk[0]) * 1.05), true)
  const loopLayout = layoutOf('learning-loop')
  check('the learning loop draws every step and every gate that can stop one',
    [loopLayout.boxes.filter(([, , , , , l]) => /^step \d+: /.test(l)).length,
      loopLayout.boxes.filter(([, , , , , l]) => /^gate for step /.test(l)).length],
    [TRAINING.steps.length, TRAINING.steps.filter((s) => s.gate).length])
  check('each chart carries a distinct wrapper width (no chart is scaled by another)',
    new Set([overviewLayout.viewBox[2], loopLayout.viewBox[2]]).size, 2)
  /* ⚠ THE FRAME IS THE LAST THING THAT CAN CLIP A CHART SILENTLY. Every reserved box has to sit
     inside the viewBox, including a lane or a legend row that ran past the end of the drawing. */
  check('NOTHING IN ANY CHART FALLS OUTSIDE ITS FRAME (a clipped mark is an invisible one)',
    [...html.matchAll(/data-layout="([^"]*)"/g)].map((m) => JSON.parse(dec(m[1]))).flatMap((L) => {
      const [ox, oy, w, h] = L.viewBox
      return L.boxes
        .filter((b) => b[1] < ox - 3 || b[2] < oy - 3 || b[1] + b[3] > ox + w + 3 || b[2] + b[4] > oy + h + 3)
        .map((b) => b[5] + ' ' + JSON.stringify([b[1], b[2], b[3], b[4]]))
    }), [])

  // 4. tools
  const toolFiles = ['recursive_status', 'recursive_init', 'recursive_lock', 'recursive_lint', 'recursive_closeout', 'recursive_scratch', 'recursive_worktree', 'recursive_phase', 'recursive_review', 'recursive_delegate', 'recursive_ask', 'recursive_preview', 'recursive_audit_team']
  check('13 tool files declare 13 names', toolFiles.map((f) => {
    const s = readRepo('src/' + f + '.tool.ts')
    const m = s.match(/name: '(recursive_[a-z_]+)'/)
    return m ? m[1] : 'MISSING'
  }), TOOLS.map((t) => t.n))

  // 5. errors — order is the REGISTRY's order (it groups by class on purpose), so
  // the comparison sorts both sides rather than reordering the page.
  const codes = [...errorsSrc.matchAll(/code: '(RM\d{4})'/g)].map((m) => m[1])
  check('the RM#### codes in TOOL_ERRORS', [...codes].sort(), [...ERRORS.map((e) => e.code)].sort())
  const klass = {}
  for (const m of errorsSrc.matchAll(/code: '(RM\d{4})',\s*\n\s*klass: '(\w+)'/g)) klass[m[1]] = m[2]
  check('each code\'s third character matches its class group', codes.map((c) => ({ c, group: c[3] })).map(({ c, group }) => ({ '1': 'input', '2': 'value', '3': 'workspace', '4': 'state', '5': 'runtime', '6': 'capability' }[group])), codes.map((c) => klass[c]))

  // 6. hooks
  check('HOOK_POINTS', stringList(hooksSrc, 'export const HOOK_POINTS'), HOOKS.map((h) => h.point))
  check('GATING_POINTS', stringList(hooksSrc, 'export const GATING_POINTS', { typed: true }), HOOKS.filter((h) => h.gating).map((h) => h.point))
  check('OBSERVING_POINTS', stringList(hooksSrc, 'export const OBSERVING_POINTS', { typed: true }), HOOKS.filter((h) => !h.gating).map((h) => h.point))
  check('gating and observing partition the five points',
    [...new Set([...HOOKS.filter((h) => h.gating).map((h) => h.point), ...HOOKS.filter((h) => !h.gating).map((h) => h.point)])].length,
    HOOKS.length)
  // The guard registers under a CONSTANT name, so the binding is asserted from the
  // constant's own value plus the register call, not from a guessed literal.
  check('the exit-plan-mode-gate binding (name + priority)',
    [...indexSrc.matchAll(/name: '(exit-plan-mode-gate)',\s*\n\s*priority: (\d+)/g)].map((m) => m[1] + '@' + m[2]),
    ['exit-plan-mode-gate@5'])
  check('the built-in guard registers at priority 0 under BUILTIN_GUARD_HOOK_NAME',
    /BUILTIN_GUARD_HOOK_NAME = '([^']+)'/.test(indexSrc) &&
    new RegExp("name: BUILTIN_GUARD_HOOK_NAME,\\s*\\n\\s*priority: 0").test(indexSrc), true)
  check('the built-in guard constant is the name the page shows',
    (indexSrc.match(/BUILTIN_GUARD_HOOK_NAME = '([^']+)'/) || [])[1], 'builtin-tool-guard')
  check('exactly two pre_trigger bindings are registered',
    (indexSrc.match(/hooks\.register\('pre_trigger', \{/g) || []).length, 2)
  check('seam event strings present in index.ts', ['tools/pre-execute', 'fs/observed', 'session/event', 'agent/pre-step'].filter((s) => indexSrc.includes("on('" + s + "'")), ['tools/pre-execute', 'fs/observed', 'session/event', 'agent/pre-step'])
  check('systemPrompt section name', [/name: 'recursive:policy'/.test(indexSrc) ? 'recursive:policy' : 'MISSING'], ['recursive:policy'])

  // 7. guard labels + run-start
  check('guard rule labels, in built-in rule order', [...globsSrc.matchAll(/label: '([a-z-]+)'/g)].map((m) => m[1]), ['lock-order', 'locked-write', 'phase-order', 'memory-read'])
  check('phase-rules tdd-evidence label', [/label: 'tdd-evidence'/.test(rulesSrc) ? 'tdd-evidence' : 'MISSING'], ['tdd-evidence'])
  check('run-start gate id + labels', [startSrc.match(/RUN_START_GATE_ID = '([^']+)'/)[1], startSrc.match(/RUN_START_APPROVE = '([^']+)'/)[1], startSrc.match(/RUN_START_HOLD = '([^']+)'/)[1]], ['run-start', 'Start run', 'Hold'])
  const askSrc = readRepo('src/recursive_ask.tool.ts')
  check('the workflow gate ids and their headers are the ones shown', [
    ...askSrc.matchAll(/id: '(tdd-mode|qa-signoff|gate-block)',\s*\n\s*header: '([^']+)'/g),
  ].map((m) => m[1] + ' / ' + m[2]), ['tdd-mode / TDD Mode', 'qa-signoff / QA sign-off', 'gate-block / Gate block'])
  check('run-start is deliberately not one of the three workflow gates', /Deliberately NOT in ASK_GATE_IDS/.test(startSrc), true)
  check('the relay flag is refused for every gate but run-start', /args\.relay === true && !isRunStartGate\(gateId\)/.test(askSrc), true)
  /** The option labels of one ASK_GATES entry: its `id:` through its `marker:` line. */
  const gateOptions = (id) => {
    const block = (askSrc.match(new RegExp("'" + id + "': \\{[\\s\\S]*?marker: '[^']+',")) || [''])[0]
    return [...block.matchAll(/label: '([^']+)'/g)].map((m) => m[1])
  }
  check('the gate-block options are fix | reopen | abandon', gateOptions('gate-block'), ['fix', 'reopen', 'abandon'])
  check('the tdd-mode options are strict | pragmatic', gateOptions('tdd-mode'), ['strict', 'pragmatic'])
  check('the qa-signoff options are human | agent-operated | hybrid', gateOptions('qa-signoff'), ['human', 'agent-operated', 'hybrid'])

  // 8. the HTML's own structure: every aria-controls resolves, exactly one panel per tab
  const tabIds = [...html.matchAll(/<button role="tab" id="tab-([a-z0-9-]+)" aria-controls="panel-([a-z0-9-]+)"/g)]
  const panelIds = new Set([...html.matchAll(/class="panel[^"]*" id="panel-([a-z0-9-]+)"/g)].map((m) => m[1]))
  check('every tab aria-controls names an existing panel', tabIds.map((m) => m[2]).filter((id) => !panelIds.has(id)), [])
  check('every panel is a tabpanel labelled by its own tab',
    [...html.matchAll(/id="panel-([a-z0-9-]+)" role="tabpanel" aria-labelledby="tab-([a-z0-9-]+)"/g)].length, tabIds.length)
  check('every panel is addressed by exactly one tab',
    [...panelIds].filter((p) => tabIds.filter((m) => m[2] === p).length !== 1), [])
  check('tab count == 1 overview + 1 graph + 12 phases + 1 learning loop + 8 other views', tabIds.length, 23)
  check('exactly one TAB starts aria-selected=true', [...html.matchAll(/<button role="tab"[^>]*aria-selected="true"/g)].length, 1)
  check('exactly one TAB starts tabindex=0', [...html.matchAll(/<button role="tab"[^>]*tabindex="0"/g)].length, 1)
  check('every other tab starts at tabindex=-1 (the roving tabindex)',
    [...html.matchAll(/<button role="tab"[^>]*tabindex="-1"/g)].length, tabIds.length - 1)
  check('the tablist is labelled', /role="tablist" aria-labelledby="tabstrip-hint"/.test(html), true)
  check('every phase file has its own panel', PHASES.map((p) => p.file.replace(/[^a-z0-9]+/gi, '-')).filter((s) => !panelIds.has('phase-' + s)), [])
  check('every phase artifact is named somewhere on the page', PHASES.filter((p) => !html.includes(p.file)), [])
  check('no external resource references', /(<link[^>]+href="(?!#)|<script[^>]+src=)/.test(html), false)

  // 9. CONTRAST — every declared pair, at the threshold it owes. This is the
  // accessibility claim the page makes, so it is MEASURED rather than asserted.
  const contrastResults = CONTRAST_REQUIREMENTS.map((r) => ({
    what: r.what, pair: r.fg + ' on ' + r.bg, need: r.need,
    ratio: Math.round(contrast(tone(r.fg), tone(r.bg)) * 100) / 100,
  }))
  check('every WCAG pair meets its threshold',
    contrastResults.filter((r) => r.ratio < r.need).map((r) => r.pair + ' = ' + r.ratio + ' (needs ' + r.need + ')'),
    [])

  // 10. the CSS really consumes the audited tokens — a palette audited in the
  // checker but hardcoded in the sheet would hollow out the whole claim.
  check('every hex in the sheet is a declared token value',
    [...new Set([...html.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase()))].filter((h) => !Object.values(C).map((v) => v.toLowerCase()).includes(h)),
    [])

  // 11. the radius ladder is concentric, and no token was left dangling
  const declared = new Set([...html.matchAll(/--(r-\d|r-pill):/g)].map((m) => m[1]))
  const used = new Set([...html.matchAll(/var\(--(r-\d|r-pill)\)/g)].map((m) => m[1]))
  const ladder = ['r-1', 'r-2', 'r-3'].map((n) => Number((html.match(new RegExp('--' + n + ':(\\d+)px')) || [0, '0'])[1]))
  check('radius ladder is strictly increasing (outer > inner)', ladder.join('<') === [...ladder].sort((a, b) => a - b).join('<') && new Set(ladder).size === 3, true)
  check('every radius token used is declared', [...used].filter((u) => !declared.has(u)), [])
  check('every radius token declared is used', [...declared].filter((d) => !used.has(d)), [])
  check('no dangling --r token (the old shorthand was removed)', /var\(--r\)/.test(html), false)

  // 12. responsiveness / motion / interaction affordances the design skills require
  const tablistRule = (html.match(/\[role="tablist"\]\{[\s\S]*?\n\}/) || [''])[0]
  const tabRule = (html.match(/\[role="tab"\]\{[\s\S]*?\n\}/) || [''])[0]
  check('the tab strip scrolls in one row rather than wrapping', /overflow-x:auto/.test(tablistRule), true)
  check('the tab strip does not wrap', /flex-wrap:wrap/.test(tablistRule), false)
  check('the tab hit area is at least 44px', /min-height:44px/.test(tabRule), true)
  check('fluid type uses clamp', (html.match(/clamp\(/g) || []).length >= 5, true)
  check('prefers-reduced-motion is honoured', /@media \(prefers-reduced-motion: reduce\)/.test(html), true)
  check('tabular numerals are applied', /font-variant-numeric:tabular-nums/.test(html), true)
  check('font smoothing is applied', /-webkit-font-smoothing:antialiased/.test(html), true)
  check('text-wrap is used for headings and body', /text-wrap:balance/.test(html) && /text-wrap:pretty/.test(html), true)
  // NOTE, twice over. (a) The `[^;{}]*` stops a `transition-property:` declaration from
  // spanning to an unrelated `all`. (b) The required `[;{]` before the property means
  // this matches a CSS DECLARATION only — the page's own prose is allowed to say the
  // words "transition: all" while explaining that it uses none, and a check that
  // forbids the documentation from naming the thing it avoids is a broken check.
  check('no `transition: all` declaration', /[;{]\s*transition:[^;{}]*\ball\b/.test(html), false)
  check('transitions name exact properties', /transition-property:/.test(html), true)
  check('no declaration sets animation', /[;{]\s*animation:/.test(html), false)
  check('a visible focus style exists', /:focus-visible\{/.test(html), true)
  check('a skip link exists and targets the overview', /class="skip" href="#tab-overview"/.test(html), true)
  check('every gate carries a text label, not only a colour', (html.match(/g-shape">(DECISION|REFUSAL|AUTO|ABSTAIN|UNVERIFIED)/g) || []).length >= 12, true)

  // 13. CITATION COVERAGE — the property this whole page rests on. Every rendered
  // citation must name a real source file AND a line, that line must exist, and a
  // phase panel must not be able to lose its provenance during an edit.
  //
  // ⚠ THE SPLIT ACCEPTS A COMMA **OR A NEWLINE**: a citation naming several sources
  // wraps across lines in the caption, and treating a wrapped entry as ONE entry made
  // this check report a list of perfectly good citations as broken. The check was
  // wrong, not the citations.
  //
  // ⚠ AND THE SHAPE TEST IS DELIBERATELY NOT `[a-z-]+`: real source files carry
  // underscores (`recursive_status.tool.ts`, `run-start.ts`), so a character class
  // that omits one is a check that fails on correct input. What a citation must
  // satisfy is (1) `path:line`, (2) a path that EXISTS and is readable, and (3) a
  // line inside it — which is what is asserted here instead.
  const citations = [...html.matchAll(/<span class="cite">([^<]*)<\/span>/g)].map((m) => m[1])
  const citationParts = [...new Set(citations.flatMap((c) => c.split(/,\s*|\s*\n\s*/)).map((c) => c.trim()).filter(Boolean))]
  const readOk = (file) => { try { return sourceLines(file).length } catch { return null } }
  check('every rendered citation has the shape `path:line`',
    citationParts.filter((c) => !/^src\/\S+\.ts:\d+(-\d+)?$/.test(c)),
    [])
  check('every cited path is a file that exists and can be read',
    citationParts.filter((c) => readOk(c.slice(0, c.lastIndexOf(':'))) === null),
    [])
  check('every citation line exists inside the file it names',
    citationParts.filter((c) => {
      const file = c.slice(0, c.indexOf(':'))
      const end = Number(c.split('-').pop().split(':').pop())
      try { return !(end >= 1 && end <= sourceLines(file).length) } catch { return true }
    }),
    [])
  check('at least one citation per phase panel (>= 8 each)',
    PHASES.filter((p) => {
      const panel = (html.match(new RegExp('id="panel-phase-' + p.file.replace(/[^a-z0-9]+/gi, '-') + '"[\\s\\S]*?\\n</section>')) || [''])[0]
      return panel === '' || (panel.match(/class="cite"/g) || []).length < 8
    }).map((p) => p.file),
    [])
  check('a good number of citations are rendered in total', citations.length >= 150, true)
  check('the page states what it could not verify', /class="unv">/.test(html), true)

  return { problems, ok, contrastResults }
}

/* ========================================================================== */
/* MAIN                                                                       */
/* ========================================================================== */

const argv = process.argv.slice(2)
const verifyOnly = argv.includes('--verify')
const outAt = argv.indexOf('--out')
const out = outAt >= 0 && argv[outAt + 1] ? resolve(argv[outAt + 1]) : DEFAULT_OUT

const html = render()
const { problems, ok, contrastResults } = verify(html)

console.log('gen-workflow-map — ' + (verifyOnly ? 'verify only' : 'generate') + '\n')
console.log('  WCAG contrast audit (measured from the palette this page ships):')
for (const r of contrastResults) {
  const verdict = r.ratio >= r.need ? 'PASS' : 'FAIL'
  console.log('    ' + verdict + '  ' + String(r.ratio).padStart(6) + ':1  (needs ' + r.need.toFixed(1) + ')  ' + r.pair.padEnd(22) + r.what)
}
console.log('')

for (const label of ok) console.log('  PASS  ' + label)
if (problems.length > 0) {
  console.log('')
  for (const p of problems) console.log('  FAIL  ' + p)
  console.log('\n' + problems.length + ' check(s) FAILED. Nothing written.')
  process.exit(1)
}
console.log('\n  ' + ok.length + ' / ' + ok.length + ' checks passed.')
if (!verifyOnly) {
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, html, 'utf8')
  const rel = out.startsWith(ROOT) ? out.slice(ROOT.length + 1).replace(/\\/g, '/') : out
  console.log('  wrote ' + rel + '  (' + html.length.toLocaleString('en-US') + ' bytes, ' + html.split('\n').length.toLocaleString('en-US') + ' lines)')
}
