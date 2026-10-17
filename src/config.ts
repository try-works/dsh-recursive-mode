/**
 * T7 — the plugin's Config: the `recursive` settings namespace.
 *
 * HOW THE SETTINGS SERVICE ACTUALLY SEES THIS, measured against
 * `@deepseek-ai/dsh-settings`'s own types rather than assumed: `describe()` "read[s]
 * active plugin schemas and their live values", and `update(ns, patch, expectedRevision)`
 * "merge[s] editable fields into an entry's config". There is **no `register(...)` call
 * for a plugin to make** — the item's `registerEnforcementSettings(settings)` wording
 * describes a seam that does not exist. **Declaring this schema IS the registration:**
 * the Loader owns the profile entry, the service projects the schema into a form, and an
 * edit re-applies the plugin with the new config. That re-application IS the hot reload,
 * which is why there is no watcher here to keep in sync.
 *
 * VALIDATION IS NOT DUPLICATED. The schema is what the UI reads and what gives the form
 * its shape; `resolveEnforcementConfig` remains the STRICT validator (unknown keys
 * rejected, budgets required to be positive integers, fail-loud at load). A schema that
 * silently coerced a bad value would be a second, weaker contract beside the real one.
 */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_BUDGETS, DEFAULT_ENFORCEMENT_MODE } from './enforcement.ts'

/** One enforcement mode, as the settings form presents it. */
const enforcementMode = z.union([z.const('strict'), z.const('advisory')])

export interface RecursiveModeBudgets {
  maxAuditRounds?: number
  maxRepairAttempts?: number
  maxDelegationDepth?: number
  maxChildrenPerPhase?: number
  maxResultBytes?: number
}

/**
 * ⚠ FU-20 — ONE LEVEL OF THE PROVIDER/MODEL LADDER, as a settings form presents it.
 *
 * `provider` is the SUBAGENT provider (who creates the child: `spawn`, `fork`); `modelProvider` is the LLM
 * provider that SERVES the model (`deepseek-official`). Two names for two ideas, kept apart here because
 * conflating them was a real defect in this feature's first schema.
 */
export interface RecursiveModeSubagentRoute {
  provider?: string
  model?: string
  modelProvider?: string
}

export interface RecursiveModeRouter {
  defaults?: Record<string, string | number | boolean | undefined>
  /** FU-20 — the general subagent route: applies to every delegated child no narrower level claims. */
  subagent?: RecursiveModeSubagentRoute
  /**
   * FU-20 — PER ROLE: "code-reviewer runs on this model". The owner's first ask.
   *
   * ⚠ THIS IS HOW THE SETTING REACHES THE PLUGIN WITHOUT TOUCHING `src/index.ts`. That file already forwards the
   * plugin's whole `router` config section to `setRouterOverrides` (`index.ts:362`), so anything DECLARED here
   * arrives at `loadRouterPolicy` by construction — the schema is the seam, and `index.ts` is not edited.
   */
  roles?: Record<string, RecursiveModeSubagentRoute>
  /** FU-20 — PER PHASE: "phase 3.5 runs on this model". Overrides the role level; see the schema description. */
  phases?: Record<string, RecursiveModeSubagentRoute & { role?: string }>
}

export interface RecursiveModeEnforcement {
  preStep?: 'strict' | 'advisory'
  toolGuards?: 'strict' | 'advisory'
  tamper?: 'strict' | 'advisory'
  budgets?: RecursiveModeBudgets
}

/**
 * ⚠ PART B — WHO MAY SIGN THE MANUAL QA PHASE OFF. See the schema comment below for why this is a switch and
 * why its default is `false`.
 */
export interface RecursiveModeQa {
  humanReview?: boolean
}

/** One human ask: whether a person is asked, and what to record when they are not. */
export interface RecursiveModeGateAsk {
  ask?: boolean
  default?: string
}

/** Per-gate human-ask switches. Absence means enabled, except `tddMode` (owner's choice: off, `strict`). */
export interface RecursiveModeGates {
  runStart?: RecursiveModeGateAsk
  tddMode?: RecursiveModeGateAsk
  qaSignoff?: RecursiveModeGateAsk
  gateBlock?: RecursiveModeGateAsk
}

export interface RecursiveModeConfig {
  /**
   * DEFAULT-INERT opt-in for the server surface: `true` registers the `RecursiveRuntime` service,
   * the thirteen `recursive_*` tools, the skills and the route; ABSENT registers NOTHING.
   *
   * ⚠ ABSENCE MEANS INERT, AND THAT IS THE WHOLE POINT — see the measured leak on `Config` below.
   */
  serverSurface?: boolean
  /** R4 shell split: expose ONLY the client bundle, registering nothing server-side. */
  shellOnly?: boolean
  /** Roles that keep the primitive dispatch surface so their own provider/model/effort apply. */
  teammate?: { primitiveRoles?: string[] }
  /** Per-gate human-ask switches; absence means enabled (except `tddMode`, which defaults to not asking). */
  gates?: RecursiveModeGates
  repoRoot?: string
  /** T7/T28: the enforcement modes and the budgets, editable live. */
  enforcement?: RecursiveModeEnforcement
  /**
   * ⚠ PART B: the phase-5 QA gate. Absent means today's standard — `humanReview` defaults to `false`, so
   * every existing run keeps locking exactly as it does now.
   */
  qa?: RecursiveModeQa
  /** T7: overrides for the workspace router file — see the schema comment on defaults. */
  router?: RecursiveModeRouter
}

/**
 * ⚠ THE THREE SUB-SCHEMAS ARE EXPORTED, AND THAT IS A CONTRACT RATHER THAN TIDINESS.
 *
 * `.recursive/config/recursive-gates.json` (see `src/gates-config.ts`) is a SECOND SOURCE for exactly
 * these three settings. Two shapes hand-written in two files would be two validators, and the first
 * time one gained a field the other would silently ignore it. So the file's schema is composed from
 * THESE objects — the same `dict` keys, the same defaults, the same descriptions. A field added here
 * becomes accepted (and visible to the unknown-key refusal) in the workspace file with no second edit.
 *
 * They are declared before `Config` only so `Config` can reference them; the settings service still
 * discovers `Config` alone.
 */
export const teammateConfigSchema = z.object({
  primitiveRoles: z.array(z.string()).default([]).description(
    'Roles that keep the primitive dispatch path so their own provider/model/effort apply (a rostered '
    + 'teammate cannot carry agentOptions and therefore inherits the Lead\'s route). Empty means team everywhere.',
  ),
})

/** `qa.humanReview` — the phase-5 lint switch. Shared by the plugin Config and the workspace file. */
export const qaConfigSchema = z.object({
  humanReview: z.boolean().default(false).description(
    'Set true to require a HUMAN sign-off of phase-5 manual QA: an agent-operated QA mode then fails the lint, ' +
    'the artifact must carry the sign-off line recursive_ask writes, and it must contain a ## Human Review ' +
    'Instructions section naming where the product runs, what the person must check, and how they sign off. ' +
    'Leave false — the default — and the phase keeps its existing standard.',
  ),
})

/**
 * The four per-gate ask switches. Shared by the plugin Config and the workspace file, so the file cannot
 * accept a gate key or a `default` label the Config schema would reject.
 */
export const gatesConfigSchema = z.object({
  runStart: z.object({
    ask: z.boolean().default(true).description('Ask a person before a run starts (arms the run goal).'),
  }).description('The run-start gate (phase 0).'),
  tddMode: z.object({
    ask: z.boolean().default(false).description('Ask a person which TDD mode phase 3 uses.'),
    default: z.string().default('strict').description(
      'The TDD Mode recorded when the ask is disabled. Must be one of strict | pragmatic.',
    ),
  }).description('The TDD-mode gate (phase 3). Defaults to NOT asking, and to recording strict.'),
  qaSignoff: z.object({
    ask: z.boolean().default(true).description('Ask a person who signs the phase-5 manual QA off.'),
    default: z.string().default('agent-operated').description(
      'The QA Execution Mode recorded when the ask is disabled. Must be one of human | agent-operated | hybrid.',
    ),
  }).description('The QA-sign-off gate (phase 5).'),
  gateBlock: z.object({
    ask: z.boolean().default(true).description(
      'Ask a person how a blocking gate is resolved (fix | reopen | abandon). Disabling this leaves a blocked '
      + 'transition blocked on purpose: the ask is refused by name rather than invented.',
    ),
  }).description('The block-recovery gate (any phase).'),
}).description('Per-gate human-ask switches: which gates put a question to a person, and what to record when not.')

/**
 * The schema the settings service discovers. Field descriptions are the form's help
 * text, so they are written for the person toggling them, not for the reader of this file.
 */
export const Config = z.object({
  /**
   * ⚠ DEFAULT-INERT — THE SERVER SURFACE REQUIRES AN EXPLICIT OPT-IN, AND THIS IS THE FIX FOR A
   * MEASURED GLOBAL LEAK. Read the whole note before changing the default: it is `false` because
   * the alternative was observed to put this plugin's ENTIRE surface into a session that never
   * asked for it.
   *
   * WHAT WAS MEASURED. Decoding all 496 DSH session logs found the recursive-mode surface (13
   * `recursive_*` tools plus the `recursive-mode` and twelve `recursive-phase-*` skills) appearing
   * INSIDE sessions running the `cordis` agent preset — the one the GUI calls "Creator mode".
   * Session `3c7e83b4`'s `request/header` went from 49 tools (0 recursive) at 06:09:48 to 62 tools
   * (13 recursive) at 06:25:05 with NO preset switch (a session cannot switch preset after its
   * first turn), the changed skill catalogue was injected at that same second, the agent loop
   * emitted 13 `tool-addition` entries, and the model's own reasoning recorded the change. The
   * surface was withdrawn fifteen minutes later.
   *
   * WHY A ROW'S OWN CONFIG CANNOT BE ITS ONLY GUARD. Both registries are layered by the CALLER's
   * scope, and `register`/`registerProvider` bind `this.ctx` to the caller. The `recursive` and
   * `cordis` preset scopes are SIBLINGS, so a registration made inside a preset group cannot reach
   * another preset's agent — which means those registrations landed in the GLOBAL layer, from an
   * unscoped context: the HOST row, applied with `shellOnly` falsy. And here is the reason this
   * field exists rather than a better check on `shellOnly`: this bundle ships TWO rows whose id was
   * the SAME WORD (`recursive`) — the host shell row carrying `shellOnly: true`, and the preset row
   * inside `recursive-realm` carrying NO config at all, deliberately, so the guard would not fire.
   * The Loader addresses rows BY ID, and the settings service edits a Loader entry's config and the
   * Loader RE-APPLIES the plugin — so a guard that fires on the PRESENCE of a key is lost the
   * moment that key is lost. Under `shellOnly`, a rewrite that dropped or cleared the flag
   * registered the full surface globally. Under this field, the identical rewrite makes the plugin
   * do NOTHING: absence is inert, and only an explicit `true` registers anything.
   *
   * HOW IT IS CARRIED. All three places that mount the real surface opt in explicitly:
   * `preset/recursive.patch.yml` (the row inside `recursive-realm`),
   * `preset/recursive/agent.cordis.yml` (its `@@RECURSIVE_SERVER_ENTRY@@` placeholder row), and
   * therefore whatever materializes either of them, because the flag rides the row itself.
   */
  serverSurface: z.boolean().default(false).description(
    'Set true to mount the server surface (the RecursiveRuntime service, the recursive_* tools and the ' +
    'packaged skills). Leave false — the default — and this row registers NOTHING on the server: losing or ' +
    'clearing this flag makes the plugin inert instead of registering globally.',
  ),
  shellOnly: z.boolean().default(false).description(
    'Client-shell only: registers nothing on the server (no tools, no command, no projection).',
  ),
  /**
   * ⚠ PER-ROLE DISPATCH SURFACE — the answer to "a teammate cannot carry its own model".
   *
   * A rostered child gets a name, a durable mailbox and task ownership, but `SpawnTeammateRequest` has no
   * `agentOptions` field, so it ALWAYS inherits the Lead's provider/model/effort. Registering a provider with
   * `agentRouteDefaults` does not help either: that value is read only by the model-facing `tool-subagent`
   * tool (`tool-subagent/src/index.ts:369`), never by `startContinuable`, and a provider's only participation
   * in a continuable child is `prepareContinuable`. So a role that must run on its own model keeps the
   * PRIMITIVE path, where this plugin passes `agentOptions` itself.
   *
   * Empty by default — team everywhere; list a role here only when its own route matters more than the roster.
   * Whichever surface a child gets, the routing notes state it, so the run's record never implies a model it
   * did not use.
   */
  teammate: teammateConfigSchema.description('Teammate dispatch surface: which roles stay off the agent-team roster, and why.'),
  repoRoot: z.string().description(
    'Control-plane root. Defaults to the process working directory when unset.',
  ),
  /**
   * ⚠ THE THREE MODE DEFAULTS READ `DEFAULT_ENFORCEMENT_MODE` FROM `enforcement.ts`, and
   * that is deliberate: the schema default and the runtime default are the SAME value, and
   * two literals here would be two defaults. A caller that omits the section gets
   * `DEFAULT_ENFORCEMENT` from the runtime; a caller that supplies a partial section gets
   * the resolver's fill. Both must be the enforcing posture — see the const for why.
   */
  enforcement: z.object({
    preStep: enforcementMode.default(DEFAULT_ENFORCEMENT_MODE).description(
      'Phase pre-step enforcement: strict refuses an out-of-order transition, advisory warns and proceeds.',
    ),
    toolGuards: enforcementMode.default(DEFAULT_ENFORCEMENT_MODE).description(
      'Tool guard mode: strict DENIES an out-of-order tool call, advisory allows it and carries the warning.',
    ),
    tamper: enforcementMode.default(DEFAULT_ENFORCEMENT_MODE).description(
      'Tamper detection: strict refuses an artifact whose LockHash no longer matches its body.',
    ),
    budgets: z.object({
      maxAuditRounds: z.natural().default(DEFAULT_BUDGETS.maxAuditRounds).description(
        'Rounds one phase audit loop may run, even while every round makes progress.',
      ),
      maxRepairAttempts: z.natural().default(DEFAULT_BUDGETS.maxRepairAttempts).description(
        'How many times a phase may be sent back for repair before the loop stops.',
      ),
      maxDelegationDepth: z.natural().default(DEFAULT_BUDGETS.maxDelegationDepth).description(
        'Ceiling for the WHOLE recursion. A child narrows it; it is never re-granted per level.',
      ),
      maxChildrenPerPhase: z.natural().default(DEFAULT_BUDGETS.maxChildrenPerPhase).description(
        'Delegated children one phase may start, counted by distinct operation.',
      ),
      maxResultBytes: z.natural().default(DEFAULT_BUDGETS.maxResultBytes).description(
        'Byte ceiling for one tool result, applied after the finding-count cap.',
      ),
    }).description('T28 budgets.'),
  }).description('The enforcement modes plus the T28 budgets.'),
  /**
   * ⚠ PART B — `qa.humanReview`: CONFIGURABLE HUMAN QA, AND THE LIVE RUN THAT ASKED FOR IT.
   *
   * THE DEFECT THIS ANSWERS, IN THE OWNER'S WORDS: *"the agent asks me for qa approval without sending a
   * proper question ui component for sign off, so i dont see any notification its just in the chat text and
   * i miss it"*. Part A fixes the delivery: every gate is now put to the mounted user-questions channel, so
   * the person gets a card. But a card can be ignored, and a run can carry on — in the live run that
   * exposed this, the agent asked the `qa-signoff` gate three times (13:26:57, 13:38:00, 13:39:02), no card
   * was ever rendered, nobody answered, and the agent then wrote `QA Execution Mode: agent-operated` into
   * `05-manual-qa.md` and proceeded to lock the phase.
   *
   * This switch is the second half: with `humanReview: true` the PHASE cannot lock on an agent's own say-so,
   * because the lint FAILS an `agent-operated` mode and requires the human-review evidence (see
   * `lintPhaseSpecificRules` in `ts-lint.ts`). It is `false` by DEFAULT on purpose — the workflow's existing
   * standard allows an agent-operated QA phase, and turning the switch on is a decision a workspace makes
   * about who signs its QA, not something a plugin upgrade should impose on runs already in flight.
   *
   * ⚠ WHAT IT HONESTLY GUARANTEES. It cannot stop an agent from typing anything it likes into an artifact;
   * the linter reads a document. What it makes impossible is the SILENT downgrade: the refusal comes from
   * CONFIG, so an agent cannot select `agent-operated` to escape the gate — that mode fails the phase no
   * matter who wrote it, and the run cannot lock until a person's answer is what the artifact records.
   */
  qa: qaConfigSchema.description('Phase-5 QA: whether a person must sign the manual QA phase off, or an agent may.'),
  /**
   * ⚠ PER-GATE ASK SWITCHES — "every phase that has a human ask should also have the ask gate be
   * configurable true/false so users can customize when they are asked or not" (owner, 2026-10-17).
   *
   * The plugin has four human gates (`ASK_GATES` in `recursive_ask.tool.ts` plus `run-start`). Whether a
   * person is ASKED is now a per-gate choice instead of a fact of the workflow:
   *
   *   • `ask: true`  — the gate puts the question to the mounted user-questions channel, so the harness
   *     renders a card and notifies. Unchanged behaviour.
   *   • `ask: false` — nobody is asked. `recursive_ask` records the gate's configured `default` at once and
   *     reports `source: 'config'` + `ask: 'disabled'`, so the artifact still carries a truthful value and the
   *     run's own record says the person was NOT asked. A gate with no meaningful default (`gate-block`) must
   *     refuse by name instead: fix/reopen/abandon are the person's call, and inventing one would have the
   *     plugin abandon a phase on their behalf.
   *
   * ⚠ ONLY AN EXPLICIT `false` DISABLES AN ASK. This follows the same lesson as the `shellOnly` leak: a guard
   * that fires on the PRESENCE of a key is lost the moment the key is lost, so absence must mean the safe
   * thing. `tddMode` is the one exception, at the owner's explicit instruction: it defaults to NOT asking and
   * recording `strict`.
   *
   * ⚠ AND `qa.humanReview: true` WITH `qaSignoff.ask: false` IS A CONTRADICTION, refused at mount: humanReview
   * exists precisely to guarantee that a person signs phase 5 off, so a configuration that also disables that
   * ask must not silently let either side win.
   */
  gates: gatesConfigSchema,
  /**
   * T7 — the ROUTER overrides. Deliberately NO defaults on these fields: `.default()`
   * would make every field present, and a present field overrides the workspace's
   * `recursive-router.json` — so defaulting them would silently shadow the declarative
   * file forever. Absent means "defer to the file"; present means "override it".
   *
   * ⚠ FU-20 — `roles` AND `phases` ARE THE SAME RULE, and the dict shape is load-bearing rather than cosmetic:
   * an entry that names only a `model` must leave the file's provider for that role intact. Each level of the
   * ladder is therefore keyed and merged per FIELD, never wholesale.
   */
  router: z.object({
    defaults: z.object({
      when_role_unconfigured: z.union([z.const('ask'), z.const('fallback-local')]).description(
        'What to do when a role has no configured route. `ask` (the default) invents no route for it; '
        + '`fallback-local` runs it on the local session model. Leave unset to use the workspace router file.',
      ),
      when_cli_unavailable: z.union([z.const('ask'), z.const('fallback-local')]).description(
        'What to do when a route names a CLI that has no registered provider. `ask` substitutes nothing; '
        + '`fallback-local` routes it to the local session MODEL — a real delegated child, never a self-review. '
        + 'Leave unset to use the workspace router file.',
      ),
      when_model_unknown: z.union([z.const('ask'), z.const('fallback-local')]).description(
        'What to do when a routed model is not in the inventory DSH reports. No model is ever substituted '
        + 'silently: the substitution is reported, and named when the session\'s own model could be read. '
        + 'Leave unset to use the workspace router file.',
      ),
      allow_auto_assign_if_single_cli: z.boolean().description(
        'Assign a role automatically when exactly one CLI is configured. Unset defers to the file.',
      ),
      probe_timeout_ms: z.natural().description('CLI capability probe timeout in ms. Unset defers to the file.'),
      invoke_timeout_ms: z.natural().description('Routed CLI invocation timeout in ms. Unset defers to the file.'),
    }).description('Router default policy fields this namespace overrides.'),
    /**
     * ⚠ FU-20 — THE GENERAL SUBAGENT ROUTE, deliberately a SIBLING of `defaults` rather than a key inside it.
     *
     * A pinned property of this namespace is that an unedited `defaults` carries NO present field, because a
     * present field overrides the workspace file — and a nested object schema ALWAYS materializes as `{}`, which
     * is a present field. `settings-config.spec.ts` caught the first version of this change doing exactly that.
     * It lands on the file's `defaults.subagent` in `loadRouterPolicy`, which is the same level of the ladder.
     */
    subagent: z.object({
      provider: z.string().description('Subagent provider (who creates the child): spawn, fork. Unset defers.'),
      model: z.string().description('Model for EVERY delegated child that no narrower level claims. Unset defers.'),
      modelProvider: z.string().description('The LLM provider serving that model. Unset defers.'),
    }).description('The general subagent route — the level above the session default.'),
    /**
     * ⚠ FU-20 — PER ROLE. Lower precedence than `phases`, higher than `defaults.subagent`; the SESSION's own
     * model is the floor below every level, and is what a child inherits when no level names a model.
     */
    roles: z.dict(z.object({
      provider: z.string().description('Subagent provider for this role (who creates the child).'),
      model: z.string().description('Model this role runs on, e.g. code-reviewer -> a stronger model.'),
      modelProvider: z.string().description('The LLM provider serving that model. Unset looks it up in DSH.'),
    })).description(
      'Per-ROLE subagent model, e.g. { "code-reviewer": { "model": "deepseek-pro" } }. A phase route overrides it.',
    ),
    /**
     * ⚠ FU-20 — PER PHASE. The NARROWEST configured level, so it wins over the role route: a phase is the more
     * specific statement of intent ("phase 3.5 needs the strong model"), and the more specific level is the one
     * the user meant. A per-call override from the tool still wins over both.
     */
    phases: z.dict(z.object({
      role: z.string().description('Use this role\'s route for this phase instead of the requested role\'s.'),
      provider: z.string().description('Subagent provider for this phase.'),
      model: z.string().description('Model this phase runs on; overrides the role level.'),
      modelProvider: z.string().description('The LLM provider serving that model.'),
    })).description(
      'Per-PHASE subagent model, e.g. { "3.5": { "model": "deepseek-pro" } }. Overrides the role route.',
    ),
  }).description('Overrides for .recursive/config/recursive-router.json — one path, not two.'),
})
