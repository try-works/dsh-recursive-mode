/**
 * Board/Inspector theme state (run 16 / Paper). Default LIGHT, dark via a
 * header toggle that flips data-theme on the root .rec-board / .rec-inspector.
 * Persisted to localStorage under 'dsh-recursive-theme' (first visit = light).
 */
import { createElement, useCallback, useEffect, useState } from 'react'

export const BOARD_THEME_STORAGE_KEY = 'dsh-recursive-theme'

export type BoardTheme = 'light' | 'dark'

export interface BoardThemeState {
  theme: BoardTheme
  toggle: () => void
}

function readInitialTheme(): BoardTheme {
  if (typeof localStorage === 'undefined') return 'light'
  try {
    return localStorage.getItem(BOARD_THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/**
 * Hoisted at the TOP of Board and Inspector (never after an early return — run
 * 0.1.10 invariant). Defaults light, reads a persisted dark on init, and writes
 * the chosen theme back to localStorage.
 */
export function useBoardTheme(): BoardThemeState {
  const [theme, setTheme] = useState<BoardTheme>(readInitialTheme)
  const toggle = useCallback(() => setTheme((t) => (t === 'light' ? 'dark' : 'light')), [])
  useEffect(() => {
    try {
      localStorage.setItem(BOARD_THEME_STORAGE_KEY, theme)
    } catch {
      /* storage unavailable — theme still works for the session */
    }
  }, [theme])
  return { theme, toggle }
}

/** The shared header toggle button (moon in light, sun in dark). */
export function ThemeToggle({ theme, toggle }: BoardThemeState) {
  return createElement('button', {
    type: 'button',
    className: 'rec-theme-toggle',
    onClick: toggle,
    title: theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme',
    'aria-label': 'Toggle theme',
  }, theme === 'light' ? '☾' : '☀')
}
