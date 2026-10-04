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
