# ADR: the delegation surface — wrap the harness primitive, do not adopt the harness tools

> ## ⚠ SUPERSEDED IN PART — 2026-10-17
>
> **The decision below to make `ctx.subagents` "the only spawn path" is NO LONGER IN FORCE.** The owner has decided
> that **every delegated child — review, work and audit — is created through the agent-team roster**
> (`ctx.agentTeams.spawnTeammate`) and followed up through `ctx.agentTeams.sendMessage`. See
> **[`decisions/DECISION-teammate-delegation.md`](decisions/DECISION-teammate-delegation.md)**, which records the
> rule, the two-step dispatch, the settlement-attribution fix, the flat-roster limits and the fail-closed errors.
>
> **Why the earlier reasoning did not survive:** this ADR treated the teams roster as a *sibling* of this plugin
> over one shared primitive, and counted its layer as cost with no countervailing benefit. It is not a sibling — it
> is a **layer over the same primitive** (`agent-team/src/roster.ts` `spawnAdmitted` calls
> `ctx.subagents.startContinuable`), so a teammate IS a continuable child: same durable id, same steer path for
> follow-ups, same `subagent-settled` notice. Routing through it therefore costs the repair loop nothing and buys a
> durable, named, board-visible child for every delegation this plugin starts.
>
> **What still stands from this ADR, and is not superseded:**
> - this plugin ships its **own phase-aware surface** and keeps the phase contract (brief, reply, action record,
>   verification) — the harness's tools still cannot satisfy it, so they are still not adopted as *the* interface;
> - the **audit breadth** mechanism remains the teams task board (`recursive_audit_team`), and now the same roster
>   also carries review and work children;
> - the **evidence-capture obligation** ("a settlement for a child nobody filed must still land in the run") remains,
>   and was strengthened: the adopted record is now filed where the round observer READS it, marked `adopted: true`;
> - the **FU-9 host limitations** argument is untouched: the known live blocker sits beneath both paths.
>
> Read the sections below as the record of what was decided on 2026-10-06 and why, **not as the current contract**.

**Status:** superseded in part (see the notice above) · **Date:** 2026-10-06 · **Supersedes:** nothing · **Related:** FU-17, FU-9, §8 of README.md

---

## The question

For work delegation (the main agent handing a phase's *actual work* — requirements, analysis, planning,
implementation, testing — to a subagent, then reviewing and repairing it), should this plugin:

- **(A)** build on the harness's own subagent / agent-team **tools**, or
- **(B)** ship its own tool over the same primitive?

## The finding that reframes it

**Both paths already sit on the same primitive, so this was never a choice about how children are created.**

| Caller | What it calls |
|---|---|
| `packages/subagent/tool-subagent/src/index.ts:530` — the harness's subagent tool | `ctx.subagents.startContinuable({ provider, label, request, signal: exec.signal })` |
| `packages/experimental/agent-team/src/roster.ts:282` — the teams roster | `ctx.subagents.startContinuable({ childId, provider, label, request: { prompt, parent } })` |
| `src/delegation.ts` — this plugin | `startContinuable(spec)` through the same optional `ctx.subagents` seam |

The harness's tools and this plugin are **siblings over one service**. The real question is therefore **who owns
the phase contract** — the brief, the reply, the action record, the verification — not who spawns the child.

## Decision

> **⚠ SUPERSEDED (2026-10-17) — the paragraph below is the original decision and is kept as the record of it.** The
> operative contract is `decisions/DECISION-teammate-delegation.md`: the roster, not `ctx.subagents`, is the spawn
> path.

**Wrap the primitive. Ship our own thin, phase-aware surface (FU-17). Keep the harness's tools working, and add
evidence capture so work done through them still lands in the run.**

Concretely: `ctx.subagents` is the **only** spawn path; `recursive_delegate` is the workflow's interface to it;
the teams task board remains the **parallel-breadth** mechanism for audits; and settlements are captured for
**any** child, including one this plugin did not start.

## Evidence

Four measurements, each decisive for a different reason.

**1 · The harness tools write nothing run-scoped.** A grep for `.recursive`, `action.md`, `run/`, `brief.md`,
`reply.md` across `packages/subagent/tool-subagent/src` returns **nothing**. But the workflow's central contract —
`## Subagent Contribution Verification`, enforced by the linter in strict profiles for
`AUDITED_PHASE_FILES` — requires:
- **Reviewed Action Records**, and they may only reference records **inside the run**;
- **Main-Agent Verification Performed**;
- an acceptance decision, Refresh Handling, and Repair Performed After Verification.

> **A delegation made through the harness's tools cannot satisfy the phase contract**, because there is no
> run-scoped record for the artifact to cite. Adopting them as *the* interface would break the workflow's core
> guarantee for every phase that delegates.

**2 · The tools are not phase-aware.** No phase, no brief, no reply contract, no expected sections. The phase
standard — required sections read from `getArtifactRequiredSections`, gates, evidence — is exactly what this
plugin contributes, and a child that is not told the standard cannot meet it.

**3 · Availability differs, and the difference matters.** `ctx.subagents` is resolved as an **optional service**
at composition, with a **named** degradation when absent (`self-audit`, reported, never hidden). The tools depend
on what a profile mounts (tool-presentation, the teams bundle). Building a workflow invariant on a profile's tool
set makes the invariant profile-dependent.

**4 · The known live blocker sits *below* the tool layer, so switching would unblock nothing.** The FU-9 failure —
a continuable start whose prompt delivery is refused, and whose error is then **replaced** by a host
error-classifier's crash (`control.ts:106`, DSH-LIMITATIONS entries 9 and 10) — happens inside the host, beneath
both paths. This is the strongest practical argument: adopting the harness tools would carry the same risk, the
same unknowns, and no new capability.

**Bonus fact, and it is the reason teams stay:** the teams path adds something this plugin does not have — a
**durable task board** (`create / claim / … / interrupt / get`) for **parallel** coordination, which is what the
audit fan-out needs ("one phase per role, one item per reviewer"). Sequential phase-work and parallel audit
breadth are different problems with different right answers.

## Alternatives considered

**A · Adopt the harness tools as the interface.** Rejected: no run-scoped evidence (breaks the linter contract),
no phase awareness, no repair loop we control, and the same underlying blocker. It would look like less code
while removing the auditability that justifies the plugin.

**B · Build our own subagent system (own spawn, own durability, own lifecycle).** Rejected outright: the service
already provides spawning, continuable children, followup by object identity, interrupt, drain, provider
discovery and settlement events. Reimplementing that would duplicate the host, diverge from its fixes, and — as
the sandbox has already demonstrated — collide with host constraints we do not control.

**C · Hybrid — our surface over the primitive, teams for breadth, capture for foreign children. Accepted.**

## Consequences

- **⚠ SUPERSEDED — one spawn path, but it is the ROSTER'S.** The bullet below said "every child this plugin starts
  goes through `ctx.subagents`". Since 2026-10-17 every delegated child goes through
  `ctx.agentTeams.spawnTeammate`, which itself goes through `ctx.subagents.startContinuable`; the primitive remains
  the path for an explicit one-shot delegation and for compositions with no roster. One spawn path still holds —
  the layer is simply named correctly now.
- **One spawn path.** Every child this plugin starts goes through `ctx.subagents`. No parallel lifecycle.
- **`advanceReview` generalises to `advanceDelegation(kind)`** so review and work share the round/repair loop
  rather than duplicating it. Review behaviour must not change as a result — that is a test obligation, not a
  hope.
- **The brief becomes a function of the phase**: `getArtifactRequiredSections` feeds the work brief, so a child is
  told the standard it must meet. The reviewer brief keeps its anti-pattern framing.
- **A new obligation: adopt foreign children.** `runDirForChild` attributes a child by the `subagents/<delegation>/
  child-<id>/` layout this plugin writes, and its own comment explains why it refuses to guess — *"filing a
  settlement into the wrong run is worse than not filing it."* So a child started through `spawn_teammate` has no
  directory and is currently unattributable. To keep the contract satisfiable **whichever path the agent chose**,
  add an explicit adoption path: when a settlement arrives for a child with no delegation directory, file it under
  a synthetic delegation, marked as adopted. This is the difference between "use our tool or lose your evidence"
  and "the run records what happened".
- **Teams remain for audits.** `recursive_audit_team` keeps driving the board; it does not become a second
  phase-work path.
- **The FU-9 blocker is unaffected by this decision** and remains the live unknown. It is a host-side mask, not a
  consequence of the surface chosen here.

## What this decision does *not* claim

It does not claim work delegation works today — it does not; FU-17 is unimplemented. It does not claim the
approach is proven live: the review path that shares this primitive reaches the native tier and starts a
continuable child, but no child turn has ever been observed to settle in a live session (FU-9). The argument above
is about **architecture**, and it is settled by reading the code both paths share — not by a successful run.
