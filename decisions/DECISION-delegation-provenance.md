# Decision: the delegation gate checks provenance, not file layout

Status: accepted, implemented. Scope: `src/identity.ts`, `src/runtime.ts`, `src/delegation.ts`,
`src/ts-lint.ts`.

> **Where this file lives, and why it is not under `docs/`.** It was requested as
> `docs/DECISION-delegation-provenance.md`, and a top-level `docs/` tree CANNOT exist in this repo:
> `tests/docs-contract.spec.ts` classifies `docs/` as a FOREIGN tree — "the DSH checkout's packages/
> docs/ apps/ vendor/" (its own header) — and its class-3 skip is `if (!existsSync(join(ROOT, top)))
> continue` (`:194`). The moment a `docs/` directory exists here, every `docs/...` path PROPOSAL.md
> cites becomes a class-1 path that MUST exist, and that one assertion fails on 40 such references.
> Measured both ways: with `docs/` present the spec is `1 failed | 26 passed`; with it removed,
> `27 passed`, exit 0. The document therefore lives in `decisions/`, the repo convention this file
> follows (`ADR-*.md`, `DISCUSSION-*.md`, `HANDOFF-*.md` at the root are the same class of record).

## The problem, from a finished run

Run `01-threejs-scientific-calculator` in `E:\Temp\eryery` obtained SIX of its eight reviews outside the plugin —
the delegation path was broken at the time, so the main agent used the harness's raw `subagent` tool and then
HAND-WROTE the artifacts the gate inspects: six `## Subagent Action Record` files under
`subagents/`, six `reply.md` files, and the `## Subagent Contribution Verification` sections that cite them.
The synthetic round-number timestamps (`1791849000000`, `1791849500000`, …) give them away beside the plugin's
own epoch-millisecond filenames (`1791848786449-9ec6106b-…-action.md`), and the run's own
`operations/operations.jsonl` holds only the plugin's TWO dispatches, both `act=delegate-review,
outcome=unaccepted, phase=01`.

So the phase locked with six verdicts that no plugin operation produced, and a reader reconciling
`operations.jsonl` against `subagents/` finds verdicts with no matching operation. **The gate could be
satisfied without the plugin dispatching anything.**

Why the existing check cannot see it: `getSubagentActionRecordPaths` (`src/ts-lint.ts:1350`) is a path-prefix
filter (`.recursive/run/<this run>/subagents/`), and `lintSubagentActionRecordFile` is a shape check on the
document. Both are about WHERE a file is and HOW it is written. Neither compares the citation against the run's
own record of what it dispatched, so a well-formed file in the right directory is accepted on its face.

## The mechanism chosen

**Reuse `operations/operations.jsonl`; do not add a second provenance file.** The run already keeps an
append-only operation index for exactly this class of fact ("this run did this"), and the repo's rule is to say
each fact once. Two additive fields make the reconciliation possible:

1. `OperationRecord.delegationId` and `OperationRecord.childId` (`src/identity.ts`), written by the one
   `recordOperation` call on the delegation path (`src/runtime.ts`). Parsed additively: a record written before
   this change still parses, and simply carries no delegation.
2. `- Delegation: <delegationId>` in the action record's `## Metadata` (`src/delegation.ts` `writeActionRecord`),
   emitted only when the caller supplies one, so a caller that says nothing writes the record it always did.
   `delegateReview` always supplies it.

The gate (`lintSubagentDelegationProvenance`, called from `lintSubagentContributionVerification`) then, for every
`subagents/` path cited in `## Subagent Contribution Verification`:

- resolves the delegation id — from the path's first segment when the citation is nested
  (`subagents/01-review/child-…/reply.md` → `01-review`), otherwise from the record's own `## Metadata`
  `Delegation` field;
- resolves the child id when one is named — from a `child-<id>` segment in the path, otherwise from the record's
  `Subagent ID` field (the same value `delegateReview` passes to both writers, so the two always agree for a
  plugin-written record);
- requires the run's operation log to hold a `delegate-review` record for that delegation, and, when a child id
  was resolved, for that child as well.

**What the gate reports** (three messages, in the style of the surrounding lint findings, each naming the path):

- `Subagent Contribution Verification cites delegation '<id>', which operations.jsonl records no delegate-review for: <path>`
- `Subagent Contribution Verification cites a record that names no delegation, so its provenance cannot be checked against operations.jsonl: <path>`
- `Subagent Contribution Verification cites child '<childId>' of delegation '<id>', which operations.jsonl records no dispatch of: <path>`

The first two are the ones the real run would have met (its forged records name no delegation at all). All
three are `FAIL` findings, so they refuse a lock by the existing standard gate — the plugin's own dispatch path
now writes both fields, so the only citations it can refuse are ones this plugin did not write, **or ones an
EARLIER version of this plugin wrote**: a record filed before this change carries no `Delegation:` line, and an
in-flight run that spans the upgrade will be refused until its next dispatch. That consequence is accepted
rather than hidden, and it is the price of the fail-closed choice argued below — the alternative is a gate that
cannot refuse anything a fabrication needs it to accept.

## The fail-open / fail-closed question, argued

`FAIL` (blocking) rather than `WARN`, because a warning would leave the defect exactly where it was: the run
would still lock with verdicts no operation produced, and the report would be a line nobody has to answer. The
aggression is bounded on both sides:

- **No log, or an unreadable log, degrades to the old behaviour.** The check runs only when
  `operations/operations.jsonl` can actually be read (`readOperationsOrNull`); if it is absent or unreadable the
  gate returns no findings at all and every phase lints exactly as it did before. A run that cannot be
  reconciled is not therefore a run that failed.
- **A recorded delegation is not required to be `accepted`.** A parked or unaccepted dispatch counts: the gate
  asks whether the plugin dispatched this delegation, not whether the dispatch succeeded. A failed review that
  a human or a raw subagent then completed is still a dispatch, and the record it produced is still a record of
  work this run did.

## Alternatives rejected

1. **A second provenance file per delegation** (`subagents/<id>/dispatch.json`, or a dispatch line in
   `handoff.md`). A second log beside the first is a second thing to keep in sync, and it would be written by
   the same path that already writes the operation — the same fact, said twice.
2. **Trusting the record's own `Record Provenance: Writer:` line.** The real run's forged record carries an
   honest `Writer: main agent (controller), reconstructed after the delegation completed` line, so a check on it
   would either pass (the forger is candid) or reject a candid volunteer; and it is written by the same hand as
   everything around it.
3. **A timestamp-shape heuristic** (`1791849000000` is a synthetic round number). It catches this forger's
   habits, not the next one's, and a legitimate clock could produce a round-looking millisecond.
4. **Requiring the delegation directory to exist** (`subagents/<delegationId>/handoff.md`). That is file layout
   again — the exact authority this change removes — and a forger who can write a `reply.md` can create the
   directory above it.
5. **Matching on the phase alone.** The log already carries `phase`, and it is not enough: the real run's two
   records are both `phase=01`, so phase matching would have blessed every forged phase-01 citation.

## The honest LIMIT

**A run that can write the operation log can still forge provenance.** `operations/operations.jsonl` is a plain
append-only file inside the run directory, and the same agent that hand-wrote six action records could have
appended six matching `delegate-review` lines with the right delegation and child ids. This gate is a
CONSISTENCY CHECK between two of the run's own artifacts, not a signature: it raises the cost of a fabricated
verdict from "write a file the linter already accepts, in a directory it already trusts" to "also write a
plausible operation-log line per verdict, and keep the two agreeing" — and it makes the disagreement visible to
the next reader, which the previous gate did not. It does not, and cannot, prove that a child ever ran.

Two things it deliberately does not claim:

- It does not check the six hand-written `reply.md` files that are never cited in an artifact — an uncited
  reply is outside the SCV contract and is not refused by this check.
- It does not prove the cited child authored the record: the `Subagent ID` it matches against the log is a
  field in the cited document. It is matched against a REAL dispatch of that child id, which is what makes the
  forgery need the log, but the authorship question stays open.
