/**
 * Spec for run 15/16: injectBoardStyles() injects exactly ONE <style
 * data-dsh-recursive> into document.head (idempotent), carrying the Paper
 * theme tokens (light default + dark remap) and solid status pills.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { injectBoardStyles } from '../src/client/styles.ts'

interface FakeStyle {
  attrs: Record<string, string>
  textContent: string
  setAttribute(k: string, v: string): void
  remove(): void
}

function makeFakeDocument() {
  const styles: FakeStyle[] = []
  const doc = {
    querySelector: (sel: string): FakeStyle | null => {
      if (sel !== 'style[data-dsh-recursive]') return null
      return styles.find(s => s.attrs['data-dsh-recursive'] !== undefined) ?? null
    },
    createElement: (_tag: string): FakeStyle => {
      const el: FakeStyle = {
        attrs: {}, textContent: '',
        setAttribute(k, v) { el.attrs[k] = v },
        remove() { const i = styles.indexOf(el); if (i >= 0) styles.splice(i, 1) },
      }
      return el
    },
    head: { appendChild: (el: FakeStyle) => { styles.push(el) } },
  }
  return { doc, styles }
}

describe('injectBoardStyles (one-shot <style> + Paper tokens)', () => {
  let original: unknown
  beforeEach(() => { original = (globalThis as { document?: unknown }).document })

  it('injects exactly one style with Paper tokens + solid pills, and disposes it', () => {
    const { doc, styles } = makeFakeDocument()
    ;(globalThis as { document?: unknown }).document = doc
    try {
      const dispose = injectBoardStyles()
      expect(styles.length).toBe(1)
      expect(styles[0].attrs['data-dsh-recursive']).toBe('')
      const css = styles[0].textContent
      expect(css).toContain('--rm3-light-background')
      expect(css).toContain('--board-bg: var(--rm3-light-background)')
      expect(css).toContain('[data-theme=\'dark\']')
      expect(css).toContain('.rec-pill[data-pill=\'locked\']')
      expect(css).toContain('var(--board-success)')
      // Idempotent.
      const dispose2 = injectBoardStyles()
      expect(styles.length).toBe(1)
      dispose2()
      expect(styles.length).toBe(1)
      dispose()
      expect(styles.length).toBe(0)
    } finally {
      ;(globalThis as { document?: unknown }).document = original
    }
  })
})
