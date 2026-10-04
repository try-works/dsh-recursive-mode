Type: pattern
Status: CURRENT
Scope: How the dsh-recursive-mode plugin enforces its workflow through DSH's native lifecycle seams: a lifecycle.ts transition set + log-folded recursive/* events, an agent/pre-step phase-transition gate and tools/pre-execute surgical guards (both callers of the transition set), a recursive:policy prompt section, goal-round pause-on-block coupling, configurable strict|advisory enforcement (default advisory), and fs/observed lock-tamper warnings.
Owns-Paths:
- dsh-recursive-mode/src/lifecycle.ts
- dsh-recursive-mode/src/enforcement.ts
- dsh-recursive-mode/src/policy.ts
Watch-Paths:
- /.recursive/run/
- /.recursive/memory/skills/SKILLS.md
- dsh-recursive-mode/src/runtime.ts
- dsh-recursive-mode/src/index.ts
Source-Runs:
- 05-phase-c-enforcement
Validated-At-Commit: promoted-from-run-05-phase-c-enforcement
Last-Validated: 2026-08-16T17:00:00Z
Tags:
- skills
- recursive-run
- enforcement
- lifecycle
- gates
- policy
- goals

# Pattern: enforcement-layer-model

- **Type:** pattern
- **Status:** CURRENT
- **Source-Runs:** 05-phase-c-enforcement
- **Summary:** recursive-mode workflows are enforced through cooperating DSH layers, not a single hook.

## Rules

1. **Layers 1 and 2 call the lifecycle transition set; they never duplicate it.** The `agent/pre-step` phase-transition gate and the `tools/pre-execute` surgical guards delegate gate checks to `lifecycle.ts` (`validateTransition`) — a single definition of the predicates, multiple callers.
2. **Enforcement strictness is configurable `strict|advisory` per gate (default advisory).** strict flips reject/deny; advisory emits `recursive/gate-blocked` (warn) and lets the step through; the config rides the plugin config, never the workflow files.
3. **State is derived, never cached.** `recursive/*` events are log-only; the fold re-derives the in-force phase on every transition (resume/fork-safe); a manifest-style second store is drift waiting to happen.
