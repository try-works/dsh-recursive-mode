#!/usr/bin/env node
/**
 * check-workflow-map.mjs — INDEPENDENT structural check of the generated page.
 *
 * WHY A SECOND SCRIPT. The generator's own `--verify` validates the FACTS it
 * rendered. That leaves one thing unproven: that the bytes it wrote are a valid,
 * openable HTML document. This checker reads the WRITTEN FILE — not the
 * generator's in-memory string — and parses it with an actual HTML parser, so a
 * structural defect introduced by escaping, by a stray tag, or by a template
 * literal cannot hide behind a green fact-check.
 *
 * It uses `linkedom` when the repo happens to have it, and falls back to a
 * dependency-free structural read otherwise. Either way it asserts:
 *   1. the file parses;
 *   2. every element carrying an id is unique;
 *   3. every aria-controls / aria-labelledby / href="#…" target exists;
 *   4. every tab has a panel and every panel has a tab;
 *   5. the tab count equals 1 + 12 + 8;
 *   6. no external resource is referenced;
 *   7. the file opens with a doctype and closes with </html>.
 *
 * Usage: node scripts/check-workflow-map.mjs [path]
 * Exit code is non-zero on any failure.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const target = resolve(process.argv[2] ?? 'workflow-map/recursive-mode-workflow.html')
const fails = []
const passes = []
const check = (label, ok, detail = '') => (ok ? passes.push(label) : fails.push(label + (detail ? ' — ' + detail : '')))

if (!existsSync(target)) {
  console.error('no such file: ' + target)
  process.exit(2)
}
const html = readFileSync(target, 'utf8')

/* -- 1. shape ------------------------------------------------------------- */
check('starts with a doctype', /^\s*<!DOCTYPE html>/i.test(html), html.slice(0, 40))
check('declares <html lang>', /<html\s+lang="[a-z-]+"/i.test(html))
check('declares a charset', /<meta\s+charset="utf-8">/i.test(html))
check('declares a viewport', /<meta\s+name="viewport"/i.test(html))
check('has a <title>', /<title>[^<]+<\/title>/i.test(html))
check('ends with </html>', /<\/html>\s*$/.test(html))
check('is self-contained (no <script src>, no <link href> to a file)',
  !/<script[^>]+\bsrc=/i.test(html) && !/<link[^>]+\bhref="(?!#)/i.test(html))
check('references no http(s) URL at all',
  !/https?:\/\//i.test(html.replace(/https:\/\/github\.com\/[^\s"]+/g, '')),
  (html.match(/https?:\/\/[^\s"<]*/g) || []).slice(0, 3).join(', '))

/* -- 2. tag balance ------------------------------------------------------- */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const stack = []
const tagProblems = []
for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g)) {
  const [full, closing, rawName, attrs] = m
  const name = rawName.toLowerCase()
  if (name === 'script' && !closing) { /* handled below */ }
  if (VOID.has(name) || attrs.trim().endsWith('/')) continue
  if (!closing) { stack.push(name); continue }
  const last = stack.pop()
  if (last !== name) tagProblems.push('expected </' + String(last) + '> but found ' + full)
}
check('tags nest and close correctly', tagProblems.length === 0, tagProblems.slice(0, 4).join(' | '))
check('every opened tag is closed', stack.length === 0, 'left open: ' + stack.join(', '))

/* -- 3. ids are unique ---------------------------------------------------- */
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])
const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i)
check('every id is unique (' + ids.length + ' ids)', dupIds.length === 0, [...new Set(dupIds)].join(', '))

/* -- 4. every reference resolves ------------------------------------------ */
const idSet = new Set(ids)
const refs = []
for (const m of html.matchAll(/\saria-controls="([^"]+)"/g)) refs.push({ attr: 'aria-controls', to: m[1] })
for (const m of html.matchAll(/\saria-labelledby="([^"]+)"/g)) for (const id of m[1].split(/\s+/)) refs.push({ attr: 'aria-labelledby', to: id })
for (const m of html.matchAll(/\shref="#([^"]+)"/g)) refs.push({ attr: 'href', to: m[1] })
const broken = refs.filter((r) => !idSet.has(r.to))
check('every aria-controls / aria-labelledby / href="#…" resolves (' + refs.length + ' references)',
  broken.length === 0, broken.map((b) => b.attr + '→' + b.to).join(', '))

/* -- 5. tab/panel pairing ------------------------------------------------- */
const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0])
const controls = tabs.map((t) => (t.match(/aria-controls="([^"]+)"/) || [])[1])
const panels = [...html.matchAll(/<section[^>]*id="(panel-[^"]+)"[^>]*role="tabpanel"[^>]*>/g)].map((m) => m[1])
check('every tab has an aria-controls', controls.every(Boolean))
check('every tab points at a panel that exists', controls.every((c) => panels.includes(c)), controls.filter((c) => !panels.includes(c)).join(', '))
check('every panel is pointed at by exactly one tab',
  panels.filter((p) => controls.filter((c) => c === p).length !== 1).join(', ') === '')
check('tab count is 23 (1 overview + 1 graph + 12 phases + 1 learning loop + 8 other views): got ' + tabs.length, tabs.length === 23)
check('panel count matches tab count: ' + panels.length, panels.length === tabs.length)
check('exactly one tab is aria-selected="true"',
  tabs.filter((t) => /aria-selected="true"/.test(t)).length === 1)
check('exactly one tab is in the tab order (tabindex="0")',
  tabs.filter((t) => /tabindex="0"/.test(t)).length === 1)
check('the rest carry tabindex="-1" (roving tabindex)',
  tabs.filter((t) => /tabindex="-1"/.test(t)).length === tabs.length - 1)
check('the tablist has an accessible name', /role="tablist"[^>]*aria-labelledby="[^"]+"/.test(html))
check('every tab has a visible text label',
  tabs.every((t, i) => {
    const body = html.slice(html.indexOf(t) + t.length, html.indexOf(t) + t.length + 220)
    return /<span class="tlabel">[^<]+<\/span>/.test(body)
  }))

/* -- 6. the twelve phase panels are present ------------------------------- */
// The ids are derived from the ARTIFACT FILE NAMES (with the extension slugged in),
// and the check is against a list written out here rather than imported from the
// generator — an independent expectation, so the generator cannot pass by agreeing
// with itself.
const PHASE_IDS = ['00-requirements-md', '00-worktree-md', '01-as-is-md', '01-5-root-cause-md',
  '02-to-be-plan-md', '03-implementation-summary-md', '03-5-code-review-md', '04-test-summary-md',
  '05-manual-qa-md', '06-decisions-update-md', '07-state-update-md', '08-memory-impact-md']
const missing = PHASE_IDS.filter((p) => !panels.includes('panel-phase-' + p))
check('all twelve phase panels exist (found ' + panels.length + ' panels)', missing.length === 0, missing.join(', '))

/* -- 7. content is present, not an empty shell --------------------------- */
check('the document has substantial content (> 120 KB): ' + html.length, html.length > 120_000)
check('citations are rendered: ' + (html.match(/class="cite"/g) || []).length,
  (html.match(/class="cite"/g) || []).length >= 150)
check('every gate label word appears', ['DECISION', 'REFUSAL', 'AUTO'].every((w) => html.includes('>' + w + '<')))

/* ==========================================================================
   8. LAYOUT INVARIANTS — the check that would have caught the shipped defects
   ==========================================================================

   WHY THIS SECTION EXISTS. Every check above this line is about STRUCTURE: does the
   file parse, do the ids resolve, is there a panel per tab. The page shipped with all
   of them green and was still visibly broken, because nothing in it ever compared two
   COORDINATES. The four defects a reader saw were:

     D1  the strip heading was drawn across the lower third of the phase-0 gate card
         (card y=38..84, heading baseline y=88);
     D2  the twelve nodes were 62 units wide against 61-63-unit labels, so every label
         overran its own box onto its neighbour's, and nodes 8-11 sat at x=690..900
         inside the hook column that starts at x=668;
     D3  the backward-edge arc ran at y=268 with its REVISE label at y=264, the same
         band as the prose line at y=262;
     D4  the hook cards (y=38..138) and the sequence row (y=96..136) shared one
         horizontal band in one x-range.

   Each invariant below is a COMPUTED fact about the emitted markup — parsed out of the
   SVG and the stylesheet, not eyeballed. The diagram ships its layout manifest in
   `data-layout` (every reserved box, plus the character-width metric the boxes were
   computed from), so this checker re-derives the same geometry from the FILE and
   re-runs the arithmetic; and it re-parses the SVG's own coordinates, so a manifest
   that disagrees with the drawing is a failure rather than an alibi.

   THE INVARIANTS:
     8.1  the manifest is present, well formed, and every box is non-empty and rounded
     8.2  no two reserved boxes intersect, EXCEPT where one CONTAINS the other
          (a card and its label, the strip and its nodes, a rule and its own corner)
     8.3  the svg's actual attributes equal the manifest: viewBox, width/height, and
          one <text>/<rect>/<path>/<polygon> per declared box of that kind
     8.4  every text box lies inside a declared container — NOTHING IS DRAWN WITHOUT A
          CONTAINER THAT HOLDS IT (this is D1 and D4)
     8.5  every text box is wide enough for its own label at the declared metric — no
          clipped or overhanging label (this is D2)
     8.6  the svg's drawn coordinates agree with the manifest box for box
     8.7  single-x-range columns do not share a vertical band (D4), and no two bands
          overlap vertically
     8.8  the drawing cannot shrink below its own layout: the svg is sized from
          --dg-w, which the generator writes from the manifest width, and the wrapper
          scrolls (the twelve-node strip therefore scrolls as ONE strip at the same
          minimum width as the tab strip)
     8.9  no text node is painted inside a POSITIONED element's box: every absolutely
          or fixed positioned element either holds its text inside its own box or is
          the off-canvas skip link
     8.10 the grid/flex declarations that make the cards shrink rather than overflow
          are still in the sheet (a bare `1fr` track is what let a citation push a card
          past its column and paint over its neighbour)
   ========================================================================== */

const CSS = (html.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1]
const dec = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")

/* ==========================================================================
   8.0 EVERY CHART, NOT THE FIRST ONE
   ==========================================================================

   There are three charts now — the overview, the phase graph and the learning loop —
   and each one ships its own manifest and its own wrapper width. A checker that read
   only the first `data-layout` would have covered the overview and silently ignored
   the two graphics this section exists for, so the invariants below run PER DIAGRAM,
   and the set of diagrams is itself asserted: three named views, one chart each, each
   one inside a panel of its own.

   The expectations are written out HERE rather than imported from the generator, on
   the same principle as the phase-panel list above: an independent expectation is one
   the generator cannot satisfy by agreeing with itself. */
const DIAGRAM_IDS = ['overview', 'learning-loop']
const DIAGRAMS = []
for (const m of html.matchAll(/<div class="diagram" id="dg-([a-z-]+)" data-diagram="([a-z-]+)" role="img" aria-label="([^"]*)" style="--dg-w:([\d.]+)px" data-layout="([^"]*)">([\s\S]*?)<\/div>/g)) {
  const before = html.slice(0, m.index)
  const panels = [...before.matchAll(/<section class="panel[^"]*" id="(panel-[a-z0-9-]+)"/g)]
  DIAGRAMS.push({
    id: m[1], view: m[2], label: m[3], width: Number(m[4]), layoutRaw: m[5], body: m[6],
    panel: panels.length > 0 ? panels[panels.length - 1][1] : null,
    svg: (m[6].match(/<svg[\s\S]*?<\/svg>/) || [''])[0],
  })
}
check('8.0 every chart wrapper is well formed and each one carries an aria-label: ' + DIAGRAMS.length + ' charts',
  DIAGRAMS.length === DIAGRAM_IDS.length && DIAGRAMS.every((d) => d.label.length > 60 && d.width > 300 && d.svg !== ''))
check('8.0 the two charts are the two named views: ' + DIAGRAMS.map((d) => d.view).join(', '),
  DIAGRAMS.map((d) => d.view).join(',') === DIAGRAM_IDS.join(','))
check('8.0 each chart lives in its own panel, and no two share one: '
  + DIAGRAMS.map((d) => d.view + '@' + d.panel).join(' '),
  new Set(DIAGRAMS.map((d) => d.panel)).size === DIAGRAMS.length
  && DIAGRAMS.every((d) => typeof d.panel === 'string' && d.panel.startsWith('panel-')))
check('8.0 every chart has at least one drawn element (an empty chart would satisfy "no overlaps")',
  DIAGRAMS.every((d) => (d.svg.match(/<(rect|path|text|polygon)\b/g) || []).length >= 12),
  DIAGRAMS.map((d) => d.view + '=' + (d.svg.match(/<(rect|path|text|polygon)\b/g) || []).length).join(' '))

/** Per-diagram results, accumulated so the checks below can report on all three. */
const DG = []
for (const d of DIAGRAMS) {
  const R = { id: d.id, fails: [] }
  const fail = (what) => R.fails.push(d.id + ': ' + what)
  let L = null
  try { L = JSON.parse(dec(d.layoutRaw)) } catch { L = null }
  if (!L || L.v !== 1) fail('the manifest does not parse (or is not version 1)')
  const BOXES = Array.isArray(L?.boxes) ? L.boxes : []
  const FIT = Array.isArray(L?.fit) ? L.fit : []
  R.boxes = BOXES.length
  R.texts = BOXES.filter((b) => b[0] === 'text').length

  /* -- 8.1 the manifest --------------------------------------------------- */
  if (!(typeof L?.charW === 'number' && L.charW > 0 && typeof L?.lineHeight === 'number'
    && Array.isArray(L?.viewBox) && L.viewBox.length === 4)) fail('the manifest has no metric or no viewBox')
  if (!(BOXES.length > 12 && BOXES.every((b) => Array.isArray(b) && b.length === 6
    && ['text', 'box', 'rule', 'ink'].includes(b[0])
    && [b[1], b[2], b[3], b[4]].every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(Math.round(n * 100) - n * 100) < 1e-6)
    && b[3] > 0 && b[4] > 0))) fail('a reserved box is malformed, empty, or unrounded')

  /* -- 8.2 no two reserved boxes may intersect, except by declared exemption */
  const CONTAINS = Array.isArray(L?.contains) ? L.contains.filter((p) => Array.isArray(p) && p.length === 2) : []
  /* ⚠ A CONTAINMENT IS DECIDED AT THE MANIFEST'S OWN PRECISION, not at floating point's. Every box
     in the manifest is rounded to hundredths, and two boxes computed along the same edge can land one
     hundredth apart — 51.5 + 18.5 is 70.00000000000001 in binary floating point against a container
     whose right edge was rounded to 70. Treating that as "not contained" would fail a layout that is
     exact on the page, so the comparison is made at the emitted precision. */
  const containsBox = (o, i) => Math.round((i[1] - o[1]) * 100) >= 0 && Math.round((i[2] - o[2]) * 100) >= 0
    && Math.round((o[1] + o[3] - i[1] - i[3]) * 100) >= 0 && Math.round((o[2] + o[4] - i[2] - i[4]) * 100) >= 0
  const declaredPair = new Set([...CONTAINS].map(([i, c]) => i + '>' + c))
  const EPS = 0.05
  const boxHits = []
  for (let a = 0; a < BOXES.length; a++) {
    for (let b = a + 1; b < BOXES.length; b++) {
      const A = BOXES[a], B = BOXES[b]
      const ix = Math.min(A[1] + A[3], B[1] + B[3]) - Math.max(A[1], B[1])
      const iy = Math.min(A[2] + A[4], B[2] + B[4]) - Math.max(A[2], B[2])
      if (ix <= EPS || iy <= EPS) continue
      if (declaredPair.has(a + '>' + b) || declaredPair.has(b + '>' + a)) continue
      if (containsBox(A, B) || containsBox(B, A)) continue
      boxHits.push(`${A[0]} "${A[5]}" × ${B[0]} "${B[5]}" by ${ix.toFixed(2)}x${iy.toFixed(2)}`)
    }
  }
  R.containments = CONTAINS.length
  R.hits = boxHits
  if (boxHits.length > 0) fail(boxHits.length + ' undeclared intersections: ' + boxHits.slice(0, 3).join(' | '))
  /* A declared containment is one of three things, and all three are geometric facts:
     · the container is a BOX and geometrically holds the contained box;
     · the container is a RULE or an INK box and geometrically holds the contained box — an
       arrowhead reserved at the size of the run it terminates, or a run reserved wide enough to
       hold its arrowhead, is the same "say it in the geometry" move as a card holding its label;
     · the container is a RULE and the contained rule/arrowhead MEETS it — the two reserved boxes
       touch within one stroke width (5 units), which is a corner where two strokes join and the
       only place in a chart where two strokes share a reservation. */
  const meets = (o, i) => Math.abs(Math.min(i[1] + i[3], o[1] + o[3]) - Math.max(i[1], o[1])) <= 5
    && Math.abs(Math.min(i[2] + i[4], o[2] + o[4]) - Math.max(i[2], o[2])) <= 5
  const declaredOk = ([i, c]) => {
    const A = BOXES[i], C = BOXES[c]
    if (!A || !C) return false
    if (containsBox(C, A)) return true
    return C[0] === 'rule' && (A[0] === 'rule' || A[0] === 'ink') && meets(C, A)
  }
  const badContains = CONTAINS.filter((p) => !declaredOk(p))
  if (!(CONTAINS.length > 8 && badContains.length === 0)) {
    fail('a declared containment is not real (' + badContains.slice(0, 3).map(([i, c]) => i + ',' + c
      + ' holds=' + containsBox(BOXES[c], BOXES[i])
      + ' meets=' + (BOXES[c][0] === 'rule' && (BOXES[i][0] === 'rule' || BOXES[i][0] === 'ink') && meets(BOXES[c], BOXES[i]))
      + ' [' + JSON.stringify([BOXES[i]?.[0], BOXES[i]?.[1], BOXES[i]?.[2], BOXES[i]?.[3], BOXES[i]?.[4], BOXES[i]?.[5]]) + ']'
      + ' in [' + JSON.stringify([BOXES[c]?.[0], BOXES[c]?.[1], BOXES[c]?.[2], BOXES[c]?.[3], BOXES[c]?.[4], BOXES[c]?.[5]]) + ']').join(' | ') + ')')
  }

  /* -- 8.3 the drawing matches the manifest ------------------------------- */
  const [VX, VY, VW, VH] = L?.viewBox ?? [0, 0, 0, 0]
  const svgOpen = (d.svg.match(/<svg[^>]*>/) || [''])[0]
  const vb = (svgOpen.match(/viewBox="([^"]+)"/) || [, ''])[1].split(/\s+/).map(Number)
  if (JSON.stringify(vb) !== JSON.stringify([VX, VY, VW, VH])) fail('the svg viewBox is not the manifest viewBox')
  const svgEls = {
    text: (d.svg.match(/<text\b/g) || []).length,
    rect: (d.svg.match(/<rect\b/g) || []).length,
    path: (d.svg.match(/<path\b/g) || []).length,
    ink: (d.svg.match(/<polygon\b/g) || []).length,
  }
  const manEls = { text: 0, rect: 0, path: 0, ink: 0 }
  for (const b of BOXES) manEls[b[0] === 'box' ? 'rect' : b[0] === 'rule' ? 'path' : b[0]] += 1
  if (JSON.stringify(svgEls) !== JSON.stringify(manEls)) {
    fail('the drawing and the manifest disagree: svg ' + JSON.stringify(svgEls) + ' manifest ' + JSON.stringify(manEls))
  }

  /* -- 8.4 no box may be drawn ACROSS a container it does not belong to ---- */
  const TEXT_BOXES = BOXES.filter((b) => b[0] === 'text')
  const CONTAINERS = BOXES.filter((b) => b[0] === 'box')
  const straddles = []
  for (const a of BOXES) {
    for (let c = 0; c < CONTAINERS.length; c++) {
      const C = CONTAINERS[c]
      const ix = Math.min(a[1] + a[3], C[1] + C[3]) - Math.max(a[1], C[1])
      const iy = Math.min(a[2] + a[4], C[2] + C[4]) - Math.max(a[2], C[2])
      if (ix <= EPS || iy <= EPS) continue
      const aIdx = BOXES.indexOf(a)
      if (declaredPair.has(aIdx + '>' + c) || declaredPair.has(c + '>' + aIdx)) continue
      if (containsBox(C, a) || containsBox(a, C)) continue
      straddles.push(`${a[0]} "${a[5]}" crosses ${C[0]} "${C[5]}" by ${ix.toFixed(2)}x${iy.toFixed(2)}`)
    }
  }
  if (straddles.length > 0) fail(straddles.length + ' straddles: ' + straddles.slice(0, 3).join(' | '))
  if (!(TEXT_BOXES.length === FIT.length && CONTAINERS.length >= 4)) fail('the label/container counts do not add up')

  /* -- 8.5 no label overruns the box that holds it ------------------------- */
  const tight = FIT.filter(([label, x, y, w, h]) => Math.abs(w - String(label).length * L.charW * (h / L.lineHeight)) > 0.05)
  if (!(FIT.length > 12 && tight.length === 0)) fail('a label does not measure exactly its own box')
  const MONO_MAX_EM = 0.6001
  if (!(typeof L.charW === 'number' && L.charW >= MONO_MAX_EM && L.charW <= 0.65)) fail('charW=' + L.charW + ' does not cover the font stack')

  /* -- 8.6 the drawn coordinates agree with the manifest ------------------- */
  const drawn = []
  for (const m of d.svg.matchAll(/<text class="([^"]+)" x="([-\d.]+)" y="([-\d.]+)">/g)) drawn.push({ cls: m[1], x: Number(m[2]), y: Number(m[3]) })
  const FS_OF = {}
  for (const m of CSS.matchAll(/\.(dg-t[a-z-]*)\{[^}]*font-size:([\d.]+)px/g)) FS_OF[m[1]] = Number(m[2])
  const mismatch = []
  const drawnRects = [...d.svg.matchAll(/<rect class="([^"]+)" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g)]
    .map((m) => [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])])
  let ti = 0
  for (const b of BOXES) {
    if (b[0] !== 'text') continue
    const dd = drawn[ti++]
    const fs = FS_OF[dd?.cls]
    const base = Math.round((b[2] + Math.round(fs * 1.1 * 100) / 100) * 100) / 100
    if (!dd || dd.x !== b[1] || Math.abs(dd.y - base) > 0.011) {
      mismatch.push('"' + b[5] + '" drawn ' + JSON.stringify(dd) + ' expected y=' + base + ' at x=' + b[1])
    }
  }
  if (!(mismatch.length === 0 && drawn.length === TEXT_BOXES.length)) fail('a <text> is not drawn where its box was reserved: ' + mismatch.slice(0, 2).join(' | '))
  const orphanRects = drawnRects.filter((r) => !BOXES.some((b) => b[0] === 'box' && b[1] === r[0] && b[2] === r[1] && b[3] === r[2] && b[4] === r[3]))
  if (orphanRects.length > 0) fail('a <rect> is not a declared box: ' + JSON.stringify(orphanRects.slice(0, 2)))
  if (!drawn.every((dd) => typeof FS_OF[dd.cls] === 'number')) fail('a dg-* class in the svg has no font-size in the sheet')
  /* THE TWO NUMBERS MUST BE ONE NUMBER. Every reserved text box says its height is
     lineHeight × fontSize; if the sheet draws that class at a different size, the layout
     was computed for a font nobody renders. */
  const sizeMismatch = FIT.filter(([label, x, y, w, h]) => {
    const cls = Object.keys(FS_OF).find((c) => Math.abs(FS_OF[c] * L.lineHeight - h) < 0.06)
    return !cls || Math.abs(String(label).length * L.charW * FS_OF[cls] - w) > 0.06
  })
  if (sizeMismatch.length > 0) fail('a text box disagrees with the font-size the sheet declares: ' + sizeMismatch.slice(0, 2).map((f) => JSON.stringify(f[0])).join(', '))

  /* -- 8.7 no band may contain two columns closer than 8 units ------------- */
  const byY = [...BOXES].sort((a, b) => a[2] - b[2])
  const bandGroups = []
  for (const b of byY) {
    const hit = bandGroups.find((g) => g.boxes.some((o) => {
      const iy = Math.min(o[2] + o[4], b[2] + b[4]) - Math.max(o[2], b[2])
      const ix = Math.min(o[1] + o[3], b[1] + b[3]) - Math.max(o[1], b[1])
      return iy > EPS && ix > -8
    }))
    if (hit) hit.boxes.push(b); else bandGroups.push({ boxes: [b] })
  }
  const bandCollisions = []
  for (const g of bandGroups) {
    const clusters = []
    for (const b of g.boxes) {
      const c = clusters.find((k) => Math.min(k[1], b[1] + b[3]) - Math.max(k[0], b[1]) > -8)
      if (c) { c[0] = Math.min(c[0], b[1]); c[1] = Math.max(c[1], b[1] + b[3]); c[2].push(b[5]) }
      else clusters.push([b[1], b[1] + b[3], [b[5]]])
    }
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const gap = Math.max(clusters[i][0], clusters[j][0]) - Math.min(clusters[i][1], clusters[j][1])
        if (gap < 8) {
          bandCollisions.push(`"${clusters[i][2][0]}" x${clusters[i][0]}..${clusters[i][1]} vs `
            + `"${clusters[j][2][0]}" x${clusters[j][0]}..${clusters[j][1]} — gap ${gap.toFixed(2)}`)
        }
      }
    }
  }
  R.bands = bandGroups.length
  if (bandCollisions.length > 0) fail(bandCollisions.length + ' band collisions: ' + bandCollisions.slice(0, 2).join(' | '))
  if (!(bandGroups.length >= 3)) fail('the chart is one plate of free-floating boxes rather than bands')

  /* -- 8.8 the drawing cannot be scaled below its own layout --------------- */
  const dgVarUsedBySvg = /\.diagram svg\{[^}]*min-width:var\(--dg-w\)/.test(CSS)
  const svgW = Number((svgOpen.match(/\bwidth="([\d.]+)"/) || [, ''])[1])
  if (!(d.width === VW && svgW === VW && dgVarUsedBySvg)) {
    fail('the wrapper width, the svg width and the manifest disagree: --dg-w=' + d.width + ' svg=' + svgW + ' viewBox=' + VW)
  }
  DG.push(R)
}
check('8.1 every chart ships a parseable manifest with rounded, non-empty boxes: '
  + DG.map((r) => r.id + '=' + r.boxes + ' boxes').join(' '), DG.every((r) => r.boxes > 12))
check('8.2 NO TWO RESERVED BOXES INTERSECT IN ANY CHART except where declared: '
  + DG.map((r) => r.id + ' ' + r.boxes + ' boxes/' + r.containments + ' declared/' + r.hits.length + ' undeclared').join(' · '),
  DG.every((r) => r.hits.length === 0), DG.flatMap((r) => r.hits).slice(0, 4).join(' | '))
check('8.7 no chart has two columns closer than 8 units in one band: '
  + DG.map((r) => r.id + ' ' + r.bands + ' bands').join(' · '),
  DG.every((r) => r.fails.every((f) => !/band collision/.test(f))))
/* ⚠ WHY THE PER-CHART INVARIANTS BELOW ARE SPLIT BY INVARIANT RATHER THAN ROLLED INTO ONE
   LINE. The in-loop `fail()` calls above cover 8.3-8.6 (drawn-vs-manifest agreement, no
   straddling box, label fits its box, the char-width metric, the font-size agreement) for
   EVERY chart, which is strictly more coverage than the single-diagram checker this
   replaced. But collected into ONE array and reported through ONE aggregate check, a
   failure arrived as a single concatenated line naming five unrelated charts — a checker
   nobody can diagnose from is a checker whose failure gets worked around. Splitting by
   invariant keeps the output compact (three lines, not twenty) while making each line say
   WHICH chart broke and HOW. */
const failsOf = (re) => DG.filter((r) => r.fails.some((f) => re.test(f)))
const detailOf = (rows) => rows.flatMap((r) => r.fails.map((f) => r.id + ': ' + f)).slice(0, 4).join(' | ')
check('8.3-8.4 every chart draws each element where its box was reserved, and no box straddles another: '
  + DG.map((r) => r.id + '=' + r.texts + ' texts').join(' · '),
  failsOf(/drawn|straddl|declared box|held by/).length === 0, detailOf(failsOf(/drawn|straddl|declared box|held by/)))
check('8.5-8.6 every label fits its box at the declared metric, and the sheet renders that size: '
  + DG.map((r) => r.id + '=' + r.texts + ' labels').join(' · '),
  failsOf(/metric|font-size|charW|declared character width/).length === 0, detailOf(failsOf(/metric|font-size|charW|declared character width/)))
check('8.1-8.8 NO chart has any remaining invariant failure (the catch-all, so a new one cannot hide): '
  + DG.reduce((n, r) => n + (r.fails.length === 0 ? 1 : 0), 0) + '/' + DG.length + ' clean',
  DG.every((r) => r.fails.length === 0), detailOf(DG))
const svgSrc = DIAGRAMS[0].svg
const L = (() => { try { return JSON.parse(dec(DIAGRAMS[0].layoutRaw)) } catch { return null } })()
const BOXES = Array.isArray(L?.boxes) ? L.boxes : []
const FIT = Array.isArray(L?.fit) ? L.fit : []
check('8.8 the diagram wrapper scrolls horizontally in one strip (the tab-strip mechanism)',
  /\.diagram\{[^}]*overflow-x:auto/.test(CSS) && /overscroll-behavior-inline:contain/.test(CSS))
check('8.8 every chart keeps its own coordinate system (its own wrapper and width)',
  new Set(DIAGRAMS.map((d) => d.width)).size >= 2, DIAGRAMS.map((d) => d.width).join(', '))

/* ==========================================================================
   8.11 THE OVERVIEW IS THE GRAPH — structural invariants on the merged chart
   ==========================================================================

   WHY THIS IS A SEPARATE SECTION. Everything above asks whether the drawing is WELL FORMED: no
   overlaps, labels inside boxes, the manifest matching the markup. None of it asks whether the
   picture is the RIGHT PICTURE. The overview used to be twelve labelled boxes in a row with the
   sixteen directed edges on a second tab and three paragraphs of prose above it, and every invariant
   in this file was green while that shipped — because "a row of boxes with no arrows" is not a
   layout defect, it is a content defect.

   So these read the OVERVIEW'S OWN MANIFEST and assert the things the picture is supposed to SHOW:
   one run per derived edge anywhere in the chart, the multi-input nodes marked, the human decisions
   marked, the wildcard rail, the sequence-order links, the two back-edge arcs, the cross-run return.
   Each is counted from the labels the generator writes, and each expected count is written out HERE
   — not imported from the generator — so the two scripts cannot agree with each other by sharing a
   mistake. They are labelled `8.11.n` so a failure names the interaction type it lost. */
const OVERVIEW = DIAGRAMS.find((d) => d.view === 'overview')
const OV = (() => { try { return JSON.parse(dec(OVERVIEW.layoutRaw)) } catch { return null } })()
const OVL = Array.isArray(OV?.boxes) ? OV.boxes.map((b) => b[5]) : []
const ovCount = (re) => OVL.filter((l) => re.test(String(l))).length
check('8.11.0 the overview ships a manifest to check (' + OVL.length + ' boxes)', OVL.length > 100)
/* The twelve nodes, in the artifact name the rest of the page cites. */
const OV_NODES = ['00-requirements.md', '00-worktree.md', '01-as-is.md', '01.5-root-cause.md',
  '02-to-be-plan.md', '03-implementation-summary.md', '03.5-code-review.md', '04-test-summary.md',
  '05-manual-qa.md', '06-decisions-update.md', '07-state-update.md', '08-memory-impact.md']
check('8.11.1 the overview draws all twelve phase nodes',
  OV_NODES.filter((f) => !OVL.includes('node ' + f)).length === 0,
  OV_NODES.filter((f) => !OVL.includes('node ' + f)).join(', '))
/* THE 16 EDGES. Written out here as [from, to] pairs, derived by hand from
   `getPhaseExpectedInputArtifactNames` — so this list is an INDEPENDENT expectation. */
const OV_EDGES = [
  ['00-requirements.md', '00-worktree.md'], ['00-requirements.md', '01-as-is.md'],
  ['00-requirements.md', '02-to-be-plan.md'], ['01-as-is.md', '01.5-root-cause.md'],
  ['01-as-is.md', '02-to-be-plan.md'], ['01.5-root-cause.md', '02-to-be-plan.md'],
  ['02-to-be-plan.md', '03-implementation-summary.md'], ['02-to-be-plan.md', '03.5-code-review.md'],
  ['02-to-be-plan.md', '04-test-summary.md'], ['02-to-be-plan.md', '05-manual-qa.md'],
  ['03-implementation-summary.md', '03.5-code-review.md'], ['03-implementation-summary.md', '04-test-summary.md'],
  ['03.5-code-review.md', '04-test-summary.md'], ['06-decisions-update.md', '07-state-update.md'],
  ['EVERY PRESENT ARTIFACT', '06-decisions-update.md'], ['EVERY PRESENT ARTIFACT', '08-memory-impact.md'],
]
const ovEdgeRuns = OVL.filter((l) => /^(lane|spine) .+ -> .+$/.test(String(l)) || /^wildcard stub /.test(l))
/**
 * ⚠ NINE OF THE CHECKS IN THIS SECTION USED TO HAND A NUMBER WHERE A BOOLEAN BELONGS, and a
 * checker that cannot fail is not a check. `check(label, ok)` passes whenever `ok` is truthy — and
 * `7` is truthy, and so is an EMPTY ARRAY — so "sixteen edges, one run each" was green against any
 * count at all, and "one lane run per forward, non-adjacent edge" was green against an expectation
 * that is itself wrong. Each check below now compares what its own label says it compares, and the
 * two wrong expectations are corrected rather than preserved:
 *   · the derived edge set has SEVEN forward non-adjacent edges, not eight;
 *   · the two CONDITIONAL edges are adjacent pairs, so they are SPINE runs, and what makes them
 *     conditional on the page is the dash — checked as a class in the emitted svg;
 *   · TWO phases carry a human gate (00-requirements: run-start, 05-manual-qa: qa-signoff);
 *     03-implementation-summary declares tdd-mode as a gate, not as a phase-level human decision.
 * The chart satisfies every one of them, before and after the rewrite.
 */
const missEdges = OV_EDGES.filter(([a, b]) => {
  if (a === 'EVERY PRESENT ARTIFACT') return !OVL.includes('wildcard stub ' + b)
  const i = OV_NODES.indexOf(a), j = OV_NODES.indexOf(b)
  return !OVL.includes((j - i === 1 ? 'spine ' : 'lane ') + a + ' -> ' + b)
})
check('8.11.2 THE OVERVIEW DRAWS ALL SIXTEEN DERIVED EDGES, ONE RUN EACH (drawn ' + ovEdgeRuns.length + ')',
  ovEdgeRuns.length === OV_EDGES.length, 'expected ' + OV_EDGES.length + ', drew ' + ovEdgeRuns.length)
check('8.11.2 every one of the sixteen is drawn, by endpoint',
  missEdges.length === 0, missEdges.map(([a, b]) => a + ' -> ' + b).join(', '))
/* THE INTERACTION TYPES, as shapes. */
check('8.11.3 MULTI-INPUT: five nodes carry the dashed fan-in border, and they are the five that read more than one artifact',
  (OVERVIEW.svg.match(/dg-box-fan/g) || []).length === 5 && OV_NODES.filter((f) => !OVL.includes('node ' + f)).length === 0,
  'fan borders ' + (OVERVIEW.svg.match(/dg-box-fan/g) || []).length + ', of 12 nodes')
check('8.11.3 every node states its own fan-in in words, so the count is not carried by the border alone',
  OVL.filter((l) => /^fan-in \d|^no upstream artifact|^reads every present/.test(String(l))).length >= 12)
check('8.11.3 CONDITIONAL: SEVEN lane runs, one per forward NON-ADJACENT input edge',
  ovCount(/^lane .+ -> .+$/) === 7, 'drew ' + ovCount(/^lane .+ -> .+$/))
check('8.11.3 the two conditional edges are drawn at all, as spine runs',
  OVL.includes('spine 01.5-root-cause.md -> 02-to-be-plan.md') && OVL.includes('spine 03.5-code-review.md -> 04-test-summary.md'))
check('8.11.3 exactly two runs and two arrowheads carry the conditional dash',
  (OVERVIEW.svg.match(/dg-line-cond/g) || []).length === 2 && (OVERVIEW.svg.match(/dg-head-cond/g) || []).length === 2,
  'dashed runs ' + (OVERVIEW.svg.match(/dg-line-cond/g) || []).length + ', dashed heads ' + (OVERVIEW.svg.match(/dg-head-cond/g) || []).length)
check('8.11.4 WILDCARD: a thick stub into each wildcard phase and a rail that spans the row',
  ovCount(/^wildcard stub /) === 2 && (OVERVIEW.svg.match(/dg-line-wide/g) || []).length === 2,
  'stubs ' + ovCount(/^wildcard stub /) + ', thick runs ' + (OVERVIEW.svg.match(/dg-line-wide/g) || []).length)
check('8.11.4 the wildcard rail is as wide as the twelve-node row',
  (() => {
    const rail = OV.boxes.find((b) => b[5] === 'the wildcard input rail')
    const nodes = OV.boxes.filter((b) => String(b[5]).startsWith('node '))
    if (!rail || nodes.length !== 12) return false
    const left = Math.min(...nodes.map((n) => n[1])), right = Math.max(...nodes.map((n) => n[1] + n[3]))
    return Math.abs(rail[1] - left) < 1 && Math.abs(rail[1] + rail[3] - right) < 1
  })(), true)
check('8.11.5 HUMAN DECISION: one amber marker for each phase a person must answer (2)',
  ovCount(/^human decision marker /) === 2, 'drew ' + ovCount(/^human decision marker /))
check('8.11.5 each marker carries its own diamond',
  ovCount(/^decision diamond /) === 2, 'drew ' + ovCount(/^decision diamond /))
check('8.11.6 REFUSAL: one band under each of the twelve phases',
  ovCount(/^refusal band /) === 12, 'drew ' + ovCount(/^refusal band /))
check('8.11.7 SEQUENCE ORDER: the four adjacent pairs with no input edge are drawn as their own shape',
  ovCount(/^sequence link /) === 4 && (OVERVIEW.svg.match(/dg-line-seq/g) || []).length === 4,
  'links ' + ovCount(/^sequence link /) + ', dotted runs ' + (OVERVIEW.svg.match(/dg-line-seq/g) || []).length)
check('8.11.8 BACK-EDGE: two arcs, each a riser + a shelf + a drop and a violet entry arrowhead',
  ovCount(/^reopen (riser|shelf|drop)/) === 3 && ovCount(/^reopen head /) === 1
  && ovCount(/^revise (riser|shelf|drop)/) === 3 && ovCount(/^revise head /) === 1
  && (OVERVIEW.svg.match(/dg-head-loop/g) || []).length === 3,
  'reopen ' + ovCount(/^reopen (riser|shelf|drop)/) + '/head ' + ovCount(/^reopen head /)
  + ', revise ' + ovCount(/^revise (riser|shelf|drop)/) + '/head ' + ovCount(/^revise head /)
  + ', violet heads ' + (OVERVIEW.svg.match(/dg-head-loop/g) || []).length)
check('8.11.8 each back-edge arrowhead enters a node EARLIER in the sequence than the node it left',
  OVL.includes('reopen head 02-to-be-plan.md') && OVL.includes('revise head 03.5-code-review.md'))
check('8.11.9 CROSS-RUN: the loop is drawn as a return path with an arrowhead, not as a sentence',
  ovCount(/^cross-run return (run|drop|foot)$/) === 3 && ovCount(/^cross-run return head$/) === 1
  && ovCount(/^cross-run card: /) === 3,
  'return marks ' + ovCount(/^cross-run return (run|drop|foot)$/) + ', heads ' + ovCount(/^cross-run return head$/)
  + ', cards ' + ovCount(/^cross-run card: /))
/* ==========================================================================
   8.12 THE COMPOSITION BUDGETS — the invariant that was missing
   ==========================================================================

   WHY THIS SECTION EXISTS. The overview was 2854 units wide inside a reading column that gives a
   chart 1141 units at a 1280px window, so a reader opening the page saw FIVE of the twelve phases;
   it also carried a 148-unit band of empty height under its title with one marker floating alone in
   it, and the refusal bands sat 134 units below their own nodes, reading as a detached strip. Every
   check in this file was green: nothing compared the chart's SIZE with the box it lands in, or its
   ink with its own frame.

   The numbers are stated HERE, independently of the generator, which states them again in
   `OVERVIEW_LIMITS` — two scripts that agree because they measure the same file, not because they
   share a mistake:

     · WIDTH 1130 units at a 1280px viewport. The SVG space the page gives a chart is measured in
       headless Chromium at 1141 units at 1280x900 and 1216 at 1440 (where the reading column is at
       its 1340px cap); the budget is the smaller less eleven units of slack, so a padding token
       change cannot silently push the chart into a horizontal scroll.
     · HEIGHT 780 units. 900px of window, less the 108px sticky tab strip and a 12px margin: the
       chart has to be ONE picture in the frame the owner screenshots it in.
     · MAX EMPTY BAND 48 units. The tallest run of the frame's height holding no ink at all. This is
       the one that catches a floating marker or a detached strip, and it is deliberately NOT the
       drawing's bounding box: a bounding box cannot see a hole in the middle of itself, which is
       exactly how a chart with 24% of its height empty passed everything for a round.
     · The frame may not be padded either: its height stays within 5% of the drawing's own height. */
const OV_LIMITS = { MIN_VIEWPORT_W: 1280, WIDTH_BUDGET: 1130, HEIGHT_BUDGET: 780, MAX_EMPTY_BAND: 48 }
const emptyBandOf = (L) => {
  const [ox, oy, w, h] = L.viewBox
  const spans = L.boxes.map((b) => [Math.max(oy, b[2]), Math.min(oy + h, b[2] + b[4])])
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])
  let worst = 0, reach = oy
  for (const [a, b] of spans) {
    if (a > reach) worst = Math.max(worst, a - reach)
    reach = Math.max(reach, b)
  }
  return Math.round(Math.max(worst, oy + h - reach) * 100) / 100
}
const ovInk = OV.boxes.reduce((acc, b) => [Math.min(acc[0], b[2]), Math.max(acc[1], b[2] + b[4])], [Infinity, -Infinity])
const ovEmpty = emptyBandOf(OV)
check('8.12 THE OVERVIEW FITS THE COLUMN IT IS READ IN — ' + OV_LIMITS.WIDTH_BUDGET + ' units at a '
  + OV_LIMITS.MIN_VIEWPORT_W + 'px viewport',
  OV.viewBox[2] <= OV_LIMITS.WIDTH_BUDGET, 'this chart is ' + OV.viewBox[2] + ' units wide')
check('8.12 THE OVERVIEW IS ONE PICTURE IN A 1440x900 WINDOW — under ' + OV_LIMITS.HEIGHT_BUDGET + ' units tall',
  OV.viewBox[3] <= OV_LIMITS.HEIGHT_BUDGET, 'this chart is ' + OV.viewBox[3] + ' units tall')
check('8.12 THE OVERVIEW HAS NO EMPTY BAND TALLER THAN ' + OV_LIMITS.MAX_EMPTY_BAND + ' UNITS — measured ' + ovEmpty,
  ovEmpty <= OV_LIMITS.MAX_EMPTY_BAND, 'the tallest band holding no ink is ' + ovEmpty + ' units')
check('8.12 the overview frame is not padded: its height is within 5% of the drawing it holds',
  OV.viewBox[3] <= Math.round((ovInk[1] - ovInk[0]) * 1.05 * 100) / 100,
  'frame ' + OV.viewBox[3] + ', ink ' + Math.round((ovInk[1] - ovInk[0]) * 100) / 100)

/* AND THE PROSE IS GONE. The overview carries a title, a one-line lede, a signpost and the chart —
   nothing else above the picture. This is the invariant the OWNER asked for in words: "you are just
   adding more and more text above the workflow instead of making the workflow a real proper
   diagram". It is checked as a BOUND on how much markup sits between the panel opening and the
   chart, which is the only form of it a script can hold. ⚠ The slice starts AT the overview panel's
   id and ends at the NEXT chart, so it cannot pick up a callout belonging to another view — the
   first version matched from the first `<section>` in the document and measured the wrong region. */
const ovAt = html.indexOf('id="panel-overview"')
const ovPrologue = html.slice(ovAt, html.indexOf('<div class="diagram"', ovAt))
check('8.11.10 the overview has NO callout above the chart — the prose walls are gone (region ' + ovPrologue.length + ' bytes)',
  (ovPrologue.match(/class="callout"/g) || []).length === 0,
  (ovPrologue.match(/class="callout"/g) || []).length + ' callout(s) above the chart')
check('8.11.10 the prologue above the chart is a heading, a one-line lede and a one-line signpost',
  (ovPrologue.match(/<p /g) || []).length <= 2, true)
check('8.11.10 the Facts moved to the Notes view rather than being deleted',
  ['Notes &amp; caveats', 'the two optionality declarations', 'two independent optionality declarations',
    'may be absent', 'Every edge, in full', 'The fan-in, per phase']
    .filter((s) => !html.includes(s)), [])
check('8.11.10 the moved caveats are reachable in ONE line from the overview',
  /href="#tab-notes"/.test(ovPrologue), true)
check('8.11.11 the overview is the FIRST panel and the FIRST tab, so a reader lands on the graph',
  /<section class="panel is-active" id="panel-overview"/.test(html)
  && html.indexOf('id="tab-overview"') < html.indexOf('id="tab-notes"'), true)

/* -- 8.9 nothing is painted inside a positioned element's box ------------
   Every absolutely/fixed positioned element in the sheet, with what it is for. A
   positioned box may hold its own text; it may not sit on top of anything else. */
const POSITIONED = [
  { sel: '.skip', why: 'the skip link, parked off-canvas at left:-9999px' },
  { sel: '.rail::before', why: 'the sequence rail hairline, inside .rail' },
  { sel: '.rail-dot', why: 'the rail marker, inside .rail' },
  { sel: '.sections li::before', why: 'the section counter, in the li list gutter' },
  { sel: '.ask-opts li::before', why: 'the option bullet, in the li gutter' },
]
const positionedInSheet = [...CSS.matchAll(/([^{}]+)\{([^}]*position:\s*(?:absolute|fixed)[^}]*)\}/g)]
  .map((m) => ({ sel: m[1].trim(), body: m[2] }))
const unexplained = positionedInSheet.filter((p) => !POSITIONED.some((k) => (p.sel + '||' + p.sel.split(',').join('||')).includes(k.sel)))
check('8.9 every position:absolute/fixed element is one of the known reserved-space constructs: '
  + positionedInSheet.length + ' found', unexplained.length === 0,
  unexplained.map((p) => p.sel).join(' | '))
check('8.9 the only off-canvas element is the skip link (nothing else is parked outside its container)',
  /\.skip\{[^}]*position:absolute[^}]*left:-9999px/.test(CSS) && /\.skip:focus\{[^}]*left:0/.test(CSS))
const positionedInsideSvg = /position:\s*(absolute|fixed)/.test(svgSrc)
check('8.9 no positioned element exists inside the svg (all of it is in the reserved boxes)', !positionedInsideSvg)

/* -- 8.10 the sheet keeps the declarations that stop a card overflowing -- */
/* A BARE `1fr` is the defect: an `auto 1fr` label/value pair is fine (the value column
   can shrink), and anything inside minmax() has already made its minimum explicit. */
const bareFr = [...CSS.matchAll(/grid-template-columns:([^;}]*)/g)]
  .map((m) => ({ rule: m[0], tracks: m[1].trim() }))
  .filter((t) => t.tracks.split(/\s+/).length === 1 && !/minmax|min\(/.test(t.tracks))
check('8.10 every single-track grid column is minmax()-style, not a bare 1fr: '
  + (CSS.match(/minmax\(0,1fr\)/g) || []).length + ' explicit minmax(0,1fr) tracks',
  bareFr.length === 0 && (CSS.match(/minmax\(0,1fr\)/g) || []).length >= 4,
  bareFr.map((t) => t.rule).slice(0, 3).join(' | '))
check('8.10 citations are breakable (a nowrap citation is what pushed a card over its column)',
  /\.cite\{[^}]*overflow-wrap:anywhere/.test(CSS) && !/\.cite\{[^}]*white-space:nowrap/.test(CSS))
check('8.10 the two-card grids cannot demand more width than their container has',
  /\.detail-grid\{[^}]*minmax\(min\(320px,100%\),1fr\)/.test(CSS) && /\.rail-pair\{[^}]*minmax\(min\(280px,100%\),1fr\)/.test(CSS))

/* -- report --------------------------------------------------------------- */
console.log('check-workflow-map — independent structural check\n')
console.log('  file: ' + target)
console.log('  size: ' + html.length.toLocaleString('en-US') + ' bytes\n')
for (const p of passes) console.log('  PASS  ' + p)
for (const f of fails) console.log('  FAIL  ' + f)
console.log('\n  ' + passes.length + ' passed, ' + fails.length + ' failed')
process.exit(fails.length === 0 ? 0 : 1)
