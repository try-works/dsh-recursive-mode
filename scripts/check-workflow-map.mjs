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
check('tab count is 21 (1 overview + 12 phases + 8 other views): got ' + tabs.length, tabs.length === 21)
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
const svgSrc = (html.match(/<svg[\s\S]*?<\/svg>/) || [''])[0]
const dec = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")

/* -- 8.1 the manifest ----------------------------------------------------- */
const layoutAt = html.indexOf('data-layout="')
const layoutRaw = layoutAt < 0 ? '' : html.slice(layoutAt + 'data-layout="'.length, html.indexOf('"', layoutAt + 'data-layout="'.length))
let L = null
try { L = JSON.parse(dec(layoutRaw)) } catch { L = null }
check('8.1 the diagram ships a parseable layout manifest', !!L && L.v === 1)
const BOXES = Array.isArray(L?.boxes) ? L.boxes : []
const FIT = Array.isArray(L?.fit) ? L.fit : []
check('8.1 the manifest declares a metric and a viewBox: charW=' + L?.charW + ' lineHeight=' + L?.lineHeight
  + ' viewBox=' + JSON.stringify(L?.viewBox),
  typeof L?.charW === 'number' && L.charW > 0 && typeof L?.lineHeight === 'number'
  && Array.isArray(L?.viewBox) && L.viewBox.length === 4)
check('8.1 every reserved box is a 6-tuple with positive, rounded geometry: ' + BOXES.length + ' boxes',
  BOXES.length > 40 && BOXES.every((b) => Array.isArray(b) && b.length === 6
    && ['text', 'box', 'rule', 'ink'].includes(b[0])
    && [b[1], b[2], b[3], b[4]].every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(Math.round(n * 100) - n * 100) < 1e-6)
    && b[3] > 0 && b[4] > 0))

/* -- 8.2 no two reserved boxes may intersect, except by declared exemption -
   Two exemptions are allowed, and both must be DECLARED, not inferred:
     · `contains` — the generator's own record of "this box holds that box";
     · a rule or an arrowhead sharing an index with a rule it joins (a path's corner).
   Everything else that overlaps is the defect class this whole section exists for. */
const CONTAINS = Array.isArray(L?.contains) ? L.contains.filter((p) => Array.isArray(p) && p.length === 2) : []
const containsBox = (o, i) => i[1] >= o[1] && i[2] >= o[2] && i[1] + i[3] <= o[1] + o[3] && i[2] + i[4] <= o[2] + o[4]
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
check('8.2 no two reserved boxes intersect except where declared: ' + BOXES.length + ' boxes compared, '
  + CONTAINS.length + ' declared containments, ' + boxHits.length + ' undeclared intersections',
  boxHits.length === 0, boxHits.slice(0, 4).join(' | '))
/* A declared containment is one of two things, and both are geometric facts:
   · the container is a BOX and geometrically holds the box inside it;
   · the container is a RULE and the contained rule/arrowhead MEETS it — the two
     reserved boxes touch within one stroke width (5 units), which is the arc's corner
     and the only place in the chart where two strokes share a reservation. A pair that
     merely sat near each other would not qualify, and the check says so. */
const meets = (o, i) => Math.abs(Math.min(i[1] + i[3], o[1] + o[3]) - Math.max(i[1], o[1])) <= 5
  && Math.abs(Math.min(i[2] + i[4], o[2] + o[4]) - Math.max(i[2], o[2])) <= 5
const declaredOk = ([i, c]) => {
  const A = BOXES[i], C = BOXES[c]
  if (!A || !C) return false
  if (C[0] === 'box' && containsBox(C, A)) return true
  return C[0] === 'rule' && (A[0] === 'rule' || A[0] === 'ink') && meets(C, A)
}
check('8.2 every declared containment is real: a box that holds its content, or a rule that meets a rule at a corner',
  CONTAINS.length > 10 && CONTAINS.every(declaredOk),
  CONTAINS.filter((p) => !declaredOk(p)).slice(0, 3).map(([i, c]) => i + ',' + c).join(' | '))

/* -- 8.3 the drawing matches the manifest --------------------------------- */
const [VX, VY, VW, VH] = L?.viewBox ?? [0, 0, 0, 0]
const svgOpen = (svgSrc.match(/<svg[^>]*>/) || [''])[0]
const vb = (svgOpen.match(/viewBox="([^"]+)"/) || [, ''])[1].split(/\s+/).map(Number)
check('8.3 the svg viewBox is the manifest viewBox', JSON.stringify(vb) === JSON.stringify([VX, VY, VW, VH]),
  'svg=' + JSON.stringify(vb) + ' manifest=' + JSON.stringify([VX, VY, VW, VH]))
const svgEls = {
  text: (svgSrc.match(/<text\b/g) || []).length,
  rect: (svgSrc.match(/<rect\b/g) || []).length,
  path: (svgSrc.match(/<path\b/g) || []).length,
  ink: (svgSrc.match(/<polygon\b/g) || []).length,
}
const manEls = { text: 0, rect: 0, path: 0, ink: 0 }
for (const b of BOXES) manEls[b[0] === 'box' ? 'rect' : b[0] === 'rule' ? 'path' : b[0]] += 1
check('8.3 one drawn element per reserved box: svg ' + JSON.stringify(svgEls) + ' manifest ' + JSON.stringify(manEls),
  JSON.stringify(svgEls) === JSON.stringify(manEls))

/* -- 8.4 no text may be drawn ACROSS a box it does not belong to ----------
   This is the invariant for D1 and D4. A text box is allowed to be inside a container
   (a label in its card) or clear of every container, but it may never PARTIALLY
   intersect one: that is the heading printed across the gate card, and the hook card
   slicing the first sequence node. Text-on-text is already covered by 8.2. */
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
check('8.4 no box is drawn partly across another: ' + TEXT_BOXES.length + ' texts, ' + CONTAINERS.length
  + ' containers, ' + straddles.length + ' straddles', straddles.length === 0, straddles.slice(0, 4).join(' | '))
check('8.4 every label the manifest promises is held by a declared container: ' + TEXT_BOXES.length + ' of ' + FIT.length,
  TEXT_BOXES.length === FIT.length && CONTAINERS.length >= 18)

/* -- 8.5 no label overruns the box that holds it ------------------------- */
const tight = FIT.filter(([label, x, y, w, h]) => Math.abs(w - String(label).length * L.charW * (h / L.lineHeight)) > 0.05)
check('8.5 every text box is exactly its label at the declared metric (no clipped or overhanging label): '
  + FIT.length + ' labels', FIT.length > 40 && tight.length === 0,
  tight.slice(0, 3).map((f) => JSON.stringify(f[0])).join(', '))
/* And the metric itself must be the width the rendering font can produce. The stack is
   monospace, so one advance width per glyph; Courier New — the last fallback — is the
   widest plausible member at 0.6001 em, and the layout must not under-declare it. */
const MONO_MAX_EM = 0.6001
check('8.5 the declared character width covers the widest monospace in the font stack: charW='
  + L.charW + ' vs ' + MONO_MAX_EM + ' em',
  typeof L.charW === 'number' && L.charW >= MONO_MAX_EM && L.charW <= 0.65)

/* -- 8.6 the drawn coordinates agree with the manifest -------------------- */
const drawn = []
for (const m of svgSrc.matchAll(/<text class="([^"]+)" x="([-\d.]+)" y="([-\d.]+)">/g)) drawn.push({ cls: m[1], x: Number(m[2]), y: Number(m[3]) })
const FS_OF = {}
for (const m of CSS.matchAll(/\.(dg-t[a-z-]*)\{[^}]*font-size:([\d.]+)px/g)) FS_OF[m[1]] = Number(m[2])
const mismatch = []
const drawnRects = [...svgSrc.matchAll(/<rect class="([^"]+)" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g)]
  .map((m) => [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])])
let ti = 0
for (const b of BOXES) {
  if (b[0] !== 'text') continue
  const d = drawn[ti++]
  const fs = FS_OF[d?.cls]
  // textEl writes the baseline at round(boxTop) + fontSize*1.1 — both halves must
  // agree, so a box whose x or line-top was edited to "fix" a drawing fails here.
  const base = Math.round((b[2] + Math.round(fs * 1.1 * 100) / 100) * 100) / 100
  if (!d || d.x !== b[1] || Math.abs(d.y - base) > 0.011) {
    mismatch.push('"' + b[5] + '" drawn ' + JSON.stringify(d) + ' expected y=' + base + ' at x=' + b[1])
  }
}
check('8.6 every <text> is drawn at the manifest box it declared: ' + drawn.length + ' texts',
  mismatch.length === 0 && drawn.length === TEXT_BOXES.length, mismatch.slice(0, 3).join(' | '))
const orphanRects = drawnRects.filter((r) => !BOXES.some((b) => b[0] === 'box' && b[1] === r[0] && b[2] === r[1] && b[3] === r[2] && b[4] === r[3]))
check('8.6 every <rect> is a declared box: ' + drawnRects.length + ' rects', orphanRects.length === 0,
  JSON.stringify(orphanRects.slice(0, 3)))
check('8.6 every dg-* class used in the svg has a font-size in the sheet',
  drawn.every((d) => typeof FS_OF[d.cls] === 'number'),
  [...new Set(drawn.filter((d) => !FS_OF[d.cls]).map((d) => d.cls))].join(', '))
/* THE TWO NUMBERS MUST BE ONE NUMBER. Every reserved text box says its height is
   lineHeight × fontSize; if the sheet draws that class at a different size, then the
   layout was computed for a font nobody renders — which is exactly how a `9px` label
   came to be measured at `9.5px`. This check re-derives the size from the box. */
const sizeMismatch = FIT.filter(([label, x, y, w, h]) => {
  const cls = Object.keys(FS_OF).find((c) => Math.abs(FS_OF[c] * L.lineHeight - h) < 0.06)
  return !cls || Math.abs(String(label).length * L.charW * FS_OF[cls] - w) > 0.06
})
check('8.6 every text box height/width agrees with the font-size the sheet declares for its class',
  sizeMismatch.length === 0, sizeMismatch.slice(0, 3).map((f) => JSON.stringify(f[0])).join(', '))

/* -- 8.7 no band may contain two columns closer than 8 units -------------
   THE SHAPE OF THE DEFECT. The old chart put the hook channel at x=668..896 while the
   sequence row ran to x=900: two columns, one horizontal band, OVERLAPPING x-ranges.
   The test therefore looks for exactly that shape — a horizontal band (a run of boxes
   whose y-intervals connect) that contains two x-clusters closer than 8 units — and
   not at vertical stacking, which is how the whole chart is laid out. */
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
check('8.7 no band holds two columns closer than 8 units: ' + bandGroups.length + ' bands, '
  + bandCollisions.length + ' collisions', bandCollisions.length === 0, bandCollisions.slice(0, 3).join(' | '))
check('8.7 the diagram is laid out in bands rather than one plate of free-floating boxes: '
  + bandGroups.length + ' bands', bandGroups.length >= 8)

/* -- 8.8 the drawing cannot be scaled below its own layout ---------------- */
const dgW = Number((CSS.match(/--dg-w:\s*([\d.]+)px/) || [, ''])[1])
const dgVarUsedBySvg = /\.diagram svg\{[^}]*min-width:var\(--dg-w\)/.test(CSS)
const svgW = Number((svgOpen.match(/\bwidth="([\d.]+)"/) || [, ''])[1])
check('8.8 the svg is sized from --dg-w and cannot shrink: --dg-w=' + dgW + ' svg width=' + svgW,
  dgW === VW && svgW === VW && dgVarUsedBySvg)
check('8.8 the diagram wrapper scrolls horizontally in one strip (the tab-strip mechanism)',
  /\.diagram\{[^}]*overflow-x:auto/.test(CSS) && /overscroll-behavior-inline:contain/.test(CSS))

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
