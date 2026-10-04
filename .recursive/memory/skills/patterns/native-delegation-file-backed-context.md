Type: pattern
Status: CURRENT
Scope: How the dsh-recursive-mode plugin implements native, optional, context-contract delegation: file-backed review bundles and handoff docs, a TS-native router over the declarative recursive-router.json policy, plugin-driven ctx.subagents.start() with the full request shape, reference validation, and durable action records — all preserving the workspace-scoping invariant and fail-loud optionality.
Owns-Paths:
Watch-Paths:
- /.recursive/run/
- /.recursive/config/recursive-router.json
- /.recursive/memory/skills/SKILLS.md
Source-Runs:
- 04-phase-b-delegation
Validated-At-Commit: promoted-from-run-04-phase-b-delegation
Last-Validated: 2026-08-16T15:00:00Z
Tags:
- skills
- recursive-run
- delegation
- subagents
- review-bundle
- handoff
- router
- plugin

# DSH Plugin Native Delegation (File-Backed Context Contract)

Phase B of the dsh-recursive-mode plugin adds a native delegation stack. The pattern keeps
delegation optional (self-audit when no provider is registered), fail-loud (capability
mismatches reject), and workspace-scoped (every path resolves under the control-plane root).

## Rule 1 — Policy stays declarative; execution is TS-native

- Keep `/.recursive/config/recursive-router.json` as the declarative role-routing policy
  (enabled/mode/cli/model/fallback + probe/invoke timeouts). Never hard-code role routes in
  the plugin.
- Resolve roles in the plugin (`src/router.ts`): native DSH subagent provider -> external-CLI
  route -> self-audit / local-controller fallback. A missing provider, missing policy, or
  failed probe resolves to self-audit — never a hard failure (optionality-preserving).
- Do not vendor external-CLI router wrappers in the TS plugin; external-CLI invocation is a
  separate harness concern (the policy still declares the route, but the plugin only
  consumes it for decisions and probes).

## Rule 2 — File-backed context-in contract

- Build a review bundle under `<run-dir>/evidence/review-bundles/<phase>-bundle.md` with an
  `Artifact Path` + `Artifact Content Hash` (LF-normalized sha256) header and the 8 canonical
  headings (Diff Basis, Changed Files Reviewed, Upstream Artifacts To Re-read, Relevant
  Addenda, Prior Recursive Evidence, Targeted Code References, Audit Questions, Required
  Output).
- Also materialize a main-agent `handoff.md` plus per-child `brief.md` / `reply.md`; make the
  delegation prompt reference-based (pointers, not a monolithic paste) so the child reads the
  files it needs.
- The plugin calls `ctx.subagents.start(provider, request)` with the FULL request:
  `prompt`, `label`, `outputSchema`, `toolFilter`, `maxDepth`. Fail loud with typed errors
  (NO_PROVIDER / UNSUPPORTED_CAPABILITY / DELEGATION_FAILED) — never accepted-then-ignored.
- A capability probe (`capabilityProbe`) must gate the choice: no provider -> self-audit
  fallback with a recorded decision basis.

## Rule 3 — Child-scoped scratch + reference validation + action records

- Each delegated child gets its own disposable scratch under `<run-dir>/scratch/<child-id>.md`
  (escape-guarded); the parent's `scratch/scratch.md` stays the main agent's working memory.
  A child may read the parent scratch only when the prompt includes it; writes go only to the
  child's own file.
- Validate a child's claimed references against actual files (path exists + line-range
  bounds) before acceptance.
- Write a durable action record (Metadata / Inputs Provided / Claimed Actions Taken / Claimed
  File Impact / Claimed Artifact Impact / Claimed Findings / Verification Handoff) with
  `success:false` marked failed; treat `success:false` or a non-completed stopReason as a
  failed attempt (preserve diagnostics, rerun or fall back, then verify).
- Prefer a stable reviewed artifact (e.g. a locked implementation summary) for the bundle's
  `Artifact Path` so the hash is not circular; the bundle itself is not lock-validated, so its
  hash can be finalized after the reviewed artifact locks.
