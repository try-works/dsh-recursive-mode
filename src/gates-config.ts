/**
 * THE WORKSPACE GATES FILE — `.recursive/config/recursive-gates.json`.
 *
 * WHY THIS FILE EXISTS. The plugin's gate/QA settings live in the plugin Config (`src/config.ts`), and a
 * user can only reach that Config through the profile's settings form. The owner's requirement is that
 * the configuration surface be reached from the product itself: *"the config surface should be reached
 * via the Recursive tab in the chat context view"*. A tab cannot write the profile YAML, so the
 * workspace file is the durable, user-editable half, and the Recursive tab is its editor.
 *
 * ⚠ ONE SHAPE, ONE VALIDATION. The file's schema is COMPOSED from the very schemas `Config` uses
 * (`qaConfigSchema`, `gatesConfigSchema`, `teammateConfigSchema`, exported from `src/config.ts`), so a
 * field accepted by the settings form is accepted here and vice versa. Schemastery does not reject
 * unknown keys, so `refuseUnknownKeys` walks the schema's own `dict` maps: the allowed-key list can
 * never drift from the declared shape, and an unknown key is refused BY NAME rather than dropped.
 *
 * ⚠ PRECEDENCE, STATED ONCE AND TESTED (tests/gates-config.spec.ts):
 *   1. an explicitly configured plugin Config WINS — the profile is the deliberate, deployment-level
 *      statement, and a workspace file must not silently overrule it;
 *   2. the file fills every value the Config left at its schema default;
 *   3. with no file, the behaviour is exactly today's: the Config defaults (`resolveGateAsks`).
 *
 * "EXPLICIT" IS OBSERVED AS "DIFFERS FROM THE SCHEMA DEFAULT", and the limitation is stated rather than
 * hidden: `apply()` receives the Config AFTER the schema has filled defaults (Cordis validates through
 * `Config` before calling the plugin), so an explicit `false`/`[]` is byte-identical to a schema default
 * of the same value. A value equal to its default therefore lets the file fill it. That is the same
 * effective meaning as "the file fills what the Config left at its default", and it never silently
 * changes a non-default Config.
 *
 * ⚠ A MALFORMED FILE MUST NEVER FALL BACK SILENTLY. `readGatesConfig` returns a NAMED problem
 * (`RM1147`, or `RM1145`/`RM1146`/`RM2203` for the value rules), and the use-time readers in
 * `runtime.ts` THROW that problem instead of obeying a guessed configuration. The GET route reports it;
 * the PUT route refuses it. The only "fallback" is a file that does not exist, which is today.
 *
 * ⚠ USED AT USE TIME, NOT ONLY AT APPLY TIME. `runtime.gateAsk(...)`, the phase-5 lint's
 * `humanReview` and the teammate `primitiveRoles` decision read this file on every call. A JSON read of
 * one small file per gate ask / lint / delegation is not a hot path (each happens once per phase, not
 * per token), so there is deliberately NO mtime cache: a cache would be one more thing that could
 * disagree with the file the user just saved. If it ever measures hot, cache by mtime — but measure
 * first.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  gatesConfigSchema,
  qaConfigSchema,
  teammateConfigSchema,
  type RecursiveModeConfig,
  type RecursiveModeGates,
  type RecursiveModeGateAsk,
  type RecursiveModeQa,
} from './config.ts'
import { resolveGateAsks, type ResolvedGateAsks } from './gates.ts'
import { toolError } from './errors.ts'

/** The workspace file, relative to the control-plane root. */
export const GATES_CONFIG_RELATIVE_PATH = '.recursive/config/recursive-gates.json'

/** Absolute path of the workspace gates file under one control-plane root. */
export function gatesConfigPath(root: string): string {
  return join(root, '.recursive', 'config', 'recursive-gates.json')
}

/** The file's value: the same fields as the Config, every section optional. */
export interface RecursiveGatesFile {
  qa?: RecursiveModeQa
  gates?: RecursiveModeGates
  teammate?: { primitiveRoles?: string[] }
}

/**
 * The file schema. It is deliberately composed from the Config's own sub-schemas (see the header), and
 * deliberately does NOT require any section: a file that names only `qa` is valid and changes only that.
 */
export const GatesFileSchema = z.object({
  qa: qaConfigSchema,
  gates: gatesConfigSchema,
  teammate: teammateConfigSchema,
})

/** A schema node with object keys, as much as the unknown-key walk needs to know. */
interface ObjectSchemaNode {
  dict?: Record<string, unknown>
}

function dictOf(schema: unknown): Record<string, unknown> | undefined {
  // ⚠ A SCHEMA INSTANCE IS A FUNCTION OBJECT, NOT A PLAIN OBJECT (schemastery returns a callable
  // `schema` value), so `typeof schema === 'object'` would skip every schema and silently accept
  // unknown keys. Measured: `typeof z.object({...}) === 'function'`.
  if (schema === null || (typeof schema !== 'object' && typeof schema !== 'function')) return undefined
  const dict = (schema as ObjectSchemaNode).dict
  return dict !== undefined && dict !== null && typeof dict === 'object' ? dict : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A problem that is already one of this plugin's named refusals, or `RM1147` for anything else. */
function namedProblem(error: unknown): string {
  const message = errorMessage(error)
  return /^RM\d{4} /.test(message) ? message : toolError('GATES_CONFIG_INVALID', message)
}

/**
 * Refuse an unknown key BY NAME, using the schema's own dict as the allow-list.
 *
 * Schemastery merges undeclared keys into its output instead of rejecting them (measured against
 * vendor/schemastery), so a typo like `gates.tddModes` would otherwise be accepted and ignored — the
 * exact silent fallback this file must not have. Walking `dict` keeps the allow-list derived from the
 * one declared shape.
 */
function refuseUnknownKeys(schema: unknown, value: unknown, path: string): void {
  const dict = dictOf(schema)
  if (dict === undefined || !isPlainObject(value)) return
  for (const key of Object.keys(value)) {
    const child = dict[key]
    if (child === undefined) {
      throw new Error(toolError(
        'GATES_CONFIG_INVALID',
        'unknown key "' + path + key + '" in .recursive/config/recursive-gates.json — allowed keys here: '
        + Object.keys(dict).join(', '),
      ))
    }
    refuseUnknownKeys(child, value[key], path + key + '.')
  }
}

/**
 * Validate one file value. Throws a NAMED refusal; never returns a partially interpreted value.
 *
 * The order is deliberate: shape first (unknown keys, then the schema's own types), then the two
 * registry rules the schema cannot express, then the cross-field contradiction.
 */
export function validateGatesFile(value: unknown): RecursiveGatesFile {
  if (!isPlainObject(value)) {
    throw new Error(toolError('GATES_CONFIG_INVALID', 'the root of .recursive/config/recursive-gates.json must be a JSON object'))
  }
  refuseUnknownKeys(GatesFileSchema, value, '')
  let decoded: RecursiveGatesFile
  try {
    decoded = GatesFileSchema(value) as RecursiveGatesFile
  } catch (error) {
    throw new Error(namedProblem(error))
  }
  // RM1145: a configured default must be a label its own gate offers. `resolveGateAsks` is the ONE
  // validator for that rule (the same function the plugin Config is checked by), so the file cannot
  // invent a second opinion.
  resolveGateAsks(decoded.gates)
  if (decoded.gates?.runStart?.ask === false) {
    throw new Error(toolError(
      'RUN_START_ASK_REQUIRED',
      'gates.runStart.ask is false in .recursive/config/recursive-gates.json, but the run-start gate is the approval that arms the run',
    ))
  }
  if (decoded.qa?.humanReview === true && decoded.gates?.qaSignoff?.ask === false) {
    throw new Error(toolError(
      'QA_HUMAN_REVIEW_CONTRADICTION',
      'the workspace gates file sets qa.humanReview: true while gates.qaSignoff.ask is false — a person must sign the QA off, but the only question that can obtain that sign-off is disabled',
    ))
  }
  return decoded
}

/** A read result: the value (`null` when the file does not exist) or a NAMED problem. */
export type GatesConfigRead =
  | { ok: true; value: RecursiveGatesFile | null }
  | { ok: false; problem: string }

/**
 * Read and validate the workspace gates file. A missing file is `{ ok: true, value: null }` — that is
 * today's behaviour, not a failure. A present-but-unusable file is `{ ok: false, problem }`, and the
 * caller must surface the problem rather than fall back.
 */
export function readGatesConfig(root: string): GatesConfigRead {
  const path = gatesConfigPath(root)
  if (!existsSync(path)) return { ok: true, value: null }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return {
      ok: false,
      problem: toolError('GATES_CONFIG_INVALID', '.recursive/config/recursive-gates.json is not valid JSON: ' + errorMessage(error)),
    }
  }
  try {
    return { ok: true, value: validateGatesFile(raw) }
  } catch (error) {
    return { ok: false, problem: namedProblem(error) }
  }
}

/**
 * Validate and write the workspace gates file ATOMICALLY (temp file + rename in the same directory, so
 * a reader never sees a half-written JSON document). Returns the absolute path written.
 *
 * Throws the named refusal for an invalid value, so the route can return it verbatim and the file on
 * disk stays untouched.
 */
export function writeGatesConfig(root: string, value: unknown): string {
  const decoded = validateGatesFile(value)
  const path = gatesConfigPath(root)
  mkdirSync(dirname(path), { recursive: true })
  const temp = path + '.tmp-' + String(process.pid) + '-' + String(Date.now())
  try {
    writeFileSync(temp, JSON.stringify(decoded, null, 2) + '\n', 'utf8')
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw new Error(toolError('GATES_CONFIG_INVALID', 'could not write .recursive/config/recursive-gates.json: ' + errorMessage(error)))
  }
  return path
}

/* -------------------------------------------------------------------------- */
/* Effective settings and their sources                                       */
/* -------------------------------------------------------------------------- */

/** Which layer decided one effective value. */
export type GatesSettingSource = 'config' | 'file' | 'default'

/** The effective values, plain (the shape a form binds to). */
export interface EffectiveGates {
  qa: { humanReview: boolean }
  gates: {
    runStart: { ask: boolean }
    tddMode: { ask: boolean; default: string }
    qaSignoff: { ask: boolean; default: string }
    gateBlock: { ask: boolean }
  }
  teammate: { primitiveRoles: string[] }
}

/** One layer's contribution, keyed by the Config field path (`gates.tddMode.ask`, ...). */
export type GatesLayerValues = Record<string, boolean | string | string[]>

/** The effective settings plus where each one came from. */
export interface GatesResolution {
  effective: EffectiveGates
  /** Field path -> the layer that won. A path absent from this map is absent from the settings. */
  sources: Record<string, GatesSettingSource>
  /** The effective values the plugin Config decided. */
  fromConfig: GatesLayerValues
  /** The effective values the workspace file decided. */
  fromFile: GatesLayerValues
}

/** The Config slice this module resolves against. */
export type GatesConfigSlice = Pick<RecursiveModeConfig, 'qa' | 'gates' | 'teammate'>

/**
 * The schema defaults, stated once. These are the values `resolveGateAsks(undefined)` and the Config
 * schema produce; a Config value EQUAL to one of them is treated as "left at the default" so the file
 * can fill it (see the header's precedence note).
 */
const SCHEMA_DEFAULTS = {
  humanReview: false,
  runStartAsk: true,
  tddModeAsk: false,
  tddModeDefault: 'strict',
  qaSignoffAsk: true,
  qaSignoffDefault: 'agent-operated',
  gateBlockAsk: true,
  primitiveRoles: [] as string[],
} as const

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

interface Chosen<T> {
  value: T
  source: GatesSettingSource
}

/**
 * One precedence decision: a non-default Config wins, then the file, then the schema default.
 */
function choose<T>(configValue: T | undefined, schemaDefault: T, fileValue: T | undefined): Chosen<T> {
  if (configValue !== undefined && !sameValue(configValue, schemaDefault)) {
    return { value: configValue, source: 'config' }
  }
  if (fileValue !== undefined) return { value: fileValue, source: 'file' }
  return { value: configValue ?? schemaDefault, source: 'default' }
}

function record(layer: GatesLayerValues, sources: Record<string, GatesSettingSource>, path: string, chosen: Chosen<boolean | string | string[]>): void {
  sources[path] = chosen.source
  // The caller records the file's contribution separately; this helper only owns the Config side.
  if (chosen.source === 'config') layer[path] = chosen.value
}

/**
 * Compose the EFFECTIVE gate/QA settings from the plugin Config and the workspace file.
 *
 * This is the only place precedence is decided; `runtime.ts` uses it for every use-time read and the
 * GET route uses it for the payload, so the UI and the run can never read two different answers.
 *
 * Both inputs are assumed already validated (the Config by Cordis at apply, the file by
 * `readGatesConfig`). A bad configured default still throws `RM1145` here, through the same
 * `resolveGateAsks` validator.
 */
export function resolveEffectiveGates(config: GatesConfigSlice | undefined, file: RecursiveGatesFile | null): GatesResolution {
  // Resolving both sides through the SAME function is what makes an absent gate take the documented
  // default (absence means asked, except tddMode). It also validates each side's configured labels.
  void resolveGateAsks(config?.gates)
  void resolveGateAsks(file?.gates)

  const effective: EffectiveGates = {
    qa: { humanReview: SCHEMA_DEFAULTS.humanReview },
    gates: {
      runStart: { ask: SCHEMA_DEFAULTS.runStartAsk },
      tddMode: { ask: SCHEMA_DEFAULTS.tddModeAsk, default: SCHEMA_DEFAULTS.tddModeDefault },
      qaSignoff: { ask: SCHEMA_DEFAULTS.qaSignoffAsk, default: SCHEMA_DEFAULTS.qaSignoffDefault },
      gateBlock: { ask: SCHEMA_DEFAULTS.gateBlockAsk },
    },
    teammate: { primitiveRoles: [] },
  }
  const sources: Record<string, GatesSettingSource> = {}
  const fromConfig: GatesLayerValues = {}
  const fromFile: GatesLayerValues = {}

  const configGate = (gate: keyof RecursiveModeGates): RecursiveModeGateAsk | undefined => config?.gates?.[gate]
  const fileGate = (gate: keyof RecursiveModeGates): RecursiveModeGateAsk | undefined => file?.gates?.[gate]

  const humanReview = choose(config?.qa?.humanReview, SCHEMA_DEFAULTS.humanReview, file?.qa?.humanReview)
  effective.qa.humanReview = humanReview.value
  record(fromConfig, sources, 'qa.humanReview', humanReview)
  if (humanReview.source === 'file') fromFile['qa.humanReview'] = humanReview.value

  const runStart = choose(configGate('runStart')?.ask, SCHEMA_DEFAULTS.runStartAsk, fileGate('runStart')?.ask)
  effective.gates.runStart.ask = runStart.value
  record(fromConfig, sources, 'gates.runStart.ask', runStart)
  if (runStart.source === 'file') fromFile['gates.runStart.ask'] = runStart.value

  const tddAsk = choose(configGate('tddMode')?.ask, SCHEMA_DEFAULTS.tddModeAsk, fileGate('tddMode')?.ask)
  effective.gates.tddMode.ask = tddAsk.value
  record(fromConfig, sources, 'gates.tddMode.ask', tddAsk)
  if (tddAsk.source === 'file') fromFile['gates.tddMode.ask'] = tddAsk.value
  const tddDefault = choose(configGate('tddMode')?.default, SCHEMA_DEFAULTS.tddModeDefault, fileGate('tddMode')?.default)
  effective.gates.tddMode.default = tddDefault.value
  record(fromConfig, sources, 'gates.tddMode.default', tddDefault)
  if (tddDefault.source === 'file') fromFile['gates.tddMode.default'] = tddDefault.value

  const qaAsk = choose(configGate('qaSignoff')?.ask, SCHEMA_DEFAULTS.qaSignoffAsk, fileGate('qaSignoff')?.ask)
  effective.gates.qaSignoff.ask = qaAsk.value
  record(fromConfig, sources, 'gates.qaSignoff.ask', qaAsk)
  if (qaAsk.source === 'file') fromFile['gates.qaSignoff.ask'] = qaAsk.value
  const qaDefault = choose(configGate('qaSignoff')?.default, SCHEMA_DEFAULTS.qaSignoffDefault, fileGate('qaSignoff')?.default)
  effective.gates.qaSignoff.default = qaDefault.value
  record(fromConfig, sources, 'gates.qaSignoff.default', qaDefault)
  if (qaDefault.source === 'file') fromFile['gates.qaSignoff.default'] = qaDefault.value

  const gateBlock = choose(configGate('gateBlock')?.ask, SCHEMA_DEFAULTS.gateBlockAsk, fileGate('gateBlock')?.ask)
  effective.gates.gateBlock.ask = gateBlock.value
  record(fromConfig, sources, 'gates.gateBlock.ask', gateBlock)
  if (gateBlock.source === 'file') fromFile['gates.gateBlock.ask'] = gateBlock.value

  const primitiveRoles = choose(
    config?.teammate?.primitiveRoles,
    SCHEMA_DEFAULTS.primitiveRoles,
    file?.teammate?.primitiveRoles,
  )
  effective.teammate.primitiveRoles = [...primitiveRoles.value]
  record(fromConfig, sources, 'teammate.primitiveRoles', primitiveRoles)
  if (primitiveRoles.source === 'file') fromFile['teammate.primitiveRoles'] = [...primitiveRoles.value]

  return { effective, sources, fromConfig, fromFile }
}

/**
 * The cross-field rule the schema cannot express, checked against the EFFECTIVE settings: with
 * `qa.humanReview` on, the QA sign-off ask may not be off. Returns the named problem, or null.
 *
 * The plugin's apply already refuses this contradiction inside the Config; this is the same rule for
 * the file, and for a file that only causes the contradiction when combined with the Config (e.g. the
 * Config asks for human review and the file silences the qa-signoff ask).
 */
export function validateEffectiveGates(config: GatesConfigSlice | undefined, file: RecursiveGatesFile | null): string | null {
  const effective = resolveEffectiveGates(config, file).effective
  if (effective.qa.humanReview === true && effective.gates.qaSignoff.ask === false) {
    return toolError(
      'QA_HUMAN_REVIEW_CONTRADICTION',
      'the EFFECTIVE settings require a human QA sign-off (qa.humanReview is true) while the qa-signoff ask is disabled (gates.qaSignoff.ask is false) — a person must sign, but the only question that obtains the sign-off is never put to them',
    )
  }
  return null
}

/** The effective settings in the resolved shape the runtime already consumes. */
export function effectiveGateAsks(effective: EffectiveGates): ResolvedGateAsks {
  return {
    runStart: { ask: effective.gates.runStart.ask },
    tddMode: { ask: effective.gates.tddMode.ask, default: effective.gates.tddMode.default },
    qaSignoff: { ask: effective.gates.qaSignoff.ask, default: effective.gates.qaSignoff.default },
    gateBlock: { ask: effective.gates.gateBlock.ask },
  }
}
