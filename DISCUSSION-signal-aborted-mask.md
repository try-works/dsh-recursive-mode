# Discussion post: `isCancellation` throws over the error it was asked to classify

**Suggested category:** General (it is a defect report with a proposed one-line fix; Q&A is for questions).

---

## Summary

`packages/subagent/subagent/src/control.ts` reads `signal.aborted` **without optional chaining**, while its own
sibling in the same package guards the identical read. When `signal` is `undefined`, the classifier throws a
`TypeError` **in place of** the error it was called to classify — so the caller sees

```
Cannot read properties of undefined (reading 'aborted')
```

instead of the real failure, and the real failure is never logged.

## The code

```ts
// packages/subagent/subagent/src/control.ts  L105-107
function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof SubagentError && error.code === 'CANCELLED')
}
```

called from `rejectPrompt` (same file, L56-58):

```ts
export function rejectPrompt(error: unknown, childSessionId: SessionId, signal: AbortSignal): never {
  if (isCancellation(error, signal)) {
    throw new RemoteError('gateway/cancelled', 'subagent prompt was cancelled', {}, { cause: error })
  }
  …
```

which is called from the prompt-delivery catch in `index.ts` (L463-465):

```ts
} catch (error: unknown) {
  return rejectPrompt(error, childSessionId, signal)
}
```

**And the sibling guards it:**

```ts
// packages/subagent/subagent/src/list-children.ts  L130
if (signal?.aborted) {
```

One of those two is wrong, and it is not the guarded one.

## Impact

A caller cannot correct its own side, because the information does not exist on the caller's side of the boundary:

1. **The original error is replaced inside the host** before any of it reaches the plugin that called
   `startContinuable`.
2. **Nothing is logged.** A full live run left `stderr.txt` and `stderr-resume.txt` at **0 KB**, with no log
   directory and no other mention of the failure — the session log's only trace was my plugin's own record of the
   masked message.
3. **The workarounds are the masked path.** The operations that would surface the real error — re-delivering the
   prompt, classifying the refusal — are exactly the ones behind the mask.

In my case this cost **six rounds** of investigation. I added instrument after instrument to my own surfaces (a
specific fallback reason, a lossless-JSON projection, a failure line in an action record, the tier and provider
name in the message) and each one faithfully reported the `TypeError` — because the `TypeError` is what arrived. I
chased the wrong cause for six rounds and twice declared a *falsified* hypothesis, with evidence, about a failure
that was not the failure.

## Why I think this is worth a change rather than a local workaround

**An error handler must not replace the error it handles.** A masked error is worse than a missing one: a missing
error is visible as absence, while a mask looks like an answer, and callers trust answers.

The pattern is also easy to reproduce accidentally, because the function's *type* says `signal: AbortSignal` — so
a caller reading the signature has no reason to think the value can be absent. The type is a promise the code does
not keep at this one point.

## Proposed fixes, smallest first

**1 · One character — guard the read:**

```ts
return signal?.aborted || (error instanceof SubagentError && error.code === 'CANCELLED')
```

**2 · Or make the classifier unable to destroy its input.** Keep the original error attached no matter what the
classification does:

```ts
function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  try {
    return signal?.aborted === true || (error instanceof SubagentError && error.code === 'CANCELLED')
  } catch {
    return false
  }
}
```

**3 · And a log line, which is the part that would have ended this in one round.** `logger.warn` is already used
elsewhere in that same file (e.g. the disposal-after-catalog-append-failure path), so the cost is one line:

```ts
} catch (error: unknown) {
  // One line here would have saved six rounds of downstream debugging.
  this.ctx.logger.warn(`subagent: prompt delivery failed: ${String(error)}`)
  return rejectPrompt(error, childSessionId, signal)
}
```

## What I can provide

I have the change written and verified in my own tree, with the reasoning above; I am happy to post it as a patch
or a diff against `639ed015` if that is more useful than the snippet. I did **not** attempt a PR, since this
repository does not accept them.

## Environment, if it helps reproduce

- Checkout at `639ed015397290b3745d163aafe02ffee4aa3f84` (merge of #5479, release `0.2.0-rc.2`).
- Reached through `ctx.subagents.startContinuable(...)` from a plugin, with a provider resolved as `spawn` via
  `tool-subagent`'s own call pattern.
- The `TypeError` surfaces as the *reason* a continuable delegation reports `fellBackToOneShot`, i.e. as
  "no continuable repair path" — which is how it first reached me, and why it looked like a plugin bug for so
  long.

Thanks — and if the answer is "the signal is guaranteed present on this path and the caller is wrong", I would
genuinely like to know, because that would mean the fix belongs on my side and the failure has a different cause
than the one I measured.
