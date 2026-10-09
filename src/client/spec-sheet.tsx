/**
 * THE RUN-START SPEC SHEET — the document beside the question it decides.
 *
 * THE DEFECT THIS ANSWERS. The owner asked for a run spec, the plugin scaffolded one and raised the
 * `run-start` gate — "start this run or hold?" — and NOBODY WAS SHOWN THE DOCUMENT:
 * *"the card ui for accepting the spec appeared, but i was never shown the spec before that so how could i
 * approve if i havent seen it"*. The gate was decidable before it was readable.
 *
 * ⚠ WHERE THIS RENDERS, AND WHY NOT IN `conversation.approval.detail`. That seat was the first candidate —
 * its catalog summary reads "Optional detail for the Tool call correlated with an approval request" — and it
 * is the WRONG one, for a reason that is structural rather than stylistic:
 *
 *   1. `conversation.composer` is a CHAIN slot: its entries' selectors run in order and the FIRST non-null
 *      match renders. `ui-approval` claims it with `select: pendingInteraction instanceof PendingApproval`
 *      and declares `conversation.approval.detail` as its child; `ui-user-questions` claims it with
 *      `select: pendingInteraction instanceof PendingQuestion` and declares
 *      `conversation.plan-review.actions` instead. They are two mutually exclusive cells of ONE chain.
 *   2. The run-start gate is asked through the USER-QUESTIONS channel (`askRunStartDirectly` →
 *      `channel.ask(...)`, correlated by `wait: { callId: exec.callId }`), so while it is pending the
 *      pending interaction IS a `PendingQuestion` — the question composer owns the composer, and
 *      `conversation.approval.detail` is not mounted at all. A sheet registered there would render on the
 *      one occasion it is not needed and never on the one it is.
 *   3. `tool.call.toolview` keyed by tool name is the seat that exists exactly while THIS tool call is on
 *      screen, is unclaimed for `recursive_ask` (the harness's own `ask_user_question` IS claimed, which is
 *      the parallel that matters), and hands the view its own `callId`, the session `cwd` and the frozen
 *      call block — which is how the `runId` is read out of the call's own arguments.
 *
 * WHAT IT SHOWS — AND THE DEFECT THAT CHANGED IT. This seat first showed the ACTUAL bytes of
 * `.recursive/run/<runId>/00-requirements.md` as RAW TEXT, on the reasoning that verbatim is the honest
 * thing to print. The honest answer to "is that a preview?" was NO, and the owner was being asked to APPROVE
 * what they read: *reading `##` headings and pipe-table syntax is not reviewing a spec*. So the default is now
 * a RENDERED PREVIEW — headings, lists, fenced code and pipe tables drawn as such — and the verbatim text is
 * one press away behind "View source".
 *
 * ⚠ AND THE RAW MODE IS NOT DECORATION. A preview is an INTERPRETATION, and this seat asks a person to
 * approve a document on the strength of it. The raw view exists so that "the preview is not paraphrasing or
 * hiding anything" is a claim the reader can CHECK against the bytes rather than one they must take from the
 * renderer. Its state is carried by `aria-pressed` and repeated in a `role="status"` line that names the mode
 * on screen, so the mode is announced and not merely coloured.
 *
 * ⚠ ONE RENDERER, NOT TWO. The markdown is parsed and drawn by `doc-viewer.tsx` — `parseDoc` and its
 * `PreviewLines` — the same code path the phase-doc viewer uses. A second markdown renderer in one plugin
 * would be a second answer to "what does this document say", which is the defect this plugin exists to
 * refuse. What `parseDoc` could not carry for a real `00-requirements.md` (the task boxes and the gate
 * readings the template ships) was added THERE, for both readers, rather than forked here.
 *
 * WHAT IT STILL REFUSES TO DO. It is READ-ONLY (R9): the sheet has no approve/hold control, because a second
 * control that looks like the question card's would be a second way to answer one question — the sheet may
 * change HOW the document is shown, never WHETHER it is approved. And the honesty rule of
 * `settings-view.ts` is unchanged: when the artifact is still the unfilled template the rendered view says so
 * loudly and the unfilled marks stay visible AS unfilled (`☐ …` items and `Coverage: FAIL` gates are drawn as
 * exactly that), so a pretty preview of an empty form can never read as an approvable spec.
 *
 * ACCESSIBILITY. The outer element is a `region` named by its own heading (`aria-labelledby`); the document
 * body is a focusable (`tabIndex=0`) scrolling box with its own `aria-label` and `aria-readonly`, so the
 * keyboard reaches the text and can scroll it without the decision controls leaving the viewport (the cap is
 * CSS `max-height` with `overflow-y: auto`). The box is the SAME element in both modes, so toggling never
 * drops focus. Escape is swallowed deliberately, because on a dialog-ish surface Escape is the key that
 * dismisses and dismissing this sheet must never be read as a decision; and the one transition it has is none
 * under `prefers-reduced-motion` (see the `.rec-spec` rules in `styles.ts`). No modal is used: nothing here
 * needs a focus trap, and a trap would take the keyboard away from the decision controls.
 */
import { createElement, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SessionListStateLike, SnapshotSelectorHook, WorkspaceListStateLike } from './contract.ts'
import { currentSessionCwd, currentWorkspacePath } from './contract.ts'
import { parseDoc, PreviewLines } from './doc-viewer.tsx'
import { fetchPhaseDoc } from './host-api.ts'
import { useLiveProjection } from './use-live.ts'
import { unfilledEvidence } from '../run-spec.ts'
import {
  decisionLine,
  isSpecSheetCall,
  otherMode,
  PREPARING_NOTICE,
  readCall,
  RUN_START_OPTION_MEANING,
  RUN_START_QUESTION,
  RUN_START_SPEC_FILE,
  SPEC_DEFAULT_MODE,
  specBodyContent,
  specPath,
  specSheetModel,
  specViewToggle,
  TRUNCATED_NOTICE,
  type SpecFetch,
  type SpecSheetBlock,
  type SpecSheetModel,
  type SpecViewMode,
} from './spec-sheet-view.ts'

export {
  RUN_START_TOOL_NAME,
  RUN_START_SPEC_FILE,
  parseRecursiveAskArgs,
  isRunStartCall,
  specPath,
  specSheetModel,
  decisionLine,
  UNFILLED_NOTICE,
  UNFILLED_SHORT,
  NO_CALL_NOTICE,
  PREPARING_NOTICE,
  TRUNCATED_NOTICE,
  SPEC_DEFAULT_MODE,
  SPEC_MODE_LABEL,
  SPEC_MODE_NOTE,
  SPEC_TOGGLE_LABEL,
  otherMode,
  specBodyContent,
  specViewToggle,
} from './spec-sheet-view.ts'
export type { SpecSheetModel, SpecSheetBlock, SpecFetchState, RecursiveAskArgs, SpecViewMode, SpecViewToggle } from './spec-sheet-view.ts'

/** The session-standard hooks the seat is given, all optional so the spec can render the sheet alone. */
export interface SpecSheetProps {
  /** The owner's call block; `null` when the owner supplied none (a window-truncated caller). */
  block?: SpecSheetBlock
  /** The session workspace root the owner supplied (`ToolCallCommonProps.cwd`). */
  cwd?: string
  useSessions?: SnapshotSelectorHook<SessionListStateLike>
  useWorkspaces?: SnapshotSelectorHook<WorkspaceListStateLike>
}

const EMPTY_WORKSPACES: WorkspaceListStateLike = { items: [], recentWorkspaceId: undefined }

/**
 * A scope that resolves nothing.
 *
 * The hook stays UNCONDITIONAL (the run 13 lesson: a conditional hook changed the hook count across renders
 * and threw "Rendered more hooks than during the previous render"), so a row that is not a run-start call
 * passes this and the route is never asked for it.
 */
const NO_SCOPE = { sessionId: undefined as string | undefined, cwd: undefined as string | undefined }

/**
 * Resolve the workspace root the `/doc` route will accept.
 *
 * ⚠ THE ROOT CANNOT BE THE SESSION CWD BY GUESSWORK. The route re-validates whatever root it is handed
 * against the host's own workspace registry (`live-route.ts`: `resolveRoot(undefined, root)` must return the
 * same canonical path), so the root used here is the one the live route ITSELF answered with; the workspace
 * path is the hydration hint every other seat passes, and the owner-supplied `cwd` is the last resort.
 */
export function resolveSpecRoot(
  snapshotRoot: string | null | undefined,
  workspacePath: string,
  cwd: string,
): string | null {
  if (typeof snapshotRoot === 'string' && snapshotRoot.trim() !== '') return snapshotRoot
  if (workspacePath.trim() !== '') return workspacePath
  return cwd.trim() === '' ? null : cwd
}

/** The route states the /doc fetch can produce, and what each one MEANS. */
function readDoc(
  runId: string | null,
  root: string | null,
  file: string,
): SpecFetch {
  const [fetchState, setFetchState] = useState<SpecFetch>({ state: 'loading' })
  useEffect(() => {
    if (runId === null || root === null) {
      // Nothing to read yet: the route has not resolved a root (or the call names no run). This is the
      // LOADING state, not an error — the subscription is what resolves the root.
      setFetchState({ state: 'loading' })
      return
    }
    let disposed = false
    setFetchState({ state: 'loading' })
    fetchPhaseDoc({ root, runId, file })
      .then((text) => { if (!disposed) setFetchState({ state: 'loaded', text }) })
      .catch((err: unknown) => {
        if (disposed) return
        const message = err instanceof Error ? err.message : String(err)
        // ⚠ 404 IS AN ANSWER, NOT A FAILURE. The route distinguishes "this document is not there" from every
        // other failure, and a client that folded them together would report a broken route when the truth
        // is that the spec has not been written — the difference between "fix the client" and "write it".
        const missing = /HTTP 404\b/.test(message)
        setFetchState({ state: missing ? 'absent' : 'error', error: message })
      })
    return () => { disposed = true }
  }, [runId, root, file])
  return fetchState
}

/**
 * The seat component: renders the spec sheet for ONE `recursive_ask` tool call, and NOTHING for any other.
 *
 * Returning `null` is how an unclaimed key behaves, so a `tdd-mode` / `qa-signoff` / `gate-block` ask, or a
 * preparing call whose arguments have not been dispatched yet, keeps the generic tool row it has today.
 */
export function RunStartSpecSheet({ block, cwd, useSessions, useWorkspaces }: SpecSheetProps): ReactNode {
  const sessions = useSessions === undefined ? null : useSessions((s) => s)
  const workspaces = useWorkspaces === undefined ? EMPTY_WORKSPACES : useWorkspaces((s) => s) ?? EMPTY_WORKSPACES
  const workspacePath = sessions === null ? '' : currentWorkspacePath(workspaces, sessions)
  const sessionCwd = sessions === null ? '' : currentSessionCwd(sessions)

  const read = readCall(block)
  const claims = isSpecSheetCall(read)
  const runId = read.ok ? read.args.runId : null
  const scope = sessions === null
    ? NO_SCOPE
    : { sessionId: sessions.current, cwd: workspacePath !== '' ? workspacePath : sessionCwd }
  const snapshot = useLiveProjection(scope, { enabled: claims })
  const root = resolveSpecRoot(snapshot?.root ?? null, workspacePath, cwd ?? '')
  const fetchState = readDoc(claims ? runId : null, root, RUN_START_SPEC_FILE)

  if (!read.ok) {
    // Each failure says WHICH failure it is: an empty frame would read as "the document is empty", which is
    // a different and much worse claim than "this panel could not resolve the call".
    if (read.reason === 'missing') return null
    const text = read.reason === 'preparing' ? PREPARING_NOTICE : TRUNCATED_NOTICE
    return specFrame(createElement('p', { className: 'rec-spec-notice', role: 'status' }, text))
  }
  if (!claims) return null
  if (read.args.runId === null) {
    // Unreachable through `claims` (which requires a runId), kept as the explicit statement of the rule.
    return specFrame(createElement('p', { className: 'rec-spec-notice', role: 'status' },
      'This `recursive_ask` call names no runId, so no run spec can be shown for it.'))
  }

  return createElement(RunStartSpecSheetBody, {
    model: specSheetModel({ args: read.args, root, fetch: fetchState }),
  })
}

/**
 * The body, from a MODEL — split out so the spec can drive every state (stub, filled, absent, error, a
 * recorded Hold, a recorded approval) without a route, a session, or a fetch.
 *
 * The MODE is local state and starts at the rendered preview (`SPEC_DEFAULT_MODE`); everything that decides
 * what the sheet SAYS still comes from the pure model, so a spec can assert the words and the marks without
 * mounting a component.
 */
export function RunStartSpecSheetBody({ model }: { model: SpecSheetModel }): ReactNode {
  const headingId = 'rec-spec-title-' + (model.runId ?? 'unresolved')
  const [mode, setMode] = useState<SpecViewMode>(SPEC_DEFAULT_MODE)
  const toggle = specViewToggle(mode)
  return createElement('section', {
    className: 'rec-spec',
    role: 'region',
    'aria-labelledby': headingId,
    'aria-readonly': 'true',
    'data-verdict': model.verdict ?? model.state,
    'data-mode': mode,
    // ⚠ ESCAPE MUST NOT SILENTLY APPROVE. There is no control here to dismiss and no decision to cast, so the
    // key is consumed and dropped — written out rather than left to whatever a surrounding dialog might do
    // with it. (The decision itself belongs to the question card, which owns its own keyboard handling. The
    // preview/source toggle is a mode, not a dismissal, so it is a button and Escape deliberately ignores it.)
    onKeyDown: (event: { key?: string; preventDefault?: () => void; stopPropagation?: () => void }) => {
      if (event.key !== 'Escape') return
      event.preventDefault?.()
      event.stopPropagation?.()
    },
  },
  createElement('header', { className: 'rec-spec-header' },
    createElement('h3', { className: 'rec-spec-title', id: headingId },
      'Run spec — ' + (model.runId ?? 'runId not carried') + ' / ' + model.file),
    createElement('span', { className: 'rec-spec-tag' }, 'read-only'),
  ),
  createElement('p', { className: 'rec-spec-path' }, specPath(model.runId, model.root, model.file)),
  notice(model),
  questionBlock(model),
  viewControls(toggle, model, () => { setMode(otherMode(toggle.mode)) }),
  documentBody(model, mode),
  )
}

/**
 * The mode control: one button, and the line that announces the state it just put the sheet in.
 *
 * ⚠ KEYBOARD-REACHABLE BY BEING A BUTTON. It is a real `<button type="button">`, so Tab reaches it and
 * Enter/Space press it with no key handler of our own to get wrong. `aria-pressed` carries the state to a
 * screen reader on the control, and the `role="status"` paragraph repeats it in words, naming the mode ON
 * SCREEN ("Showing: raw source") rather than the action — so neither a pointer user nor a reader has to infer
 * the current mode from the button's face.
 */
function viewControls(toggle: ReturnType<typeof specViewToggle>, model: SpecSheetModel, onToggle: () => void): ReactNode {
  const shown = model.text !== null
  return createElement('div', { className: 'rec-spec-view' },
    createElement('button', {
      type: 'button',
      className: 'rec-spec-view-toggle',
      // `aria-pressed` is the STATE; the label is the ACTION. A toggle whose label says "raw" while the
      // preview is on screen is the classic way a control lies about which of two things is displayed.
      'aria-pressed': toggle.pressed,
      title: toggle.announce,
      // ⚠ `aria-disabled`, NOT `disabled`. A real `disabled` attribute does not stop the adjacent
      // `role="status"` line from announcing a mode, so with no document loaded the control would be inert
      // while the line beside it claimed a mode was on screen. `aria-disabled` keeps the control reachable and
      // its state true, and the click is refused below instead of by the browser.
      'aria-disabled': !shown,
      onClick: () => { if (shown) onToggle() },
    }, toggle.action),
    createElement('span', { className: 'rec-spec-view-state', role: 'status' }, toggle.announce),
  )
}

/**
 * The document body: the rendered preview, or the raw bytes — and only ever the document's OWN text.
 *
 * Both modes are built from the same string, so neither is a second reading of the file: `raw` prints the
 * characters, `preview` hands those same characters to the one parser this plugin has.
 */
function documentBody(model: SpecSheetModel, mode: SpecViewMode): ReactNode {
  const content = specBodyContent(model.text, mode)
  // The box is rendered in EVERY state, including the empty one: it is the element the keyboard focuses and
  // the label names, and a box that appears and disappears would move that focus target around the page.
  const box = {
    className: 'rec-spec-body-scroll' + (content !== null && content.mode === 'raw' ? ' rec-spec-body-raw' : ''),
    // The text IS the point of this seat: focusable so the keyboard can reach and scroll it, and named
    // separately from the region so the two are not announced as one thing. The same element serves both
    // modes, so pressing the toggle changes its children and never its identity — focus survives the swap.
    tabIndex: 0,
    role: 'group' as const,
    'aria-label': 'Document text of ' + (model.runId ?? 'the run') + ' / ' + model.file + ', read-only, '
      + (mode === 'raw' ? 'raw source' : 'rendered preview'),
  }
  if (content === null) {
    return createElement('div', box,
      createElement('p', { className: 'rec-spec-empty' }, 'No document text to show.'),
    )
  }
  if (content.mode === 'raw') {
    return createElement('div', box, createElement('pre', { className: 'rec-spec-text' }, content.text))
  }
  return createElement('div', box, createElement(SpecPreview, { text: content.text, runId: model.runId, file: model.file }))
}

/**
 * The rendered document.
 *
 * The parsing is memoised on the TEXT, so a toggle back and forth does not re-parse the document, and the
 * elements come from `doc-viewer.tsx`'s `PreviewLines` — the one place in this plugin where a `DocLine`
 * becomes markup.
 */
function SpecPreview({ text, runId, file }: { text: string; runId: string | null; file: string }): ReactNode {
  const lines = useMemo(() => parseDoc(text), [text])
  return createElement(PreviewLines, { lines, keyBase: 'rec-spec-' + (runId ?? 'run') + '-' + file })
}


/** The verdict notice: what the document IS, decided from its own text. */
function notice(model: SpecSheetModel): ReactNode {
  if (model.state === 'loading') {
    return createElement('p', { className: 'rec-spec-notice', role: 'status' }, 'Reading the document…')
  }
  if (model.state === 'absent') {
    return createElement('p', { className: 'rec-spec-notice rec-spec-notice-error', role: 'status' },
      'That document does not exist yet, so there is nothing here to read and nothing to approve.')
  }
  if (model.state === 'error') {
    return createElement('p', { className: 'rec-spec-notice rec-spec-notice-error', role: 'status' },
      'The document could not be read: ' + (model.error ?? 'the route gave no reason'))
  }
  if (model.verdict === 'unfilled') {
    const strong = unfilledEvidence({ verdict: 'unfilled', hits: model.evidence })
    const context = model.evidence.filter((hit) => hit.id !== 'placeholder')
    return createElement('div', { className: 'rec-spec-notice rec-spec-notice-unfilled', role: 'status' },
      createElement('p', { className: 'rec-spec-unfilled-lead' },
        'This document is still the UNFILLED TEMPLATE. There is no spec to approve yet.'),
      createElement('p', { className: 'rec-spec-unfilled-why' },
        'The template\'s own placeholder text is still in it:'),
      createElement('ul', { className: 'rec-spec-evidence' },
        strong.slice(0, 8).map((hit, n) => createElement('li', {
          key: 'placeholder-' + String(n),
          className: 'rec-spec-evidence-item',
        }, 'line ' + String(hit.line) + ': ' + hit.text)),
      ),
      strong.length > 8
        ? createElement('p', { className: 'rec-spec-unfilled-why' },
          '…and ' + String(strong.length - 8) + ' more placeholder lines.')
        : null,
      context.length > 0
        ? createElement('p', { className: 'rec-spec-unfilled-why' },
          'It also carries ' + String(context.length) + ' unfinished marker(s) of its own: '
          + context.slice(0, 3).map((hit) => 'line ' + String(hit.line) + ': ' + hit.text).join(' | '))
        : null,
      createElement('p', { className: 'rec-spec-unfilled-next' },
        'Fill the document in first. Approving here would record a decision about a spec that does not exist yet.'),
    )
  }
  if (model.verdict === 'filled') {
    return createElement('p', { className: 'rec-spec-notice rec-spec-notice-filled', role: 'status' },
      'The document carries real content: no template placeholder remains in it.')
  }
  return null
}

/** The decision under way, in the gate's own words, plus the fact that the controls live elsewhere. */
function questionBlock(model: SpecSheetModel): ReactNode {
  const recorded = decisionLine(model.args.answer)
  return createElement('div', { className: 'rec-spec-question' },
    createElement('p', { className: 'rec-spec-question-lead' }, 'The question about this document is: “' + RUN_START_QUESTION + '”'),
    createElement('p', { className: 'rec-spec-question-options' }, RUN_START_OPTION_MEANING),
    createElement('p', { className: 'rec-spec-question-where' },
      'The decision controls are the question card\'s. This panel is read-only: it casts no vote and writes nothing.'),
    recorded === null ? null : createElement('p', { className: 'rec-spec-decision' }, recorded),
  )
}

/** A minimal named frame for the states that precede a document (no call, no run id). */
function specFrame(...children: ReactNode[]): ReactNode {
  return createElement('section', {
    className: 'rec-spec',
    role: 'region',
    'aria-label': 'Run spec',
    'aria-readonly': 'true',
  }, ...children)
}
