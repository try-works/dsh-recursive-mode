/**
 * One-shot board/inspector stylesheet injection (run 15 + run 16 / Paper).
 * The client bundle is a plain CJS closure with NO CSS pipeline (tsdown), so we
 * inject a single <style data-dsh-recursive> element into document.head.
 *
 * Run 16 (Paper): the design is ported 1:1 — DEFAULT LIGHT theme, dark via a
 * data-theme attribute on the .rec-board / .rec-inspector root. Raw --rm3-*
 * tokens live on the scoped roots; semantic --board-* aliases remap under
 * [data-theme='dark']. EVERY component rule consumes ONLY --board-* aliases
 * (never --rm3-* directly). Idempotent injection; disposer removes the element.
 */

const BOARD_CSS = `
/* ===== dsh-recursive Paper theme (run 16) ===== */

/* Raw tokens: light (default) + dark + shared, scoped to the board/inspector. */
.rec-board, .rec-inspector {
  /* light */
  --rm3-light-background: #FFFFFF;
  --rm3-light-foreground: #111111;
  --rm3-light-card: #FFFFFF;
  --rm3-light-muted: #FAFAFA;
  --rm3-light-muted-foreground: #666666;
  --rm3-light-accent: #F5F5F5;
  --rm3-light-border: #EAEAEA;
  --rm3-light-success: #27A644;
  --rm3-light-warning: #B67A11;
  --rm3-light-error: #D84F6A;
  --rm3-light-advisory: #9664E8;
  --rm3-light-info: #3F87F5;
  --rm3-light-destructive: #B4261A;
  /* dark */
  --rm3-background: #0A0A0A;
  --rm3-foreground: #EDEDED;
  --rm3-card: #0F0F0F;
  --rm3-muted: #141414;
  --rm3-muted-foreground: #9A9A9A;
  --rm3-accent: #1A1A1A;
  --rm3-border: #1F1F1F;
  --rm3-success: #27A644;
  --rm3-warning: #D9A441;
  --rm3-error: #E06C89;
  --rm3-advisory: #B479FF;
  --rm3-info: #6EA8FF;
  /* shared */
  --rm3-font-sans: 'Geist', ui-sans-serif, system-ui, sans-serif;
  --rm3-font-mono: 'Geist Mono', ui-monospace, Menlo, monospace;
  --rm3-text-xs: 12px;
  --rm3-text-sm: 14px;
  --rm3-text-md: 16px;
  --rm3-text-lg: 20px;
  --rm3-text-xl: 28px;
  --rm3-font-weight-regular: 400;
  --rm3-font-weight-medium: 500;
  --rm3-font-weight-semibold: 600;
  --rm3-radius-sm: 5px;
  --rm3-radius-md: 6px;
  --rm3-radius-lg: 8px;
  --rm3-radius-xl: 11px;
  --rm3-space-8: 8px;
  --rm3-space-12: 12px;
  --rm3-space-16: 16px;
  --rm3-space-24: 24px;
  --rm3-space-32: 32px;
  --rm3-tracking-tight: -0.02em;
  --rm3-tracking-mono: 0.02em;

  /* Semantic aliases (LIGHT default) */
  --board-bg: var(--rm3-light-background);
  --board-fg: var(--rm3-light-foreground);
  --board-card: var(--rm3-light-card);
  --board-muted: var(--rm3-light-muted);
  --board-muted-fg: var(--rm3-light-muted-foreground);
  --board-accent: var(--rm3-light-accent);
  --board-border: var(--rm3-light-border);
  --board-success: var(--rm3-light-success);
  --board-warning: var(--rm3-light-warning);
  --board-error: var(--rm3-light-error);
  --board-advisory: var(--rm3-light-advisory);
  --board-info: var(--rm3-light-info);
  --board-destructive: var(--rm3-light-destructive);
  --board-font-sans: var(--rm3-font-sans);
  --board-font-mono: var(--rm3-font-mono);
  --board-text-xs: var(--rm3-text-xs);
  --board-text-sm: var(--rm3-text-sm);
  --board-text-md: var(--rm3-text-md);
  --board-text-lg: var(--rm3-text-lg);
  --board-text-xl: var(--rm3-text-xl);
  --board-fw-regular: var(--rm3-font-weight-regular);
  --board-fw-medium: var(--rm3-font-weight-medium);
  --board-fw-semibold: var(--rm3-font-weight-semibold);
  --board-radius-sm: var(--rm3-radius-sm);
  --board-radius-md: var(--rm3-radius-md);
  --board-radius-lg: var(--rm3-radius-lg);
  --board-radius-xl: var(--rm3-radius-xl);
  --board-space-8: var(--rm3-space-8);
  --board-space-12: var(--rm3-space-12);
  --board-space-16: var(--rm3-space-16);
  --board-space-24: var(--rm3-space-24);
  --board-space-32: var(--rm3-space-32);
  --board-tracking-tight: var(--rm3-tracking-tight);
  --board-tracking-mono: var(--rm3-tracking-mono);
}

/* Semantic aliases remapped for DARK. */
.rec-board[data-theme='dark'], .rec-inspector[data-theme='dark'] {
  --board-bg: var(--rm3-background);
  --board-fg: var(--rm3-foreground);
  --board-card: var(--rm3-card);
  --board-muted: var(--rm3-muted);
  --board-muted-fg: var(--rm3-muted-foreground);
  --board-accent: var(--rm3-accent);
  --board-border: var(--rm3-border);
  --board-success: var(--rm3-success);
  --board-warning: var(--rm3-warning);
  --board-error: var(--rm3-error);
  --board-advisory: var(--rm3-advisory);
  --board-info: var(--rm3-info);
  --board-destructive: var(--rm3-error);
}

/* ===== Board ===== */
.rec-board {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: var(--board-space-16);
  gap: var(--board-space-12);
  background: var(--board-bg);
  color: var(--board-fg);
  font-family: var(--board-font-sans);
  pointer-events: auto;
  overflow: hidden;
}

/* Inline board (conversation.view tab): fills its parent view area, not fixed. */
.rec-board-view {
  position: relative;
  inset: auto;
  z-index: auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  flex: 1;
}

.rec-board-header {
  display: flex;
  align-items: center;
  gap: var(--board-space-12);
  flex: none;
}

.rec-board-title {
  margin: 0;
  font-size: 22px;
  font-weight: var(--board-fw-semibold);
  letter-spacing: var(--board-tracking-tight);
  color: var(--board-fg);
  white-space: nowrap;
}

.rec-board-path {
  flex: none;
  font-family: var(--board-font-mono);
  font-size: var(--board-text-xs);
  letter-spacing: var(--board-tracking-mono);
  color: var(--board-muted-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40%;
}

.rec-board-count {
  flex: none;
  font-size: var(--board-text-xs);
  font-weight: var(--board-fw-medium);
  color: var(--board-muted-fg);
  background: var(--board-muted);
  border-radius: 9999px;
  padding: 4px 10px;
}

.rec-board-empty {
  margin: 0;
  padding: var(--board-space-32);
  text-align: center;
  color: var(--board-muted-fg);
}

.rec-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  margin-left: auto;
  flex: none;
  background: transparent;
  border: 1px solid var(--board-border);
  border-radius: var(--board-radius-md);
  color: var(--board-muted-fg);
  cursor: pointer;
  font-size: var(--board-text-md);
  line-height: 1;
}

.rec-close:hover {
  background: var(--board-accent);
  color: var(--board-fg);
}

.rec-theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  flex: none;
  background: transparent;
  border: 1px solid var(--board-border);
  border-radius: var(--board-radius-md);
  color: var(--board-muted-fg);
  cursor: pointer;
  font-size: var(--board-text-md);
  line-height: 1;
}

.rec-theme-toggle:hover {
  background: var(--board-accent);
  color: var(--board-fg);
}

.rec-columns {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(220px, 1fr);
  gap: var(--board-space-12);
  flex: 1;
  min-height: 0;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-inline: contain;
  padding-bottom: 6px;
  scrollbar-color: var(--board-border) var(--board-accent);
  scrollbar-width: thin;
}

.rec-columns::-webkit-scrollbar { height: 10px; }
.rec-columns::-webkit-scrollbar-track { background: var(--board-accent); border-radius: 999px; }
.rec-columns::-webkit-scrollbar-thumb { background: var(--board-border); border-radius: 999px; }

.rec-column {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--board-muted);
  border: 1px solid var(--board-border);
  border-radius: var(--board-radius-xl);
  overflow: hidden;
}

.rec-column-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: var(--board-space-12);
  flex: none;
}

.rec-column-title {
  margin: 0;
  flex: 1;
  font-size: 13px;
  font-weight: var(--board-fw-semibold);
  color: var(--board-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rec-column-count {
  flex: none;
  font-size: var(--board-text-xs);
  font-weight: var(--board-fw-medium);
  color: var(--board-muted-fg);
  background: var(--board-accent);
  border-radius: 9999px;
  padding: 1px 8px;
}

.rec-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}

.rec-status-dot[data-status='new']      { background: var(--board-muted-fg); }
.rec-status-dot[data-status='active']   { background: var(--board-info); }
.rec-status-dot[data-status='paused']   { background: var(--board-warning); }
.rec-status-dot[data-status='blocked']  { background: var(--board-error); }
.rec-status-dot[data-status='complete'] { background: var(--board-success); }

.rec-cards {
  display: flex;
  flex-direction: column;
  gap: var(--board-space-8);
  padding: 10px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.rec-column-empty {
  padding: var(--board-space-24) var(--board-space-8);
  text-align: center;
  font-size: var(--board-text-xs);
  color: var(--board-muted-fg);
}

.rec-card {
  display: flex;
  flex-direction: column;
  gap: var(--board-space-8);
  padding: var(--board-space-12) 14px;
  text-align: left;
  background: var(--board-card);
  border: 1px solid var(--board-border);
  border-radius: var(--board-radius-lg);
  cursor: pointer;
  color: var(--board-fg);
  font-family: inherit;
  transition: box-shadow 120ms ease, border-color 120ms ease, transform 120ms ease;
}

.rec-card:hover {
  border-color: var(--board-info);
  transform: translateY(-1px);
}

.rec-card:active {
  transform: translateY(0);
}

.rec-card-title {
  font-size: 13px;
  font-weight: var(--board-fw-semibold);
  line-height: 1.35;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.rec-card-progress {
  height: 6px;
  background: var(--board-accent);
  border-radius: 3px;
  overflow: hidden;
}

.rec-card-progress-fill {
  height: 100%;
  background: var(--board-info);
}

.rec-card-meta {
  display: flex;
  align-items: center;
  gap: var(--board-space-8);
}

.rec-card-phase {
  flex: 1;
  font-family: var(--board-font-mono);
  font-size: var(--board-text-xs);
  letter-spacing: var(--board-tracking-mono);
  color: var(--board-muted-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ===== Solid status pill (Paper StatusPill) ===== */
.rec-pill {
  flex: none;
  border-radius: 9999px;
  padding: 4px 10px;
  font-size: var(--board-text-xs);
  font-weight: var(--board-fw-medium);
  line-height: 1;
  border: none;
  background: var(--board-muted-fg);
  color: var(--board-bg);
}

.rec-pill[data-pill='locked']      { background: var(--board-success);  color: var(--board-bg); }
.rec-pill[data-pill='in-progress'] { background: var(--board-info);     color: var(--board-bg); }
.rec-pill[data-pill='paused']      { background: var(--board-warning);  color: var(--board-bg); }
.rec-pill[data-pill='blocked']     { background: var(--board-error);    color: var(--board-bg); }
.rec-pill[data-pill='tampered']    { background: var(--board-error);    color: var(--board-bg); }
.rec-pill[data-pill='advisory']    { background: var(--board-advisory); color: var(--board-bg); }
.rec-pill[data-pill='neutral']     { background: var(--board-muted-fg); color: var(--board-bg); }

/* ===== Inspector: centered modal detail ===== */
.rec-inspector {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  pointer-events: auto;
}

.rec-detail {
  display: flex;
  flex-direction: column;
  width: min(640px, calc(100vw - 48px));
  max-height: calc(100vh - 80px);
  background: var(--board-bg);
  border: 1px solid var(--board-border);
  border-radius: 14px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.24);
  color: var(--board-fg);
  font-family: var(--board-font-sans);
  overflow: hidden;
}

.rec-detail-header {
  display: flex;
  align-items: center;
  gap: var(--board-space-12);
  padding: var(--board-space-16) var(--board-space-16);
  border-bottom: 1px solid var(--board-border);
  flex: none;
}

.rec-detail-title {
  margin: 0;
  flex: 1;
  font-size: 15px;
  font-weight: var(--board-fw-semibold);
  letter-spacing: var(--board-tracking-tight);
  overflow-wrap: anywhere;
}

.rec-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px var(--board-space-12);
  font-size: var(--board-text-xs);
  color: var(--board-fg);
  background: transparent;
  border: 1px solid var(--board-border);
  border-radius: var(--board-radius-lg);
  cursor: pointer;
  white-space: nowrap;
}

.rec-back:hover {
  background: var(--board-accent);
}

.rec-detail-body {
  padding: var(--board-space-16);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--board-space-16);
  flex: 1;
}

.rec-detail-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rec-detail-section h3 {
  margin: 0;
  font-size: var(--board-text-xs);
  font-weight: var(--board-fw-semibold);
  color: var(--board-muted-fg);
}

.rec-detail-text {
  margin: 0;
  font-size: var(--board-text-sm);
  color: var(--board-muted-fg);
}

.rec-phase-row {
  display: flex;
  align-items: center;
  gap: var(--board-space-12);
  padding: var(--board-space-8) var(--board-space-12);
  border: 1px solid var(--board-border);
  border-radius: var(--board-radius-lg);
  font-size: 13px;
}

.rec-phase-id {
  min-width: 48px;
  font-family: var(--board-font-mono);
  font-size: var(--board-text-xs);
  letter-spacing: var(--board-tracking-mono);
  color: var(--board-info);
}

.rec-phase-name {
  flex: 1;
  color: var(--board-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rec-lockhash {
  font-family: var(--board-font-mono);
  font-size: 11px;
  letter-spacing: var(--board-tracking-mono);
  color: var(--board-muted-fg);
}

/* ===== Per-phase doc viewer (0.2.4, inside the inspector detail body) ===== */

/* View phase ghost button on each present phase row. */
.rec-phase-view {
  flex: none;
  padding: 3px 10px;
  font-size: var(--board-text-xs);
  color: var(--board-info);
  background: transparent;
  border: 1px solid var(--board-border);
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
}

.rec-phase-view:hover {
  background: var(--board-accent);
}

/* Viewer shell: fills the inspector detail body (the panel owns data-theme). */
.rec-doc {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: var(--board-space-12);
  color: var(--board-fg);
  font-family: var(--board-font-sans);
  background: var(--board-bg);
  border: 1px solid var(--board-border);
  border-radius: var(--board-radius-xl);
  overflow: hidden;
}

.rec-doc-header {
  display: flex;
  align-items: center;
  gap: var(--board-space-12);
  padding: var(--board-space-12) var(--board-space-16);
  border-bottom: 1px solid var(--board-border);
  flex: none;
}

.rec-doc-heading {
  display: flex;
  align-items: baseline;
  gap: var(--board-space-12);
  flex: 1;
  min-width: 0;
}

.rec-doc-badge {
  flex: none;
  padding: 2px 10px;
  font-size: 11px;
  font-weight: var(--board-fw-semibold);
  letter-spacing: 0.05em;
  text-transform: uppercase;
  border-radius: 999px;
  background: var(--board-accent);
  color: var(--board-muted-fg);
}

.rec-doc-title {
  margin: 0;
  font-size: var(--board-text-sm);
  font-weight: var(--board-fw-semibold);
  letter-spacing: var(--board-tracking-tight);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rec-doc-run {
  flex: none;
  font-family: var(--board-font-mono);
  font-size: var(--board-text-xs);
  color: var(--board-muted-fg);
}

.rec-doc-btn {
  flex: none;
  padding: 5px 12px;
  font-size: var(--board-text-xs);
  color: var(--board-fg);
  background: transparent;
  border: 1px solid var(--board-border);
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
}

.rec-doc-btn:hover {
  background: var(--board-accent);
}

/* Search bar (/ to open). */
.rec-doc-search {
  display: flex;
  align-items: center;
  gap: var(--board-space-12);
  padding: var(--board-space-8) var(--board-space-16);
  border-bottom: 1px solid var(--board-border);
  flex: none;
}

.rec-doc-search-input {
  flex: 1 1 auto;
  background: var(--board-muted);
  color: var(--board-fg);
  border: 1px solid var(--board-border);
  border-radius: var(--board-radius-md);
  padding: 5px 10px;
  font-size: var(--board-text-xs);
  font-family: inherit;
  min-width: 0;
}

.rec-doc-search-input::placeholder {
  color: var(--board-muted-fg);
  opacity: 1;
}

.rec-doc-search-count {
  font-size: var(--board-text-xs);
  color: var(--board-muted-fg);
  white-space: nowrap;
}

/* Body: scrollable line list. */
.rec-doc-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--board-space-12) var(--board-space-16) var(--board-space-16);
}

.rec-doc-line {
  font-size: var(--board-text-sm);
  line-height: 1.7;
  padding: 0 6px;
  border-left: 2px solid transparent;
}

.rec-doc-line-current {
  background: var(--board-muted);
  border-left-color: var(--board-info);
}

.rec-doc-blank {
  height: 10px;
}

.rec-doc-plain {
  white-space: pre-wrap;
}

.rec-doc-h1 {
  font-size: 22px;
  font-weight: 700;
  margin: 8px 0 6px;
  line-height: 1.3;
}

.rec-doc-h2 {
  font-size: 18px;
  font-weight: 600;
  margin: 12px 0 4px;
  line-height: 1.3;
}

.rec-doc-h3 {
  font-size: 15px;
  font-weight: 600;
  margin: 10px 0 4px;
  line-height: 1.3;
}

.rec-doc-h4 {
  font-size: 14px;
  font-weight: 600;
  margin: 8px 0 4px;
  line-height: 1.3;
}

.rec-doc-li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: var(--board-text-sm);
  line-height: 1.65;
  margin: 0 0 4px;
}

.rec-doc-bullet {
  flex: none;
  color: var(--board-muted-fg);
  width: 14px;
  text-align: center;
}

.rec-doc-li-text {
  flex: 1;
  min-width: 0;
}

.rec-doc-pre {
  margin: 6px 0;
  padding: var(--board-space-12);
  background: var(--board-muted);
  border: 1px solid var(--board-border);
  border-radius: var(--board-radius-md);
  overflow-x: auto;
}

.rec-doc-code,
.rec-doc-inline-code {
  font-family: var(--board-font-mono);
  font-size: 12.5px;
  letter-spacing: var(--board-tracking-mono);
}

.rec-doc-inline-code {
  background: var(--board-muted);
  border: 1px solid var(--board-border);
  border-radius: 4px;
  padding: 0 4px;
}

.rec-doc-inline-link {
  color: var(--board-info);
  text-decoration: underline;
  cursor: pointer;
}

.rec-doc-table {
  width: 100%;
  border-collapse: collapse;
  margin: 6px 0;
  font-size: var(--board-text-xs);
}

.rec-doc-table th,
.rec-doc-table td {
  border: 1px solid var(--board-border);
  padding: 4px 8px;
  text-align: left;
}

.rec-doc-table th {
  background: var(--board-muted);
  color: var(--board-muted-fg);
  font-weight: var(--board-fw-semibold);
}

/* Footer: status + key hints. */
.rec-doc-footer {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--board-space-16);
  padding: var(--board-space-8) var(--board-space-16);
  border-top: 1px solid var(--board-border);
  flex-wrap: wrap;
}

.rec-doc-status {
  font-size: var(--board-text-xs);
  color: var(--board-muted-fg);
  min-width: 120px;
}

.rec-doc-status-error {
  color: var(--board-error);
}

.rec-doc-status-ok {
  color: var(--board-success);
}

.rec-doc-hints {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  font-size: var(--board-text-xs);
  color: var(--board-muted-fg);
}

.rec-doc-hints kbd {
  background: var(--board-muted);
  border: 1px solid var(--board-border);
  border-radius: 4px;
  padding: 1px 6px;
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  color: var(--board-fg);
  margin: 0 3px 0 8px;
}

.rec-doc-text {
  margin: 0;
  font-size: var(--board-text-sm);
  color: var(--board-muted-fg);
}

.rec-doc-error {
  color: var(--board-error);
}

/* ===== Strip (session dock) — keeps the shell --dsw-* theme ===== */
.rec-badge {
  flex: none;
  padding: 2px 10px;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
}
.rec-badge-tamper {
  color: var(--dsw-alias-state-error-primary);
  border-color: var(--dsw-alias-state-error-primary);
}
.rec-badge-gate {
  color: var(--dsw-alias-state-warn-primary);
  border-color: var(--dsw-alias-state-warn-primary);
}

/* ===== Settings section (Settings -> Recursive): the live projection report =====
   This panel lives INSIDE the settings shell, so it consumes the shell's own
   --dsw-alias-* theme tokens (like .rec-badge above) instead of the board's
   scoped --board-* paper tokens: no theme toggle, and it follows the app theme. */
.rec-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 940px;
  padding: 2px 2px 10px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
}

.rec-settings-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.rec-settings-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.rec-settings-tag {
  flex: none;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
}

.rec-settings-close {
  margin-left: auto;
  padding: 5px 12px;
  font: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  cursor: pointer;
}

.rec-settings-close:hover {
  background: var(--dsw-alias-bg-layer-3);
}

.rec-settings-lede,
.rec-settings-hint,
.rec-settings-none {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
}

.rec-settings-hint,
.rec-settings-none {
  font-size: 12px;
}

.rec-settings-section,
.rec-settings-notcarried,
.rec-settings-run {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
}

.rec-settings-h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
}

.rec-settings-h4 {
  margin: 6px 0 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
}

.rec-settings-run-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.rec-settings-run-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.rec-settings-run-root {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Solid state pill, same vocabulary as .rec-pill but on the SHELL tokens
   (the board's --board-* aliases are scoped to .rec-board/.rec-inspector). */
.rec-settings-pill {
  flex: none;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  border-radius: 999px;
  color: var(--dsw-alias-label-primary-foreground);
  background: var(--dsw-alias-label-tertiary);
}

.rec-settings-pill[data-pill='locked']      { background: var(--dsw-alias-state-success-primary); }
.rec-settings-pill[data-pill='in-progress'] { background: var(--dsw-alias-state-business-primary); }
.rec-settings-pill[data-pill='paused']      { background: var(--dsw-alias-state-warn-primary); }
.rec-settings-pill[data-pill='blocked']     { background: var(--dsw-alias-state-error-primary); }
.rec-settings-pill[data-pill='tampered']    { background: var(--dsw-alias-state-error-primary); }
.rec-settings-pill[data-pill='advisory']    { background: var(--dsw-alias-state-warn-secondary); }
.rec-settings-pill[data-pill='neutral']     { background: var(--dsw-alias-label-tertiary); }

dl.rec-settings-source,
dl.rec-settings-rows {
  display: grid;
  grid-template-columns: minmax(160px, 300px) 1fr;
  gap: 4px 16px;
  margin: 0;
}

.rec-settings-label {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}

.rec-settings-value {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}

/* An absent value is a STATEMENT, not an empty row — always visibly marked. */
.rec-settings-absent {
  color: var(--dsw-alias-state-warn-label);
  font-style: italic;
}

.rec-settings-phases {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rec-settings-phase {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 10px;
  padding: 4px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
}

.rec-settings-phase-id {
  flex: none;
  min-width: 40px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}

.rec-settings-phase-name {
  flex: 1;
  min-width: 140px;
  overflow-wrap: anywhere;
}

.rec-settings-phase-status,
.rec-settings-phase-pos {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--dsw-alias-label-secondary);
}

.rec-settings-phase-lock {
  flex: none;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}

.rec-settings-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.rec-settings-item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12px;
}

.rec-settings-item-id {
  flex: none;
  min-width: 96px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--dsw-alias-label-secondary);
}

.rec-settings-item-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

@media (prefers-reduced-motion: reduce) {
  .rec-card, .rec-back, .rec-close, .rec-theme-toggle { transition: none; }
}
`

/**
 * Inject the board/inspector stylesheet once. Idempotent: if a <style
 * data-dsh-recursive> already exists, returns a disposer that does nothing
 * (the first injector owns the element). Returns a disposer that removes it.
 */
export function injectBoardStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector('style[data-dsh-recursive]')
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.setAttribute('data-dsh-recursive', '')
  style.textContent = BOARD_CSS
  document.head.appendChild(style)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    style.remove()
  }
}
