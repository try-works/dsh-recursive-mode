/**
 * Spec for run 16 (Paper theme): useBoardTheme defaults to light, toggles to
 * dark, and persists to localStorage under 'dsh-recursive-theme'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { create as createRenderer, act } from 'react-test-renderer'
import { useBoardTheme, BOARD_THEME_STORAGE_KEY } from '../src/client/theme.ts'

function Probe() {
  const { theme, toggle } = useBoardTheme()
  return createElement('button', { 'data-theme': theme, onClick: toggle }, theme)
}

describe('useBoardTheme (Paper theme)', () => {
  let store: Record<string, string>
  beforeEach(() => {
    store = {}
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('defaults to light on first visit', () => {
    const r = createRenderer(createElement(Probe))
    expect(r.root.findByType('button').props['data-theme']).toBe('light')
    r.unmount()
  })

  it('toggle flips to dark and persists to localStorage', () => {
    const r = createRenderer(createElement(Probe))
    const btn = r.root.findByType('button')
    act(() => btn.props.onClick())
    expect(r.root.findByType('button').props['data-theme']).toBe('dark')
    expect(store[BOARD_THEME_STORAGE_KEY]).toBe('dark')
    r.unmount()
  })

  it('reads a persisted dark theme on init', () => {
    store[BOARD_THEME_STORAGE_KEY] = 'dark'
    const r = createRenderer(createElement(Probe))
    expect(r.root.findByType('button').props['data-theme']).toBe('dark')
    r.unmount()
  })
})
