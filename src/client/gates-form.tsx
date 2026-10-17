/**
 * THE RECURSIVE GATES TAB — the user-facing configuration surface.
 *
 * Reached as the "Recursive" tab in the chat context view (the right sidebar): the tab TYPE is
 * registered from `slots.ts` under `id: '@try-works/dsh-recursive-mode'`, `kind: 'recursive'`, and this
 * module is its body. It reads `GET /.recursive/api/gates` and saves with `PUT` — never a remote, and
 * never the filesystem directly (the browser half has no filesystem).
 *
 * WHAT THE PANEL SHOWS, and why each part is there:
 *   • one row per gate (`run-start`, TDD mode, QA sign-off, block recovery) with an ask switch, plus a
 *     default selector where the gate has one (`tddMode`: strict | pragmatic, `qaSignoff`: human |
 *     agent-operated | hybrid);
 *   • the `qa.humanReview` switch, and the CONTRADICTION (`humanReview` on while `qaSignoff.ask` is off)
 *     as a clear inline warning — the host refuses that save with RM2203, so the warning appears before
 *     the button, not after a failed PUT;
 *   • the layer that decided each value (`config` / `file` / `default`), from the GET payload's
 *     `sources`, because the effective row is composed from more than one place;
 *   • the host's refusal VERBATIM when a save fails — the server owns the sentence (`RM####`).
 *
 * STATE IS LOCAL. There is no store, no module-level mutable value, and no snapshot shared with the
 * board: this tab's form is its own `useState`, refetched when the workspace scope changes. That keeps
 * a config edit from changing any other surface's rendering.
 */
import { createElement, useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  fetchGates,
  saveGates,
  type GatesEffective,
  type GatesPayload,
  type GatesSaveResult,
  type LiveScope,
} from './host-api.ts'

/** The workspace file the panel edits (copy only — the client never touches a path). */
export const GATES_CONFIG_DISPLAY_PATH = '.recursive/config/recursive-gates.json'

/** The Config keys of the four human gates, in panel order, with their labels. */
export const GATE_ROW_DEFS = [
  {
    configKey: 'runStart',
    gateId: 'run-start',
    title: 'Run start',
    defaultLabels: null,
    hint: 'Always on: the run-start gate is the approval that arms the run, so it cannot be disabled.',
  },
  {
    configKey: 'tddMode',
    gateId: 'tdd-mode',
    title: 'TDD mode',
    defaultLabels: ['strict', 'pragmatic'],
    hint: 'When the ask is off, this label is what the phase records.',
  },
  {
    configKey: 'qaSignoff',
    gateId: 'qa-signoff',
    title: 'QA sign-off',
    defaultLabels: ['human', 'agent-operated', 'hybrid'],
    hint: 'When the ask is off, this label is what the QA phase records.',
  },
  {
    configKey: 'gateBlock',
    gateId: 'gate-block',
    title: 'Block recovery',
    defaultLabels: null,
    hint: 'No default on purpose: fix/reopen/abandon are the person\'s call, so a blocked gate stays blocked rather than inventing one.',
  },
] as const

/** What the form binds to: the plain effective settings, no source information. */
export interface GatesFormValue {
  qa: { humanReview: boolean }
  gates: {
    runStart: { ask: boolean }
    tddMode: { ask: boolean; default: string }
    qaSignoff: { ask: boolean; default: string }
    gateBlock: { ask: boolean }
  }
  teammate: { primitiveRoles: string[] }
}

/** The value a fresh workspace starts from — the same defaults the Config schema applies. */
export function emptyGatesForm(): GatesFormValue {
  return {
    qa: { humanReview: false },
    gates: {
      runStart: { ask: true },
      tddMode: { ask: false, default: 'strict' },
      qaSignoff: { ask: true, default: 'agent-operated' },
      gateBlock: { ask: true },
    },
    teammate: { primitiveRoles: [] },
  }
}

/** Project the GET payload's effective settings onto the form (a copy, never the payload object). */
export function formValueOf(effective: GatesEffective | null): GatesFormValue {
  if (effective === null) return emptyGatesForm()
  return {
    qa: { humanReview: effective.qa.humanReview },
    gates: {
      runStart: { ask: effective.gates.runStart.ask },
      tddMode: { ask: effective.gates.tddMode.ask, default: effective.gates.tddMode.default },
      qaSignoff: { ask: effective.gates.qaSignoff.ask, default: effective.gates.qaSignoff.default },
      gateBlock: { ask: effective.gates.gateBlock.ask },
    },
    teammate: { primitiveRoles: [...effective.teammate.primitiveRoles] },
  }
}

/** The FILE value: the form's fields, in the workspace file's shape (sections only, no extras). */
export function gatesFileValue(form: GatesFormValue): unknown {
  return {
    qa: { humanReview: form.qa.humanReview },
    gates: {
      runStart: { ask: form.gates.runStart.ask },
      tddMode: { ask: form.gates.tddMode.ask, default: form.gates.tddMode.default },
      qaSignoff: { ask: form.gates.qaSignoff.ask, default: form.gates.qaSignoff.default },
      gateBlock: { ask: form.gates.gateBlock.ask },
    },
    teammate: { primitiveRoles: [...form.teammate.primitiveRoles] },
  }
}

/** The contradiction the host refuses (RM2203): human review on, but the sign-off ask off. */
export function gatesContradiction(form: GatesFormValue): string | null {
  if (form.qa.humanReview !== true || form.gates.qaSignoff.ask !== false) return null
  return 'Contradiction: "Require a human QA sign-off" is on while the QA sign-off gate asks nobody. '
    + 'A person must sign the QA off, but the only question that obtains that sign-off is disabled — the '
    + 'server refuses this save with RM2203. Turn the QA sign-off ask back on, or turn human review off.'
}

/** The transport seam. Defaults to the plugin's host HTTP calls; tests inject a double. */
export interface GatesTransport {
  fetch: (scope: LiveScope) => Promise<GatesPayload>
  save: (scope: LiveScope, value: unknown) => Promise<GatesSaveResult>
}

const DEFAULT_TRANSPORT: GatesTransport = {
  fetch: (scope) => fetchGates(scope),
  save: (scope, value) => saveGates(scope, value),
}

/** The tab body's props: the session-scope standard props, plus the test seam. */
export interface RecursiveGatesTabProps {
  /** Session id — the host resolves the workspace from the attached session header (primary). */
  sessionId?: string
  /** Fallback hint while a session is hydrating; never trusted as the write target by the host. */
  cwd?: string
  transport?: GatesTransport
}

/** One source badge ("decided by config / file / default"). */
function sourceBadge(source: string | undefined): ReactNode {
  const label = source ?? 'default'
  return createElement('span', { className: 'rec-gates-source', 'data-source': label }, label)
}

/**
 * The tab body: fetch on (re)mount and workspace-scope change, render the form, save through PUT.
 *
 * It does not gate on the recursive preset: the configuration belongs to the workspace and should be
 * reachable while diagnosing a session in any preset. The route resolves the same root the board uses.
 */
export function RecursiveGatesTab({ sessionId, cwd, transport = DEFAULT_TRANSPORT }: RecursiveGatesTabProps): ReactNode {
  const [payload, setPayload] = useState<GatesPayload | null>(null)
  const [form, setForm] = useState<GatesFormValue | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadProblem, setLoadProblem] = useState<string | null>(null)
  const [saveProblem, setSaveProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setSaveProblem(null)
    setNotice(null)
    try {
      const next = await transport.fetch({ ...(sessionId === undefined ? {} : { sessionId }), ...(cwd === undefined ? {} : { cwd }) })
      setPayload(next)
      setForm(next.effective === null ? null : formValueOf(next.effective))
      setLoadProblem(next.effective === null ? (next.problem ?? 'the host reported no effective settings') : null)
    } catch (error) {
      setPayload(null)
      setForm(null)
      setLoadProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [transport, sessionId, cwd])

  useEffect(() => {
    void load()
  }, [load])

  const update = (change: (current: GatesFormValue) => GatesFormValue): void => {
    setNotice(null)
    setSaveProblem(null)
    setForm((current) => (current === null ? current : change(current)))
  }

  const save = async (): Promise<void> => {
    if (form === null) return
    // The contradiction cannot be written (the host refuses it with RM2203), so the disabled button's
    // handler refuses too — a disabled control that still PUTs when invoked is not disabled.
    if (gatesContradiction(form) !== null) return
    setSaving(true)
    setSaveProblem(null)
    setNotice(null)
    try {
      const result = await transport.save({ ...(sessionId === undefined ? {} : { sessionId }), ...(cwd === undefined ? {} : { cwd }) }, gatesFileValue(form))
      if (!result.ok) {
        setSaveProblem(result.problem)
        return
      }
      // Re-read rather than assuming the write round-tripped: the host is the authority on the
      // effective values, and a GET is what proves the file now says what the form says. The notice is
      // set AFTER the reload because `load` clears it at its start.
      await load()
      setNotice(result.path === undefined ? 'Saved.' : 'Saved to ' + result.path)
    } catch (error) {
      setSaveProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const contradiction = form === null ? null : gatesContradiction(form)
  const sources = payload?.sources ?? {}

  return createElement('div', { className: 'rec-gates' },
    createElement('header', { className: 'rec-gates-header' },
      createElement('h2', { className: 'rec-gates-title' }, 'Recursive'),
      createElement('span', { className: 'rec-gates-tag' }, 'workspace settings'),
    ),
    createElement('p', { className: 'rec-gates-lede' },
      'Edits ' + GATES_CONFIG_DISPLAY_PATH + ' for this workspace. The plugin configuration is the other layer: '
      + 'a value it sets away from its default wins, and the file fills what it left at the default. '
      + 'Each row names the layer that decided the value shown.'),
    loading && createElement('p', { className: 'rec-gates-hint' }, 'Loading the effective settings…'),
    !loading && loadProblem !== null && createElement('div', { className: 'rec-gates-failure' },
      createElement('p', { className: 'rec-gates-error', role: 'alert' }, loadProblem),
      createElement('button', { type: 'button', className: 'rec-gates-button', onClick: () => { void load() } }, 'Retry'),
    ),
    !loading && form !== null && createElement('div', { className: 'rec-gates-form' },
      createElement('section', { className: 'rec-gates-section' },
        createElement('h3', { className: 'rec-gates-h3' }, 'QA sign-off'),
        createElement('label', { className: 'rec-gates-row' },
          createElement('span', { className: 'rec-gates-label' }, 'Require a human QA sign-off'),
          createElement('span', { className: 'rec-gates-control' },
            createElement('input', {
              type: 'checkbox',
              role: 'switch',
              className: 'rec-gates-switch',
              'aria-label': 'Require a human QA sign-off',
              checked: form.qa.humanReview,
              onChange: (event: { target: { checked: boolean } }) => {
                const checked = event.target.checked
                update((current) => ({ ...current, qa: { humanReview: checked } }))
              },
            }),
          ),
          sourceBadge(sources['qa.humanReview']),
        ),
        createElement('p', { className: 'rec-gates-hint' },
          'With this on, an agent-operated QA mode fails the phase-5 lint and the artifact must carry the '
          + 'person\'s sign-off line and the Human Review Instructions section.'),
      ),
      createElement('section', { className: 'rec-gates-section' },
        createElement('h3', { className: 'rec-gates-h3' }, 'Human gates'),
        GATE_ROW_DEFS.map((row) => {
          const gate = form.gates[row.configKey]
          const gateDefault = 'default' in gate ? gate.default : null
          return createElement('div', { key: row.gateId, className: 'rec-gates-row' },
            createElement('span', { className: 'rec-gates-label' }, row.title),
            createElement('label', { className: 'rec-gates-control' },
              createElement('input', {
                type: 'checkbox',
                role: 'switch',
                className: 'rec-gates-switch',
                'aria-label': 'Ask a person for ' + row.title,
                checked: gate.ask,
                ...(row.configKey === 'runStart' ? { disabled: true } : {}),
                onChange: (event: { target: { checked: boolean } }) => {
                  const checked = event.target.checked
                  update((current) => ({
                    ...current,
                    gates: { ...current.gates, [row.configKey]: { ...current.gates[row.configKey], ask: checked } },
                  }))
                },
              }),
              createElement('span', { className: 'rec-gates-control-text' }, 'ask'),
            ),
            sourceBadge(sources['gates.' + row.configKey + '.ask']),
            row.defaultLabels === null
              ? createElement('span', { className: 'rec-gates-hint rec-gates-hint-inline' }, row.hint)
              : createElement('label', { className: 'rec-gates-default' },
                createElement('span', { className: 'rec-gates-default-label' }, 'default'),
                createElement('select', {
                  className: 'rec-gates-select',
                  'aria-label': row.title + ' default',
                  value: gateDefault ?? '',
                  onChange: (event: { target: { value: string } }) => {
                    const value = event.target.value
                    update((current) => ({
                      ...current,
                      gates: { ...current.gates, [row.configKey]: { ...current.gates[row.configKey], default: value } },
                    }))
                  },
                }, row.defaultLabels.map((label) => createElement('option', { key: label, value: label }, label))),
                sourceBadge(sources['gates.' + row.configKey + '.default']),
              ),
          )
        }),
        createElement('p', { className: 'rec-gates-hint' },
          'Ask off means nobody is asked. The gate\'s configured default is recorded instead and the result '
          + 'says source: config, so the run never implies a person was involved.'),
      ),
      contradiction !== null && createElement('p', { className: 'rec-gates-warning', role: 'alert' }, contradiction),
      saveProblem !== null && createElement('p', { className: 'rec-gates-error', role: 'alert' }, saveProblem),
      notice !== null && createElement('p', { className: 'rec-gates-notice', role: 'status' }, notice),
      createElement('div', { className: 'rec-gates-actions' },
        createElement('button', {
          type: 'button',
          className: 'rec-gates-button rec-gates-save',
          disabled: saving || contradiction !== null,
          onClick: () => { void save() },
        }, saving ? 'Saving…' : 'Save'),
        createElement('button', {
          type: 'button',
          className: 'rec-gates-button rec-gates-reset',
          disabled: saving,
          onClick: () => { void load() },
        }, 'Reset'),
      ),
    ),
  )
}

/** The title seat: the tab chip (and a floating panel's header) says exactly "Recursive". */
export function RecursiveGatesTitle(): ReactNode {
  return createElement('span', { className: 'rec-gates-tab-title' }, 'Recursive')
}
