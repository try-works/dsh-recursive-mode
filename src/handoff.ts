/**
 * File-backed delegation handoff docs (Phase B R2, PROPOSAL 10.6): a
 * main-agent handoff.md plus per-child brief.md / reply.md / scratch.md. The
 * delegation prompt is reference-based (pointers, not full context), so the
 * child reads the files it needs rather than receiving a monolithic paste.
 *
 * Workspace-scoped (run 03 R1): every path resolves under the given root.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export interface HandoffInput {
  root: string
  runId: string
  delegationId: string
  role: string
  objective: string
  runDocRefs: string[]
  codeRefs: string[]
  auditQuestions: string[]
  requiredOutput: string
  decisionBasis: string
  constraints?: string[]
}

export interface ChildBriefInput {
  root: string
  runId: string
  delegationId: string
  childId: string
  slice: string
  replyContract?: string
}

function norm(repoRelative: string): string {
  return repoRelative.replace(/\\/g, '/').replace(/^\/+/, '')
}

function resolveUnderRoot(root: string, repoRelative: string): string {
  const normalized = norm(repoRelative)
  const rootAbs = resolve(root)
  const abs = resolve(rootAbs, normalized)
  const rootPrefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep
  if (abs !== rootAbs && !abs.startsWith(rootPrefix)) {
    throw new Error('Path escapes the workspace root: ' + repoRelative)
  }
  return abs
}

function subagentsDir(root: string, runId: string): string {
  return resolveUnderRoot(root, '.recursive/run/' + runId + '/subagents')
}

function bulletList(title: string, values: string[]): string[] {
  const lines: string[] = [title]
  if (!values.length) {
    lines.push('- none')
    return lines
  }
  for (const v of values) lines.push('- ' + String.fromCharCode(96) + norm(v) + String.fromCharCode(96))
  return lines
}

/** Main-agent handoff doc: the full delegation info for one delegation. */
export function createHandoff(input: HandoffInput): string {
  const { root, runId, delegationId, role, objective } = input
  const dir = join(subagentsDir(root, runId), delegationId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'handoff.md')

  const lines: string[] = [
    '# Delegation handoff: ' + delegationId,
    '',
    'Role: ' + role,
    'Objective: ' + objective,
    '',
    '## Run Document References',
    ...bulletList('', input.runDocRefs).slice(1),
    '',
    '## Code References (with line ranges where applicable)',
    ...bulletList('', input.codeRefs).slice(1),
    '',
    '## Audit Questions',
    ...(input.auditQuestions.length ? input.auditQuestions.map((q, i) => String(i + 1) + '. ' + q) : ['- none']),
    '',
    '## Required Output Shape',
    '',
    input.requiredOutput,
    '',
    '## Constraints',
    ...(input.constraints?.length ? input.constraints.map((c) => '- ' + c) : ['- none']),
    '',
    '## Delegation Decision Basis',
    '',
    input.decisionBasis,
    '',
  ]

  writeFileSync(path, lines.join('\n'), 'utf8')
  return path
}

/** Per-child brief: the receiving slice for one child. */
export function createChildBrief(input: ChildBriefInput): string {
  const { root, runId, delegationId, childId, slice } = input
  const dir = join(subagentsDir(root, runId), delegationId, 'child-' + childId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'brief.md')
  const rootNorm = resolve(root).replace(/\\/g, '/')

  const lines: string[] = [
    '# Child brief: ' + childId,
    '',
    'Delegation: ' + delegationId,
    'Reply file: ' + replyPath(input).replace(/\\/g, '/').replace(rootNorm + '/', ''),
    '',
    '## Your Slice',
    '',
    slice,
    '',
    '## Reply Contract',
    '',
    input.replyContract ?? 'Write your submission to reply.md, then call the report tool citing reply.md.',
    '',
  ]

  writeFileSync(path, lines.join('\n'), 'utf8')
  return path
}

/** Reply path the child must write its submission to. */
export function replyPath(input: { root: string; runId: string; delegationId: string; childId: string }): string {
  const { root, runId, delegationId, childId } = input
  return join(subagentsDir(root, runId), delegationId, 'child-' + childId, 'reply.md')
}

/**
 * ⚠ FU-17 — THE WORK BRIEF'S SLICE: what a child is told when it is delegated the phase's ACTUAL WORK rather
 * than a review of it.
 *
 * WHY THIS IS SEPARATE FROM THE REVIEWER'S SLICE, and the reason is not tidiness. A reviewer is told what to
 * look FOR — anti-patterns, a verdict vocabulary, "do not be satisfied by prose". A worker must be told what to
 * PRODUCE, and above all **the standard its output will be judged against**, because the phase artifact is
 * linted for required sections and a child that was never told them cannot meet them. That standard already
 * exists in one place (`getArtifactRequiredSections`), so this composes it rather than restating it — a second
 * copy would drift from the linter, which is the defect this project has fixed more than once.
 *
 * ⚠ IT ALSO TELLS THE CHILD WHO DECIDES. The main agent verifies and records what it accepted
 * (`## Subagent Contribution Verification`: reviewed action records, main-agent verification performed, an
 * acceptance decision, refresh handling, repair performed). Saying so up front is not politeness: a child that
 * believes its own output is final writes a different, worse submission than one that knows a parent will
 * check it against named sections.
 */
export function buildWorkSlice(input: {
  /** The main agent's task for this child, verbatim. */
  instruction: string
  /** The run-relative artifact the work contributes to, e.g. `03-implementation-summary.md`. */
  artifactFile: string
  /** The phase key, for the brief's own traceability back to the run. */
  phase: string
  /** Required sections for that artifact — pass `getArtifactRequiredSections(artifactFile, profile)`. */
  requiredSections: readonly string[]
  /** Optional: the phase's lint rules, so the child sees the gate fields too. */
  lintNotes?: readonly string[]
}): string {
  const sections = input.requiredSections.length > 0
    ? input.requiredSections.map((section) => '- ' + section).join('\n')
    : '- (no section map for this artifact — follow the existing artifact\'s own shape)'
  const lines: string[] = [
    'You are doing the WORK for phase `' + input.phase + '`, not reviewing it.',
    '',
    '## Your Task',
    '',
    input.instruction.trim(),
    '',
    '## What You Are Contributing To',
    '',
    '`' + input.artifactFile + '` — the phase artifact. Write the content INTO your `reply.md` submission; the',
    'main agent is the author of record for the artifact itself and will place your work there.',
    '',
    '## The Standard It Will Be Judged Against',
    '',
    'The artifact must contain these sections. Yours must supply the ones your task touches, in this vocabulary:',
    '',
    sections,
    '',
    '## How This Will Be Checked',
    '',
    'An INDEPENDENT reviewer and the MAIN agent both judge your submission against the sections above. If it falls',
    'short, feedback comes back to YOU — the same child — so state your assumptions and your evidence plainly',
    'rather than leaving a gap someone else has to guess at.',
  ]
  if (input.lintNotes !== undefined && input.lintNotes.length > 0) {
    lines.push('', '## Phase Gates', '', input.lintNotes.map((note) => '- ' + note).join('\n'))
  }
  return lines.join('\n')
}

/** Child-scoped disposable scratch (Phase B R5, PROPOSAL 10.7). */
export function childScratchPath(input: { root: string; runId: string; childId: string }): string {
  const { root, runId, childId } = input
  return resolveUnderRoot(root, '.recursive/run/' + runId + '/scratch/' + childId + '.md')
}

/**
 * Build the reference-based delegation prompt (PROPOSAL 10.6): a pointer to
 * handoff.md + brief.md, instructions to write reply.md and call report citing
 * it. Short, not a monolithic paste.
 */
export function buildDelegationPrompt(input: { root: string; runId: string; delegationId: string; childId: string; handoffPath: string; briefPath: string }): string {
  const { root, runId, delegationId, childId, handoffPath, briefPath } = input
  const rootNorm = resolve(root).replace(/\\/g, '/')
  const handoffRel = norm(handoffPath).replace(rootNorm + '/', '')
  const briefRel = norm(briefPath).replace(rootNorm + '/', '')
  const replyRel = norm(replyPath(input)).replace(rootNorm + '/', '')
  return [
    'You are a delegated worker for recursive-mode delegation ' + delegationId + ' (child ' + childId + ').',
    '',
    '1. Read the full delegation handoff: ' + handoffRel,
    '2. Read your receiving slice: ' + briefRel,
    '3. Do the work described in your slice, reading the referenced run docs and code files as needed.',
    '4. Write your complete submission to: ' + replyRel,
    '5. Call the report tool citing ' + replyRel + ' and include your verdict, findings, and every reference you used.',
    '',
    'Do not modify files outside your child scratch and reply.md unless the handoff explicitly authorizes it.',
  ].join('\n')
}
