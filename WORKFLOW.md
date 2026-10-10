# The recursive-mode workflow — diagram

> Status key used throughout: **[M]** measured this session from source or a live run · **[R]** from the
> reference implementation in `D:\DEV\recursive-mode` · **[D]** the design the user specified · **[!]** a known
> divergence between what the code does and what it should do.

---

## 1 · The whole workflow

```mermaid
flowchart TD
  subgraph HOST["Harness host process"]
    AG[Parent Agent] --> TR["ToolRuntime<br/>recursive_* tools"]
    TR --> G{{"tool guard<br/>pre-edit · built-in hooks<br/>gate order · deny / ask / allow"}}
    G --> RT[RecursiveRuntime service]
    AG --> PS["policy section per turn<br/>stable contract + phase tail + digest"]
  end

  subgraph INIT["Bootstrap — once per repo"]
    BOOT["recursive_bootstrap<br/>creates .recursive/ control plane"] --> INITR["recursive_init<br/>scaffolds run + artifacts"]
  end

  subgraph RUN["A run: .recursive/run/&lt;runId&gt;/ — 12 phases, monotonic locks"]
    direction TB
    P0["00-requirements<br/>+ 00-worktree"] --> P1["01-as-is / 01.5-root-cause"]
    P1 --> P2["02-to-be-plan"]
    P2 --> P3["03-implementation-summary<br/>gate: TDD Mode"]
    P3 --> P35["03.5-code-review<br/>gate: Audit — DELEGATED"]
    P35 --> P4["04-test-summary"]
    P4 --> P5["05-manual-qa<br/>gate: QA Execution Mode"]
    P5 --> LATE
    subgraph LATE["phases 6 · 7 · 8 — the durable-ledger phases"]
      direction TB
      P6["06-decisions-update"] --> P7["07-state-update"] --> P8["08-memory-impact"]
    end
  end

  P8 --> CLOSE["recursive_closeout<br/>the subject of section 3"]
  CLOSE --> TRAIN["training extraction<br/>phase-8 trigger"]
  TRAIN --> SHARDS["memory shards written"]

  RT -.-> RUN
  P0 & P1 & P2 & P3 & P35 & P4 & P5 & P6 & P7 & P8 -.->|"each: write → gates → lint → lock → receipt"| LOCKED["Status: LOCKED + LockedAt + LockHash<br/>+ locks/&lt;stem&gt;.receipt.json"]
```

## 2 · Every phase transition, mechanically

```mermaid
flowchart LR
  A["recursive_phase<br/>what to write now"] --> B["agent writes the artifact"]
  B --> C["recursive_ask<br/>when a gate needs a decision<br/>(03 TDD mode, 05 QA mode)"]
  C --> B
  B --> D["recursive_lint<br/>gates + vocabulary + mappings"]
  D -->|violations| B
  D -->|clean| E{"recursive_lock"}
  E -->|earlier phase unlocked| F["REFUSED"]
  E -->|work in flight| G["REFUSED — pendingWork named"]
  E -->|ok| H["LOCKED + LockHash + locks/&lt;stem&gt;.receipt.json"]
  H --> I["recursive_preview<br/>policy · rules · next transition"]
  I --> A
```

**[M]** Lock refusals are distinct and named: out-of-order, work-in-flight, and already-locked.

---

## 3 · Phases 6, 7, 8 — and the closeout

### 3a · What 6/7/8 write (the durable records)

**[R]** Each late phase is bound to one control-plane document — the reference declares these as
`extra_inputs` / `extra_outputs` per phase:

| phase | artifact (per run) | **durable record it updates** |
|---|---|---|
| **06** | `06-decisions-update.md` | **`.recursive/DECISIONS.md`** — the decision ledger |
| **07** | `07-state-update.md` | **`.recursive/STATE.md`** — the state ledger |
| **08** | `08-memory-impact.md` | **`.recursive/memory/MEMORY.md`** + **`.recursive/memory/skills/SKILLS.md`** |

**[D]** *"phase 6 7 8 writes the state decisions memory artifacts."* The phase artifact is the run-local
**receipt of the delta**; the ledger is the durable thing that outlives the run. The three are also the
`LATE_PHASE_ARTIFACTS` set in `phase-rules.ts` **[M]**.

### 3b · What the closeout is supposed to be

**[D] — verbatim:** *"closeout.ts is supposed to verify whether the phase artifact docs contain the scaffold
information or not, then tell the agent to add it if not. It is not supposed to just insert section titles
into the docs. It is like a linter checking if the agent missed anything. It is not supposed to edit files by
itself."*

```mermaid
flowchart TD
  subgraph SHOULD["Intended closeout — READ-ONLY"]
    direction TB
    S1["read each phase artifact"] --> S2["required sections?<br/>getArtifactRequiredSections"]
    S2 --> S3["gates passing?<br/>getGateStatus"]
    S3 --> S4["locked, if required?"]
    S4 --> S5{"anything missing?"}
    S5 -->|no| S6["report: fits the standard"]
    S5 -->|yes| S7["TELL THE AGENT what to add<br/>phaseLintRulesMessage"]
  end
  S7 -.->|agent edits| ART["the artifact"]
  S6 -.-> ART
  subgraph NEV["never"]
    N1["write · scaffold · insert headings · overwrite"]
  end
```

**Where each piece of the standard already lives [M] — no private list is needed:**

| need | existing source |
|---|---|
| the artifact list | `RUN_ARTIFACT_SEQUENCE` (`ts-lint.ts`) |
| required sections | `getArtifactRequiredSections` (`phase-rules.ts`, **profile-aware**) |
| gate expectations | `getGateStatus` / `hasGateLine` (`ts-lint.ts`) |
| guidance to give the agent | `phaseLintRulesMessage` (`phase-rules.ts`) |

### 3c · What the closeout does today **[!]**

> ⚠ **`config.file` IS NOT A CONFIG FILE.** The name misled a reader once, so the path is spelled out here.
> `config` is the `PHASE_CONFIG` entry for the requested phase — `{ file, label, scopeNote, todoItems }` —
> and `config.file` is the **run document's** name (`04-test-summary.md`). The write target is therefore
> `.recursive/run/<runId>/04-test-summary.md`: **the phase artifact itself**, which the agent already wrote
> and locked. It writes nothing to `STATE.md`, `DECISIONS.md` or `memory/**` — those appear only as prose
> *inside the document it overwrites*.

```mermaid
flowchart TD
  T1["recursive_closeout(runId, phase)"] --> T2["runtime.closeoutRun(root, runId, phase, agent)"]
  T2 --> T2a{"runDir under &lt;root&gt;/.recursive/run<br/>AND exists?"}
  T2a -->|no| T2b["error: Run not found in current workspace"]
  T2a -->|yes| T2c["isPhase8? rerun =<br/>locks/08-memory-impact.receipt.json EXISTS"]
  T2c --> T2d["drain children (FU-3)<br/>BEFORE the write, phase 8 only"]
  T2d --> T3["closeoutPhase(runDir, phase)<br/>NO options — strict is TRUE in production"]
  T3 --> T4["mkdirSync(runDir)"]
  T4 --> T5["writeFileSync(join(runDir, config.file))"]
  T5 --> T6["04-test-summary.md · 05-manual-qa.md<br/>06-decisions-update.md · 07-state-update.md<br/>08-memory-impact.md"]
  T6 --> X["✗ rewrites the artifact the agent<br/>already wrote and locked"]
  T3 -.->|"phase 8 only, AFTER closeoutPhase"| T7["runPhase8Trigger(rerun, extractorAvailable,<br/>spawnExtractorRunner — FU-5)"]
```

**Measured from `runtime.closeoutRun` (L320-362):**

- A **workspace-scoping guard**: the run must sit under `<root>/.recursive/run`, else
  `Run not found in current workspace`. It never crosses workspaces.
- The **T30 training trigger is already receipt-based and re-run-only** — `rerun` is true when phase 08
  *already has a lock receipt* before this call, so a first lock cannot train a run on itself. That is the
  reference "locked 08 rerun" semantics, implemented in the RUNTIME rather than in the closeout: a placement
  difference, not a missing feature.
- The **drain is computed before the write**, because the FU-8 guard throws for exactly the re-run case and a
  drain placed after it would never run when it matters most.
- **`closeoutPhase` is called with no options, so `strict` is TRUE in production**: the prerequisite refusal
  is live, and `{ strict: false }` appears only in tests.

> **[!] A CONSEQUENCE WORTH STATING: the training-trigger path is effectively UNREACHABLE in production.**
> `runPhase8Trigger` runs *after* `closeoutPhase`, and on the only run that should trigger it — phase 08
> already closed out once, so its artifact is LOCKED — the FU-8 guard throws first, so the trigger never
> runs. The two mechanisms are individually right and mutually blocking. The closeout should never have been
> writing at all, which is why a guard against writing kept turning into an obstacle.

### 3d · The reference's control flow, for comparison **[R]**

```mermaid
flowchart TD
  R1["the reference's closeout, run per phase 04|05|06|07|08"] --> R2{"prerequisites locked?"}
  R2 -->|no| R3["WARN only —<br/>hard enforcement is at lock time"]
  R2 -->|yes| R4{"phase 08 AND exists<br/>AND locked AND not --force?"}
  R3 --> R4
  R4 -->|yes| R5["RUN THE PHASE-8 TRAINING TRIGGER<br/>recursive_closeout --phase 08 (the re-run)<br/>in-process in training.ts"]
  R4 -->|no| R6{"artifact exists<br/>AND not --force?"}
  R6 -->|yes| R7["no-op: 'exists, not overwriting'<br/>exit 0"]
  R6 -->|no| R8["scaffold + write<br/>(+ preview URL for 05,<br/>non-zero if it cannot parse)"]
```

**The four postures worth carrying over:** prerequisites **advisory**; an existing artifact is a **no-op at
exit 0**; a **locked 08 rerun runs the training trigger**; `--force` overwrites.

---

## 4 · The training path (the "training thing")

```mermaid
flowchart LR
  A["08-memory-impact LOCKED"] --> B{"closeout for 08<br/>run again?"}
  B -->|yes| C["the phase-8 training trigger<br/>(in-process: training.ts)"]
  A2["or 08 re-run through the runtime (T30)"] --> C
  C --> D{"fewer than 2 phase-8-locked runs?"}
  D -->|yes| E["refuse: 'one run is an anecdote' (exit 3)"]
  D -->|no| F{"extractor available?"}
  F -->|no| G["refuse (exit 2)"]
  F -->|yes| H["spawn extractor<br/>stdio ignore + response file"]
  H --> I["items → groups"]
  I --> J["memory/domains/&lt;subsys&gt;.md<br/>memory/training/&lt;mode&gt;.md<br/>+ MEMORY.md line REPLACED"]
```

**[M]** The two refusals carry distinct exit codes, the extractor is spawned with piped stdio avoided and a
response file, and a fresh run's `memory/domains` + `memory/training` are `.gitkeep`-only until the second
completed run.

---

## 5 · What a run leaves on disk **[M]**

```
.recursive/
  RECURSIVE.md · STATE.md · DECISIONS.md · AGENTS.md
  config/{guard-decisions.jsonl, recursive-router.json}
  memory/{MEMORY.md, domains/, training/, skills/, episodes/, incidents/, patterns/, archive/}
  run/<runId>/
    00-requirements.md … 08-memory-impact.md      ← the phase artifacts
    locks/<stem>.receipt.json                     ← one per lock
    evidence/{logs,other,perf,review-bundles,router,screenshots,traces}/
    addenda/ · router-prompts/ · operations/operations.jsonl
    subagents/<delegationId>/{handoff.md, child-<childId>/{brief.md, reply.md}, <ts>-<id>-action.md}
```

Repo-root pointers written by the plugin: `CLAUDE.md`, `.cursorrules`, `.agent/PLANS.md`,
`.codex/AGENTS.md`, `.github/copilot-instructions.md`.

---

## 6 · The closeout, corrected — what changes

| | today **[!]** | intended **[D]** |
|---|---|---|
| direction | **writes** the artifact | **reads** the artifact |
| output | a stub with section titles | a report + instruction to the agent |
| on a locked artifact | throws (FU-8 guard) | reports status; never writes |
| on a complete artifact | overwrites it | says it fits the standard |
| ledgers | named in prose inside the overwritten doc | the thing being verified |
| phase-08 rerun | blocked by the guard | **runs the training trigger** |

**Work items:** (1) rewrite `closeoutPhase` read-only, returning per-phase findings plus the instruction text;
(2) build the finding list from `getArtifactRequiredSections` / `getGateStatus` / `phaseLintRulesMessage`
rather than from `closeout.ts`'s private maps; (3) delete the write path; (4) keep the training trigger and
adopt the reference's advisory/no-op/`--force` postures; (5) wire the report through the closeout tool so the
agent is actually told.
