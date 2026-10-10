#!/usr/bin/env node
/**
 * check-workflow-map-escapes.mjs — adversarial escaping check on the generated page.
 *
 * WHY A THIRD CHECK. `check-workflow-map.mjs` validates structure (ids, references,
 * pairing). Neither it nor the generator's own `--verify` would catch the failure
 * mode that a template-literal renderer actually has: a `${…}` that never
 * interpolated, an `undefined` that reached the page, an unescaped `<` in prose, a
 * bare `&`, or an unbalanced brace in a 22 KB inline stylesheet. Those do not throw
 * — they ship, and they look like content.
 *
 * ⚠ THE SCRIPT AND STYLE BLOCKS ARE EXCLUDED FROM THE MARKUP CHECKS, ON PURPOSE.
 * Inside `<script>` and `<style>`, HTML is RAW TEXT: `index < 0`, `a && b` and `{`
 * are the language, not markup. A naive checker reports them as defects — it did,
 * five times, on a file that was correct. A check that fails on correct input is
 * worse than no check, so the regions are removed before the prose rules run.
 *
 * Usage: node scripts/check-workflow-map-escapes.mjs [path]
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const target = resolve(process.argv[2] ?? 'workflow-map/recursive-mode-workflow.html')
if (!existsSync(target)) {
  console.error('no such file: ' + target)
  process.exit(2)
}
const html = readFileSync(target, 'utf8')
const fails = []
const passes = []

const styleBlock = (html.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1]
const scriptBlock = (html.match(/<script>([\s\S]*?)<\/script>/) || ['', ''])[1]
/** The document with its raw-text regions removed: what the prose rules apply to. */
const markup = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<script>[\s\S]*?<\/script>/, '')

const check = (label, ok, detail = '') => (ok ? passes.push(label) : fails.push(label + (detail ? ' — ' + detail : '')))

/* 1. no template or JS leftovers reached the page ------------------------- */
for (const bad of ['${', '[object Object]']) {
  const n = html.split(bad).length - 1
  check('no leftover ' + JSON.stringify(bad) + ' in the output', n === 0, 'found ' + n)
}
// `undefined` / `NaN` as a WORD are leftovers; as part of a longer identifier they
// are not. A word boundary is the difference between a real finding and noise.
for (const bad of ['undefined', 'NaN']) {
  const n = (markup.match(new RegExp('\\b' + bad + '\\b', 'g')) || []).length
  check('no literal ' + bad + ' in the rendered content', n === 0, 'found ' + n)
}
check('no unresolved citation key reached the page', !/(^|[^a-zA-Z])SRC\.[a-zA-Z]/.test(markup))

/* 2. markup escaping ------------------------------------------------------ */
const strayLt = [...markup.matchAll(/<(?![/!a-zA-Z])/g)]
check('no stray `<` in the rendered content', strayLt.length === 0, strayLt.length + ' found')
const bareAmp = [...markup.matchAll(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g)]
check('no bare `&` in the rendered content', bareAmp.length === 0, bareAmp.length + ' found')
const rawLtInTag = [...markup.matchAll(/<[a-zA-Z][^>]*>/g)].filter((m) => m[0].slice(1).includes('<'))
check('no `<` inside a tag (an unescaped attribute value)', rawLtInTag.length === 0, rawLtInTag.length + ' found')

/* 3. balanced raw-text regions ------------------------------------------- */
const braces = (s) => [(s.match(/{/g) || []).length, (s.match(/}/g) || []).length]
const [ob, cb] = braces(styleBlock)
check('the inline CSS has balanced braces', ob === cb, ob + ' open / ' + cb + ' close')
check('exactly one <style> block', (html.match(/<style>/g) || []).length === 1)
check('exactly one <script> block', (html.match(/<script>/g) || []).length === 1)
check('<style> and </style> balance', (html.match(/<style>/g) || []).length === (html.match(/<\/style>/g) || []).length)
check('<script> and </script> balance', (html.match(/<script>/g) || []).length === (html.match(/<\/script>/g) || []).length)
check('the script block contains no nested closing script tag', !scriptBlock.includes('</script'))

/* 4. the SVGs are well formed enough to render ---------------------------
   ⚠ EVERY CHART, NOT THE FIRST ONE. The page carries the overview and the learning loop, so
   "exactly one <svg>" stopped being the right invariant the moment the second one was added: what
   matters is that EVERY svg is well formed, labelled, and self-closed, and that the count is the
   count the page claims. A check pinned to one svg would have covered one chart and ignored the
   other. ⚠ AND THE COUNT IS TWO, NOT THREE: the phase graph used to be a chart of its own, and the
   merge that moved its sixteen edges onto the overview is asserted here in the negative — a page
   that grew a third svg back would fail this line rather than quietly reintroduce the second tab. */
const svgs = [...html.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((m) => m[0])
check('there are two inline <svg> charts (found ' + svgs.length + ')', svgs.length === 2,
  'the page draws the overview — which IS the graph — and the learning loop')
check('every svg has a viewBox and integer dimensions',
  svgs.every((s) => /viewBox="[^"]+"/.test(s) && /\bwidth="\d+"/.test(s) && /\bheight="\d+"/.test(s)))
check('every svg is labelled for assistive technology',
  [...html.matchAll(/data-diagram="[a-z-]+" role="img" aria-label="([^"]*)"/g)].length === 2
  && [...html.matchAll(/data-diagram="[a-z-]+" role="img" aria-label="([^"]*)"/g)].every((m) => m[1].length > 60))
check('every svg <text> balances', svgs.every((s) => (s.match(/<text/g) || []).length === (s.match(/<\/text>/g) || []).length))
check('every svg <rect> is self-closed', svgs.every((s) => (s.match(/<rect[^>]*\/>/g) || []).length === (s.match(/<rect/g) || []).length))
check('every svg <path> is self-closed', svgs.every((s) => (s.match(/<path[^>]*\/>/g) || []).length === (s.match(/<path/g) || []).length))
check('every svg <polygon> is self-closed', svgs.every((s) => (s.match(/<polygon[^>]*\/>/g) || []).length === (s.match(/<polygon/g) || []).length))

/* 5. no attribute is left unquoted ---------------------------------------
   Parsed attribute by attribute, not by a scanning regex. A scanning regex reports
   `content="width=device-width, initial-scale=1"` as an unquoted attribute, because
   the text `scale=1` looks exactly like `name=value` — it did, on a correct file.
   So: take each start tag, strip quoted regions first, and only then look for `=` at
   all. That is the same "remove the raw text, then judge" discipline the rest of
   this script uses. */
const unquoted = []
for (const tag of markup.matchAll(/<[a-zA-Z][^>]*>/g)) {
  const stripped = tag[0].replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''")
  for (const m of stripped.matchAll(/([a-zA-Z-]+)=([^"'\s>][^\s>]*)/g)) unquoted.push(tag[0].slice(0, 70) + '  →  ' + m[0])
  for (const m of stripped.matchAll(/([a-zA-Z-]+)=(?=[\s>]|$)/g)) unquoted.push(tag[0].slice(0, 70) + '  →  ' + m[0] + ' (no value)')
}
check('every attribute value is quoted', unquoted.length === 0, unquoted.slice(0, 3).join(' | '))

/* report ------------------------------------------------------------------ */
console.log('check-workflow-map-escapes — adversarial escaping and structure\n')
console.log('  file: ' + target)
console.log('  markup: ' + markup.length.toLocaleString('en-US') + ' bytes  ·  css: '
  + styleBlock.length.toLocaleString('en-US') + '  ·  js: ' + scriptBlock.length.toLocaleString('en-US') + '\n')
for (const p of passes) console.log('  PASS  ' + p)
for (const f of fails) console.log('  FAIL  ' + f)
console.log('\n  ' + passes.length + ' passed, ' + fails.length + ' failed')
process.exit(fails.length === 0 ? 0 : 1)
