# Maintaining `recursive-mode-workflow.html`

**`workflow-map/recursive-mode-workflow.html` is a GENERATED artifact.** It is written by
`scripts/gen-workflow-map.mjs` and checked by two more scripts. This document is the maintainer's
guide: what each tool is for, what a failure means, why the invariants exist, and the traps that
already cost this repository real time.

Read this whole file before changing the page. It is short on ceremony and every section is a
lesson that was paid for.

---

## 0. The artifact, and the tools, in numbers

| Thing | Path | Size | What it is |
| --- | --- | --- | --- |
| The page | `workflow-map/recursive-mode-workflow.html` | 360,542 bytes (352 KiB), 2,798 lines | the deliverable: one self-contained page |
| The generator | `scripts/gen-workflow-map.mjs` | 402,395 bytes, 5,477 lines | the only writer of that file |
| Structural checker | `scripts/check-workflow-map.mjs` | 66,178 bytes, 953 lines | reads the WRITTEN FILE |
| Escaping checker | `scripts/check-workflow-map-escapes.mjs` | 7,672 bytes, 114 lines | reads the WRITTEN FILE |
| This guide | `workflow-map/README.md` | ≈50 KB | the file you are reading (its size is approximate on purpose: a document that states its own exact byte count is wrong the moment anyone edits it) |

What the page contains, and what each number means:

| Fact | Number | Where it comes from |
| --- | --- | --- |
| Accessible tabs | **23** | the `tabs` array, `gen-workflow-map.mjs:1712` |
| Phase detail views | **12** | one per entry in `PHASES` (`gen-workflow-map.mjs:718`) |
| Phase nodes drawn on the overview | **12** | one node per phase artifact |
| Derived input edges | **16** | `EDGES`, re-derived from the linter at generate time (`gen-workflow-map.mjs:1193`) |
| Connections the layout traces | **23** | 16 derived edges + 2 violet back-edges + 4 dotted sequence links + 1 cross-run return |
| Charts | **2** | the overview (188 reserved boxes) and the learning loop (136) |
| Citations rendered | **556** | `<span class="cite">` spans in the written file |
| Reserved boxes with a declared containment | overview 80, learning-loop 77 | the `data-layout` manifest each chart ships |
| Facts `--verify` re-derives | **178** | `node scripts/gen-workflow-map.mjs --verify` |
| Structural checks | **76** | `node scripts/check-workflow-map.mjs` |
| Escaping checks | **22** | `node scripts/check-workflow-map-escapes.mjs` |

Two notes on those numbers. The generator and the structural checker both print the page's size as
`359,315` — that is the JavaScript **character** count, not the byte count; the file is 360,542
bytes because the page is full of em dashes, `⚠` and box-drawing characters. (For the same reason the
generator reports `2,799 lines`: that is its own `split('\n').length`, which counts the trailing
newline as an empty final element. The file has 2,798 lines.) And every number in this table is a
number that will change; the ones that are *asserted* are named in section 5.

⚠ **And a note on the line numbers in this document.** Every `gen-workflow-map.mjs:NNNN` reference
below is a line number into a 5,477-line file, and it drifts the moment anyone edits that file. This
document proves it: the paragraph that points maintainers here from the generator's own header added
seven lines to that header, and **every generator reference in this file was wrong within the hour of
being written**. That is the same lesson section 3 teaches about the page's citations, applied to the
guide itself — *the symbol is the stable part; the number is a convenience.* Every reference below
therefore names the symbol **first** (`OVERVIEW_LIMITS` at `gen-workflow-map.mjs:4136`), so a stale
number is recoverable by grepping the symbol. If you edit the generator, do not renumber this file
line by line; do fix a reference whose symbol has moved to a different part of the file.

---

## 1. READ THIS FIRST — THE THREE RULES

### Rule 1 — NEVER EDIT THE HTML

`scripts/gen-workflow-map.mjs` writes exactly one file, and it writes it whole. A hand-edit to
`recursive-mode-workflow.html` is lost the next time anybody runs the generator, and — worse — it is
**invisible to the tool that would have caught it**: `--verify` never opens the file on disk. It
renders the page in memory and checks the facts of that render. So a hand-edit can sit in the
working tree, pass `--verify`, pass both checkers, and disappear at the next regeneration with the
suite still green.

If you want the page to say something different, change the generator and regenerate.

### Rule 2 — EVERY graphic element goes through `reserve()`, or it does not exist

Every node, edge stroke, arrowhead, label, band, rail and marker is laid out by the layout engine in
`makeEngine()` (`gen-workflow-map.mjs:3005`), and every one of them passes through `reserve()`
(`gen-workflow-map.mjs:3045`) before it is emitted. `reserve()` **throws** when two reserved boxes
intersect without a declared relationship. There is no other way to write into the SVG body, so an
element with hand-picked coordinates cannot be emitted at all — which is the point:

> **No raw coordinates, ever.** Not "usually", not "for a quick fix". A coordinate that was never
> checked against another coordinate is exactly how this page shipped four collisions that a reader
> saw in a browser and the author could not see at all (`gen-workflow-map.mjs:2937`).

### Rule 3 — `--verify` RE-DERIVES from `src/`, and that is the design

The page's whole value is that its content is transcribed from this repository's source with a
citation on every factual block. `--verify` re-reads `src/**` and re-derives the claim-bearing lists
(phase order, required sections, late/audited/optional sets, tool names, hook seam strings, error
codes, guard labels, the run-start labels) and compares them with what the generator is about to
render.

**When the plugin's source changes, `--verify` FAILS until the page and its anchors are updated.**
That is not a nuisance to work around; it is the mechanism. A red `--verify` after a source change
means the page is now making a claim the code no longer supports. Fix the page — do not loosen the
check, and do not re-anchor the citation onto a line that happens to contain the old text.

---

## 2. THE TOOLCHAIN — IN THE ORDER YOU RUN IT

Run these from the repository root, in this order.

### 2.1 `node scripts/gen-workflow-map.mjs --verify`

- **What it is for:** re-derive every claim-bearing fact from `src/**` and compare it with the
  render. It currently reports **178 / 178 checks passed**.
- **What it writes:** nothing. Not one byte. `--verify` renders in memory, verifies, prints, exits.
- **What a failure means:** a fact in `src/` changed, or an anchor moved, or a citation range ran
  past the end of its file. The output names the check and prints `expected:` / `actual:` as JSON.
  Exit code 1, and it prints `N check(s) FAILED. Nothing written.`
- **⚠ What it does NOT prove:** anything at all about the file on disk. `--verify` is a
  **source-reading** tool. If the page in the tree is stale, `--verify` is still green.

### 2.2 `node scripts/gen-workflow-map.mjs`

- **What it is for:** render, run the same 178 checks, and write the page.
- **What a failure means:** identical to 2.1 — and note that the write happens **only after every
  check passes**. A failing generator cannot leave a half-written page behind.
- **Determinism:** the output is byte-identical across runs. Regenerating on a clean tree produces
  no diff. So after running it, **`git status` must show no change to the HTML** — if it does show a
  change and you did not intend to change the page, you have just discovered that the committed page
  was stale relative to its generator.
- **Note the pass line:** the generator prints `ok.length + ' / ' + ok.length`. That line can never
  print a mismatch; it is a count, not a check. The signal is *the absence of `FAIL` lines and exit
  code 0*.

### 2.3 `node scripts/check-workflow-map.mjs`

- **What it is for:** independent structural validation of the **written file**. It re-reads the page
  from disk and re-parses `data-layout` — the manifest the layout engine emitted — rather than
  trusting anything the generator held in memory. It currently reports **76 passed, 0 failed**.
- **What a failure means:** the bytes on disk are wrong. Tags unbalanced, duplicate ids, a broken
  `aria-controls`, a tab without a panel, a reserved box that intersects another without a
  declaration, a stroke that does not trace from its source to its target, a chart outside its
  frame, a label that does not fit its box, or a sizing budget is exceeded.
- **Exit codes:** 1 on any failed check, 2 if the file does not exist.

### 2.4 `node scripts/check-workflow-map-escapes.mjs`

- **What it is for:** the failure mode a template-literal renderer actually has — a `${…}` that never
  interpolated, an `[object Object]`, a literal `undefined`, an unescaped `<` in prose, a bare `&`,
  an unbalanced brace in the inline stylesheet. Those do not throw; they ship and look like content.
  It currently reports **22 passed, 0 failed**.
- **What a failure means:** something reached the page that is not content. Usually an `esc()` call
  was missed at a new interpolation site.
- **Exit codes:** 1 on any failed check, 2 if the file does not exist.

### 2.5 `pnpm test`, then `pnpm typecheck`, then `pnpm build`

- `pnpm test` — the full vitest suite. **114 files / 1,192 tests** at the time of writing (four of
  them are the guard on *this document*, section 10).
- `pnpm typecheck` — the plugin's TypeScript, exit 0.
- `pnpm build` — `link-dsh` + `tsc -p tsconfig.build.json` + `tsdown`, exit 0.

### ⚠ 2.6 WHICH TOOL READS SOURCE, AND WHICH READS THE WRITTEN FILE

This is the trap the toolchain is arranged to close, so it is worth stating flatly:

| Tool | Reads `src/**` and re-derives? | Reads the page FROM DISK? |
| --- | --- | --- |
| `gen-workflow-map.mjs --verify` | **yes** | **no** — renders in memory |
| `gen-workflow-map.mjs` | yes | no — it *writes* it |
| `check-workflow-map.mjs` | no | **yes** |
| `check-workflow-map-escapes.mjs` | no | **yes** |

Two consequences, both of which have bitten:

1. **A stale page makes the file-reading checkers pass while proving nothing about the generator.**
   They will happily certify a page that no longer matches its own generator, because they only ever
   ask whether the bytes are internally well formed.
2. **Nothing in the toolchain is wired into `pnpm test`.** No spec, and no `package.json` script,
   invokes the generator or either checker. A green suite says *nothing whatsoever* about the page.
   The three scripts are manual gates: if you do not run them, they did not run.

`--out <path>` exists on the generator and on both checkers (the checkers take a positional path), so
you can render and check a **candidate** page without touching the shipped one. That is how the
mutation proofs in section 6 were run, and how you should test a layout change.

---

## 3. CITATIONS — NAMED ANCHORS, NOT LINE NUMBERS

Every factual block on the page carries its source, and the source is resolved **at generate time**
from a **named anchor** searched inside the file it belongs to. The generator does not store a single
transcribed line number.

**Why.** While the page was being built, another agent edited `src/policy-globs.ts` and
`src/runtime.ts` and inserted dozens of lines for a new guard rule. Every line number already
transcribed into the page below that point became **wrong** — and a wrong citation is precisely the
defect the page exists to avoid: a diagram that asserts something the code does not say
(`gen-workflow-map.mjs:40`). A hand-cited diagram would have shipped those wrong numbers.

### How it works

- **The anchor table** is `ANCHORS` at `gen-workflow-map.mjs:53`. Each entry is
  `'<key>': ['<repo path>', '<search text>']`, e.g.
  `'lock.sequence': ['src/lock.ts', 'export const PHASE_SEQUENCE = [']`.
- **`anchor(key)`** (`gen-workflow-map.mjs:305`) finds every line containing the search text:
  - **0 hits → HARD FAILURE**: `ANCHOR NOT FOUND — <key> ("<text>") in <file>`.
  - **more than 1 hit → HARD FAILURE**: `ANCHOR AMBIGUOUS (N hits, undeclared)`. A second copy of a
    marker is a duplication symptom, and silently citing the first one hides it. If the text really
    does appear more than once and the citation should list all of them, **declare the key in
    `MULTI_HIT_ANCHORS`** (`gen-workflow-map.mjs:284`) and say why in a comment. Exactly one key is
    declared today: `policy.text`.
  - otherwise it resolves to `file:line`, and the file-relative path is always part of the answer, so
    no citation can ever render as a bare line number.
- **`citeOf(spec)`** (`gen-workflow-map.mjs:321`) turns a citation spec into the rendered string.
  `'lock.sequence'` → `src/lock.ts:21` (the real resolution today). `'lock.sequence#1-13'` → a range
  starting at the anchor line (1-based, relative). Comma-separate for several. A backwards range, a
  non-numeric range, a range that runs past the end of the file, or a range taken from a multi-hit
  anchor are all hard failures.
- **`SRC`** (`gen-workflow-map.mjs:362`) resolves the anchor keys **once, at module load**. A typo in
  a key throws before anything renders. Facts are then cited by name: `${cite(SRC.someKey)}`, where
  `cite()` (`gen-workflow-map.mjs:1537`) escapes the text and wraps it in `<span class="cite">`.
- Some anchors are **declared by construction** rather than by hand: `section.<file>` for all twelve
  `SECTION_MAP` entries (`gen-workflow-map.mjs:344`) and `tool.<name>` for all thirteen tool files
  (`gen-workflow-map.mjs:354`). Their anchor text is the file's own key literal, so a citation and the
  thing it names cannot disagree.

### To add a citation for a new fact

1. Find the line in `src/**` that the fact rests on and choose a **unique** substring of it — a
   declaration, an `export const` name, a distinctive comment. Prefer a line that will *move* with
   the code rather than one that will be deleted.
2. Add the entry to `ANCHORS` (`gen-workflow-map.mjs:53`), in the block for that source file:
   `'myfact.thing': ['src/my-file.ts', 'export const THING = '],`
3. If — and only if — the substring legitimately occurs more than once, add the key to
   `MULTI_HIT_ANCHORS` (`gen-workflow-map.mjs:284`) with a comment explaining why.
4. Add a resolved name to `SRC` (`gen-workflow-map.mjs:362`):
   `myFact: citeOf('myfact.thing'),` — or use a range: `citeOf('myfact.thing#1-4')`.
5. Put `${cite(SRC.myFact)}` in the block that makes the claim, at the point a reader needs it.
6. Run `node scripts/gen-workflow-map.mjs --verify`. A missing or ambiguous anchor fails **here**,
   not on the page.
7. If the fact is one of the claim-bearing lists, also add a `check(...)` to `verify()`
   (`gen-workflow-map.mjs:4392`) so the *fact itself* is re-derived rather than only cited. See
   section 8.

### The generator already checks its own citations

`--verify` includes: every rendered citation has the shape `path:line`; every cited path is a file
that exists and can be read; every cited line exists inside the file it names; at least one citation
per phase panel (≥ 8 each); and a floor on the total. So a citation that points at line 900 of a
300-line file cannot ship.

---

## 4. THE LAYOUT ENGINE — `reserve()`, OR IT DOES NOT EXIST

`makeEngine()` (`gen-workflow-map.mjs:3005`) is the only way to draw. It holds three arrays — every
reserved **box** in emission order, the declared **containment** pairs, and the **SVG body** — and
`reserve(box, kind, label, inside)` (`gen-workflow-map.mjs:3045`) is the single gate every element
passes through.

### What `reserve()` guarantees

1. **Geometry that is checked is the geometry that is emitted.** The box is rounded to two decimals
   *on entry, then tested* — rounding after the test would let the rule disagree with the manifest it
   prints.
2. **No empty boxes.** `w > 0 && h > 0` or it throws.
3. **No undeclared overlap.** Two reserved boxes may overlap in exactly two ways:
   - a **container** holds its contents — the outer box contains the inner one completely (a card and
     its text, the strip and its twelve nodes); the pair is recorded in the containment manifest;
   - a **rule or an arrowhead** may touch the edge of the box it belongs to, declared through the
     `inside` argument.
   Anything else — a partial overlap, "these two are in the same band and neither holds the other" —
   **throws**:

   ```
   diagram: OVERLAP — rule "lane 00-worktree.md -> 01-as-is.md" [x,y,w,h] intersects
   text "01-as-is.md" [x,y,w,h] by 12x4 units — neither box contains the other
   ```

4. **TEXT may not overlap TEXT, and this one has no exemption.** A text box is **not** a container.
   `"a box may contain another box"` is what lets a card hold its own label; but when both boxes are
   text, containment is not a structure — it is one label drawn through another, which is illegible
   on the page. The engine used to wave that through: two lane labels were laid at the same point and
   **every check stayed green while the two names printed on top of each other**
   (`gen-workflow-map.mjs:3067`). The rule now reads:

   ```
   diagram: TEXT ON TEXT — "<label>" [x,y,w,h] is drawn over "<other>" [x,y,w,h]
   by 3.5x2 units: a label is not a container
   ```

   Text may be held by a box or a rule; it may never be held by other text.

### Why containment is DECLARED rather than assumed

Because the two legitimate overlaps are *facts about the picture* that a reader is entitled to see
stated:

- a box may contain **its own label** — that is structure;
- a rule may **meet the rule it joins at a corner** — `LINE_PAD` is 2.5 units, half the reserved
  height of a rule, so an L-shaped run's two strokes touch;
- an **arrowhead is ink**, and an ink box is a *rectangle around a triangle*, so its corners reach
  past the glyph: an arrowhead at the end of a horizontal run overlaps that run's box by a few units
  even though the drawn triangle only meets it at a point. The checker already accepts exactly this
  relation (`meets`, within one stroke width of 5 units) and refuses any other declared containment —
  so the exemption cannot hide a real defect;
- a stroke may have to declare **more than one** relation, which is why `inside` takes an **array**.
  The run that leaves the bundle trunk and crosses another lane overlaps **both**; a single index
  could state one of those facts and the engine would refuse the other as undeclared — it would
  refuse the *picture* instead of the *defect*. Every index becomes its own pair in the manifest and
  the checker re-derives each pair on its own, so the array widens what can be **declared** without
  widening what is **allowed**.

The tolerance is `EPS = 0.05` units: boxes that merely touch are not an overlap. The defects this
rule exists for were **4–14 units deep**, so the tolerance cannot hide one — it is three orders of
magnitude below the smallest of them.

### The rejection is not a wall you argue with

Every geometric fact the layout depends on is asserted as arithmetic adjacent to the code that relies
on it. Examples you will meet if you change the grid: the row boundary must fall on exactly one
*spine* edge across the rows and six inside them (`gen-workflow-map.mjs:3434`); the level order of
the lanes is asserted coordinate by coordinate (`gen-workflow-map.mjs:3824`). When your edit
contradicts one of these, the engine tells you **which** arithmetic fact you broke. Read the
assertion and fix the layout; do not move the assertion.

### What it has actually caught

The record in this repository is precise, and worth keeping precise:

- **Four collisions in the hand-placed SVG that came before the engine** — a 6px heading overlap on
  the phase-0 gate card, twelve nodes whose labels overran their own boxes onto their neighbours',
  a `REVISE` label painted across a sentence, and a grey hook panel slicing an amber sequence row.
  **A reader saw all four in a browser and the author could not see any of them**, because nothing in
  the file ever compared two coordinates (`gen-workflow-map.mjs:2937`). These four are *why the engine
  exists*, and they are the reason Rule 2 is absolute.
- **Four build refusals during the first generator round**, including a real crossing — a lane drawn
  across a node stub (`29ba011`). The engine refused to emit the picture rather than shipping a
  tangle.
- **The `TEXT ON TEXT` hole** was not caught by the engine; it was caught by a human looking at the
  render, and the engine's rule was then extended so it can never happen silently again.
- ⚠ **And one class it cannot catch at all, by construction.** The engine's intersection check could
  not see the broken edges of `857c4de`: *an orphaned stub intersects nothing, and a hole in a line
  is not an overlap*. That is why section 5's TRACE and orphan invariants exist. Do not expect
  `reserve()` to save you from a disconnected line.

---

## 5. THE INVARIANTS, AND WHY EACH EXISTS

This is the most important section in this document. Each invariant below is stated as a **property**,
a **number**, and the **human complaint** that made it necessary — because the number is only
meaningful next to the complaint, and the next person to edit this page needs to know which failure
the number is standing in front of.

### 5.1 The chart fits the frame it is read in

**Property.** The overview is narrower than the column that renders it, and it is one picture in a
normal window.

**Numbers** (`OVERVIEW_LIMITS`, `gen-workflow-map.mjs:4136`):

| Limit | Value | Measured today |
| --- | --- | --- |
| `MIN_VIEWPORT_W` — the narrowest window the page claims to support | 1280 px | — |
| `WIDTH_BUDGET` — the chart's SVG width at that viewport | 1130 units | chart is 1128 |
| `HEIGHT_BUDGET` — one picture in a 1440×900 window | 780 units | chart is 740 |
| `MAX_EMPTY_BAND` — tallest run of the frame holding no ink at all | 48 units | measured 14 |
| Frame padding — height vs the drawing it holds | within 5 % | passes |

The 1130 is the 1141 units the page actually gives the chart at 1280 px (measured in headless
Chromium, *not* derived from the token arithmetic) less 11 units of slack, so a padding change cannot
silently push the chart into a horizontal scroll. The 780 is 900 less the 108 px sticky tab strip and
a 12 px margin.

**The complaint.** The owner opened the page and found **five of the twelve phases** visible, with
the rest reachable only by scrolling sideways — while roughly **forty percent** of the visible frame
sat empty above the node row and the refusal bands floated 170 units below the phases they belong to
(`894b0ea`). The chart was 2854 units wide inside a ~1141-unit column and measured clean: zero
overlaps, scale exactly 1.0000, every label inside its box, 166 verified facts. **Every measurement
passed and the picture did not work, because nothing had ever asserted that an overview must be seen
whole.** The fix was two rows of six in a serpentine — and the *fit itself* became a checked
invariant in both `--verify` and the structural checker.

**Why `MAX_EMPTY_BAND` is not the bounding box.** A bounding box cannot see a hole in the middle of
itself, which is exactly how a chart with ~24 % of its height empty passed every check for a round.
The shipped chart had an empty band of **148.3 units** under its title (the generator's prose says
140; the live `--verify` output says 148.3 — trust the measurement). The tallest surviving gap is 14.

### 5.2 No text on text

**Property.** No two text boxes overlap anywhere in any chart.
**Number:** 0 — enforced by construction in `reserve()` (`gen-workflow-map.mjs:3075`) and re-derived
by the checker from the manifest (overview: 188 boxes, 80 declared containments, **0 undeclared**).
**The complaint.** Two lane labels were laid at the same point and printed through each other. Every
check was green. The engine's containment rule waved it through, because "a box may contain a box"
had no exception for text.

### 5.3 TRACE — every connection reaches its target, and ends in an arrowhead ON it

**Property.** For each of the **23** connections, the checker flood-fills from the source box through
that connection's own strokes and requires a non-empty chain that **reaches** the target box and ends
in an **ink arrowhead on it**. Eleven heads land on a node box.
**The complaint.** The owner said the connecting lines were *"somewhat broken"*. Measured off the
shipped manifest, that was literally true: **THREE of the sixteen drawn edges were not connected from
their source node to their target node at all.** `00-requirements.md → 02-to-be-plan.md` was drawn as
**two strokes with a 417-unit hole** — the run ended at x=403 and its arrival stub hung at x=820,
attached to nothing. Two more runs stopped short of their stubs by 6.5 units.
⚠ The two records of that third gap disagree, and you should know which to trust: the commit message
says **417** and prints the coordinates (x=403 → x=820, which is 417), while the generator's comment at
`gen-workflow-map.mjs:4148` says **375**. When two numbers in this repository disagree, the one that
comes with arithmetic wins.
**Why nothing saw it.** Every check counted **labels**: a box reading
`lane 00-requirements.md -> 02-to-be-plan.md` existed, so the edge counted as drawn — whether or not
its strokes reached each other. On the previous page, TRACE fails on exactly three edges and names
two orphan strokes, *while the old checker reported 71/0 on that same file*.

### 5.4 No orphan stroke

**Property.** Every stroke that draws part of a connection belongs to some traced chain. A segment
nothing reaches cannot be emitted silently.
**The complaint.** The arrival stub at x=820 hung off nothing at either end. An orphaned stub
intersects nothing, so the layout engine cannot see it; the only way to catch it is to require every
stroke to belong to a chain that starts at a source.

### 5.5 Landing margin — an arrow points at a phase, not at a boundary

**Property.** Every arrowhead that lands on a node box lands at least **16 units** inside it from
**both** vertical edges (`LAND_MARGIN`, `gen-workflow-map.mjs:4169`).
**The complaint.** The reopen arc came down **11 units** inside `02-to-be-plan.md`, having wrapped
around `03-implementation-summary.md` on the way in — so it read as pointing at the wrong phase. It
now lands on the node's centre, 79.5 units from either edge. 16 is what this canvas affords: the
arrival ports sit 20, 23, 26, 27 and 30 units in, and no head is nearer than 20 to a corner.

### 5.6 Proximity — a stroke must not brush a box it does not attach to

**Property.** No edge stroke longer than 24 units passes within **14 units** of a node box that is
not on its own connection (`PROXIMITY_MIN`).
**The complaint.** The reopen riser ran **6.5 units** from the right edge of
`03-implementation-summary.md` and 6.5 from `03.5-code-review.md`'s, attached to **neither**, and the
arc read as belonging to the node it merely passed. *"Passing through the gap is what looks broken."*

### 5.7 Channel spacing — two parallel strokes must not read as one doubled line

**Property.** Two parallel strokes belonging to **different** edges are never closer than
**12 units** (`CHANNEL_MIN`).
**The complaint.** The strip under `02-to-be-plan.md` held **four strokes at gaps of 7, 7, 7 and 9
units**, with three of them labelled the same. That is the tangle, in numbers. The fix was structural
rather than cosmetic: one labelled bundle trunk now leaves the node and branches at its own levels,
declaring its sharing instead of implying it, and the strip holds two strokes 13 apart.

### 5.8 A label names its own destination, and run labels are unique

**Property.** The label nearest to each lane run names **that run's own destination** and sits inside
the run it names, so a label can never be read against the wrong stroke. The only words the chart may
print more than once are its per-node data rows; every label that names a run is unique in the chart.
**The complaint.** Labels used to name the **source** only. In the tangle under `02-to-be-plan.md`,
three runs carried the same source name and a reader had to trace pixels to tell them apart.

### 5.9 The interaction types are SHAPES, not sentences

**Property.** Each relationship has a distinct drawn form, and the form is asserted against the fact
it encodes — so a shape cannot claim a relationship the data does not have:

| Shape | Asserted property | Count |
| --- | --- | --- |
| Dashed fan-in node border | exactly the phases that read **more than one** artifact | 5 |
| Dashed run + dashed head | exactly the **conditional** edges, edge by edge against the edge kind | 2 |
| Thick stub from the rail | the wildcard input, with the rail exactly as wide as the node row | 2 |
| Dotted link + hollow head | sequence ORDER on exactly the adjacent pairs that have **no** input edge | 4 |
| Amber marker + diamond | the phases a **person** must answer | 2 |
| Hatched band | a guard rule that can refuse **that** phase, naming the narrowest rule that bites | 12 |
| Violet arc | the two **backward** edges, each landing on a node EARLIER in `PHASE_SEQUENCE` | 2 |
| Cross-run return | the learning loop: return run, drop, foot, head, and three cards | 1 |

**The complaint.** *"You are just adding more and more text above the workflow instead of making the
workflow a real proper diagram that shows interaction between phases etc."* Three previous rounds had
answered the owner's complaints with **prose** — the badge defect produced three paragraphs
explaining the badge, and the 16 edges had been built onto a **separate tab**, so the view he
actually opened still showed twelve boxes in a row and no interaction at all. The rule that came out
of it is worth applying to every edit you make: **if a sentence explains what the picture should
show, the picture is wrong.** The moved explanations were not deleted — they live in the Notes view,
and `--verify` still re-derives the facts they assert.

### 5.10 The rest of the standing guards

These are asserted too, and a change that breaks one is a real failure:

- the page is **self-contained**: no `<script src>`, no external `<link>`, **no `http(s)` URL at all**;
- **23 tabs**, every `aria-controls` names an existing panel, every panel is addressed by exactly one
  tab, exactly one tab starts `aria-selected="true"` and exactly one at `tabindex="0"` (roving
  tabindex), the tablist is labelled, the tab strip scrolls in one row and does not wrap, tab hit
  area ≥ 44 px;
- **no meaning is carried by colour alone** — every gate also carries a word and a shape;
- every declared text/background pair meets its threshold — **4.5:1** for text (WCAG 2.2 AA, 1.4.3)
  and **3:1** for control borders, all measured from the palette the page actually ships; the few
  pairs that are decoration (the background grid line, a region fill) are declared with **1.0** and
  say so — `CONTRAST_REQUIREMENTS`, `gen-workflow-map.mjs:655`;
- one declaration of the diagram's text styles feeds **both** the layout arithmetic and the
  stylesheet, and the checker re-reads the emitted CSS and fails if the two disagree — the sheet once
  said 9px for `dg-t-sm` while the boxes were computed at 9.5px, so "every label fits its box" was
  true of a font nobody rendered;
- nothing in any chart falls outside its frame; every element is emitted where its box was reserved;
  every label fits its box at the declared metric.

### 5.11 THE PATTERN — the property asserted must be the one the label claims

When you add an assertion, write the **property** first, in the label, and then make the body measure
*that property*. The failure mode this repository paid for is a check whose label describes one thing
and whose body measures another, and it is not a hypothetical:

- a check labelled **"CONDITIONAL edges are dashed"** counted lane **labels** and never read a dash;
- a check labelled **"MULTI-INPUT is a shape"** compared two derived counts **with each other**;
- a check labelled **"HUMAN DECISION: one amber marker per phase (3)"** asserted a count of 3 where
  the source declares **two** human gates — and the wrong expectation hid behind the truthy-number
  bug in section 6 for a whole round;
- a check that counted runs but **never their endpoints** certified all sixteen edges while three
  were disconnected.

Say what you measure, and measure it. If your label says "dashed", read the class on the emitted
stroke. If it says "one run each", check the endpoints. If it says "the five that read more than one
artifact", derive the five *from the source* and then check **which** nodes carry the border.

---

## 6. ⚠ THE VACUITY TRAP

### A CHECKER THAT CANNOT FAIL IS NOT A CHECK

**Nineteen assertions in this repository were GREEN with the defect present in the chart.** Each was
proven vacuous by a mutation that left the OLD `--verify` at **170/170** and the OLD checker at
**71/0** green over a page that visibly had the defect in it (`857c4de`).

The real cases, so you recognise the species:

1. **A check labelled "CONDITIONAL edges are dashed" that counted lane LABELS and never read a dash.**
   The label promised a rendering property; the body counted strings in the manifest. Draw the two
   conditional edges solid and two required ones dashed, and it stays green.
2. **A check that compared two constants defined in the same file.** It could only fail if the file
   disagreed with itself, which is not the question anyone asked.
3. **A check that asserted a y-coordinate is a number as proof that a fan-in label exists.** It
   proved the layout engine produced arithmetic, not that a label was drawn.
4. **A check that computed `3/3` and compared it with `3/3`.** Both sides derived from the same
   source, so the comparison was a tautology.
5. **A check that counted runs but never their endpoints.** Sixteen runs existed; three of them did
   not reach their targets. This is the one the owner caught by eye.
6. **A checker block written in the generator's dialect but run through the checker's signature.** The
   generator's `check(label, actual, expected)` compares two JSON strings; the checker's
   `check(label, ok, detail)` tests **truthiness** — and `7` is truthy, and so is an **empty array**.
   A block of section 8.13 was written in the wrong dialect and reported **nine passes over a chart
   with faults in every one of them**. The checker now has `checkNoFaults` (`check-workflow-map.mjs:43`)
   precisely for a check whose value is a **list of faults**: it takes the list and decides the
   boolean itself.
7. **`String(match)[1]`**, which indexed the **second character of a stringified array** instead of
   the first capture group — so every run was matched against a label ending in a single letter
   rather than against the label the run owns (`857c4de`). Same failure as the rest: the body was not
   looking at the thing the label names.

### How to prove your own check is not vacuous

Do not reason about it. **Mutate the artifact and watch the check go red.**

1. Add the assertion.
2. Copy the generator or the page (the generator takes `--out`, the checkers take a path — use a
   scratch path; do not overwrite the shipped page).
3. Introduce **the exact defect the label describes** — invert the condition, not the whole file. A
   one-token mutation, so the failure you see is the failure you meant.
4. Confirm the assertion **fails**, and that the failure text names the thing you broke.
5. Revert.

A mutation that only makes the page fail to render proves nothing about the assertion. And if you
cannot construct a mutation that your check catches, you have not written a check.

This is exactly how the TRACE invariant was justified: the mutation that stops a lane run 60 units
short of its own arrival stub is **green** on the old `--verify` and the old checker, and red on
TRACE and NO ORPHAN SEGMENT (`857c4de`). The mutation harness that produced those proofs is
**not part of this repository** — the commit states it is reproducible from `git show HEAD:…` — so
re-derive rather than trusting a script that may not exist. ⚠ If an untracked scratch directory
survives in your working tree with a copy of that harness, treat it as a **convenience, not a
source**: it is not tracked, nothing keeps it honest, and it may be gone. The standing guards are the
arithmetic invariants in the generator and the two checkers.

---

## 7. MEASURE, AND MORE IMPORTANTLY — LOOK

### 7.1 The browser that is already on this machine

A Playwright Chromium build is present at
`%LOCALAPPDATA%\ms-playwright\chromium-1228` (a `chromium_headless_shell-1228` is there too, and
`chromium-1208`). It can be driven **headlessly over CDP** with nothing but Node's built-ins.
**Install nothing. Add no dependency.** This repository deliberately carries no Playwright, no
Puppeteer, and not even `linkedom` — `check-workflow-map.mjs` says so: it uses `linkedom` *when the
repo happens to have it* and otherwise falls back to a dependency-free structural read. Keep it that
way.

What a measurement pass is good for: viewport overflow, text-node overlap counts from DOM Ranges,
whether a chart's wrapper actually reports `scrollWidth === clientWidth` (i.e. it fits rather than
scrolls), the real glyph advance of the monospace font, and screenshots.

### 7.2 ⚠ THREE HARNESS FALSE ALARMS THAT PRODUCED CONFIDENT WRONG NUMBERS

All three were hit in one session (`a3e9fd3`), and all three are the kind of thing that reads as a
clean pass:

1. **It navigated a fresh target but measured the old one.** Every count came back **zero** and every
   check came back **green** — a page with no text nodes and no overlaps satisfies every overlap
   rule. **Fix:** write a unique nonce into the copy you are measuring and hash the copy against the
   file on disk, so the harness proves *which* bytes it measured before it reports a number.
2. **A stale browser held the debug port**, so the new one **exited silently** and the **OLD
   measurement was re-served**. Any number you get is from the previous run, and it looks perfectly
   plausible. **Fix:** use an ephemeral port and **prove it free** before launching; fail loudly if
   the port is busy rather than falling back.
3. **Labels were matched to boxes BY TEXT**, where **eleven nodes share the label "fan-in 1"** — so
   every label-to-box pairing was arbitrary. **Fix:** pair **positionally** (the manifest is emitted
   in a known order) and never match a geometry fact by a string that is not unique.

### 7.3 ⚠ THE ONE RULE THAT MATTERS MOST: TAKE A SCREENSHOT AND READ IT

**Every automated check in this repository has, at some point, been green on a page that was visibly
wrong.** Not once — at **92/92, 129/129, 143/143, 170/170 and 178/178**, all green, on pages a reader
could see were broken. And in **every single case** the defect was found by a human or an agent
**LOOKING at the render**, never by a check:

- the overview that showed five of twelve phases with roughly forty percent of the frame empty —
  166 facts verified (`894b0ea`);
- two lane labels printed through each other — all invariants green;
- three edges connecting nothing, one of them with a 417-unit hole — 170/170 on `--verify`.

The checks are how you keep a defect out *after* you have seen it. They are not how you find it.
Before you declare success: render the page, screenshot it at 1280 and 1440, look at the overview
**and** at the view you changed, and read the picture. If you cannot see the page, say so in your
report rather than claiming a visual result.

### 7.4 The measured numbers, and why they are DATED

The measurement pass that backs the numbers below is **not in the tree** — the harness was throwaway
and untracked, and `--verify` does not re-run it. Treat these as a dated reading, not a standing
check:

- twenty-three tabs' worth of panels un-hidden, measured at **eight widths** — 360, 480, 600, 768,
  820, 1024, 1440, 1920 px;
- **zero text-on-text overlaps** across 5,017–7,365 text nodes per width, in both charts, using text
  **NODE** rects via a DOM Range (so a `<code>` inside a paragraph is not miscounted as an overlap
  with its own parent);
- **no horizontal page overflow at any width** (the page measured 15 px narrower than the viewport,
  from the scrollbar);
- every chart at **scale exactly 1.0000** — a chart scrolls, it is never rescaled by its box;
- the worst label overhang **+0.04 px and 0.00 px**, against a declared metric of 0.602 em while the
  real monospace advance measures **0.5493 em**: the layout reserves more than the glyphs need;
- the two-row overview reports `scrollWidth === clientWidth` at both 1280×900 and 1440×900 — it does
  not scroll sideways at all above 1280.

**Which is exactly why the arithmetic invariants in section 5 are the standing guards.** A measured
number dies with the harness that took it; a `reserve()` throw and a `check()` in `--verify` do not.

---

## 8. WORKED RECIPE

### 8.A Add a FACT to an existing view

1. **Find the source of truth** in `src/**`. If the fact is not in the code, it does not go on the
   page — the page's value is that it is transcribed, not composed. If the fact cannot be checked
   mechanically, it may be rendered but it must be marked as unverified (`<span class="unv">`), as
   the page already does in several places.
2. **Add an anchor** to `ANCHORS` (`gen-workflow-map.mjs:53`) — a unique substring of the line the
   fact rests on. Unique, or declared in `MULTI_HIT_ANCHORS` (`gen-workflow-map.mjs:284`).
3. **Resolve it in `SRC`** (`gen-workflow-map.mjs:362`): `myFact: citeOf('myfact.thing')`.
4. **Render the fact with its citation** in `render()` (`gen-workflow-map.mjs:1697`) or in the
   relevant panel/`phaseDetail` block — `${esc(text)}${cite(SRC.myFact)}`. Always `esc()` anything
   that is not a literal; the escaping checker exists because that is easy to forget.
5. **Add a `check(...)` in `verify()`** (`gen-workflow-map.mjs:4392`) that re-derives the fact from
   `src/**` and compares it with the rendered value. This is the difference between a cited claim and
   a *checked* one.
6. `node scripts/gen-workflow-map.mjs --verify` → then `node scripts/gen-workflow-map.mjs` → then
   `node scripts/check-workflow-map.mjs` → then `node scripts/check-workflow-map-escapes.mjs`.
7. **Screenshot and read it** (section 7.3).
8. `pnpm test`, `pnpm typecheck`, `pnpm build`.

*Which command catches which mistake:* a moved or duplicated anchor → step 6's `--verify`
(`ANCHOR NOT FOUND` / `ANCHOR AMBIGUOUS`). A stale fact in `src/` → step 5's new check. An unescaped
interpolation → the escapes checker. A tab or panel that lost its pair → the structural checker.

### 8.B Add an EDGE to the graph

1. **Get the edge from the code, not from your head.** The edge set is derived from the linter's
   `getPhaseExpectedInputArtifactNames`; `EDGES` (`gen-workflow-map.mjs:1193`) is built from
   `PHASES[].inputs`, and `--verify` re-derives the whole set. If your edge is not in the source, the
   answer is "the edge does not exist", not "add it to the chart".
2. **Let the layout place it.** Add the routing in `drawOverview()` (`gen-workflow-map.mjs:3322`)
   using the engine's primitives only — `reserve`, `card`, `textEl`, `ruleH`, `ruleV`, `head`. No
   literal coordinates that nothing reserves.
3. **Expect arithmetic to refuse you.** The grid is two rows of six; the row boundary must carry
   exactly one *spine* edge and six inside the rows (`gen-workflow-map.mjs:3434`). If your edge
   breaks that, the throw will tell you — and the answer may be that the *layout* must change (that
   is what the six/six serpentine is: the only split in which the wrap can be drawn as one vertical
   arrow).
4. **Check the readability budgets, not just the collisions:** the new run needs `LAND_MARGIN` from
   the box it lands on, `PROXIMITY_MIN` from every box it does not attach to, `CHANNEL_MIN` from any
   parallel stroke of a different edge, and its nearest label must name its own destination.
5. **Make sure the run traces end to end** — one continuous polyline from source to target, ending in
   an ink arrowhead on the target. TRACE will tell you if it does not.
6. **Mind the budgets:** the chart is 1128 units wide against a 1130 budget and 740 tall against 780.
   An edge that needs more room needs a layout change, not a wider frame.
7. Re-run the four commands, then **screenshot and read the render** — a connected edge can still be
   unreadable. Then the three repo gates.

### 8.C Add a whole VIEW (tab)

1. Add the entry to the `tabs` array (`gen-workflow-map.mjs:1712`) and a matching
   `<section class="panel" id="panel-<id>" role="tabpanel" aria-labelledby="tab-<id>" tabindex="0" hidden>`.
   **The id must match the tab's `aria-controls`**, and the first tab must stay the overview — the
   reader must land on the graph.
2. Update every place that enumerates the views: `--verify` asserts the tab count is
   `1 overview + 1 graph + 12 phases + 1 learning loop + 8 other views` (`gen-workflow-map.mjs:5337`),
   and the structural checker asserts 23 as well. **The count is asserted in two files that do not
   import from each other** — deliberately, so they agree by measuring the same page rather than by
   sharing a mistake. Change both, and change the arithmetic in each label.
3. Add the panel's facts with anchors and citations (8.A), and a `check(...)` per fact.
4. Remember: anything that was *prose* the picture should have shown is a design smell (section 5.9).

### 8.D Add or change an INVARIANT

An invariant belongs in **both** places, and they must not import from each other:

- the **generator**, as a named constant near the code that depends on it
  — `OVERVIEW_LIMITS` (`gen-workflow-map.mjs:4136`), `READABILITY` (`gen-workflow-map.mjs:4169`) —
  plus a `check(...)` in `verify()` that measures the emitted manifest;
- the **structural checker**, as its own copy — `READ` at `check-workflow-map.mjs:562` and
  `OV_LIMITS` at `check-workflow-map.mjs:861` — re-derived from the written file.

Then **prove it can fail** (section 6): mutate the artifact, watch it go red, revert.

---

## 9. WHAT IS NOT COVERED

State these to whoever asked for the change, rather than letting a green run imply more than it
proves.

1. **The page maps CODE, not run outcomes.** Every claim is sourced to a declaration in `src/**`.
   Nothing on the page is evidence that any particular run behaved that way.
2. **No live run was ever exercised for this page.** No recursive-mode run was driven to produce or
   validate any part of it. The workflow is described as the code defines it.
3. **Keyboard and screen-reader behaviour is asserted STRUCTURALLY, not experienced.** The roving
   tabindex, `aria-controls`/`aria-labelledby` pairing, the labelled tablist, the ≥ 44 px hit area and
   the skip link are all checked as markup. **No assistive technology has ever run against this
   page.**
4. **Chromium only.** Every browser measurement was taken in headless Chromium. Nothing was verified
   in Firefox, WebKit or Safari.
5. **The measurement harnesses were throwaway and are not in the tree.** The numbers in section 7.4
   are a **dated reading**. `--verify` does not re-run them and cannot. The standing guards are the
   arithmetic invariants in the generator and the checkers.
6. **The checkers are not part of `pnpm test`.** Nothing invokes them automatically. A green suite is
   not a green page.
7. **The page is not shipped.** `workflow-map/` is deliberately absent from `package.json`'s `files`
   list, so the map does not travel inside the plugin. Do not "fix" that by adding it.
8. **Four diagram defects were found by reading a render, not by a check** — and the class of defect
   the engine structurally *cannot* see (an orphan stroke, a hole in a line) is covered only by the
   TRACE and orphan invariants added afterwards. A new *class* of visual defect will again be found by
   looking, not by the existing checks.

---

## 10. This document is guarded

`tests/docs-contract.spec.ts` asserts that this file exists and names the three commands
(`node scripts/gen-workflow-map.mjs --verify`, `node scripts/check-workflow-map.mjs`,
`node scripts/check-workflow-map-escapes.mjs`), and that each of those scripts is a real file.

So: if you **rename or delete this document**, or **rename the scripts**, the suite fails and points
here. Update the document and that assertion together. The assertion is additive and does not read
this file's prose — section 0's byte counts and the tab count above are documentation, not a
contract, and nothing fails if they drift. Keep them honest by hand when you touch the page.

**It is a small guard on purpose, and its limit is worth knowing.** It proves that this document
exists and that the toolchain is named in it; it does **not** prove the prose is true, and it does not
run the generator or either checker. Adding *those* to the suite would be a different and much larger
change than this task's — the checkers are standalone scripts that read a 352 KiB artifact, they were
deliberately kept out of `pnpm test`, and making the suite own them is the maintainers' call, not this
document's.

*Provenance note.* The historical claims in this document — what the owner said, what each round
changed, the counts at 92/129/143/170/178 — are taken from this repository's own record: the four
commits that built the page (`29ba011`, `a3e9fd3`, `894b0ea`, `857c4de`) and the comment blocks in
`gen-workflow-map.mjs` and the two checkers. The **current** numbers, printed properties and command
behaviour were re-derived by running the tools. Nothing here is remembered from outside the tree, and
nothing here is invented to fill a gap.
