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
}

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

function tagList(p) {
  const t = []
  if (p.human) t.push('<span class="tag tag-human">human gate</span>')
  if (p.late) t.push(`<span class="tag tag-late">late phase</span>`)
  if (p.audited) t.push('<span class="tag tag-audited">audited</span>')
  if (p.optional) t.push('<span class="tag tag-optional">optional</span>')
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
  // The diagram is CHARTED before the page is built, because the chart tells the
  // stylesheet how wide it is (`--dg-w`): the SVG then keeps its own coordinate
  // system at every viewport and the wrapper scrolls instead of squeezing it.
  const dg = diagram()

  const tabs = [
    { id: 'overview', label: 'Overview', sub: 'whole flow' },
    { id: 'start', label: 'Phase 0', sub: 'the human gate' },
    ...PHASES.map((p) => ({ id: 'phase-' + p.file.replace(/[^a-z0-9]+/gi, '-'), label: p.file.replace(/\.md$/, ''), sub: 'phase ' + p.phaseN })),
    { id: 'hooks', label: 'Hooks & seams', sub: 'where it attaches' },
    { id: 'guards', label: 'Guards & refusals', sub: 'what says no' },
    { id: 'loops', label: 'Backward loops', sub: 'REVISE / repair' },
    { id: 'closeout', label: 'Closeout & receipts', sub: 'the chain' },
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
/* The diagram's own width, decided by the generator's diagram() and consumed by
   .diagram svg below: the chart keeps its coordinate system and the wrapper scrolls. */
:root{ --dg-w:${dg.width}px; --dg-h:${dg.height}px; }
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
.tag-optional{ border-style:dashed; }
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
.sw-late{ background:var(--n-800); border-color:var(--violet); border-style:dashed; }

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
   THE DIAGRAM IS AN SVG IN AN EXPLICIT SET OF BANDS, and the two custom properties
   in this rule are the interface to it: --dg-w is the width the chart laid itself
   out for and --dg-h its height, both written by the generator (see diagram()), so
   the svg keeps its OWN coordinate system and its text stays at its declared size
   instead of being scaled by whatever box it lands in. Below --dg-w the wrapper
   SCROLLS HORIZONTALLY — one strip, exactly the mechanism the tab strip already
   uses at every width — so a narrow viewport never squeezes the chart, and nothing
   inside it can be painted outside the box that holds it. */
.diagram{ border:1px solid var(--line); border-radius:var(--r-2); background:var(--n-950); padding:var(--sp-4); overflow-x:auto; overscroll-behavior-inline:contain; scrollbar-width:thin; scrollbar-color:var(--n-600) transparent; }
.diagram svg{ display:block; width:var(--dg-w); min-width:var(--dg-w); height:auto; }
.dg-box-strip{ fill:none; stroke:var(--n-600); stroke-width:1; stroke-dasharray:3 3; }
.dg-box{ fill:var(--n-850); stroke:var(--n-500); stroke-width:1; }
.dg-box-human{ fill:var(--warn-ink); stroke:var(--warn); }
.dg-box-refuse{ fill:var(--danger-ink); stroke:var(--danger); }
/* Text styles for the diagram, EMITTED FROM DG_TEXT so the size the boxes were
   computed at and the size the glyphs are drawn at are the same number. The checker
   re-reads these four declarations and re-derives the fit from them. */
${Object.entries(DG_TEXT).map(([k, v]) => `.${k}{ fill:${v.fill}; font-family:var(--mono); font-size:${v.size}px; }`).join('\n')}
.dg-line{ stroke:var(--n-500); stroke-width:1; fill:none; }
.dg-line-acc{ stroke:var(--accent); stroke-width:1; fill:none; }
.dg-line-warn{ stroke:var(--warn); stroke-width:1; fill:none; }
.dg-line-loop{ stroke:var(--violet); stroke-width:1; fill:none; stroke-dasharray:4 3; }
.dg-head{ fill:var(--n-500); }
.dg-head-acc{ fill:var(--accent); }
.dg-head-warn{ fill:var(--warn); }
.dg-head-loop{ fill:var(--violet); }

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
      <p class="mast-sub">Twelve phase artifacts, five DSH lifecycle seams, two hook points that can actually refuse, three human gates, and a lock chain with seven refusals. Every factual block below carries the <code>file:line</code> it was transcribed from.</p>
    </div>
  </div>
  <div class="mast-meta">
    <span class="chip chip-acc"><b>12</b> phase artifacts</span>
    <span class="chip"><b>13</b> tools (12 without agentTeams)</span>
    <span class="chip"><b>8</b> guard rules</span>
    <span class="chip chip-warn"><b>3</b> human gates + run-start</span>
    <span class="chip"><b>5</b> hook points</span>
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

<!-- ===================== OVERVIEW ===================== -->
<section class="panel is-active" id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" tabindex="0">
  <div class="panel-head">
    <h2>The flow, end to end</h2>
    <p class="lede">Read top to bottom. Each card is one artifact on disk; the left rail is the sequence; the <span style="color:var(--violet)">violet</span> links are the places the flow legitimately runs BACKWARDS. ${cite(SRC.seq)}</p>
  </div>

  <div class="legend">
    <div><span class="swatch sw-auto"></span> automatic step</div>
    <div><span class="swatch sw-human"></span> DECISION — a human must answer</div>
    <div><span class="swatch sw-refuse"></span> REFUSAL — the call is stopped</div>
    <div><span class="swatch sw-loop"></span> backward edge</div>
    <div><span class="swatch sw-late"></span> late phase (dashed = optional phase)</div>
  </div>

  <div class="callout">
    <strong>Reading the shapes, not the colours.</strong> Every gate below carries a word — <b>DECISION</b>, <b>REFUSAL</b> or <b>AUTO</b> — and a border treatment, so nothing here depends on colour alone. The human steps are also the only cards with a filled amber rail dot. Layout follows the workflow, not a hardware pipeline: this is a gated process with decision points, so the diagram is a vertical sequence with side rails, not a data bus.
  </div>

  ${dg.markup}

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

  <h2 style="font-size:var(--fs-lg);margin:var(--sp-8) 0 var(--sp-4)">The late phases</h2>
  <p class="lede" style="margin-bottom:var(--sp-4)"><code>LATE_PHASE_ARTIFACTS</code> is a three-member set declared separately from the sequence, and it is what the cold-face of the workflow leans on: by phase 6 the implementation is FROZEN and these three phases document rather than change. ${cite(LATE.c)}</p>
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
        ${TOOLS.map((t, i) => `<tr><td><span class="seq">${i + 1}</span></td><td><code>${esc(t.n)}</code>${t.reg === 'conditional' ? '<br><span class="tag tag-optional">conditional</span>' : ''}</td><td>${esc(t.p)}${t.note ? `<br><span class="note" style="display:block;margin-top:var(--sp-2)">${t.note}</span>` : ''}</td><td>${cite(t.c)}</td></tr>`).join('')}
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
        <tr><td>The tab count equals 1 overview + 12 phases + 8 other views</td><td>the generated HTML itself</td></tr>
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
    <li><span class="g-shape g-shape-refuse">UNVERIFIED</span><span><b>The rendered pixels.</b> No browser was available to this generator, so the visual result — the contrast as actually rendered, wrapping at 700 px, sticky-tab behaviour, the appearance of the focus ring, whether the diagram's labels collide at some width — is NOT confirmed. The CSS is written to stated rules and its colours are measured, but it has not been SEEN. Treat every layout claim on this page as a design intent, not an observation.</span></li>
    <li><span class="g-shape g-shape-refuse">UNVERIFIED</span><span><b>Keyboard and screen-reader behaviour.</b> The tablist's roles, <code>aria-selected</code>, roving tabindex and <code>aria-controls</code> targets are asserted against the markup, and the arrow-key handler is present in the source — but no browser and no assistive technology ran this page, so "the arrow keys work" and "the tab order reads correctly" are NOT demonstrated here.</span></li>
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

function diagram() {
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
      const nested = holds(o, b) || holds(b, o)
      if (nested) {
        // Declared in [contained, container] order, whichever way round it is: a box
        // that already holds this one (the label drawn before its card, the strip's own
        // children) makes this box the contained one.
        contains.push(holds(o, b) ? [boxes.length, i] : [i, boxes.length])
        continue
      }
      if (inside !== undefined && i === inside && (kind === 'rule' || kind === 'ink')) {
        // A rule or an arrowhead sharing an index with the rule it joins: the arc's
        // corner. Declared with the neighbour as the container, so the exemption is a
        // fact in the manifest and not a hole in the check.
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

  /* ---- BAND 1: the title ----------------------------------------------- */
  let y = 0
  textEl(GUTTER, y, CLS.a, 'THE WORKFLOW, CHARTED — every band below reserves its space before it is drawn')
  y += lh(FS[CLS.a]) + 12

  /* ---- BAND 2: three columns, three x-ranges, side by side ---------------
     The three used to share one x-range AND one y-range. Now each owns a column
     and the sequence strip is the only thing that can be wide. */
  const midTop = y
  let midBottom = y

  /* column 1 — the phase-0 gate. The card ENDS WHERE THE NEXT BAND STARTS: this
     card used to run to y=84 with the strip heading drawn across it at y=88. */
  const col1 = GUTTER
  const cardW = Math.ceil(Math.max(
    tw('recursive_ask gate=run-start', FS[CLS.h]),
    tw('labels:  Start run  |  Hold', FS[CLS.s]),
  ) + 2 * PAD + 4)
  const cardH = 46
  const gateCard = card(col1, midTop, cardW, cardH, 'dg-box dg-box-human', 'phase-0 gate card')
  textEl(col1 + PAD, midTop + 7, CLS.h, 'recursive_ask gate=run-start', gateCard)
  textEl(col1 + PAD, midTop + 7 + lh(FS[CLS.h]) + 2, CLS.s, 'labels:  Start run  |  Hold', gateCard)
  midBottom = Math.max(midBottom, para(col1, midTop + cardH + 8, cardW, CLS.s,
    'refuses to ASK until 00-requirements.md is filled (RM4404). No approval means syncRunGoal creates no goal, so nothing runs.'))

  /* column 2 — the twelve artifacts, as ONE strip. It is laid out at its natural
     width and the WRAPPER scrolls (see `.diagram`), exactly as the tab strip does,
     so a label is never squeezed and two labels are never in the same box.
     NODE_W IS DERIVED FROM THE LONGEST LABEL, never chosen: 03-implementation-summary
     is 25 characters and needs 165 units at the declared metric, so a hand-picked
     126-unit node — which is what the old chart had, at 62 — would have clipped it
     again. The engine refuses the build rather than let that through. */
  const stripLabels = PHASES.map((p) => p.file.replace(/\.md$/, ''))
  const NODE_GAP = 6
  const NODE_W = Math.ceil(Math.max(...stripLabels.map((s) => tw(s, FS[CLS.t]))) + 2 * PAD + 4)
  const NODE_H = 44
  const STRIP_PAD = 10
  const stripW = PHASES.length * NODE_W + (PHASES.length - 1) * NODE_GAP + 2 * STRIP_PAD
  const stripH = 18 + lh(FS[CLS.a]) + 10 + NODE_H
  const stripX = col1 + cardW + 44
  const strip = card(stripX, midTop, stripW, stripH, 'dg-box-strip', 'the twelve-artifact strip')
  textEl(stripX + STRIP_PAD, midTop + 8, CLS.a, 'THE TWELVE PHASE ARTIFACTS — PHASE_SEQUENCE, index 0 → 11', strip)
  const nodesTop = midTop + 18 + lh(FS[CLS.a]) + 10
  PHASES.forEach((p, i) => {
    const nx = stripX + STRIP_PAD + i * (NODE_W + NODE_GAP)
    const node = card(nx, nodesTop, NODE_W, NODE_H, p.human ? 'dg-box dg-box-human' : 'dg-box', 'node ' + p.file)
    // The FULL artifact name minus its extension: every one of the twelve fits its
    // node, and the name is the string the rest of the page cites. (The old chart
    // sliced this to nine characters, which is where "00-requir" came from.)
    textEl(nx + PAD, nodesTop + 7, CLS.t, stripLabels[i], node)
    textEl(nx + PAD, nodesTop + 7 + lh(FS[CLS.t]) + 1, CLS.s, 'phase ' + p.phaseN, node)
  })
  midBottom = Math.max(midBottom, nodesTop + NODE_H)

  /* column 3 — the hook channel, in its OWN column, right of the strip. It used to
     start at x=668 while the strip ran to x=900: the grey panel sliced the amber
     one, and the strip's last four labels were painted inside these cards. */
  const col3 = stripX + stripW + 44
  textEl(col3, midTop, CLS.a, 'HOOK CHANNEL — pre_trigger (gating)')
  const hookW = Math.ceil(Math.max(
    tw('phase-order | locked | lock-order | tdd', FS[CLS.s]),
    tw('denies exit_plan_mode while a phase waits', FS[CLS.s]),
    tw('exit-plan-mode-gate   prio 5', FS[CLS.t]),
  ) + 2 * PAD + 4)
  const hookH = 44
  let hy = midTop + lh(FS[CLS.a]) + 6
  const hook1 = card(col3, hy, hookW, hookH, 'dg-box', 'hook: exit-plan-mode-gate')
  textEl(col3 + PAD, hy + 7, CLS.t, 'exit-plan-mode-gate   prio 5', hook1)
  textEl(col3 + PAD, hy + 7 + lh(FS[CLS.t]) + 1, CLS.s, 'denies exit_plan_mode while a phase waits', hook1)
  hy += hookH + 8
  const hook2 = card(col3, hy, hookW, hookH, 'dg-box', 'hook: builtin-tool-guard')
  textEl(col3 + PAD, hy + 7, CLS.t, 'builtin-tool-guard   prio 0', hook2)
  textEl(col3 + PAD, hy + 7 + lh(FS[CLS.t]) + 1, CLS.s, 'phase-order | locked | lock-order | tdd', hook2)
  hy += hookH + 10
  midBottom = Math.max(midBottom, para(col3, hy, hookW, CLS.s,
    'The first decisive hook short-circuits. Observe-only points are downgraded, not obeyed.'))

  y = midBottom + 22

  /* ---- BAND 3: the lock chain, one row, then its note ------------------ */
  textEl(GUTTER, y, CLS.a, 'recursive_lock — the chain, in checks order')
  y += lh(FS[CLS.a]) + 8
  const LOCK = [
    ['1 lock order', false], ['2 quiescence', false], ['3 phase-8 memory', true],
    ['4 lint standard', false], ['5 hash + receipt', false],
  ]
  const lockW = 128, lockH = 32, lockGap = 8
  LOCK.forEach(([label, refuse], i) => {
    const lx = GUTTER + i * (lockW + lockGap)
    const step = card(lx, y, lockW, lockH, refuse ? 'dg-box dg-box-refuse' : 'dg-box', 'lock step ' + label)
    textEl(lx + PAD, y + 9, CLS.s, label, step)
    if (i > 0) ruleH(lx - lockGap, y + lockH / 2, lockGap, 'dg-line-acc', 'lock link ' + i)
  })
  y += lockH + 10
  y = para(GUTTER, y, 460, CLS.s,
    'Ordering is FIRST and the linter is LAST: a run that is both out of order and below standard reports ORDERING.')

  /* ---- BAND 4: the backward edge. The arc owns the GUTTER; its label and the
     prose own reserved rows to the right of it. They are never in the same band —
     which is exactly what the old chart did, printing REVISE across a sentence. */
  y += 22
  const backTop = y
  textEl(GUTTER, backTop, CLS.s, 'BACKWARD EDGE — a REVISE verdict or a reopen sends work BACK, not forward')
  let by = backTop + lh(FS[CLS.s]) + 6
  by = para(GUTTER, by, 560, CLS.s,
    'A REVISE verdict or a reopen sends work back to repair: REVISE returns the follow-up to the SAME child, and a reopen invalidates the downstream receipts.')
  by = para(GUTTER, by, 560, CLS.s,
    'nextLegalPhase returns null — NOT the next node — when the first unlocked node has an unlocked prerequisite. With a back-edge, "continue" and "blocked" are different answers, and only null is correct.')
  const arcTop = backTop + 4
  const arcBottom = by - 6
  const riser = ruleV(14, arcTop + 8, arcBottom - arcTop - 8, 'dg-line-loop', 'backward-edge riser')
  // The run starts AT the riser (same corner, same path) — the one place two rules may
  // touch by their 2.5-unit stroke padding, and it is declared here rather than excused
  // by widening the tolerance: the arc is still made of reserved boxes.
  ruleH(14, arcBottom, GUTTER - 20, 'dg-line-loop', 'backward-edge run', riser)
  head([[14, arcTop], [10, arcTop + 8], [18, arcTop + 8]], 'dg-head-loop', 'backward-edge arrowhead', riser)
  y = by + 22

  /* ---- BAND 5: the footer legend -------------------------------------- */
  textEl(GUTTER, y, CLS.s, 'DECISION = amber box, filled rail dot  ·  REFUSAL = hatched  ·  everything else: AUTO')
  y += lh(FS[CLS.s]) + 6
  textEl(GUTTER, y, CLS.s, 'Every element above reserved its box first: the generator REFUSES to emit the chart when two of them intersect.')
  y += lh(FS[CLS.s])

  const W = Math.ceil(Math.max(
    col3 + hookW + 24,
    stripX + stripW + 24,
    GUTTER + 460 + 24,
    GUTTER + 560 + 24,
  ))
  const H = Math.ceil(y + 16)

  /* ---- the manifest, shipped inside the markup -------------------------
     The reserved boxes ARE the invariant, so they leave the generator with the page:
     `check-workflow-map.mjs` re-reads them from this attribute and re-verifies the
     geometry — including that no two boxes intersect — by parsing the markup rather
     than by looking at it. `charW` and `lineHeight` ship with them so the arithmetic
     is auditable instead of implied, and an independent headless pass can compare the
     reserved boxes against what a real layout engine actually renders. */
  const manifest = {
    v: 1,
    charW: CHAR_W,
    lineHeight: TEXT_LH,
    viewBox: [0, 0, W, H],
    fit: boxes.filter((b) => b.kind === 'text').map((b) => [b.label, b.x, b.y, b.w, b.h]),
    boxes: boxes.map((b) => [b.kind, b.x, b.y, b.w, b.h, b.label]),
    // The declared overlaps, by index pair: [inside, container]. A box that CONTAINS
    // another is an overlap by construction, so the relation is exported rather than
    // left for the checker to re-infer — an inferred exception is not a checked one.
    contains,
  }

  return {
    width: W,
    height: H,
    markup: `
  <div class="diagram" role="img" aria-label="Overview diagram: the Phase 0 human gate, the twelve-artifact sequence as one horizontally scrollable strip, the two gating hooks in their own column, the lock chain, and the backward edge drawn in its own band. The same information is given as text in the sequence below." data-layout="${esc(JSON.stringify(manifest)).replace(/\n/g, ' ')}">
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMinYMin meet">
${svgParts.map((s) => '      ' + s).join('\n')}
    </svg>
  </div>`,
  }
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
  check('tab count == 1 overview + 12 phases + 8 other views', tabIds.length, 21)
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
