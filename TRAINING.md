# Training & memory: a TypeScript design (proposal)

**Status:** proposal, not implemented. **Scope:** replace the reference's Python training/loader scripts with a
first-class TypeScript design inside this plugin — and improve on them rather than port them.

---

## 1 · What the reference does (measured, quoted)

| script | size | what its own header says |
|---|---|---|
| `recursive-training-loader.py` | 21.1 KB | *"Progressive memory loader … reads the memory router plus the repository memory plane, **scores memory docs by relevance to the current task, reads the most relevant docs, scores individual items, and returns formatted context for the agent**."* Lives at `.recursive/scripts/`, *"copied there during recursive-mode installation"*, *"the canonical way to load repo-specific experiential knowledge"*. Driven by `--query/--files` or `--subsystem/--max-docs`. |
| `recursive-training-phase8-trigger.py` | 5 KB | *"Post-Phase 8 training trigger … **Thin wrapper: checks preconditions, then delegates to `recursive-training-grpo.py`**"*, with `--auto`. |
| `recursive-training-extract.py` | 3.6 KB | the extraction step |
| `recursive-training-grpo.py` | 58.4 KB | **GRPO — Group Relative Policy Optimization**: real preference-based model training |
| `recursive-training-sync.py` | 7.1 KB | syncing memory between places |
| `recursive-training-mcp.py` | 10.3 KB | an MCP surface over the same data |

**Two-stage scoring** — docs by relevance, then items within them — is the loader's core idea, and it is a good
one. Its weakness is that the ranking is **opaque**: it returns context, not the reasons.

## 2 · What this plugin already has

`src/memory.ts` is the read half, in process: `selectMemory`, `readMemoryEntries`, `retrieveMemory`,
`renderMemorySection`, `MEMORY_INDEX_FILE`. It is wired per phase in `runtime.ts`, and **FU-4 verified it
live**: a shard naming a real uncommitted path outranked a wording-only one, using `changedPaths` from
`git-context.ts`.

`src/training.ts` is the trigger's precondition half: two typed refusals (`EXTRACTOR_UNAVAILABLE` = 2,
`INSUFFICIENT_EVIDENCE` = 3), the *"at least two phase-8-locked runs"* evidence gate, duplicate-group dropping,
and the pluggable extractor behind `RECURSIVE_TRAINING_EXTRACTOR_CMD` / the response file. The plugin never
embeds an LLM client, and that stays true.

The plane's vocabulary already exists: `MEMORY_REQUIRED_FIELDS`, `MEMORY_ALLOWED_TYPES`
(`index|domain|pattern|incident|episode`), `MEMORY_ALLOWED_STATUSES` (`CURRENT|SUSPECT|STALE|DEPRECATED|DRAFT`),
`REQUIREMENT_ID_RE`.

**So the decision is not "build a loader" — it is "promote what we have and make it explainable".**

## 3 · What ours should do better

1. **Use signals the Python cannot see.** The script receives a query and a file list. We are *inside* the
   run: we know the current phase, the run's **changed paths**, which gates are unmet, the run's requirement
   ids, and the addenda that closed upstream gaps. Relevance should be computed from the run, with `--query`
   as one input among several rather than the only one.
2. **Explain every selection.** Each injected entry reports its score components (`path-overlap: 3`,
   `phase-applicable: +1`, `status: CURRENT`, `last-validated: run-42`). An opaque ranking cannot be debugged,
   and "why did the agent get this?" is a question a workflow tool should answer.
3. **Never inject what is dead.** `DEPRECATED` and `STALE` are excluded outright; `SUSPECT` is injected only
   with a visible warning. Status is a filter before it is a weight.
4. **Deterministic and budgeted.** Fixed output budget (max docs, max items, max lines) and a deterministic
   tie-break, so the same run always yields the same context. No timestamps in selection output — the same
   discipline the closeout receipts now follow.
5. **Close the loop with counters, not with GRPO.** Model training is out of scope for a workflow plugin. What
   *is* in scope is recording **which entries were injected into which run, and how that run turned out** — so
   an entry that keeps appearing in successful runs gains reinforcement, and one that keeps appearing in
   reworked phases loses it. That is a feedback counter, honestly labelled as one.
6. **Keep the extraction we have, tighten the writes.** Shards get **stable ids**, duplicates are dropped (the
   reference's rule), and an existing shard is never silently rewritten — an update is an explicit, reported
   operation. That is the FU-8 lesson applied to the memory plane.

## 4 · Shape of the implementation

```
src/memory.ts            extend: entry parsing → typed MemoryEntry (id, type, status, subsystem,
                         applies-to phases, last-validated, applied/contradicted counters)
src/memory-select.ts     NEW: the selector
                           select({ runDir, phase, changedPaths, query?, budget })
                             → { entries: RankedEntry[], rendered: string, excluded: ExcludedEntry[] }
                           RankedEntry = { id, path, score, components: ScoreComponent[], warnings: string[] }
src/memory-feedback.ts   NEW: the loop
                           recordInjection(runDir, entries)        → appended to the run's record
                           settleInjection(runDir, outcome)        → counters on the entries
src/commands.ts          extend: a `memory` verb (query/subsystem/preview) on the existing command surface,
                         so the same selector is reachable without the plugin's agent loop
src/training.ts          extend: at closeout, settle the run's injections before extraction
```

**Scoring table** (one place, published, tunable):

| component | weight | source |
|---|---|---|
| path overlap with the run's changed paths | +3 each, capped | `changedPaths` (FU-4) |
| subsystem match | +2 | the shard's `subsystem` vs the run's changed paths |
| applies to this phase | +2 | the shard's declared phases |
| requirement-id mention from the run | +1 each | `REQUIREMENT_ID_RE` over the run's artifacts |
| free-text match on `--query` | +1 | optional query |
| status `CURRENT` / `DRAFT` | +1 / 0 | `MEMORY_ALLOWED_STATUSES` |
| last validated within N runs | +1 | the shard's recorded run |
| reinforced / contradicted | ±1 | the feedback counters |

Exclusions: `DEPRECATED`, `STALE`, unparseable entries (reported in `excluded`, never silently dropped).

## 5 · Phases, each with a live acceptance

| phase | deliverable | acceptance (in the FU-1 harness, on `E:`) |
|---|---|---|
| **P1** | typed entries + the selector, with components | a run whose shard list includes scores and an `excluded` list; the same run twice yields identical bytes |
| **P2** | changed-path and phase signals wired | extend FU-4: a shard that matches an uncommitted path **and** the current phase outranks one matching neither |
| **P3** | injection record + settle at closeout | `operations.jsonl` (or the run's record) shows which entries were injected; after a closeout the counters moved, and a contradicted entry loses a rank |
| **P4** | the `memory` command verb | the selector runs from the CLI with no agent loop, printing components |
| **P5** | a behaviour test | a run where removing one shard changes what the agent is told — the only acceptance that proves the loader matters |

## 6 · Non-goals

- **No Python scripts, and no second implementation of the read half.** One selector, in TypeScript.
- **No GRPO and no model training.** Preference learning over *memory entries* is in scope; training weights
  is not.
- **No embedded LLM client**, ever — extraction stays behind the pluggable command and the response file.
- **No timestamps in selection or receipts**, so two runs can be compared byte-for-byte.

## 7 · The one thing to decide first

**P1 is additive and unblocks the rest.** P5 is the only phase that proves value, and it needs P1–P3. If the
answer is "parity with the reference" rather than "our own", stop here — everything above is deliberately
*not* that.
