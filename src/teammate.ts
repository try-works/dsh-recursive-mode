/**
 * ⚠ DECISION: EVERY DELEGATED CHILD IS A ROSTERED TEAMMATE (see `decisions/DECISION-teammate-delegation.md`,
 * which SUPERSEDES the "wrap the primitive" half of `ADR-delegation-surface.md`).
 *
 * WHAT CHANGED AND WHY IT IS FEASIBLE. `TeamService` is a LAYER over the very service this plugin used directly:
 * `spawnTeammate` internally starts a continuable child through the host's activation API — as of DSH 0.2.1-rc.2
 * that is `ctx.subagents.startActivation({ delivery: 'parent', childId, provider, label, request: { prompt,
 * parent }, signal })` (`agent-team/src/roster.ts`, `spawnAdmitted`; it was `startContinuable` on 0.2.0) — so a
 * teammate IS a continuable child. Its
 * durable roster id is a `SessionId`, follow-ups reach it through the same host steer path
 * (`mailbox.ts` → `steerHostSubagentPrompt`), and its settlement arrives as the harness's own
 * `source.kind === 'subagent-settled'` notice — the exact shape `src/settlement.ts` already recognises. Nothing
 * about the repair loop is given up by going through the roster; what is GAINED is that every child this plugin
 * starts is visible on the team board and attributable to a named, durable member.
 *
 * WHAT THIS MODULE OWNS, and what it deliberately does not:
 *   • the STRUCTURAL seam (`TeammateRosterLike`) the live `ctx.agentTeams` satisfies without an adapter, so the
 *     whole dispatch path is unit-testable with a fake — the same posture `teams-loop.ts` takes;
 *   • the LIVE-CALLER GATE. Every team method authorizes by EXACT object identity
 *     (`roster.ts`: `if (this.ctx.agents.get(agent.id) !== agent) return undefined`), so the caller handed to it
 *     must be the live Agent from `exec.agent`, never a `{ id }` copy. This plugin has been bitten by that
 *     before, so the gate is one function rather than a condition repeated at each call site;
 *   • the DETERMINISTIC NAME and its durable record, which is what lets a later round resume the SAME teammate
 *     instead of spawning a second one;
 *   • the FAIL-CLOSED error vocabulary: a roster limit or a taken name is reported by NAME, with what to do, and
 *     it NEVER falls back to an unrecorded child.
 *
 * ⚠ THE LIMIT OF THE FLAT ROSTER, STATED RATHER THAN DISCOVERED LATER. A teammate cannot spawn teammates:
 * `tryMembership` returns undefined for any agent carrying a subagent descriptor (`roster.ts`, the
 * `subagentDescriptor` branches), and `spawn` throws `TEAM_LEAD_REQUIRED` for a non-Lead caller. So
 * `maxDelegationDepth: 2` — "a child may delegate once more" — does NOT survive for a roster child: a teammate's
 * children can only be ordinary `subagents` children, which is precisely the unrecorded shape this decision
 * removes. The depth budget therefore bounds children that go through THIS module (the depth is still computed and
 * still passed down), but a delegated child cannot itself start a rostered delegation. That is a property of the
 * harness roster, not a choice made here, and it is recorded so a reader does not infer nested rosters from the
 * depth cap.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Minimal cancellation shape (a live AbortSignal satisfies it). */
export interface TeamSignalLike {
  readonly throwIfAborted: () => void
}

/** One content block as the team service takes it (text is all this plugin sends). */
export interface TeamContentBlockLike {
  readonly type: 'text'
  readonly text: string
}

/** The roster row's fields this module reads (`TeamMemberView` in the live service). */
export interface TeamMemberViewLike {
  readonly id: string
  readonly name: string
  readonly role?: string
  readonly status?: string
}

/** The membership answer `tryMembership` gives (`TeamMembership` in the live service). */
export interface TeamMembershipLike {
  readonly role: 'lead' | 'teammate'
  readonly name: string
  readonly id?: string
}

/** `SpawnTeammateRequest` — note there is NO `childId`: the roster generates one (see {@link teammateNameFor}). */
export interface SpawnTeammateRequestLike {
  readonly name: string
  readonly description: string
  readonly prompt: readonly TeamContentBlockLike[]
  readonly context: 'fresh' | 'fork'
  readonly provider: string
  readonly signal: TeamSignalLike
}

/** `SpawnTeammateResult`. */
export interface SpawnTeammateResultLike {
  readonly member: TeamMemberViewLike
}

/** `SendTeamMessageRequest` — `signal` is REQUIRED by the live service. */
export interface SendTeamMessageRequestLike {
  readonly target: string
  readonly content: readonly TeamContentBlockLike[]
  readonly signal: TeamSignalLike
}

/** `SendTeamMessageResult`. */
export interface SendTeamMessageResultLike {
  readonly messageId: string
  readonly status: 'accepted' | 'queued'
}

/**
 * The `agentTeams` seam this module calls.
 *
 * ⚠ THE METHODS ARE OPTIONAL ON THE SEAM AND CHECKED AS A GROUP, because a composition can mount a DIFFERENT
 * `agentTeams`-shaped service (or none at all), and the honest answer then is "there is no roster dispatch
 * available" — which keeps the primitive path exactly as it is. `spawnTeammate`/`sendMessage`/`tryMembership` are
 * the three this module cannot work without; `listMembers` is optional and only widens reuse.
 */
export interface TeammateRosterLike {
  tryMembership?(agent: unknown): TeamMembershipLike | undefined
  listMembers?(agent: unknown): TeamMemberViewLike[]
  spawnTeammate?(caller: unknown, request: SpawnTeammateRequestLike): Promise<SpawnTeammateResultLike>
  sendMessage?(caller: unknown, request: SendTeamMessageRequestLike): Promise<SendTeamMessageResultLike>
}

/** A fresh signal for one roster call. Both `spawnTeammate` and `sendMessage` REQUIRE one. */
export function teamCallSignal(): TeamSignalLike {
  return new AbortController().signal
}

/**
 * Is this caller the LEAD of its team, resolved from the EXACT LIVE Agent?
 *
 * ⚠ THE IDENTITY RULE, AND WHY IT IS ONE FUNCTION. `TeamRoster.tryMembership` opens with
 * `if (this.ctx.agents.get(agent.id) !== agent) return undefined`, so a structural `{ id }` copy — the shape a
 * plugin is tempted to build when it only has an id — is not merely unauthenticated, it is INVISIBLE: the roster
 * answers "not a member" for the very caller that owns the team. Every call site must therefore pass the live
 * Agent straight through. There is exactly one gate here, so there is one place to get it wrong.
 *
 * A seam that throws is treated as "not the Lead" rather than propagated: this decides WHICH dispatch path to
 * take, and a probe must never fail a delegation that the primitive path could still serve.
 */
export function isTeamLeadCaller(teams: TeammateRosterLike | undefined | null, caller: unknown): boolean {
  if (teams === undefined || teams === null || caller === undefined || caller === null) return false
  if (typeof teams.tryMembership !== 'function') return false
  try {
    return teams.tryMembership(caller)?.role === 'lead'
  } catch {
    return false
  }
}

/**
 * Can this seam dispatch a roster child at all — i.e. is the caller the Lead AND are both team methods present?
 *
 * This is the single condition under which the roster path is taken. Absent it the plugin MUST keep the
 * `subagents.startContinuable` path byte for byte (it is live-verified: a review settles in three calls with one
 * repair delivery), which is why this gate lives in one place rather than being re-derived.
 */
export function canRosterDispatch(teams: TeammateRosterLike | undefined | null, caller: unknown): boolean {
  if (teams === undefined || teams === null) return false
  if (typeof teams.spawnTeammate !== 'function' || typeof teams.sendMessage !== 'function') return false
  return isTeamLeadCaller(teams, caller)
}

/**
 * The model-facing teammate name for one delegated child, derived from identity rather than guessed.
 *
 * THE NAME IS THE RESUME KEY, so it has to be deterministic: the roster addresses children BY NAME
 * (`SendTeamMessageRequest.target`), and a teammate name is NEVER REUSED within a team
 * (`TEAM_MEMBER_NAME_TAKEN`). Deriving the name from `(runId, delegationId, role)` gives both properties at once:
 * the same delegation+role always maps to the same member — so a later round resumes the SAME child — while a
 * different run, delegation or role maps to a different member instead of colliding with the first one's name.
 *
 * Shape constraints come from `roster.ts` `memberName()`: lower-kebab `^[a-z0-9]+(?:-[a-z0-9]+)*$`, at most 64
 * characters, and never `lead`. The 8-hex digest suffix is what guarantees the last two: it is the disambiguator
 * for inputs that slug to the same prefix, and it means the name can never BE `lead`. The visible prefix is kept
 * (prefix `rm-`, then the delegation and role slugs) because a person reading the team board has to recognise
 * which phase and role a member is working on without decoding a hash.
 *
 * `runId` is in the DIGEST and not the visible prefix: it makes two runs that reuse a delegation id distinct
 * without making every name unreadably long.
 */
export function teammateNameFor(runId: string, delegationId: string, role: string): string {
  const slug = (value: string): string => value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const digest = createHash('sha256')
    .update(runId + '\u0000' + delegationId + '\u0000' + role, 'utf8')
    .digest('hex')
    .slice(0, 8)
  const suffix = '-' + digest
  const base = ('rm-' + slug(delegationId) + '-' + slug(role)).replace(/-+/g, '-').replace(/-+$/, '')
  const max = 64 - suffix.length
  const trimmed = base.length > max ? base.slice(0, max).replace(/-+$/, '') : base
  // `trimmed` is non-empty for any input: it always starts with "rm-", which is never all hyphens.
  return trimmed + suffix
}

/** One rostered child, as this plugin records it (the durable half of the name mapping). */
export interface TeammateEntry {
  /** The delegation whose child this is, e.g. `03-review`. */
  delegationId: string
  /** The role the child was dispatched for, e.g. `code-reviewer`. */
  role: string
  /** The model-facing roster name — the address a follow-up must use. */
  name: string
  /** The child's durable roster id, LEARNED from `spawnTeammate` (the request cannot carry it). */
  childId: string
  /** When the dispatch happened (ISO). */
  at: string
  /** True when this entry was recovered from the live roster rather than written by a spawn. */
  recovered?: true
}

interface TeammateRegistryFile {
  version: 1
  teammates: TeammateEntry[]
}

/** Where the (delegation, role) → teammate mapping lives, beside the run's other delegation state. */
export function teammateRegistryPath(runDir: string): string {
  return join(runDir, 'subagents', 'teammates.json')
}

/**
 * Every recorded teammate for a run, in record order. NEVER THROWS: a missing, unreadable or corrupt registry is
 * "nothing recorded", which makes the next dispatch SPAWN rather than reuse — a wasted child, never a wrong one.
 */
export function readTeammates(runDir: string): TeammateEntry[] {
  let raw: string
  try {
    raw = readFileSync(teammateRegistryPath(runDir), 'utf8')
  } catch {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TeammateRegistryFile> | null
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.teammates)) return []
    const out: TeammateEntry[] = []
    for (const candidate of parsed.teammates) {
      if (candidate === null || typeof candidate !== 'object') continue
      const entry = candidate as Partial<TeammateEntry>
      if (typeof entry.delegationId !== 'string' || entry.delegationId === '') continue
      if (typeof entry.role !== 'string') continue
      if (typeof entry.name !== 'string' || entry.name === '') continue
      if (typeof entry.childId !== 'string' || entry.childId === '') continue
      const recovered: TeammateEntry = {
        delegationId: entry.delegationId,
        role: entry.role,
        name: entry.name,
        childId: entry.childId,
        at: typeof entry.at === 'string' ? entry.at : '',
      }
      if (entry.recovered === true) recovered.recovered = true
      out.push(recovered)
    }
    return out
  } catch {
    return []
  }
}

/** The recorded teammate for one delegation + role, or null. */
export function findTeammate(runDir: string, delegationId: string, role: string): TeammateEntry | null {
  const matches = readTeammates(runDir).filter((entry) => entry.delegationId === delegationId && entry.role === role)
  return matches.length === 0 ? null : matches[matches.length - 1]!
}

/**
 * The recorded teammate owning one child id, or null.
 *
 * This is how a FOLLOW-UP finds its target: a repair is addressed by the child id the loop holds, and the roster
 * addresses children by name, so the mapping has to be read back from disk. Used by `deliverRepair`.
 */
export function findTeammateByChild(runDir: string, childId: string): TeammateEntry | null {
  if (childId === '') return null
  const matches = readTeammates(runDir).filter((entry) => entry.childId === childId)
  return matches.length === 0 ? null : matches[matches.length - 1]!
}

/**
 * Record (or refresh) the mapping for one delegation + role.
 *
 * WRITTEN ONCE PER DISPATCH, and the SAME entry is updated on reuse, so the file always names the child this
 * delegation is actually talking to. Throws on an IO failure — deliberately: the caller turns that into a routing
 * note, and a dispatch whose mapping could not be recorded is still a real child whose id is in the result, while
 * a SILENT failure here would break the next round's reuse with nothing to point at.
 */
export function recordTeammate(runDir: string, entry: TeammateEntry): string {
  const path = teammateRegistryPath(runDir)
  const kept = readTeammates(runDir).filter((existing) =>
    !(existing.delegationId === entry.delegationId && existing.role === entry.role))
  const file: TeammateRegistryFile = { version: 1, teammates: [...kept, entry] }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', 'utf8')
  return path
}

/** The roster row for a name, when the live roster can be listed. */
export function liveMemberNamed(
  teams: TeammateRosterLike | undefined | null,
  caller: unknown,
  name: string,
): TeamMemberViewLike | null {
  if (teams === undefined || teams === null || typeof teams.listMembers !== 'function') return null
  try {
    const member = teams.listMembers(caller).find((candidate) => candidate.name === name)
    return member ?? null
  } catch {
    // A roster that cannot be listed is "no live row": the durable registry is still authoritative for reuse.
    return null
  }
}

/**
 * ⚠ THE FAIL-CLOSED VOCABULARY FOR A ROSTER DISPATCH.
 *
 * A delegation that is supposed to be a rostered teammate and is not MUST NOT quietly become an unrecorded child:
 * that is the exact defect the provenance gate exists to catch, and it would make the run's `operations.jsonl`
 * claim a dispatch that no child answered. So every roster refusal here is NAMED — which limit was hit, which
 * name was taken — and it says WHAT TO DO. The delegation then fails with that sentence as its reason and records
 * no child.
 */
export type TeamDispatchFailureCode =
  | 'TEAM_ROSTER_LIMIT'
  | 'TEAM_MEMBER_NAME_TAKEN'
  | 'TEAM_NOT_LEAD'
  | 'TEAM_PROVIDER_MISSING'
  | 'TEAM_SPAWN_FAILED'
  | 'TEAM_SEND_FAILED'

/** One named, actionable roster refusal. */
export interface TeamDispatchFailure {
  code: TeamDispatchFailureCode
  message: string
}

/** The harness error code on a thrown team error (`TeamError.code`), when it carries one. */
function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Turn a `spawnTeammate` rejection into a NAMED, actionable failure.
 *
 * The harness's own codes (verified in `agent-team/src/roster.ts` / `types.ts`) are what the mapping keys on:
 *   • `TEAM_MEMBER_LIMIT`      — `maxMembers` (default 16) reached;
 *   • `TEAM_MEMBER_NAME_TAKEN` — the name was already used; names are NEVER reused;
 *   • `TEAM_LEAD_REQUIRED`     — the caller stopped being the Lead (race with teardown/reassignment);
 *   • `TEAM_INVALID_MEMBER_NAME` is not mapped separately: the generated name satisfies `memberName()`'s rule by
 *     construction (lower-kebab, ≤64, digest suffix), so a rejection there is an unexpected failure.
 */
export function describeSpawnFailure(input: {
  delegationId: string
  role: string
  name: string
  provider: string
  error: unknown
}): TeamDispatchFailure {
  const { delegationId, role, name, provider } = input
  const code = errorCodeOf(input.error)
  const detail = errorMessageOf(input.error)
  const context = 'delegation ' + delegationId + ' (role ' + role + ', teammate "' + name + '")'
  if (code === 'TEAM_MEMBER_LIMIT' || detail.includes('Team member limit')) {
    return {
      code: 'TEAM_ROSTER_LIMIT',
      message: 'the agent-team roster REFUSED the spawn for ' + context + ': ' + detail + '. The roster cap '
        + '(agentTeams.maxMembers, default 16) is not something this plugin may raise for you, and a delegated '
        + 'child must be a RECORDED teammate — so this delegation did NOT fall back to an unrecorded child. '
        + 'REUSE an existing teammate by resuming this delegation, or raise `maxMembers` on the agentTeams row in '
        + 'the composition, or continue this phase in a fresh team/session.',
    }
  }
  if (code === 'TEAM_MEMBER_NAME_TAKEN' || detail.includes('already used in this Team')) {
    return {
      code: 'TEAM_MEMBER_NAME_TAKEN',
      message: 'the agent-team roster REFUSED the spawn for ' + context + ': ' + detail + '. A TEAMMATE NAME IS '
        + 'NEVER REUSED, and this name is derived from (run, delegation, role) — so the roster already holds a '
        + 'member under it, most likely this delegation\'s own child. REUSE IT: the durable mapping is '
        + '`subagents/teammates.json` in the run directory and the live roster is `listMembers`. If that member '
        + 'is gone, delete the stale mapping entry or move the delegation to a fresh team; do NOT spawn an '
        + 'unrecorded child for it.',
    }
  }
  if (code === 'TEAM_LEAD_REQUIRED' || code === 'TEAM_NOT_MEMBER') {
    return {
      code: 'TEAM_NOT_LEAD',
      message: 'the agent-team roster refused the spawn for ' + context + ': ' + detail + '. The CALLER must be the '
        + 'team Lead, and the live Agent is the authority credential — a `{ id }` copy of it is not. This '
        + 'delegation did not fall back to an unrecorded child; re-issue it from the Lead agent\'s own session.',
    }
  }
  return {
    code: 'TEAM_SPAWN_FAILED',
    message: 'the agent-team roster could not create a teammate for ' + context + ' (provider "' + provider + '"): '
      + detail + '. The child was NOT dispatched and no unrecorded substitute was started.',
  }
}

/** The named failure for a follow-up that could not reach its rostered child. */
export function describeSendFailure(input: {
  delegationId: string
  name: string
  error: unknown
}): TeamDispatchFailure {
  return {
    code: 'TEAM_SEND_FAILED',
    message: 'the teammate "' + input.name + '" for delegation ' + input.delegationId + ' could not be reached: '
      + errorMessageOf(input.error) + '. The child is kept (nothing is lost), so a later call can retry the '
      + 'delivery; it was NOT replaced by an unrecorded child.',
  }
}

/**
 * The FIRST message a spawned teammate receives.
 *
 * ⚠ WHY IT DOES NOT CONTAIN THE BRIEF, AND WHY IT STILL HAS TO SAY ``WAIT``. `SpawnTeammateRequest` has no
 * `childId` — the roster generates one inside `spawnTeammate` — while the brief and the reply path embed that id
 * (`subagents/<delegationId>/child-<childId>/`). So the dispatch is TWO STEPS: spawn with this hold message, learn
 * `member.id`, write the brief, then deliver the real instructions. A child that does not know it is waiting will
 * start working from the hold message and write a reply where no round is looking, which is why the message is
 * explicit that the next message is the one that matters and what it will contain.
 */
export function teammateHoldPrompt(input: { delegationId: string; role: string; name: string }): string {
  return [
    'You are the recursive-mode teammate "' + input.name + '" for delegation ' + input.delegationId
      + ' (role: ' + input.role + ').',
    '',
    'WAIT. Your brief has not been written yet — it is being prepared now, and it arrives as the very next message',
    'from the Team Lead. Do NOT read, write, run, or change anything for this delegation before it arrives.',
    '',
    'The next message names your brief file, your reply file and the exact contract you must meet. When it arrives,',
    'read the files it names and do the work described there. If it never arrives, say so and stop — do not guess',
    'what the delegation wanted.',
  ].join('\n')
}

/** Whether the run directory exists — a dispatch with nowhere to write the brief must not spawn a child. */
export function teammateDispatchAvailable(runDir: string): boolean {
  return existsSync(runDir)
}
