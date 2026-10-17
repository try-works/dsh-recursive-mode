# Decision: every delegated child is a rostered agent-team teammate

**Status:** accepted, implemented · **Date:** 2026-10-17 · **Supersedes:** the *"wrap the primitive / `ctx.subagents`
is the only spawn path"* decision in `ADR-delegation-surface.md` (that ADR stays as the record of what was decided
then; its phase-contract reasoning and its audit-breadth reasoning still stand) · **Scope:** `src/teammate.ts` (new),
`src/runtime.ts`, `src/delegation.ts`, `src/settlement.ts`, `src/recursive_review.tool.ts`,
`src/recursive_delegate.tool.ts`, `src/index.ts`.

## The decision

**Every delegated child — review, work and audit — is created through the agent-team roster:
`ctx.agentTeams.spawnTeammate(...)`, not `ctx.subagents.startContinuable(...)`. Follow-ups and repairs go through
`ctx.agentTeams.sendMessage(...)`, not `subagents.sendMessage(...)`.**

The owner made this decision. It replaces the earlier choice to "wrap the primitive", which was made when the
roster looked like a *sibling* of this plugin over one shared service and its extra layer looked like cost with no
countervailing benefit. The reason it now wins is that the roster is not a sibling — it is a *layer over the same
primitive*, so routing through it costs the repair loop nothing and buys a durable, named, board-visible child for
every delegation this plugin starts.

## Why this is feasible (established, not re-derived here)

`TeamService` injects and calls the same service this plugin used directly:

- `static inject = ['agents','sessions','sessionPersistence','sessionProjections','subagents']`
  (`packages/experimental/agent-team/src/index.ts:56-57`);
- `spawnTeammate` → `TeamRoster.spawnAdmitted` → `ctx.subagents.startContinuable({ childId, provider, label,
  request: { prompt, parent }, signal })` (`roster.ts:280-291`).

So **a teammate IS a continuable child**:

- its durable id is a `SessionId` in the roster snapshot (`types.ts:47-55`), stable across activations;
- a follow-up reaches it through the same host steer path the primitive uses — `mailbox.ts:262`
  `steerHostSubagentPrompt(...)`;
- its settlement arrives as the harness's own notice (`continuation-activation.ts:871-888` →
  `continuation-messages.ts:152-158`, `source.kind === 'subagent-settled'`), which is the exact message
  `src/settlement.ts` already recognises.

The repair loop therefore survives intact: one durable child, a REVISE delivered to that same child, and a
settlement the round observer can read.

## The three gaps this change had to close

### G1 — settlement attribution (the prerequisite)

A roster child is created by `spawnTeammate`, so at the moment it settles there may be no
`subagents/<delegationId>/child-<id>/` directory for `runDirForChild` to attribute it by. The plugin already had an
**adoption** path for exactly that case, but it filed the record into
`subagents/adopted-<childId>/settlement.jsonl` — **a file nothing reads.** `readSettlements` opens exactly one path,
`subagents/settlements.jsonl`, so an adopted verdict was filed and *unreadable*: `settlementRoundObserver` would
wait out its timeout and report "no settlement yet" for a child that had already answered, and no phase could ever
be approved by such a child.

**The mechanism chosen: one log, one reader, and the origin in the record.** Adoption now appends to the run's own
`subagents/settlements.jsonl` with `adopted: true` and the reason, and `readSettlements` parses that marker back into
`SettlementNotice.adopted` / `.adoptionReason`. The round observer needed no change at all.

Why this and not the alternatives:

- **a second file the reader also opens** would put the same fact in two places, and — decisively — the round
  observer consumes settlements **FIFO per child** (`readUnconsumedSettlement` + a durable cursor), so "which of
  these two arrived first" is load-bearing and a merge across files would have to guess it;
- **writing a synthetic `child-<id>` directory** so the child is attributed natively next time would make the plugin
  claim a delegation layout it never wrote, and would erase the adopted marker on the next settlement;
- **dropping it** was the defect.

The progressive rule is unchanged: with exactly one run the settlement is adopted into that run's log; with more
than one it goes to a root-level `.recursive/adopted-settlements.jsonl` outside every run's evidence chain. The
"never guess between runs" guarantee is intact and is asserted in both directions.

### G2 — id reservation / two-step dispatch

`SpawnTeammateRequest` has **no `childId`** (`types.ts:166-173`; `roster.ts:259` generates one with `randomUUID()`),
while this plugin's brief embeds the child id — the reply path is
`subagents/<delegationId>/child-<childId>/reply.md`. The brief therefore cannot be written before the child exists.

**The dispatch is two steps:**

1. **spawn** with a HOLD prompt that says, in as many words, *wait: your brief is the next message, and it names the
   files and the contract*. This is not a placeholder — it is what keeps the child's own instructions coherent, so
   it does not start working from a message that was never meant to be a task;
2. learn `member.id`, **write** the handoff/brief/reply tree under `subagents/<delegationId>/child-<member.id>/`,
   then **deliver** the real instructions with `agentTeams.sendMessage({ target: name, content, signal })`.

Both `spawnTeammate` and `sendMessage` type `signal` as required, so a fresh `AbortController().signal` is supplied
per call.

### G3 — flat roster limits

- **`tryMembership` returns undefined for any agent carrying a subagent descriptor** (`roster.ts:106`/`:114`), and
  `spawn` throws `TEAM_LEAD_REQUIRED` for a non-Lead caller. **A teammate cannot spawn teammates.** The honest
  consequence, recorded in `src/teammate.ts`: **nested delegation (`maxDelegationDepth: 2`) does NOT survive for
  team children** — a teammate's children could only be ordinary `subagents` children, which is the unrecorded
  shape this decision removes.
- **`maxMembers` defaults to 16**; names are lower-kebab, ≤64 chars, never `lead`, and **never reused**
  (`TEAM_MEMBER_NAME_TAKEN`). So the plugin **reuses one teammate per (run, delegation, role) across rounds and
  phases** rather than spawning per round, and **generates the name deterministically**:

  ```
  rm-<delegation-slug>-<role-slug>-<8 hex of sha256(runId \0 delegationId \0 role)>
  ```

  The slug prefix is readable on the board; the digest makes the same input whole the same name (so a later round
  resumes the same child) and different inputs different names (so two runs that share a delegation id do not
  collide). The digest also guarantees the name can never be `lead`.
- **The durable mapping** `(delegationId, role) → { name, childId }` lives in
  `subagents/teammates.json` in the run, written by the dispatch path. It records **the child id the roster
  learned**, which is the value the action record, the operation log and `resumeChild` must all use.
- **Fail closed, by name.** A roster limit, a taken name, a missing provider, a spawn failure or a failed delivery
  produce a **named** error that says which limit was hit and what to do (`TEAM_ROSTER_LIMIT`,
  `TEAM_MEMBER_NAME_TAKEN`, `TEAM_NOT_LEAD`, `TEAM_PROVIDER_MISSING`, `TEAM_SPAWN_FAILED`, `TEAM_SEND_FAILED`).
  The delegation then fails; it **never** falls back to an unrecorded child, because an unrecorded child is the
  defect this change removes and the provenance gate would refuse the phase anyway.

## The dispatch rules

- **Gate on the live caller**: `ctx.agentTeams.tryMembership(parent).role === 'lead'`. Team methods take the EXACT
  LIVE Agent as the authority credential (`roster.ts:93`: `if (this.ctx.agents.get(agent.id) !== agent) return
  undefined`), so a `{ id }` copy of the agent is not a member — it takes the primitive path. This plugin has been
  bitten by that before, so the gate is one function (`canRosterDispatch`) rather than a condition repeated at
  each call site.
- **`signal` is required** on `spawnTeammate` and `sendMessage`; one is supplied for every call.
- **The primitive path is preserved**: no roster seam, a non-Lead caller, no team service — or an explicit
  `mode: 'one-shot'` — takes `subagents.startContinuable` exactly as before, and the records are byte-identical
  (no team marker is emitted).
- **Provenance**: a roster dispatch is recorded as a plugin dispatch in `operations/operations.jsonl` carrying
  `delegationId` AND the learned `childId`; the action record's `Subagent ID` carries the same id and its
  `Execution Mode` adds `, team <name>`. The obligation in `decisions/DECISION-delegation-provenance.md` is
  unchanged and the gate is not weakened — the citation of `subagents/<delegation>/child-<member.id>/reply.md` is
  reconciled against the dispatch of that child.

## What does NOT travel through the roster, stated rather than discovered later

`SpawnTeammateRequest` carries `name, description, prompt, context, provider, signal` and nothing else. It has **no
`toolFilter`, no `maxDepth`, no `agentOptions` and no `outputSchema`**. Consequences, each reported in
`routingNotes` when it applies:

- a roster child runs with the **composition's default tools**, so the reviewer's read-only filter is not applied to
  a rostered reviewer (the brief still instructs it as a reviewer and the round still validates its citations);
- a routed model (FU-19/FU-20) is not applied to a roster child; the composition's model applies;
- the depth budget is still computed and passed, but it cannot matter for nested delegation (see G3).

The `audit` leg needs no new code here: `recursive_audit_team` already drives the roster's own task board, and the
main agent's audit children are roster children by construction. What changed is that **review and work** children
now join them there.

## What this decision does not claim

- It does not claim the host leg is proven: no live session has yet driven a real `spawnTeammate` to a settlement
  through this plugin. The unit suite uses a structural roster fixture, so it proves the plugin's dispatch
  sequence, records, fail-closed errors and the G1 read path — not the host service's behaviour end to end. The
  FU-9 host-side unknowns recorded in `DSH-LIMITATIONS.md` are untouched by this decision.
- It does not claim the roster preserves every capability of the primitive: the list above is the measured
  difference.
