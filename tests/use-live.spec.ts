/**
 * Spec for run 0.1.18 (LIVE BUG 5): useLiveProjection must RETAIN its returned
 * snapshot when the scope changes, so the board never blanks during a
 * session/workspace switch. The synchronous stale-workspace suppression lives
 * in board.tsx (run 0.1.16); the hook must NOT null the snapshot on scope change.
 */
import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { create as createRenderer, act, type ReactTestRenderer } from 'react-test-renderer'
import { useLiveProjection } from '../src/client/use-live.ts'

vi.mock('../src/client/host-api.ts', () => ({
  fetchLiveState: vi.fn(),
  subscribeLiveEvents: vi.fn(() => () => {}),
}))

import { fetchLiveState } from '../src/client/host-api.ts'

function Probe({ cwd }: { cwd: string }) {
  const snapshot = useLiveProjection({ cwd })
  const value = snapshot === null ? 'null' : snapshot.root
  return createElement('div', { 'data-snapshot': value }, value)
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

describe('useLiveProjection (scope-change retention)', () => {
  it('retains the previous snapshot when scope.cwd changes until the new fetch resolves', async () => {
    const fetchMock = fetchLiveState as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockReset()

    // First scope resolves to workspace A.
    fetchMock.mockImplementationOnce(() => Promise.resolve({ root: '/a', projection: {}, revision: 1 }))
    let renderer: ReactTestRenderer | undefined
    await act(async () => { renderer = createRenderer(createElement(Probe, { cwd: '/a' })) })
    await flush()
    expect(renderer!.root.findByType('div').props['data-snapshot']).toBe('/a')

    // Second scope: deferred fetch we do NOT resolve yet.
    let resolveB: (v: unknown) => void = () => {}
    fetchMock.mockImplementationOnce(() => new Promise((res) => { resolveB = res }))
    await act(async () => { renderer!.update(createElement(Probe, { cwd: '/b' })) })

    // The previous '/a' snapshot must survive the switch — no blank flash (0.1.18).
    expect(renderer!.root.findByType('div').props['data-snapshot']).toBe('/a')

    // Resolve the new fetch and verify it lands.
    await act(async () => { resolveB({ root: '/b', projection: {}, revision: 2 }) })
    await flush()
    expect(renderer!.root.findByType('div').props['data-snapshot']).toBe('/b')
    renderer!.unmount()
  })

  it('still renders null for an empty scope (no sessionId, no cwd)', async () => {
    const fetchMock = fetchLiveState as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockReset()
    fetchMock.mockImplementation(() => Promise.resolve({ root: '/a', projection: {}, revision: 1 }))

    let renderer: ReactTestRenderer | undefined
    await act(async () => { renderer = createRenderer(createElement(Probe, { cwd: '/a' })) })
    await flush()
    expect(renderer!.root.findByType('div').props['data-snapshot']).toBe('/a')

    // Switching to an empty scope must still null the snapshot (no root to key on).
    await act(async () => { renderer!.update(createElement(Probe, { cwd: '' })) })
    expect(renderer!.root.findByType('div').props['data-snapshot']).toBe('null')
    renderer!.unmount()
  })
})
