/**
 * Per-phase run-doc viewer (0.2.4): renders one .recursive/run/<runId>/<file>
 * markdown doc read LAZILY via the host GET /.recursive/api/doc route, inside
 * the Inspector run-detail panel. Read-only: NO approve / changes / comment /
 * quit actions, NO session-answer writes, NO recursive/* session events.
 *
 * ATTRIBUTION — ported from @guillaumemeyer/dsh-plan-approval (MIT),
 * https://github.com/guillaumemeyer/dsh-plan-approval:
 *   - the markdown line parser (parseDoc, based on parsePlan), and
 *   - the vim-nav + / search key handling (onKey/move/goTop/goBottom/
 *     computeMatches/searchNext/searchPrev/openSearch/closeSearch).
 * Reused under MIT. NO planReviewOf / overlay / session-question logic is
 * carried over — this viewer reads run artifacts.
 */
import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { fetchPhaseDoc } from './host-api.ts'
import type { BoardTheme } from './theme.ts'

/* ============================ parser (pure) ============================ */

/** One rendered markdown line (parsePlan base + fenced code + tables). */
export interface DocLine {
  kind: 'blank' | 'h1' | 'h2' | 'h3' | 'h4' | 'li' | 'plain' | 'code' | 'table';
  text: string;
  /** table: data rows (header separator row dropped); first row is the header. */
  cells?: string[][];
  /**
   * li: the item WAS a `- [ ]` / `- [x]` task box, and whether it was ticked.
   *
   * ⚠ THIS IS A FIELD ON `li`, NOT A NEW KIND, ON PURPOSE. A task box is a list item — it keeps the bullet
   * layout, the line index and the search behaviour every existing `li` has — and the ONE thing the reader
   * must be able to see that a plain string cannot carry is the BOX ITSELF. The scaffolded Phase 0 template
   * ships seven unticked boxes, so "is this still the template?" is partly a question about these marks.
   *
   * ⚠ AND THE BOX IS NOT LEFT IN `text`. `text` is the item's CONTENT, exactly the shape the base parser
   * already produces for a plain bullet, so `search`/`copy` and every other consumer of a line's text see the
   * words rather than the syntax. The tick survives as this field, and the renderer draws the mark back.
   */
  checked?: boolean;
  /**
   * plain: this line is a `Coverage:` / `Approval:` GATE reading, and how it reads.
   *
   * Same reasoning as `checked`: a gate line is a line of text, so it stays `plain` and gains the one fact
   * the renderer cannot re-derive — whether it currently says PASS or FAIL, which is exactly what a person
   * must be able to see before approving the document that contains it.
   */
  gate?: 'pass' | 'fail';
}

/** Inline segment parsed from line text (bold / code span / link). */
export interface InlineSegment {
  type: 'text' | 'bold' | 'code' | 'link';
  text: string;
  href?: string;
}

/**
 * A list item: the text AFTER its marker. The marker is consumed here exactly as the base parser consumed
 * it — `text` is the item's CONTENT, and the renderer draws the `- ` / box back from `kind` + `checked`.
 */
const BULLET_RE = /^\s*[-*]\s+(.+)$/;

/**
 * A task box (`[ ]`, `[x]`, `[X]`) at the front of a list item, split into its tick and the rest of the item.
 *
 * The tick is the one fact a reader of the document cannot recover from the text alone once the box has been
 * recognised, so it travels as `checked`; everything after it is the item's content, as for any other bullet.
 */
const TASK_BOX_RE = /^\[([ xX])\]\s*(.*)$/;

/** A gate reading: `Coverage: FAIL` / `Approval: PASS`, as `run-spec.ts` reads the same lines. */
const GATE_RE = /^\s*(?:Coverage|Approval)\s*:\s*(PASS|FAIL)\s*$/i;

/**
 * Markdown -> line tokens. Base is parsePlan (blank/h1-h4/li/plain, MIT),
 * extended for fenced code blocks (one code line per block) and pipe tables
 * (one table line per block, header separator row dropped).
 *
 * AND EXTENDED FOR WHAT THE RUN ARTIFACTS ACTUALLY CONTAIN — the task boxes and gate readings the
 * scaffolded `00-requirements.md` ships (`- [ ] …`, `Coverage: FAIL`, `Approval: FAIL`), because a preview
 * that renders an unticked box and a FAIL gate as generic body text hides the two marks a person who is
 * being asked to approve the document most needs to see. Both are additive FIELDS on the existing `li` and
 * `plain` kinds, so no line is retyped, no character is dropped, and every existing caller keeps working.
 */
export function parseDoc(plan: string): DocLine[] {
  const raw = String(plan == null ? '' : plan).split('\n');
  const out: DocLine[] = [];
  let i = 0;
  while (i < raw.length) {
    const line = raw[i];
    // blank
    if (/^\s*$/.test(line)) { out.push({ kind: 'blank', text: '' }); i += 1; continue; }
    // fenced code block: group until the closing fence
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < raw.length && !/^```\s*$/.test(raw[i])) { code.push(raw[i]); i += 1; }
      i += 1; // consume closing fence (or end of input)
      out.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    // pipe table: group consecutive | rows, drop the |-| separator row
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      while (i < raw.length && /^\s*\|/.test(raw[i])) {
        const parts = raw[i].split('|').slice(1, -1).map((c) => c.trim());
        rows.push(parts);
        i += 1;
      }
      const data = rows.filter((r) => !r.every((c) => /^:?-{3,}:?$/.test(c)));
      out.push({ kind: 'table', text: rows.map((r) => r.join(' | ')).join('\n'), cells: data });
      continue;
    }
    // headings
    const h = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (h) {
      let kind: DocLine['kind'];
      switch (h[1].length) {
        case 1: kind = 'h1'; break;
        case 2: kind = 'h2'; break;
        case 3: kind = 'h3'; break;
        default: kind = 'h4';
      }
      out.push({ kind, text: h[2] });
      i += 1;
      continue;
    }
    // list item — a task box is CLASSIFIED (its tick kept as `checked`) and its text is the item's CONTENT,
    // which is the shape the base parser already produces for a bullet. The marker and the box are DRAWN by
    // the renderer from `kind` + `checked`, so no line is retyped and the reader still sees `- [ ] item`.
    const item = BULLET_RE.exec(line);
    if (item) {
      const box = TASK_BOX_RE.exec(item[1]);
      out.push(box === null
        ? { kind: 'li', text: item[1] }
        : { kind: 'li', text: box[2], checked: box[1] !== ' ' });
      i += 1;
      continue;
    }
    // gate reading: `Coverage: FAIL` / `Approval: PASS`
    const gate = GATE_RE.exec(line);
    if (gate) { out.push({ kind: 'plain', text: line, gate: gate[1].toUpperCase() === 'FAIL' ? 'fail' : 'pass' }); i += 1; continue; }
    out.push({ kind: 'plain', text: line });
    i += 1;
  }
  return out;
}

/**
 * Inline scanner: **bold**, `code`, [text](url); unmatched markers stay plain
 * text. Used to build the React children of a line text.
 */
export function parseInline(text: string): InlineSegment[] {
  const out: InlineSegment[] = [];
  const re = /(\*\*(.+?)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ type: 'bold', text: m[2] });
    if (m[3] !== undefined) out.push({ type: 'code', text: m[4] });
    if (m[5] !== undefined) out.push({ type: 'link', text: m[6], href: m[7] });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

/* ============================ component ============================ */

export interface DocViewerProps {
  runId: string;
  worktreeRoot: string;
  fileName: string;
  theme: BoardTheme;
  onClose: () => void;
}

const SEARCH_HINTS: Array<[string, string]> = [
  ['j/k', 'move'], ['gg/G', 'ends'], ['/', 'search'], ['n/N', 'next/prev'], ['y', 'copy'], ['Esc', 'close'],
];

/** Inline segments -> ReactNodes (bold/code/link markup). */
function inlineNodes(segments: InlineSegment[], baseKey: string): ReactNode[] {
  return segments.map((seg, n) => {
    const key = baseKey + '-seg-' + String(n);
    if (seg.type === 'bold') return createElement('strong', { key }, seg.text);
    if (seg.type === 'code') return createElement('code', { key, className: 'rec-doc-inline-code' }, seg.text);
    if (seg.type === 'link') return createElement('a', { key, href: seg.href, target: '_blank', rel: 'noreferrer', className: 'rec-doc-inline-link' }, seg.text);
    return createElement('span', { key }, seg.text);
  });
}

/**
 * The mark of a task box.
 *
 * ⚠ THE MARK REPLACES `[ ]` / `[x]` IN PLACE, GLYPH FOR GLYPH. The parser hands over the item's content
 * without the box, so what the reader sees is `- [ ] item` where the document says `- [x] item`: same line,
 * same position, same length of reading — and the box is still legible as a box rather than as an assertion
 * about the item.
 *
 * ⚠ AND THE TICK IS CARRIED TWICE — once as that glyph for the eye and once as text, visually hidden, for the
 * ear — because the two bracket forms are read inconsistently by screen readers, and the whole point of the
 * mark is that "this box is not ticked" survives every way of reading it. This span carries NO separator of
 * its own: the item's text follows it directly, separated by the leading space on that text (see
 * `lineElement`), so that neither side of the boundary has a trailing space to lose.
 */
function todoMark(line: DocLine, key: string): ReactNode {
  const done = line.checked === true;
  const cls = 'rec-doc-todo-check' + (done ? ' rec-doc-todo-check-on' : ' rec-doc-todo-check-off');
  return createElement('span', { key, className: cls, title: done ? 'done' : 'not done' },
    createElement('span', { 'aria-hidden': 'true' }, done ? '[x]' : '[ ]'),
    createElement('span', { className: 'rec-doc-sr' }, done ? 'done:' : 'not done:'),
  );
}

/**
 * Render one parsed line as a React element. Headings/bullets get parsePlan
 * sizing; code/table get block layout; inline markup applies to plain-ish text.
 *
 * ⚠ ONE RENDERER, TWO READERS. `DocViewer` and the run-start spec sheet's preview both come through here,
 * so a mark that means "unticked box" or "gate reads FAIL" cannot mean one thing in the phase-doc viewer and
 * another in the document a person is approving. Exported for that reason alone.
 */
export function lineElement(line: DocLine, i: number, isCurrent = false): ReactNode {
  const cls = 'rec-doc-line rec-doc-' + line.kind + (isCurrent ? ' rec-doc-line-current' : '');
  const gateCls = line.gate === undefined ? '' : ' rec-doc-gate rec-doc-gate-' + line.gate;
  const todoCls = line.checked === undefined ? '' : ' rec-doc-todo' + (line.checked ? ' rec-doc-todo-done' : ' rec-doc-todo-open');
  if (line.kind === 'blank') return createElement('div', { key: i, 'data-line': String(i), className: cls }, null);
  if (line.kind === 'code') return createElement('pre', { key: i, 'data-line': String(i), className: cls + ' rec-doc-pre' }, createElement('code', { className: 'rec-doc-code' }, line.text));
  if (line.kind === 'table') {
    const all = line.cells ?? [];
    const header = all[0] ?? [];
    const body = all.slice(1);
    return createElement('div', { key: i, 'data-line': String(i), className: cls },
      createElement('table', { className: 'rec-doc-table' },
        createElement('thead', null, createElement('tr', null, header.map((c, n) => createElement('th', { key: 'th-' + String(n) }, c)))),
        createElement('tbody', null, body.map((r, n) => createElement('tr', { key: 'tr-' + String(n) }, r.map((c, m) => createElement('td', { key: 'td-' + String(m) }, c))))),
      ),
    );
  }
  const nodes = inlineNodes(parseInline(line.text), String(i));
  // ⚠ THE PREVIEW LINE IS THE DOCUMENT'S OWN LINE. The parser keeps list content MARKER-FREE (the base
  // parser's shape), so the renderer puts the marker back: `- ` for a bullet, and a drawn box IN PLACE OF
  // the `[ ]` / `[x]` for a task box. That is what lets a reader check the preview against the source and
  // see at a glance that an unticked box is unticked.
  //
  // ⚠ AND THE SEPARATOR IS A NON-BREAKING SPACE WRITTEN AS AN ESCAPE, ON THE ITEM'S SIDE OF THE MARK.
  // Measured, twice: a text node that ENDS in a space loses it (so a `'- '` bullet glyph renders as `-`,
  // and a minifier carries that through to the shipped bundle, turning every bullet into `-item`), and a
  // plain leading space is normalised away by the JSX transform before React ever sees it. An ESCAPED
  // non-breaking space is neither trailing nor transformable, so it is what these separators are.
  const SPACER = '\u00A0';
  if (line.kind === 'li' && line.checked !== undefined) {
    return createElement('div', { key: i, 'data-line': String(i), className: cls + todoCls },
      createElement('span', { className: 'rec-doc-bullet' }, '-'),
      todoMark(line, 'todo-' + String(i)),
      createElement('span', { className: 'rec-doc-li-text' }, SPACER, nodes));
  }
  if (line.kind === 'li') return createElement('div', { key: i, 'data-line': String(i), className: cls }, createElement('span', { className: 'rec-doc-bullet' }, '-'), createElement('span', { className: 'rec-doc-li-text' }, SPACER, nodes));
  return createElement('div', { key: i, 'data-line': String(i), className: cls + gateCls }, nodes);
}

/**
 * The parsed lines as elements — the preview built from `parseDoc` + `lineElement`, with no shell of its own.
 *
 * ⚠ THIS IS WHAT MAKES A SECOND RENDERER UNNECESSARY. Any surface that wants to show a run artifact as a
 * PREVIEW (the phase-doc viewer's body, the run-start spec sheet's document body) renders these nodes inside
 * whatever frame it owns, so the markdown is parsed and drawn exactly once in the plugin. `keyBase` namespaces
 * the React keys when several of these are on screen at once; `current` is the vim cursor line, which the
 * spec sheet never sets.
 */
export function PreviewLines({ lines, keyBase = 'doc', current = -1 }: { lines: DocLine[]; keyBase?: string; current?: number }): ReactNode {
  return createElement('div', { className: 'rec-doc-lines', 'data-preview-lines': String(lines.length) },
    ...lines.map((line, i) => createElement(
      'div',
      { key: keyBase + '-line-' + String(i), className: 'rec-doc-line-wrap' },
      lineElement(line, i, i === current),
    )));
}

/**
 * The per-phase doc viewer. Fetches the route on mount / fileName change.
 * Vim nav + / search + n/N + Esc; y copies the doc. Esc closes search first,
 * else the viewer. data-theme is passed down by the hoisting Inspector
 * (0.1.10 invariant: useBoardTheme lives in the panel).
 */
export function DocViewer({ runId, worktreeRoot, fileName, theme, onClose }: DocViewerProps): ReactNode {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<number[]>([]);
  const [activeMatch, setActiveMatch] = useState(0);
  const ggArmed = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let disposed = false;
    setText(null); setError(null); setNotice(null); setCopied(false); setCursor(0);
    fetchPhaseDoc({ root: worktreeRoot, runId, file: fileName })
      .then((t) => { if (!disposed) { setText(t); setCopied(false); } })
      .catch(() => { if (!disposed) setError('Failed to load doc'); });
    return () => { disposed = true; };
  }, [worktreeRoot, runId, fileName]);

  const docLines = useMemo(() => (text === null ? [] : parseDoc(text)), [text]);

  const move = (delta: number) => {
    if (docLines.length === 0) return;
    setCursor((c) => Math.max(0, Math.min(docLines.length - 1, c + delta)));
  };
  const goTop = () => setCursor(0);
  const goBottom = () => setCursor(Math.max(0, docLines.length - 1));
  const computeMatches = (q: string) => {
    if (!q) return [];
    const needle = q.toLowerCase();
    const found: number[] = [];
    for (let i = 0; i < docLines.length; i++) {
      if (docLines[i].text.toLowerCase().indexOf(needle) >= 0) found.push(i);
    }
    return found;
  };
  const openSearch = () => { setSearchOpen(true); setError(null); setNotice(null); };
  const closeSearch = () => { setSearchOpen(false); setQuery(''); setMatches([]); setActiveMatch(0); if (rootRef.current) rootRef.current.focus(); };
  const onSearchChange = (e: { target: { value: string } }) => {
    const q = e.target.value;
    setQuery(q);
    setMatches(computeMatches(q));
    setActiveMatch(0);
  };
  const searchNext = () => {
    if (matches.length === 0) return;
    const next = (activeMatch + 1) % matches.length;
    setActiveMatch(next);
    setCursor(matches[next]);
  };
  const searchPrev = () => {
    if (matches.length === 0) return;
    const prev = (activeMatch - 1 + matches.length) % matches.length;
    setActiveMatch(prev);
    setCursor(matches[prev]);
  };
  const onSearchKey = (e: { key: string; shiftKey: boolean; preventDefault: () => void }) => {
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); searchPrev(); }
    else if (e.key === 'Enter') { e.preventDefault(); searchNext(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
  };

  const copyDoc = () => {
    // SAFETY: node/SSR has no clipboard object; the guarded shape matches lib.dom's
    // Navigator.clipboard and falls back to an error status when absent.
    const clip = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } }).navigator?.clipboard;
    if (clip === undefined || clip.writeText === undefined) { setError('Copy unavailable'); setNotice(null); return; }
    if (clip && clip.writeText) {
      const data = text ?? '';
      clip.writeText(data).then(() => { setNotice('Doc copied'); setError(null); setCopied(true); }).catch(() => { setError('Copy failed'); setNotice(null); });
    } else { setError('Copy unavailable'); setNotice(null); }
  };

  const onKey = (e: { key: string; preventDefault: () => void; target?: { tagName?: string } | null }) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const rawKey = e.key || '';
    const key = rawKey.toLowerCase();
    if (rawKey === 'G') { e.preventDefault(); ggArmed.current = false; goBottom(); return; }
    if (rawKey === 'N') { e.preventDefault(); ggArmed.current = false; searchPrev(); return; }
    if (key === 'g') {
      e.preventDefault();
      if (ggArmed.current) { ggArmed.current = false; goTop(); }
      else ggArmed.current = true;
      return;
    }
    ggArmed.current = false;
    if (key === 'j') { e.preventDefault(); move(1); }
    else if (key === 'k') { e.preventDefault(); move(-1); }
    else if (key === '/') { e.preventDefault(); openSearch(); }
    else if (key === 'n') { e.preventDefault(); searchNext(); }
    else if (key === 'y') { e.preventDefault(); copyDoc(); }
    else if (key === 'escape') {
      e.preventDefault();
      if (searchOpen) closeSearch();
      else onClose();
    }
  };

  // NOTE: `n`/`N` move the cursor to the matching line, which is marked `rec-doc-line-current` by
  // `PreviewLines` below. The lines themselves are NOT individually match-highlighted — they were not
  // before this file gained a shared preview renderer either, and inventing a highlight here would change
  // how the phase-doc viewer draws a document as a side effect of the run-start spec sheet's work.
  const searchBar = searchOpen ? createElement('div', { className: 'rec-doc-search' },
    createElement('input', { className: 'rec-doc-search-input', value: query, placeholder: '/ search doc…', onChange: onSearchChange, onKeyDown: onSearchKey }),
    createElement('span', { className: 'rec-doc-search-count' }, matches.length > 0 ? (activeMatch + 1) + '/' + matches.length : (query ? '0' : '')),
  ) : null;

  const statusText = error || notice || (docLines.length + ' lines');
  const statusCls = 'rec-doc-status' + (error ? ' rec-doc-status-error' : notice ? ' rec-doc-status-ok' : '');

  return createElement('div', { className: 'rec-doc', 'data-theme': theme, onKeyDown: onKey, ref: rootRef, tabIndex: -1 },
    createElement('header', { className: 'rec-doc-header' },
      createElement('div', { className: 'rec-doc-heading' },
        createElement('span', { className: 'rec-doc-badge' }, 'Phase doc'),
        createElement('h2', { className: 'rec-doc-title' }, fileName),
        createElement('span', { className: 'rec-doc-run' }, runId),
      ),
      createElement('button', { type: 'button', className: 'rec-doc-btn rec-doc-copy', onClick: copyDoc, title: 'Copy doc', 'aria-label': 'Copy doc' }, 'Copy doc'),
      createElement('button', { type: 'button', className: 'rec-doc-btn rec-doc-close', onClick: onClose, title: 'Close', 'aria-label': 'Close' }, 'Close'),
    ),
    searchBar,
    createElement('div', { className: 'rec-doc-body' },
      text === null && error === null ? createElement('p', { className: 'rec-doc-text' }, 'Loading doc…') : null,
      error !== null ? createElement('p', { className: 'rec-doc-text rec-doc-error' }, error) : null,
      text !== null ? createElement(PreviewLines, { lines: docLines, keyBase: 'doc', current: cursor }) : null,
    ),
    createElement('footer', { className: 'rec-doc-footer' },
      createElement('div', { className: statusCls, role: 'status' }, statusText),
      createElement('div', { className: 'rec-doc-hints' }, SEARCH_HINTS.map((h, n) => createElement('span', { key: 'hint-' + String(n) }, createElement('kbd', null, h[0]), ' ' + h[1] + (n < SEARCH_HINTS.length - 1 ? ' |' : '')))),
    ),
  );
}
