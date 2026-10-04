/**
 * Spec for run 13 (conditional-hook fix) + run 14 (workspace-keyed board).
 *
 * Run 14 (USER-DIRECTED): the board must show runs for the CURRENT WORKSPACE,
 * not the current session. A workspace owns the .recursive/ run-layer history
 * and can hold several sessions. The old code keyed the live-route scope on
 * sessionId + session cwd; when the route's sessionsStore lookup missed the
 * header, root came back null -> 'No recursive runs' even though the workspace
 * has 9 runs. Fix: key on the WORKSPACE path via useWorkspaces.
 */
import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { create as createRenderer } from 'react-test-renderer'
import type { SessionListStateLike, SnapshotSelectorHook, WorkspaceListStateLike } from '../src/client/contract.ts'
import { currentWorkspacePath } from '../src/client/contract.ts'

const useLiveProjectionSpy = vi.fn()

vi.mock('../src/client/use-live.ts', () => ({
  useLiveProjection: (...args: unknown[]) => useLiveProjectionSpy(...args),
}))

import { RecursiveBoardOverlay } from '../src/client/slots.ts'

function sessionState(preset: string | undefined, current = 's1', cwd = '/w'): SessionListStateLike {
  return {
    ids: [current],
    byId: { [current]: { id: current, agentPreset: preset, cwd } },
    current,
  }
}

function selectorHook<T>(state: T): SnapshotSelectorHook<T> {
  return ((sel: (s: T) => unknown) => sel(state)) as SnapshotSelectorHook<T>
}

describe('currentWorkspacePath (run 14 workspace-keyed board)', () => {
  const ws: WorkspaceListStateLike = {
    items: [
      { workspaceId: 'ws1', path: '/recent', title: 'Recent', sessionIds: ['s2'] },
      { workspaceId: 'ws2', path: '/by-session', title: 'BySession', sessionIds: ['s1'] },
      { workspaceId: 'ws3', path: '/by-cwd', title: 'ByCwd', sessionIds: ['s3'] },
    ],
    recentWorkspaceId: 'ws1',
  }

  it('prefers the CURRENT session workspace over recentWorkspaceId', () => {
    const list: WorkspaceListStateLike = {
      items: [
        { workspaceId: 'ws-current', path: '/dsh-anti-slop', title: 'AntiSlop', sessionIds: ['s1'] },
        { workspaceId: 'ws-recent', path: '/temp', title: 'Temp', sessionIds: ['s2'] },
      ],
      recentWorkspaceId: 'ws-recent', // recent points at /temp, but session s1 is in dsh-anti-slop
    }
    expect(currentWorkspacePath(list, sessionState('recursive', 's1', '/dsh-anti-slop'))).toBe('/dsh-anti-slop')
  })

  it('falls back to the workspace whose sessionIds contains the current session', () => {
    const noRecent: WorkspaceListStateLike = { items: ws.items, recentWorkspaceId: undefined }
    expect(currentWorkspacePath(noRecent, sessionState('recursive', 's1', '/other'))).toBe('/by-session')
  })

  it('falls back to the workspace whose path equals the session cwd', () => {
    const noRecent: WorkspaceListStateLike = { items: ws.items, recentWorkspaceId: undefined }
    expect(currentWorkspacePath(noRecent, sessionState('recursive', 's9', '/by-cwd'))).toBe('/by-cwd')
  })

  it('returns empty string when nothing resolves', () => {
    const empty: WorkspaceListStateLike = { items: [], recentWorkspaceId: undefined }
    expect(currentWorkspacePath(empty, sessionState('recursive'))).toBe('')
  })
})

describe('slots hooks (run 13 conditional-hook + run 14 workspace-keyed)', () => {
  it('RecursiveBoardOverlay calls useLiveProjection UNCONDITIONALLY (even when closed/hidden)', () => {
    useLiveProjectionSpy.mockClear()
    const root = createRenderer(
      createElement(RecursiveBoardOverlay, { useSessions: selectorHook(sessionState('recursive')), useWorkspaces: selectorHook({ items: [], recentWorkspaceId: undefined } as WorkspaceListStateLike) }),
    )
    // Board starts closed -> content='hidden' -> renders null, but the hook MUST run.
    expect(root.toJSON()).toBeNull()
    expect(useLiveProjectionSpy).toHaveBeenCalledTimes(1)
    root.unmount()
  })

  it('RED: RecursiveBoardOverlay keys useLiveProjection on the WORKSPACE path (not sessionId)', () => {
    useLiveProjectionSpy.mockClear()
    const workspaces: WorkspaceListStateLike = {
      items: [{ workspaceId: 'ws1', path: '/workspace-root', title: 'WS', sessionIds: ['s1'] }],
      recentWorkspaceId: 'ws1',
    }
    const root = createRenderer(
      createElement(RecursiveBoardOverlay, {
        useSessions: selectorHook(sessionState('recursive', 's1', '/session-cwd')),
        useWorkspaces: selectorHook(workspaces),
      }),
    )
    expect(useLiveProjectionSpy).toHaveBeenCalledTimes(1)
    const scope = useLiveProjectionSpy.mock.calls[0][0] as Record<string, unknown>
    expect(scope.cwd).toBe('/workspace-root')
    expect(scope.sessionId).toBeUndefined()
    root.unmount()
  })

})
