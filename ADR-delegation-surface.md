# ADR: the delegation surface — wrap the harness primitive, do not adopt the harness tools

**Status:** accepted · **Date:** 2026-10-06 · **Supersedes:** nothing · **Related:** FU-17, FU-9, §8 of README.md

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
