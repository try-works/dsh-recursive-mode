/**
 * LIVE BUG / dsh-v0.1.1-rc.2 compatibility: ZERO session-event emission.
 *
 * Static source scan over EVERY file under src/ (server + client):
 *   - no production code calls Session.append / sessions.append / .emit(
 *   - no production code references a session event whose type starts with
 *     'recursive/' (e.g. 'recursive/phase', 'recursive/phase-intent')
 *   - no SessionEventMap merge
 * The only allowed 'recursive' tokens are comments (stripped before scanning)
 * and '.recursive/...' path strings (the control-plane file tree, not events).
 *
 * Planned transition (run spec 0.2.2): the legacy event-fold dead surface
 * (foldRecursivePhase / detectTransitionIntent / LifecycleDriver / the
 * recursive/* event payload interfaces) is removed from src/, so this scan
 * turns GREEN after the cleanup. RED against the pre-cleanup tree.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url))

/** Walk src/ collecting .ts/.tsx files (server + client). */
function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSourceFiles(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Quote chars that open a JS string literal (single, double, backtick). */
const QUOTES = String.fromCharCode(39) + String.fromCharCode(34) + String.fromCharCode(96)

/**
 * Strip // line comments and /* block comments *​/ from TS source WITHOUT
 * touching string literals (a tiny state machine). The remaining code text is
 * what the forbidden-pattern scan sees.
 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  let stringCh: string | null = null
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (stringCh) {
      out += ch
      if (ch === '\\' && i + 1 < src.length) { out += next; i += 2; continue }
      if (ch === stringCh) stringCh = null
      i += 1
      continue
    }
    if (QUOTES.indexOf(ch) >= 0) { stringCh = ch; out += ch; i += 1; continue }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

// A quoted event-type literal: 'recursive/phase' style. Built from parts to
// dodge template-literal escaping; deliberately NOT matching '.recursive/'
// paths (a quote must DIRECTLY precede 'recursive').
const EVENT_TYPE_RE = new RegExp('[' + QUOTES + ']recursive\\/[A-Za-z][A-Za-z0-9-]*[' + QUOTES + ']')

const FORBIDDEN: Array<{ label: string; re: RegExp }> = [
  { label: 'Session.append / sessions.append', re: /(?:Session|sessions)\s*\.\s*append\s*\(/ },
  { label: '.emit( (session-event emission)', re: /\.emit\s*\(/ },
  { label: 'event type string recursive/<slug>', re: EVENT_TYPE_RE },
  { label: 'SessionEventMap merge', re: /\bSessionEventMap\b/ },
]

describe('no-emission — zero recursive/* session-event logic in src/', () => {
  it('no production source file appends/emits/folds recursive/* session events', () => {
    const files = listSourceFiles(SRC_ROOT)
    expect(files.length).toBeGreaterThan(0)
    const violations: string[] = []
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'))
      const rel = file.replace(SRC_ROOT.replace(/\\/g, '/'), 'src').replace(/\\/g, '/')
      for (const { label, re } of FORBIDDEN) {
        const g = new RegExp(re.source, 'g' + (re.flags.includes('i') ? 'i' : ''))
        let m: RegExpExecArray | null
        while ((m = g.exec(code)) !== null) {
          const idx = m.index
          const lineNo = code.slice(0, idx).split('\n').length
          violations.push(rel + ':' + lineNo + ' — ' + label + ' (' + m[0].slice(0, 60) + ')')
        }
      }
    }
    expect(violations).toEqual([])
  })
})
