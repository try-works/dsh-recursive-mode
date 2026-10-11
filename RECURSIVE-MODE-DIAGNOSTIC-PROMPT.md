# Diagnostic run: recursive-mode, live, in a temp workspace

You are running a LIVE diagnostic of the `recursive-mode` plugin. Your job is to EXERCISE it and REPORT what happens.
Your job is NOT to fix anything, not to make it work, and not to judge whether the plugin is good.

## Ground rules

1. **WORK IN A TEMP WORKSPACE.** Create a fresh empty directory and do all work there. Nothing you do may touch
   `D:\DEV\dsh-recursive-mode` (the plugin source) or `D:\deepseek-harness` (read-only). Suggested:
   `E:\tmp\rm-probe-<yyyy-MM-dd-HHmm>`.
2. **REPORT ONLY WHAT HAPPENED.** Quote tool output VERBATIM, in fenced blocks, including refusals, partial output and
   errors. Never paraphrase a refusal. Never summarise a success into a claim you did not observe.
3. **DISTINGUISH THREE THINGS, and label every finding as one of them:**
   - **OBSERVED** — you ran it and saw this exact output.
   - **INFERRED** — you concluded it from something you observed, and you say what.
   - **NOT TESTED** — you did not reach it, and you say why.
4. **DO NOT FIX ANYTHING.** If a tool refuses, record the refusal and continue. Do not edit the plugin, do not edit the
   scaffolded docs to make something work, do not retry with a workaround unless the refusal itself tells you to.
5. **NEGATIVE RESULTS ARE THE VALUABLE ONES.** "X did not happen" is a finding worth more than "Y worked". If you finish
   and nothing went wrong, say that plainly — but only after you have actually attempted every step below.
6. **DO NOT REPAIR THE RUN.** If a phase refuses, that is data. Do not hand-edit an artifact to get past a gate.

## Before you start: record the environment

Do these first and put them in your report verbatim:

- The installed plugin version and the pinned version:
  `%USERPROFILE%\.dsh\profiles\web\package.json` (the `@try-works/dsh-recursive-mode` pin) and
  `%USERPROFILE%\.dsh\profiles\web\node_modules\@try-works\dsh-recursive-mode\package.json` (the installed version).
  **These must agree**; if they disagree, STOP and report that, because a mismatch means the profile is broken.
- Whether the ENFORCEMENT MODE IS LIVE. The plugin's default is now **strict** (it was `advisory` in 0.4.9 and earlier),
  so confirm which behaviour you actually get. Grep the installed bundle for these literals and report the counts:
  `Select-String -Path <installed>\lib\index.js -Pattern 'memory-read','no memory read is recorded for phase 0','phase8-memory-missing','Memory is READ AT PHASE ENTRY' -SimpleMatch`
  A count of 0 for a literal means that feature is NOT in the build you are running — say so and stop expecting it.
- Your tool list: call your tool-listing capability and report the exact names and count of every `recursive_*` tool you
  can see. **13 is expected.** Report a name you did not expect and a tool you expected but cannot see.

## The behaviours to exercise, in order

Attempt every step. If a step is refused, quote the refusal and move to the next.

### 1. Create a run — and check that it creates NO goal and NO autonomous rounds

Ask for a run spec (something small and self-contained, e.g. "a spec for a command-line todo app"). This should call
`recursive_init`.

Then check, and report each separately:

- **A goal must NOT exist.** Call your goal-reading capability (e.g. `get_goal`) BEFORE and AFTER `recursive_init` and
  quote both results. Creating a spec must not arm a goal, must not start autonomous continuation rounds, and the
  `run-start` gate must not have been answered. This is a deliberate design rule: **phase 0 requires explicit approval
  to start a run and a goal.**
- **All twelve artifacts should be scaffolded**: `00-requirements.md`, `00-worktree.md`, `01-as-is.md`,
  `01.5-root-cause.md`, `02-to-be-plan.md`, `03-implementation-summary.md`, `03.5-code-review.md`, `04-test-summary.md`,
  `05-manual-qa.md`, `06-decisions-update.md`, `07-state-update.md`, `08-memory-impact.md`. List what was actually
  created, with sizes. Report any that are missing.
- **Report the scaffolded docs' own instructions.** Open the workspace's `CLAUDE.md`, `.recursive/AGENTS.md` and
  `.recursive/RECURSIVE.md` and report whether they name REAL `recursive_*` tools. **Search them for `python`,
  `.recursive/scripts/`, and `.py`** and report every hit verbatim. (In earlier live runs these files instructed agents
  to run `recursive-lock.py` — a file that does not exist — and no run ever locked a phase as a result. If you find such
  an instruction, that is a MAJOR finding: report the file, the line and the text, and DO NOT follow it.)

### 2. The memory-read gate — and the empty-plane trap

The rule: **memory must be READ before `00-requirements.md` is written.** The read happens when you call
`recursive_phase`. In a fresh workspace the memory plane is EMPTY, and an empty plane must still SATISFY the gate —
"the read is what is required, not a match".

- **First, try to write `00-requirements.md` WITHOUT calling `recursive_phase`.** Report exactly what happens. Expected:
  a refusal naming `memory-read` and telling you to call `recursive_phase`. **If the write SUCCEEDS, that is a major
  finding** — the gate is not in force in the build you are running.
- **Then call `recursive_phase`** and quote its FULL output. Report separately: what `memory` contains, what
  `memoryReason` says, and whether the tool description mentions memory. On an empty plane, `memory` should be empty and
  `memoryReason` should say why — **that is a normal result, not a failure.**
- **Then retry the write.** It should now be allowed. If it is still refused, quote the refusal.
- Look for `.recursive/run/<runId>/memory-injections.json` and report its contents — it should carry a read receipt for
  the phase, even though nothing was injected.

### 3. Strict enforcement on writes — the phase-order rule

With `toolGuards: strict` (the shipped default), a write to a LATER phase artifact must be REFUSED pre-dispatch.

- From phase 0, try to write `08-memory-impact.md` directly. Quote the refusal. Expected: it names the active phase, the
  target's phase, and the rule `phase-order`. **If it succeeds, report that** — strict is not in force.
- Confirm support files are NOT refused: write a scratch file under the run's `evidence/` or `scratch/` directory and
  report whether that was allowed.

### 4. THE MAIN QUESTION: does ANY phase lock?

**This is the most important measurement in the whole probe.** Three previous live runs completed every artifact and
locked NOTHING — all twelve artifacts stayed `DRAFT`, and `operations.jsonl` recorded no lock operation at all.

- Do the phase-0 work properly (requirements with real content), then **call `recursive_lock` on `00-requirements.md`**
  and quote the result verbatim — success or refusal.
- If it is refused, quote the FULL refusal text and say which condition it names. Then try to satisfy exactly what the
  refusal asks for and retry ONCE. Report both attempts.
- If a lock succeeds: report the artifact's new `Status:` line, whether `.recursive/locks/<artifact>.receipt.json`
  appeared, and what `operations/operations.jsonl` recorded.
- **Report how many of the twelve artifacts end up LOCKED.** Zero is a finding of the highest importance; say so
  directly rather than burying it. One lock is the proof that the rest of the chain can work at all.

### 5. Phase 8 must WRITE the plugin's own memory

The rule: locking `08-memory-impact.md` is REFUSED unless this run has written a doc under `.recursive/memory/` whose
own text carries `Source-Runs` naming THIS run.

- If you reach phase 8: try to lock `08-memory-impact.md` before writing any memory doc. Quote the refusal.
- Then write a memory doc under `.recursive/memory/` — `memory/episodes/<runId>.md` is always available — declare its
  path in the artifact's `## Affected Memory Docs` section, and give the file `Source-Runs: <runId>`. Retry the lock and
  quote the result.
- **Report whether the run wrote anything to `.recursive/memory/` at all, and what.** In an earlier live run, phase 8's
  artifact claimed `[x] Write the durable ones to memory` while its stated memory input was another plugin's tools
  (`memory_search`/`memory_status`) and `.recursive/memory/` still held only bootstrap placeholders. **If you observe a
  run declaring the memory step done without writing to `.recursive/memory/`, that is a major finding.**

### 6. Does `recursive_phase` actually return memory? (the read is the learning half)

- Report whether `recursive_phase`'s payload contains `memory` and `memoryReason` fields at all, and quote them.
- Report the five kinds the loader is supposed to read: `domains`, `patterns`, `episodes`, `training`, `skills`.
  `incidents/` and `archive/` are deliberately NOT read.
- If you can, put a shard in `.recursive/memory/training/` and re-enter a phase, then report whether it is injected.
  **Do this only if it does not compromise the run** — a diagnostic is allowed to add a memory shard, but say what you
  added.

### 7. The cross-run training trigger (likely NOT REACHABLE — say so if it is not)

`recursive_closeout --phase 08` on a RE-RUN triggers the learnings extractor, but it requires **at least two LOCKED
runs** ("one run is an anecdote") and a configured executor command `RECURSIVE_TRAINING_EXTRACTOR_CMD`. Report:

- whether you reached a closeout at all;
- the tool's output verbatim, including any exit code it reports (`INSUFFICIENT_EVIDENCE` = fewer than two locked runs;
  `EXTRACTOR_UNAVAILABLE` = the executor command is unset);
- whether `memory/training/<task-type>.md` was created and whether `.recursive/memory/MEMORY.md` was updated.

**If you have zero or one locked run, this is expected to be unreachable. Say "NOT REACHABLE — fewer than two locked
runs" rather than reporting it as a failure.**

## The data to collect — write it to a file, not just to your reply

Create `E:\tmp\rm-probe-<stamp>\REPORT.md` in the temp workspace and put everything below in it, then give me a short
summary plus the path.

1. **Every refusal, verbatim**, in fenced blocks, with the tool call and arguments that produced it. The refusal TEXT is
   the primary data — the plugin has a history of refusals that named the wrong cause, so the exact wording matters.
2. **The phase table**: for each of the twelve artifacts — name, `Status:` line, byte size, last-modified time. The
   ORDER of the modification times matters as much as the statuses: a run that writes phase 8 before phase 1.5, or
   writes all twelve within the same minute, tells you the chain was bypassed even if nothing refused.
3. **`operations/operations.jsonl`** in full (it is usually tiny; an empty or single-line file is itself a finding).
4. **`subagents/`**: every file and directory, with sizes and timestamps. If you delegate, report whether a `reply.md`
   appeared, whether the record says `Status: accepted`, `failed` or `parked`, and **quote the record's `Status:` and
   `Failure:`/`Parked:` lines**. A parked delegation means the child had not reported YET — it is not a failure, and the
   record must say so.
5. **`memory-injections.json`** and anything under `.recursive/memory/` you or the run wrote.
6. **The agent-visible surface**: the `recursive_*` tool names and count you can see; the model-facing policy text if you
   can read it; the tool descriptions for `recursive_phase`, `recursive_lock` and `recursive_init`.
7. **A timeline**: the wall-clock time of every significant call you made (init, each `recursive_phase`, each write,
   each lock attempt), so the reader can see whether anything waited or stalled. **If a call takes an unexpectedly long
   time before failing, time it and report the duration** — an earlier probe failed after 22.9 seconds of silence, and
   the duration was the clue that identified the cause.
8. **What you did NOT test, and why.** Be specific: "did not reach phase 3 because the phase-1 lock was refused".

## The report's shape

Finish with these sections, in this order, and keep them short:

- **VERDICT**: one paragraph. Did the workflow run end to end, partially, or not at all? How many phases locked?
- **WHAT WORKED**: each item marked OBSERVED, with the evidence.
- **WHAT FAILED OR DID NOT HAPPEN**: each item, with the verbatim output that shows it.
- **WHAT I COULD NOT TEST**: with the reason.
- **THE SINGLE MOST IMPORTANT FINDING**: if you had to tell me one thing, what is it? If the answer is "no phase ever
  locked", say exactly that.

Do not describe the plugin's design or repeat its documentation back to me. I want what you observed, in the workspace
you created, with the output quoted.
