/**
 * THE RECURSIVE TAB IN THE CHAT CONTEXT VIEW — the client half.
 *
 * Contract pinned here, exactly as the owner asked for it ("the config surface should be reached via
 * the Recursive tab in the chat context view"):
 *   • the tab TYPE registers into `ctx.sidebarRightTabs` with `id`, `kind: 'recursive'` and a title of
 *     "Recursive";
 *   • the BODY and TITLE seats register under that same `id` (the keyed dispatch contract), and the
 *     body seat renders the gates form;
 *   • the form itself renders one ask switch per gate plus the QA human-review switch, the default
 *     selectors where a gate has one, the contradiction WARNING before any PUT, and the host's named
 *     refusal verbatim when a save fails;
 *   • the plugin's settings section has a button that opens the tab via `sidebarRight.openTab`.
 *
 * The transport is injected, so no fetch is mocked and no network is touched: the double returns the
 * same payload shape `GET /.recursive/api/gates` serves (the route's own contract is pinned in
 * tests/gates-config.spec.ts).
 */
import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { act, create as createRenderer, type ReactTestInstance } from 'react-test-renderer'
import type { ClientContext } from '../src/client/contract.ts'
import type { GatesPayload, LiveScope } from '../src/client/host-api.ts'
import { RECURSIVE_TAB_ID, RECURSIVE_TAB_KIND, registerSlots } from '../src/client/slots.ts'
import {
  RecursiveGatesTab,
  type GatesTransport,
} from '../src/client/gates-form.tsx'

/** A payload matching the host's GET contract: effective values plus their sources. */
function payload(overrides: {
  humanReview?: boolean
  tddAsk?: boolean
  tddDefault?: string
  qaAsk?: boolean
  qaDefault?: string
  gateBlockAsk?: boolean
  problem?: string
} = {}): GatesPayload {
  return {
    root: '/workspace',
    effective: {
      qa: { humanReview: overrides.humanReview ?? false },
      gates: {
        runStart: { ask: true },
        tddMode: { ask: overrides.tddAsk ?? false, default: overrides.tddDefault ?? 'strict' },
        qaSignoff: { ask: overrides.qaAsk ?? true, default: overrides.qaDefault ?? 'agent-operated' },
        gateBlock: { ask: overrides.gateBlockAsk ?? true },
      },
      teammate: { primitiveRoles: [] },
    },
    sources: {
      'qa.humanReview': 'file',
      'gates.runStart.ask': 'default',
      'gates.tddMode.ask': 'file',
      'gates.tddMode.default': 'file',
      'gates.qaSignoff.ask': 'default',
      'gates.qaSignoff.default': 'default',
      'gates.gateBlock.ask': 'default',
      'teammate.primitiveRoles': 'default',
    },
    fromConfig: {},
    fromFile: { 'qa.humanReview': overrides.humanReview ?? false, 'gates.tddMode.ask': overrides.tddAsk ?? false },
    ...(overrides.problem === undefined ? {} : { problem: overrides.problem }),
  }
}

/** A transport double: records each PUT value, and can refuse the write. */
function transport(options: {
  initial?: GatesPayload
  saveResult?: { ok: true; path?: string } | { ok: false; problem: string }
} = {}): GatesTransport & { saved: unknown[]; fetches: LiveScope[]; saveMock: ReturnType<typeof vi.fn> } {
  const saved: unknown[] = []
  const fetches: LiveScope[] = []
  const saveMock = vi.fn(async (_scope: LiveScope, value: unknown) => {
    saved.push(value)
    return options.saveResult ?? { ok: true, path: '/workspace/.recursive/config/recursive-gates.json' }
  })
  return {
    saved,
    fetches,
    saveMock,
    fetch: async (scope) => {
      fetches.push(scope)
      return options.initial ?? payload()
    },
    save: saveMock as unknown as GatesTransport['save'],
  }
}

/** Concatenate every string in a rendered tree. */
function textOf(json: unknown): string {
  if (typeof json === 'string') return json
  if (typeof json === 'number') return String(json)
  if (json === null || json === undefined || typeof json === 'boolean') return ''
  if (Array.isArray(json)) return json.map(textOf).join(' ')
  return textOf((json as { children?: unknown }).children)
}

/** Render inside act and let the mount effect's GET settle. */
async function render(element: ReturnType<typeof createElement>): Promise<ReturnType<typeof createRenderer>> {
  let renderer!: ReturnType<typeof createRenderer>
  await act(async () => {
    renderer = createRenderer(element)
    await Promise.resolve()
  })
  return renderer
}

function switches(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((node) => node.type === 'input' && (node.props as Record<string, unknown>).role === 'switch')
}

function buttonByText(root: ReactTestInstance, text: string): ReactTestInstance {
  const matches = root.findAll((node) => node.type === 'button' && textOf((node.props as Record<string, unknown>).children).trim() === text)
  expect(matches, 'expected a button labelled ' + text).toHaveLength(1)
  return matches[0]!
}

/* ========================================================================== */
/* 1. registration: type, body seat, title seat, under the same id            */
/* ========================================================================== */

interface FakeCtx {
  ctx: ClientContext
  types: Array<{ id: string; kind: string; title: (address: string) => string }>
  slots: Array<{ name: string; key?: string; component: (props?: Record<string, unknown>) => unknown }>
  openTab: ReturnType<typeof vi.fn>
  effects: Array<() => void>
  /** Simulate the right-sidebar package appearing AFTER this client bundle applied. */
  releaseLate: () => void
}

function fakeCtx(withSidebar = true, late = false): FakeCtx {
  const types: FakeCtx['types'] = []
  const slots: FakeCtx['slots'] = []
  const effects: Array<() => void> = []
  const openTab = vi.fn()
  const makeTabs = (): { register: (definition: FakeCtx['types'][number]) => () => void } => ({
    register: (definition) => { types.push(definition); return () => {} },
  })
  let tabsService: ReturnType<typeof makeTabs> | undefined = withSidebar && !late ? makeTabs() : undefined
  const lateCallbacks: Array<(ctx: ClientContext) => void> = []
  const ctx = {
    slots: {
      inject: (_seat: string, factory: (inner: unknown) => () => void) => {
        const disposer = factory({})
        effects.push(disposer)
        return disposer
      },
      register: (options: { name: string; key?: string }, component: unknown) => {
        slots.push({ name: options.name, ...(options.key === undefined ? {} : { key: options.key }), component: component as FakeCtx['slots'][number]['component'] })
        return () => {}
      },
    },
    get: (name: string) => {
      if (!withSidebar) return undefined
      if (name === 'sidebarRightTabs') return tabsService
      if (name === 'sidebarRight') return { openTab }
      return undefined
    },
    inject: (deps: string[], callback: (ctx: ClientContext) => void) => {
      expect(deps).toEqual(['sidebarRightTabs'])
      lateCallbacks.push(callback)
      return {}
    },
    effect: (fn: () => () => void) => {
      const disposer = fn()
      effects.push(disposer)
      return disposer
    },
  }
  registerSlots(ctx as unknown as ClientContext)
  return {
    ctx: ctx as unknown as ClientContext,
    types,
    slots,
    openTab,
    effects,
    releaseLate: () => {
      tabsService = makeTabs()
      for (const callback of lateCallbacks) callback(ctx as unknown as ClientContext)
    },
  }
}

describe('the Recursive tab registers its type and both seats', () => {
  it('1a. registers { id, kind: recursive, title: "Recursive" } into sidebarRightTabs', () => {
    const { types } = fakeCtx()
    expect(types).toHaveLength(1)
    expect(types[0]!.id).toBe(RECURSIVE_TAB_ID)
    expect(types[0]!.kind).toBe(RECURSIVE_TAB_KIND)
    expect(types[0]!.title('/any/address')).toBe('Recursive')
  })

  it('1b. registers the body and the title under the DEFINITION id (not the kind)', () => {
    const { types, slots } = fakeCtx()
    const body = slots.filter((slot) => slot.name === 'sidebar.right.pane.tab')
    const title = slots.filter((slot) => slot.name === 'sidebar.right.pane.tab.title')
    expect(body).toHaveLength(1)
    expect(title).toHaveLength(1)
    // ⚠ THE KEY IS THE DEFINITION'S id, READ FROM THE REGISTERED TYPE rather than compared with a
    // constant: a change to the id that the seats did not follow would break dispatch while a
    // constant-vs-constant assertion stayed green (caught by mutation).
    expect(body[0]!.key).toBe(types[0]!.id)
    expect(title[0]!.key).toBe(types[0]!.id)
    expect(body[0]!.key).toBe(RECURSIVE_TAB_ID)
    // The body seat renders the gates tab, with the session scope passed through.
    const element = body[0]!.component({ sessionId: 's1' }) as { type: unknown; props: Record<string, unknown> }
    expect(element.type).toBe(RecursiveGatesTab)
    expect(element.props.sessionId).toBe('s1')
    // The title seat renders the constant title.
    const titleElement = title[0]!.component() as { type: string; props: Record<string, unknown> }
    expect(titleElement.props.children).toBe('Recursive')
  })

  it('1c. without the right-sidebar services the other seats still register (nothing breaks)', () => {
    const { types, slots } = fakeCtx(false)
    expect(types).toHaveLength(0)
    expect(slots.some((slot) => slot.name === 'sidebar.right.pane.tab')).toBe(false)
    // The plugin's existing surface is untouched.
    expect(slots.filter((slot) => slot.name === 'conversation.view')).toHaveLength(1)
    expect(slots.filter((slot) => slot.name === 'settings.section')).toHaveLength(1)
    expect(slots.filter((slot) => slot.name === 'sidebar.footer.action')).toHaveLength(1)
  })

  it('1d. the settings section has an entry button that opens the tab by kind', async () => {
    const { ctx, slots, openTab } = fakeCtx()
    const seat = slots.find((slot) => slot.name === 'settings.section')
    expect(seat).toBeDefined()
    // Without the root kit the seat renders the static panel — which still owns the button.
    const element = seat!.component({ close: () => {} }) as ReturnType<typeof createElement>
    const renderer = await render(element)
    const button = buttonByText(renderer.root, 'Open Recursive tab')
    act(() => { (button.props as { onClick: () => void }).onClick() })
    expect(openTab).toHaveBeenCalledWith(RECURSIVE_TAB_KIND)
    expect(ctx).toBeDefined()
  })

  it('1e. waits for a right sidebar mounted by a LATER loader package, then registers when it appears', () => {
    const fake = fakeCtx(true, true)
    // Nothing yet: the service really is absent when this bundle applies.
    expect(fake.types).toHaveLength(0)
    expect(fake.slots.some((slot) => slot.name === 'sidebar.right.pane.tab')).toBe(false)
    fake.releaseLate()
    expect(fake.types).toHaveLength(1)
    expect(fake.types[0]!.id).toBe(RECURSIVE_TAB_ID)
    expect(fake.slots.filter((slot) => slot.name === 'sidebar.right.pane.tab')).toHaveLength(1)
    expect(fake.slots.filter((slot) => slot.name === 'sidebar.right.pane.tab.title')).toHaveLength(1)
  })
})

/* ========================================================================== */
/* 2. the body: switches, defaults, save, refusals, contradiction             */
/* ========================================================================== */

describe('the Recursive tab body', () => {
  it('2a. renders ONE ask switch per gate plus the QA human-review switch, and the two default selectors', async () => {
    const t = transport()
    const renderer = await render(createElement(RecursiveGatesTab, { transport: t }))
    const root = renderer.root
    const all = switches(root)
    expect(all).toHaveLength(5)
    for (const label of ['Ask a person for Run start', 'Ask a person for TDD mode', 'Ask a person for QA sign-off', 'Ask a person for Block recovery', 'Require a human QA sign-off']) {
      expect(all.some((node) => (node.props as Record<string, unknown>)['aria-label'] === label), label).toBe(true)
    }
    const selects = root.findAll((node) => node.type === 'select')
    expect(selects.map((node) => (node.props as Record<string, unknown>)['aria-label'])).toEqual(['TDD mode default', 'QA sign-off default'])
    // run-start cannot be disabled; the other ask switches can.
    const runStart = all.find((node) => (node.props as Record<string, unknown>)['aria-label'] === 'Ask a person for Run start')!
    expect((runStart.props as Record<string, unknown>).disabled).toBe(true)
    const tdd = all.find((node) => (node.props as Record<string, unknown>)['aria-label'] === 'Ask a person for TDD mode')!
    expect((tdd.props as Record<string, unknown>).disabled).toBeUndefined()
    // The sources travel into the form: the file-decided fields say so.
    expect(textOf(renderer.toJSON()).includes('file')).toBe(true)
  })

  it('2b. a toggle + Save PUTs the whole file value and re-reads it (the host is the authority)', async () => {
    const t = transport()
    const renderer = await render(createElement(RecursiveGatesTab, { transport: t }))
    const root = renderer.root
    const qaSwitch = switches(root).find((node) => (node.props as Record<string, unknown>)['aria-label'] === 'Require a human QA sign-off')!
    await act(async () => {
      (qaSwitch.props as { onChange: (event: { target: { checked: boolean } }) => void }).onChange({ target: { checked: true } })
    })
    const tddDefault = root.findAll((node) => node.type === 'select' && (node.props as Record<string, unknown>)['aria-label'] === 'TDD mode default')[0]!
    await act(async () => {
      (tddDefault.props as { onChange: (event: { target: { value: string } }) => void }).onChange({ target: { value: 'pragmatic' } })
    })
    const save = buttonByText(root, 'Save')
    await act(async () => { (save.props as { onClick: () => void }).onClick(); await Promise.resolve() })
    expect(t.saved).toHaveLength(1)
    expect(t.saved[0]).toMatchObject({
      qa: { humanReview: true },
      gates: { tddMode: { ask: false, default: 'pragmatic' } },
    })
    // The save re-reads the effective settings, so a save cannot leave the form showing a guess.
    expect(t.fetches.length).toBeGreaterThanOrEqual(2)
    expect(textOf(renderer.toJSON())).toContain('Saved to')
  })

  it('2c. the host\'s NAMED refusal is shown VERBATIM when the save fails', async () => {
    const problem = 'RM1146 input: gates.runStart.ask is false, but the run-start gate is the approval that arms the run and cannot be disabled - remove the field. Next: set gates.runStart.ask: true.'
    const t = transport({ saveResult: { ok: false, problem } })
    const renderer = await render(createElement(RecursiveGatesTab, { transport: t }))
    const save = buttonByText(renderer.root, 'Save')
    await act(async () => { (save.props as { onClick: () => void }).onClick(); await Promise.resolve() })
    const alerts = renderer.root.findAll((node) => node.type === 'p' && (node.props as Record<string, unknown>).role === 'alert')
    expect(alerts.some((node) => textOf((node.props as Record<string, unknown>).children) === problem)).toBe(true)
  })

  it('2d. the human-review/qa-ask contradiction is an inline WARNING and Save is disabled (no unexplained PUT)', async () => {
    const t = transport({ initial: payload({ humanReview: true, qaAsk: false }) })
    const renderer = await render(createElement(RecursiveGatesTab, { transport: t }))
    const warning = renderer.root.findAll((node) => node.type === 'p' && (node.props as Record<string, unknown>).role === 'alert')
      .map((node) => textOf((node.props as Record<string, unknown>).children))
      .find((text) => text.includes('Contradiction'))
    expect(warning).toBeDefined()
    expect(String(warning)).toContain('RM2203')
    const save = buttonByText(renderer.root, 'Save')
    expect((save.props as Record<string, unknown>).disabled).toBe(true)
    // The transport is never called: the form refuses before the PUT, which is the requirement.
    await act(async () => { (save.props as { onClick: () => void }).onClick(); await Promise.resolve() })
    expect(t.saved).toHaveLength(0)
  })

  it('2e. a host-reported unusable file is displayed with its named problem and a Retry, not a guessed form', async () => {
    const problem = 'RM1147 input: the workspace gates file cannot be read as the gates schema - unknown key "gates.wat" in .recursive/config/recursive-gates.json. Next: fix .recursive/config/recursive-gates.json.'
    const t = transport({ initial: { root: '/workspace', effective: null, sources: {}, fromConfig: {}, fromFile: {}, problem } })
    const renderer = await render(createElement(RecursiveGatesTab, { transport: t }))
    expect(textOf(renderer.toJSON())).toContain(problem)
    expect(renderer.root.findAll((node) => node.type === 'input')).toHaveLength(0)
    expect(buttonByText(renderer.root, 'Retry')).toBeDefined()
  })
})
