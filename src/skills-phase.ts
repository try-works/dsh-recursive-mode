/**
 * T12 — register each phase's rules as a SKILL, so they are discoverable in the catalogue.
 *
 * WHY. Phase 8 writes skill memory to the filesystem, and a phase's rules otherwise live only in
 * this plugin's `phase-rules.ts` — reachable by grepping a checkout, not by the agent or a child
 * asking what a phase requires. The native `ctx.skills` registry is a *catalogue*: a skill it
 * holds is discoverable by name, addressable by `get()`, and visible to a discovery consumer.
 * Registering the phase rules there is what turns "the rules are in the source" into "the rules
 * are answerable".
 *
 * ⚠ THE REGISTRATION IS A RUNTIME CONTRIBUTION, and the harness names that source explicitly
 * (`SkillSource` includes `'runtime'`). Declaring `source: 'runtime'` is not decoration: it is how
 * the registry can tell this skill apart from one a checkout or a user directory supplied, and it
 * is what makes the plugin's contribution replaceable rather than tangled with the filesystem's.
 *
 * ⚠ AN ABSENT REGISTRY IS NOT A FAILURE. `ctx.skills` is an optional service; with none mounted
 * the helper does nothing and SAYS it did nothing (`skipped: true`) — the plugin's convention for
 * every optional seam, because a composition without a catalogue should still run the workflow.
 */
import { phaseRulesFor, type PhaseRules } from './phase-rules.ts'

/** The prefix every phase skill carries, so the plugin's contributions are recognisable. */
export const PHASE_SKILL_PREFIX = 'recursive-phase'

/**
 * One runtime skill contribution.
 *
 * Structural rather than imported from the harness: the plugin models every harness touchpoint as
 * a minimal seam, and this keeps the shape testable with a fake registry.
 */
export interface PhaseSkillRegistration {
  name: string
  description: string
  whenToUse?: string
  content: string
  /** A RUNTIME contribution — see the module comment for why this is declared, not implied. */
  source: 'runtime'
}

export interface SkillRegistryLike {
  register(registration: PhaseSkillRegistration): () => void
}

/**
 * The skill name for a phase file.
 *
 * Kebab-case, because the registry addresses skills by a kebab-case identifier — and STABLE,
 * because a discoverable rule nobody can name is not discoverable. `01.5-root-cause.md` becomes
 * `recursive-phase-01-5-root-cause`: the dot cannot survive, and dropping the sub-phase number
 * would collide it with a whole phase.
 */
export function phaseSkillName(fileName: string): string {
  const slug = fileName
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return PHASE_SKILL_PREFIX + '-' + slug
}

/** The markdown body a reader gets from the catalogue. */
function phaseSkillContent(rules: PhaseRules): string {
  const lines: string[] = []
  lines.push('# Phase rules: ' + rules.fileName)
  lines.push('')
  lines.push('This phase is ' + rules.label + '. Its required sections are checked by the linter,')
  lines.push('and a missing one is a lint failure — not a style preference.')
  lines.push('')
  lines.push('## Required sections')
  lines.push('')
  for (const section of rules.requiredSections) {
    lines.push('- ' + section)
  }
  if (rules.requiredSections.length === 0) {
    lines.push('- (none declared for this phase)')
  }
  lines.push('')
  lines.push('## Flags')
  lines.push('')
  lines.push('- audited: ' + (rules.audited ? 'yes — this phase needs a delegated audit' : 'no'))
  lines.push('- tdd: ' + (rules.tdd ? 'yes — the TDD Compliance gate applies' : 'no'))
  lines.push('- qa: ' + (rules.qa ? 'yes — the manual QA gate applies' : 'no'))
  return lines.join('\n')
}

/** Build the registration for one phase. Pure, so the mapping is testable without a registry. */
export function phaseSkillRegistration(rules: PhaseRules): PhaseSkillRegistration {
  const gates: string[] = []
  if (rules.audited) gates.push('audited')
  if (rules.tdd) gates.push('TDD')
  if (rules.qa) gates.push('QA')
  return {
    name: phaseSkillName(rules.fileName),
    description: 'Rules for ' + rules.fileName + ' (' + rules.label + '): its required sections and gates.',
    whenToUse: 'Use when authoring, linting or reviewing ' + rules.fileName
      + (gates.length === 0 ? '.' : ', which carries the ' + gates.join(' / ') + ' gate(s).'),
    content: phaseSkillContent(rules),
    source: 'runtime',
  }
}

export interface PhaseSkillRegistrationResult {
  /** Names registered, in phase order. */
  registered: string[]
  /** Disposers, so a caller can withdraw the contribution with its own effects. */
  disposers: Array<() => void>
  /** True when there was no registry: nothing was registered, and that is not an error. */
  skipped: boolean
}

/**
 * Register every phase's rules as a skill.
 *
 * Takes `fileNames` rather than reading a directory so the caller decides WHICH phases this
 * composition exposes; the rules themselves come from `phaseRulesFor`, so there is one definition
 * of what a phase requires and no second copy to drift.
 */
export function registerPhaseSkills(
  skills: SkillRegistryLike | null | undefined,
  fileNames: readonly string[],
  workflowProfile?: string,
): PhaseSkillRegistrationResult {
  if (skills === null || skills === undefined || typeof skills.register !== 'function') {
    return { registered: [], disposers: [], skipped: true }
  }
  const registered: string[] = []
  const disposers: Array<() => void> = []
  for (const fileName of fileNames) {
    const registration = phaseSkillRegistration(phaseRulesFor(fileName, workflowProfile))
    disposers.push(skills.register(registration))
    registered.push(registration.name)
  }
  return { registered, disposers, skipped: false }
}

/**
 * A board-facing line for the registration result — says SKIPPED out loud rather than leaving a
 * reader to infer a missing catalogue from an empty list.
 */
export function describePhaseSkills(result: PhaseSkillRegistrationResult): string {
  if (result.skipped) return 'phase rules were NOT registered as skills: no skill registry is mounted'
  return result.registered.length + ' phase rule skill(s) registered: ' + result.registered.join(', ')
}
