# DSH limitations found while building this plugin

**What this is.** Every entry below was hit while building or verifying `dsh-recursive-mode` against DSH in this
workspace, and each one records **how it was measured**, **what it forced us to do instead**, and **what a
future DSH release could provide**. These are limitations of the *host*, not of this plugin — the plugin works
around every one of them, and the workarounds are what make the plugin more complicated than it should be.

**What this is not.** A wish list. Nothing here is inferred from a README; each item has an observation behind
it, and where the observation was indirect that is stated.

---

## 1 · ~~A parked continuable child never gets a turn in a one-shot session~~ — **RETRACTED**

> **⚠ THIS ENTRY WAS WRONG, AND THE EVIDENCE THAT KILLED IT WAS IN THE RUN ITSELF.** The claim was that a child
> was started and then never given a turn. Reading the plugin's own **action record** for that delegation shows
> what actually happened:
>
> ```
> - Execution Mode: self-audit (continuable)
> - Status: failed
> ```
>
> **The delegation never happened.** The plugin fell back to self-audit because it could not resolve the
> subagents service, so no child was ever started — which is why there was no child session, no settlement and
> no reply. The child directory I kept pointing at is written by the **plugin's own brief writer**, before any
> service call, so it proves nothing about the host. I read directories instead of the record that said
> `Status: failed`, and built a host-limitation story on top of it.
>
> **The real cause is a composition-ordering trap in the plugin, not a DSH limitation:** `index.ts` resolves the
> seam with a one-shot `ctx.get('subagents')` during `apply`, while the harness's own pattern is
> `ctx.inject(['subagents'], …)`. If the service is mounted by a later layer, the get returns undefined and
> nothing re-resolves it. The name is correct — `@deepseek-ai/dsh-subagent` does `super(ctx, 'subagents')`.
>
> Kept rather than deleted, because the mistake is the instructive part: **a truthful status field was sitting
> in an artifact I had already opened, and I preferred my own story to it.**

## 1b · (original entry, superseded — kept for the record) A parked continuable child never gets a turn in a one-shot session

**Measured.** A live headless session with this plugin mounted delegated a review, wrote
`subagents/03-review/child-<id>/brief.md`, and then **nothing happened**: no child session was created, no
`settlements.jsonl` appeared, and the child's `reply.md` was never written. Driving more parent turns ran more
rounds but still never drove the child. The control that explains it: the harness's own team fixture, same
recipe, reported *"both teammates and dependent tasks completed"* and wrote **3 session logs** — so the host
**does** drive children, but only while the parent is **active**. The engine contract says why:
`submitAdmitted` *"crosses the final admission cutoff and **submits without yielding**"*
(`packages/subagent/subagent/lib/types/continuation-activation.d.ts`).

**What it forces.** A plugin cannot fire a continuable child and return. It must keep the parent waiting, and
at present the only way to observe a child's settlement is a **seam the plugin injects itself**
(`awaitRoundResult`), because the host exposes no awaitable handle. Our own first attempt parked instead of
waiting, and the consequence was that in production the child never ran at all.

**What DSH could provide.** An **awaitable child settlement** — a promise or handle from
`startContinuable`/`submitAdmitted` — or an idle pump that drains child inboxes while a session has no active
turn. Either would make "delegate, then read the answer" a one-line operation instead of a seam.

---

## 2 · `ctx.provide(...)` alone does not reach `ctx.get(...)`

**Measured.** In the FU-1 harness, providing a structural `subagents` service was not enough: the drain
reported *"no subagents runtime is mounted"* until the value was **also** put on the context with `set`.
Both calls are needed; the type surface does not say so.

**What it forces.** Every test harness that mounts a service must know a two-step incantation, and the failure
mode is silent: `ctx.get` returns nothing and the consumer reports its own "not mounted" path, which looks like
a configuration choice rather than a mistake.

**What DSH could provide.** One call that declares *and* sets, or a **loud error** when a service is provided
but not retrievable — the silent version cost real time here.

---

## 3 · A spawned child process cannot use piped stdio

**Measured.** The extractor spawn failed with **EPERM** whenever stdio was piped. The production runner
therefore uses `stdio: 'ignore'` and exchanges results through a **response file**
(`RECURSIVE_TRAINING_RESPONSE_FILE`). Capture is impossible; files are the only channel.

**What it forces.** Any plugin that shells out must invent a file protocol — write a request file, read a
response file, and decide what a missing file means. That is a lot of machinery for "run this and tell me what
it said", and it is the reason this plugin's training path looks heavier than it is.

**What DSH could provide.** An approved capture mechanism for spawned processes, or a documented
file-handshake helper. If the restriction is deliberate, saying so *in the spawn API* would save the
experiment.

---

## 4 · `--session-id` needs the full prefixed id, and the error does not say so

**Measured.** Resuming with the bare UUID fails: `dsh: session "<uuid>" does not exist; omit --session-id to
start a new Session`. The value the CLI wants is the whole `session-<uuid>`, which is also what the session
log's own `id` field carries. With the prefix it resumes cleanly (`resume exit: 0`).

**What it forces.** A caller that reads an id from a log or a directory name has to know to keep the prefix —
and the error message names neither the expected form nor the place the id comes from.

**What DSH could provide.** Accept either form, or echo the expected shape in the error
(*"expected session-<uuid>"*).

---

## 5 · A plugin package cannot be listed in `dsh.profile.bundles`

**Measured.** Neither `@deepseek-ai/dsh-workflow` nor `@deepseek-ai/dsh-tool-workflow` declares a `dsh` block.
A bundle must declare `dsh.bundle.patch` (as `@deepseek-ai/dsh-headless` does), so neither can appear in
`dsh.profile.bundles`. They are ordinary plugin packages that export a Cordis plugin and resolve their own
dependencies, and they mount only through a patch row **by file URL**.

**What it forces.** Mounting a first-party package requires knowing its path inside the checkout and writing it
into a profile patch, with the version relationship left implicit. There is no "add this plugin" path for a
package that is plainly a plugin.

**What DSH could provide.** Let `bundles` accept a plugin package, or ship a workflow bundle so the capability
is reachable the same way the other bundled features are.

---

## 6 · Client plugins need a build, and nothing says which one

**Measured.** `@deepseek-ai/dsh-client-ui-workflow-run` declares
`dsh.client = { platform: "web", inject: [...] }` — a **client** plugin, not a bundle. Mounting it in a web
profile is a patch row, but its code reaches the page through a **build**, not from source.

**What it forces.** Installing a UI plugin is not a configuration change; it is a build step whose exact
command is not discoverable from the plugin's own metadata. This is why we stopped at the engine and did not
install the run viewer.

**What DSH could provide.** State the build requirement in the plugin's metadata (or in the loader's
diagnostics when a client plugin is mounted without one), and name the command that produces it.

---

## 7 · A malformed profile reports the wrong cause

**Measured.** A hand-written headless profile was rejected with
`error: option '--profile <name>' argument 'headless' is invalid. select a profile only once` — which reads
like a CLI flag problem. The actual cause was that the profile lacked the fixture's **dependency list and its
three bundles**; copying the working recipe verbatim fixed it with no flag change at all.

**What it forces.** Debugging a profile by bisection against a known-good one, because the message points at
the wrong layer.

**What DSH could provide.** A validation error that names the missing piece — *"profile 'headless' declares no
bundles"* — rather than a flag complaint.

---

## 8 · Client-plugin changes reload only with a watcher

**Measured** (stated in this session's own runtime context, not independently re-tested here): client-plugin
changes reload without a page refresh **only while `pnpm run dev:web` is running** from the same checkout.
Everything else — the web shell, plain packages — requires rebuilding the affected artifacts and refreshing.

**What it forces.** A contributor has to hold two rules in their head, and the failure looks like the change
was ignored rather than like a stale bundle.

**What DSH could provide.** A visible build stamp in the UI, or a console warning when a client plugin's source
is newer than its bundle.

---

## The shape of these

Seven of the eight are the same complaint in different clothes: **the system knows something the caller
cannot see, and the failure is silent or misattributed.** The child that never runs, the service that is
provided but not retrievable, the profile that is invalid for a reason it does not name, the client plugin that
needs a build nobody mentions. Each cost an experiment here that a better error, or an awaitable handle, would
have made unnecessary.

None of them is a reason not to use DSH. They are the reason this plugin has as much scaffolding as it does —
and they are worth revisiting when a release addresses any of them, because several workarounds (the injected
settlement observer, the response-file protocol, the file-URL patch rows) could then be deleted outright.

---

## 9 · An error-classifier crashes over the error it was asked to classify

**Measured.** `packages/subagent/subagent/src/control.ts` L105-107:

```ts
function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof SubagentError && error.code === 'CANCELLED')
}
```

called from `rejectPrompt` (L56-58), itself called from the prompt-delivery catch at `index.ts` L464:

```ts
} catch (error: unknown) {
  return rejectPrompt(error, childSessionId, signal)
}
```

When `signal` is `undefined`, the **first** thing `isCancellation` does is throw
`Cannot read properties of undefined (reading 'aborted')` — so the TypeError **replaces the error it was called
to classify**, and the caller sees only the classifier's crash.

**What it forces.** The original failure becomes invisible. In this workspace it hid the real cause for **six
rounds** of live experimentation: every run reported the property read, and every instrument I added to my own
surfaces faithfully reported it too. The failure has no relationship to the code that failed.

**And it is inconsistent inside one package:** `list-children.ts` L130 guards the same read as
`if (signal?.aborted)`. One of those two is wrong, and it is not the guarded one.

**What DSH could provide.** `signal?.aborted` at L106. Better still, a classifier that cannot throw over its
input — wrap the classification so a crash there is attached as a `cause` rather than thrown in place of the
original. **A masked error is worse than a missing one:** a missing error is visible as absence, while a mask
looks like an answer.

**Why this entry is written even though it is one line.** Nine other entries here describe surfaces that said
too little. This one **lied**, and the cost was six rounds — which is the argument for treating "an error
handler must never replace the error" as a rule rather than a style preference.
---

## 10 · A plugin cannot recover the error that a host mask destroys

**Measured.** Entry 9 describes the mask: `control.ts:106` reads `signal.aborted` unguarded, so the prompt-delivery
catch at `index.ts:464` reports the classifier's `TypeError` instead of the refusal that triggered it. This entry
records the consequence for a **caller**:

- the original error is **replaced inside the host**, before any of it reaches the plugin that called
  `startContinuable`;
- **nothing is logged.** A full live run leaves `stderr.txt` and `stderr-resume.txt` at **0 KB**, no log
  directory, and a session log whose only mention of the failure is the plugin's own record of the masked
  message;
- and the plugin **cannot** work around it: the operations that would surface it (re-delivering the prompt,
  classifying the refusal) are exactly the ones behind the mask.

**What it forces.** A plugin-side diagnosis has to stop and report, because the information does not exist on the
plugin's side of the boundary. In this workspace that is where a six-round investigation ended: seven hypotheses
eliminated by evidence (router tier, provider name, subagents seam, live parent, child brief, capability gate,
spec shape), every instrument honest, and the last unknown destroyed by a host line I am not free to change.

**What DSH could provide.** Two things, either of which would have ended it in one round: the `?.` at
`control.ts:106`; or a **log line** when a classifier throws over its input — `logger.warn` is already used
elsewhere in that same file, so the cost is one line. **A caller that can see the original error can fix its own
side; a caller that cannot, cannot.**

## 11 · A preset cannot be installed by writing a file, and the UI gives no reason why

**What it is.** The directory `~/.dsh/.agent-presets/<name>/` is **not a discovery path**. The registry
documents its parameter as *"Parsed configuration supplied by the declaring plugin"*, and the settings UI renders
whatever emote.agentPresets.list() returns. A package that ships a preset must declare a row naming
`@deepseek-ai/dsh-agent-preset` in a patch file listed by dsh.bundle.patch - which is an **array** for such a
package, not the plain string every plugin without a preset uses.

**What it cost.** A correct-looking installer wrote a correct-looking file to a path nothing reads, and printed
success. The preset had never appeared in the UI, and **the UI gives no reason**: the CUSTOM section simply lists
what the registry returned, so "not registered" and "registered badly" look identical from the outside. The
diagnosis came from a user screenshot, not from any output the system produced.

**What it forces.** Anyone packaging a preset has to find the declaration contract in the harness source. The
symptom is a missing row in a list, which points at the registry, which points at the plugin row - three hops
from a file that looks right.

**What DSH could provide.** Either make a stray directory a **visible** condition (a warning for
`agent-presets/` entries that were never registered), or say so in the UI: an empty CUSTOM section with one
line - *"no custom presets are registered; presets are declared by plugins, not placed in a directory"* - would
have turned a screenshot-plus-investigation into a single read.
