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
}

/** Inline segment parsed from line text (bold / code span / link). */
export interface InlineSegment {
  type: 'text' | 'bold' | 'code' | 'link';
  text: string;
  href?: string;
}

/**
 * Markdown -> line tokens. Base is parsePlan (blank/h1-h4/li/plain, MIT),
 * extended for fenced code blocks (one code line per block) and pipe tables
 * (one table line per block, header separator row dropped).
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
    // list item
    const li = /^\s*[-*]\s+(.+)$/.exec(line);
    if (li) { out.push({ kind: 'li', text: li[1] }); i += 1; continue; }
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
 * Render one parsed line as a React element. Headings/bullets get parsePlan
 * sizing; code/table get block layout; inline markup applies to plain-ish text.
 */
function lineElement(line: DocLine, i: number, isCurrent: boolean): ReactNode {
  const cls = 'rec-doc-line rec-doc-' + line.kind + (isCurrent ? ' rec-doc-line-current' : '');
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
  if (line.kind === 'li') return createElement('div', { key: i, 'data-line': String(i), className: cls }, createElement('span', { className: 'rec-doc-bullet' }, '•'), createElement('span', { className: 'rec-doc-li-text' }, nodes));
  return createElement('div', { key: i, 'data-line': String(i), className: cls }, nodes);
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

  const matchSet = new Set(matches);
  const activeLine = matches.length > 0 ? matches[activeMatch] : -1;

  const lineEls = docLines.map((line, i) => lineElement(line, i, i === cursor));

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
      text !== null ? lineEls : null,
    ),
    createElement('footer', { className: 'rec-doc-footer' },
      createElement('div', { className: statusCls, role: 'status' }, statusText),
      createElement('div', { className: 'rec-doc-hints' }, SEARCH_HINTS.map((h, n) => createElement('span', { key: 'hint-' + String(n) }, createElement('kbd', null, h[0]), ' ' + h[1] + (n < SEARCH_HINTS.length - 1 ? ' |' : '')))),
    ),
  );
}
