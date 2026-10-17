/**
 * PER-GATE HUMAN-ASK SWITCHES — the resolved policy, in one place.
 *
 * WHY THIS MODULE EXISTS. Whether a person is asked is now a per-gate choice
 * (`config.gates`), and the answer is read on TWO paths that must never disagree: the ask tool
 * (`recursive_ask`, which either puts the question to the mounted channel or records the configured
 * default) and the mount check that refuses the `qa.humanReview` contradiction. Resolving the raw
 * config into one shape here means there is exactly one interpretation of "absent", and it is the safe
 * one.
 *
 * ⚠ ABSENCE MEANS ENABLED. A switch that disabled itself when a key went missing would repeat the
 * `shellOnly` leak in the opposite direction — there, losing a key registered the surface globally;
 * here, losing a key would silence the person. So `?? true`, everywhere except `tddMode`.
 *
 * ⚠ AND `tddMode` IS THE ONE DELIBERATE EXCEPTION, at the owner's instruction: it does not ask, and it
 * records `strict`. That is a DEFAULT, not a hard rule — `gates.tddMode.ask: true` restores the question.
 */
import type { RecursiveModeGates } from './config.ts'
import { toolError } from './errors.ts'

/** The ask decision for one gate, after the defaults are applied. */
export interface ResolvedGateAsk {
  /** Whether a person is asked at all. */
  ask: boolean
  /** What is recorded when `ask` is false. Absent for a gate whose decision has no safe default. */
  default?: string
}

/**
 * ⚠ THE LABELS A GATE'S CONFIGURED DEFAULT MAY TAKE.
 *
 * These MIRROR the option labels in `ASK_GATES` (`recursive_ask.tool.ts`), which owns the question text. The
 * duplication is deliberate and guarded: `tests/gate-ask-switch.spec.ts` asserts that these lists equal the
 * labels each gate actually offers, so a new label cannot be added to the question without this list
 * following — and a configured default can therefore be refused HERE, at resolve time, instead of being
 * written into an artifact and only then discovered to mean nothing.
 */
export const GATE_DEFAULT_LABELS: Readonly<Record<string, readonly string[]>> = {
  tddMode: ['strict', 'pragmatic'],
  qaSignoff: ['human', 'agent-operated', 'hybrid'],
}

/**
 * ⚠ THE GATE ID ↔ CONFIG KEY TRANSLATION, IN ONE PLACE.
 *
 * The gate ids are hyphenated (`tdd-mode`) and the config namespace is camelCase (`tddMode`); indexing one
 * with the other silently yields `undefined`, which resolves to "asked" and would make every switch a no-op
 * that still passes a typecheck. `gateAskFor` below already switches on the id; this map is the same
 * translation in a shape the GUIDANCE needs, so a phase can tell the agent which config key silenced it.
 */
export const GATE_CONFIG_KEY: Readonly<Record<string, string>> = {
  'run-start': 'runStart',
  'tdd-mode': 'tddMode',
  'qa-signoff': 'qaSignoff',
  'gate-block': 'gateBlock',
}

/** Refuse a configured default that is not one of its gate's labels, naming the gate and the allowed set. */
function validatedDefault(gateKey: string, value: string): string {
  const allowed = GATE_DEFAULT_LABELS[gateKey]
  if (allowed === undefined) return value
  if (allowed.includes(value)) return value
  // ⚠ A REGISTRY CODE, NOT A BARE SENTENCE. The refusal has to be greppable like every other refusal this
  // plugin makes (`RM1145`), and the sentence a person reads is carried as the registry entry's own detail —
  // the same shape `toolError` renders everywhere. The prose is kept verbatim so the value, the field path
  // and the allowed set all travel together.
  throw new Error(toolError(
    'BAD_GATE_DEFAULT',
    'gates.' + gateKey + '.default is "' + value + '", which is not one of '
    + allowed.join(' | ') + ' — a default that is not a label of its own gate would record a decision nobody '
    + 'offered',
  ))
}

/** Every gate's resolved ask decision. */
export interface ResolvedGateAsks {
  runStart: ResolvedGateAsk
  tddMode: ResolvedGateAsk
  qaSignoff: ResolvedGateAsk
  gateBlock: ResolvedGateAsk
}

/** Apply the documented defaults to the raw `gates` namespace. Absence never disables an ask. */
export function resolveGateAsks(config: RecursiveModeGates | undefined): ResolvedGateAsks {
  return {
    runStart: { ask: config?.runStart?.ask ?? true },
    // ⚠ THE OWNER'S DEFAULT: no question, and `strict` is what the artifact records. A run that never
    // mentions `gates` therefore gets strict TDD without a prompt — which is the behaviour that was asked
    // for, and the reason this one gate deviates from "absence means enabled".
    tddMode: { ask: config?.tddMode?.ask ?? false, default: validatedDefault('tddMode', config?.tddMode?.default ?? 'strict') },
    qaSignoff: { ask: config?.qaSignoff?.ask ?? true, default: validatedDefault('qaSignoff', config?.qaSignoff?.default ?? 'agent-operated') },
    // `gateBlock` has NO default on purpose: fix/reopen/abandon are the person's call, so a disabled ask
    // must refuse rather than invent one (see the tool).
    gateBlock: { ask: config?.gateBlock?.ask ?? true },
  }
}

/** The resolved ask decision for one gate id (`tdd-mode`, `qa-signoff`, `gate-block`, `run-start`). */
export function gateAskFor(gates: ResolvedGateAsks, gateId: string): ResolvedGateAsk {
  switch (gateId) {
    case 'tdd-mode': return gates.tddMode
    case 'qa-signoff': return gates.qaSignoff
    case 'gate-block': return gates.gateBlock
    case 'run-start': return gates.runStart
    // An unknown id is ASKED. Silencing a gate we do not recognise would make a typo look like a decision.
    default: return { ask: true }
  }
}
