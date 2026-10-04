import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ArtifactState, PhaseDef, PhaseState, RecursiveStatusResult } from './types.ts'

export const RUN_ARTIFACT_SEQUENCE = [
  '00-requirements.md',
  '00-worktree.md',
  '01-as-is.md',
  '01.5-root-cause.md',
  '02-to-be-plan.md',
  '03-implementation-summary.md',
  '03.5-code-review.md',
  '04-test-summary.md',
  '05-manual-qa.md',
  '06-decisions-update.md',
  '07-state-update.md',
  '08-memory-impact.md',
]

export const PHASES: PhaseDef[] = [
  { key: '00R', label: 'Phase 0 (Requirements)', file: '00-requirements.md', optional: false, phaseName: '0 (Requirements)' },
  { key: '00W', label: 'Phase 0 (Worktree)', file: '00-worktree.md', optional: false, phaseName: '0 (Worktree)' },
  { key: '01', label: 'Phase 1 (AS-IS)', file: '01-as-is.md', optional: false, phaseName: '1 (AS-IS)' },
  { key: '01.5', label: 'Phase 1.5 (Root Cause)', file: '01.5-root-cause.md', optional: true, phaseName: '1.5 (Root Cause)' },
  { key: '02', label: 'Phase 2 (TO-BE Plan)', file: '02-to-be-plan.md', optional: false, phaseName: '2 (TO-BE Plan)' },
  { key: '03', label: 'Phase 3 (Implementation)', file: '03-implementation-summary.md', optional: false, phaseName: '3 (Implementation)' },
  { key: '03.5', label: 'Phase 3.5 (Code Review)', file: '03.5-code-review.md', optional: true, phaseName: '3.5 (Code Review)' },
  { key: '04', label: 'Phase 4 (Test Summary)', file: '04-test-summary.md', optional: false, phaseName: '4 (Test Summary)' },
  { key: '05', label: 'Phase 5 (Manual QA)', file: '05-manual-qa.md', optional: false, phaseName: '5 (Manual QA)' },
  { key: '06', label: 'Phase 6 (Decisions)', file: '06-decisions-update.md', optional: false, phaseName: '6 (Decisions Update)' },
  { key: '07', label: 'Phase 7 (State)', file: '07-state-update.md', optional: false, phaseName: '7 (State Update)' },
  { key: '08', label: 'Phase 8 (Memory)', file: '08-memory-impact.md', optional: false, phaseName: '8 (Memory Impact)' },
]

const LOCK_HASH_LINE_RE = /^[ \t]*LockHash:.*(?:\n|$)/gm
const STRICT_WORKFLOW_PROFILES = new Set(['recursive-mode-audit-v1', 'recursive-mode-audit-v2'])
const AUDITED_PHASE_FILES = new Set([
  '01-as-is.md', '01.5-root-cause.md', '02-to-be-plan.md', '03-implementation-summary.md',
  '03.5-code-review.md', '04-test-summary.md', '06-decisions-update.md', '07-state-update.md', '08-memory-impact.md',
])
const CURRENT_WORKFLOW_PROFILE = 'recursive-mode-audit-v2'
const STRICT_WORKFLOW_PROFILE = 'recursive-mode-audit-v1'
const COMPAT_WORKFLOW_PROFILE = 'memory-phase8'
const LATE_PHASE_FILES = ['06-decisions-update.md', '07-state-update.md', '08-memory-impact.md']
const LATE_PHASE_KEYS = new Set(['06', '07', '08'])

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function trimMdValue(value: string): string {
  let trimmed = value.trim()
  for (const quote of ['`', '"', "'"]) {
    if (trimmed.startsWith(quote) && trimmed.endsWith(quote) && trimmed.length >= 2) {
      const inner = trimmed.slice(1, -1)
      if (!inner.includes(quote)) return inner.trim()
    }
  }
  return trimmed
}

export function getMdFieldValue(content: string, fieldName: string): string | null {
  const pattern = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${escapeRegExp(fieldName)}:[ \\t]*(.+?)\\s*$`, 'm')
  const match = pattern.exec(content)
  if (!match) return null
  return trimMdValue(match[1])
}

export function getGateStatus(content: string, gateName: string): string {
  const pattern = new RegExp(`^[ \\t]*${escapeRegExp(gateName)}:\\s*(PASS|FAIL)\\s*$`, 'm')
  const match = pattern.exec(content)
  return match ? match[1].toUpperCase() : 'MISSING'
}

export function getTodoStats(content: string): { hasTodo: boolean; total: number; checked: number; unchecked: number } {
  const lines = content.split(/\r?\n/)
  let inTodo = false
  let hasTodo = false
  let checked = 0
  let unchecked = 0
  let total = 0
  for (const line of lines) {
    if (!inTodo) {
      if (/^\s*##\s+TODO\s*$/.test(line)) { inTodo = true; hasTodo = true }
      continue
    }
    if (/^\s*##\s+/.test(line) || /^\s*#\s+/.test(line)) break
    const item = /^\s*[-*]\s+\[([ xX])\]\s+/.exec(line)
    if (item) {
      total += 1
      if (item[1].toLowerCase() === 'x') checked += 1
      else unchecked += 1
    }
  }
  return { hasTodo, total, checked, unchecked }
}

export function lockHashFromContent(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const stripped = normalized.replace(LOCK_HASH_LINE_RE, '')
  return createHash('sha256').update(stripped, 'utf8').digest('hex')
}

export function getWorkflowProfile(runDir: string): string {
  const requirementsPath = join(runDir, '00-requirements.md')
  try {
    const content = readFileSync(requirementsPath, 'utf8')
    const workflowVersion = getMdFieldValue(content, 'Workflow version')
    if (workflowVersion === CURRENT_WORKFLOW_PROFILE) return CURRENT_WORKFLOW_PROFILE
    if (workflowVersion === STRICT_WORKFLOW_PROFILE) return STRICT_WORKFLOW_PROFILE
    if (workflowVersion === COMPAT_WORKFLOW_PROFILE) return COMPAT_WORKFLOW_PROFILE
  } catch { /* fall through */ }
  if (LATE_PHASE_FILES.some(file => { try { statSync(join(runDir, file)); return true } catch { return false } })) return COMPAT_WORKFLOW_PROFILE
  return 'legacy'
}

export { getLatestRunDirectory, discoverRuns, resolveRunDir } from './run.ts'
export type { RunDiscoveryResult } from './run.ts'

export function getArtifactState(artifactPath: string, workflowProfile: string): ArtifactState {
  let content: string | null = null
  try { content = readFileSync(artifactPath, 'utf8') } catch { /* missing */ }
  if (content === null) {
    return { exists: false, status: 'PENDING', lockValid: false, lockProblems: ['File missing'], blockers: ['File missing'], lockedAt: null, storedHash: null, actualHash: null, coverage: 'MISSING', approval: 'MISSING', audit: 'MISSING', todoHasSection: false, todoUnchecked: 0 }
  }
  const status = getMdFieldValue(content, 'Status') ?? 'UNKNOWN'
  const todo = getTodoStats(content)
  const coverage = getGateStatus(content, 'Coverage')
  const approval = getGateStatus(content, 'Approval')
  const audit = getGateStatus(content, 'Audit')
  const tddCompliance = getGateStatus(content, 'TDD Compliance')
  const lockedAt = getMdFieldValue(content, 'LockedAt')
  const storedHash = getMdFieldValue(content, 'LockHash')
  let actualHash: string | null = null
  const lockProblems: string[] = []
  const blockers: string[] = []
  let lockValid = false
  const fileName = artifactPath.split(/[\\/]/).pop() ?? ''

  if (status !== 'LOCKED') {
    lockProblems.push(`Status is '${status}' (expected LOCKED for lock-valid)`)
  } else {
    if (!lockedAt) lockProblems.push('Missing LockedAt')
    if (!storedHash) lockProblems.push('Missing LockHash')
    if (storedHash) {
      actualHash = lockHashFromContent(content)
      if (storedHash.toLowerCase() !== actualHash.toLowerCase()) lockProblems.push('LockHash mismatch')
    }
    if (coverage !== 'PASS') lockProblems.push(`Coverage gate is ${coverage}`)
    if (approval !== 'PASS') lockProblems.push(`Approval gate is ${approval}`)
    if (STRICT_WORKFLOW_PROFILES.has(workflowProfile) && AUDITED_PHASE_FILES.has(fileName) && audit !== 'PASS') lockProblems.push(`Audit gate is ${audit}`)
    if (fileName === '03-implementation-summary.md' && tddCompliance !== 'PASS') lockProblems.push(`TDD Compliance gate is ${tddCompliance}`)
    if (!todo.hasTodo) lockProblems.push('Missing ## TODO section')
    else if (todo.unchecked > 0) lockProblems.push(`Unchecked TODO items: ${todo.unchecked}`)
    if (lockProblems.length === 0) lockValid = true
  }

  if (!todo.hasTodo) blockers.push('Missing ## TODO section')
  else if (todo.unchecked > 0) blockers.push(`Unchecked TODO items: ${todo.unchecked}`)
  if (coverage !== 'PASS') blockers.push(`Coverage gate is ${coverage}`)
  if (approval !== 'PASS') blockers.push(`Approval gate is ${approval}`)
  if (fileName === '03-implementation-summary.md' && tddCompliance !== 'PASS') blockers.push(`TDD Compliance gate is ${tddCompliance}`)

  const dedupedBlockers: string[] = []
  for (const blocker of blockers) if (!dedupedBlockers.includes(blocker)) dedupedBlockers.push(blocker)

  return { exists: true, status, lockValid, lockProblems, blockers: dedupedBlockers, lockedAt, storedHash, actualHash, coverage, approval, audit, todoHasSection: todo.hasTodo, todoUnchecked: todo.unchecked }
}

export function foldRun(runDir: string, runId: string): RecursiveStatusResult {
  const workflowProfile = getWorkflowProfile(runDir)
  const states = new Map<string, ArtifactState>()
  for (const phase of PHASES) {
    const state = getArtifactState(join(runDir, phase.file), workflowProfile)
    if (phase.optional && !state.exists) state.status = 'SKIPPED'
    else if (workflowProfile === 'legacy' && LATE_PHASE_KEYS.has(phase.key) && !state.exists) state.status = 'SKIPPED'
    states.set(phase.key, state)
  }
  let currentPhase: RecursiveStatusResult['currentPhase'] = null
  for (const phase of PHASES) {
    const state = states.get(phase.key)!
    if (state.status === 'SKIPPED') continue
    if (!state.exists || !state.lockValid) {
      currentPhase = { key: phase.key, label: phase.label, phaseName: phase.phaseName, status: state.status }
      break
    }
  }
  const phases: PhaseState[] = PHASES.map(phase => {
    const state = states.get(phase.key)!
    return { key: phase.key, label: phase.label, file: phase.file, optional: phase.optional, exists: state.exists, status: state.status, lockValid: state.lockValid, lockProblems: state.lockProblems, blockers: state.blockers }
  })
  return { runId, currentPhase, phases, workflowProfile }
}