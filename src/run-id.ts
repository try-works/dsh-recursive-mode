/**
 * A RUN ID IS A NAME, NOT A PATH.
 *
 * WHY THIS MODULE EXISTS. Every consumer of a run id JOINS it onto a directory
 * that already carries the meaning "the run layer":
 *
 *     join(root, '.recursive', 'run', runId)   // runtime.ts, run.ts, handoff.ts, scratch.ts
 *     join(repoRoot, '.worktrees', runId)      // worktree.ts (a linked worktree)
 *     'recursive/' + runId                     // worktree.ts (the run's git branch)
 *
 * `join` is a PATH operation: absolute paths, drive specifiers and `..` segments
 * are all legal input to it, and each one silently changes what the call means.
 * A caller who passes `E:\tmp\rm-live-diagnostics\01-calculator-lib` is asking
 * for a run "on another drive"; what they get is a `mkdir` of
 *
 *     <workspace>\.recursive\run\E:\tmp\rm-live-diagnostics\01-calculator-lib
 *
 * which is not drive-qualified at all — on POSIX and Windows alike the colon is
 * just another character in a relative component. The result is a bogus nested
 * folder INSIDE the workspace, created before anything can refuse it, surfacing
 * far away as an ENOENT-shaped runtime failure (RM5501) with the operator's
 * filesystem already dirty.
 *
 * SO THE RULE IS ENFORCED WHERE THE NAME ENTERS, and NOT by teaching the runtime
 * to accept a path. The joins in `runtime.ts` are CORRECT for a name; what was
 * missing was a gate on the name. Do not "fix" this back: a run on another drive
 * or in a worktree is reached through the session's control-plane root
 * (`recursive_worktree`, `00-worktree.md`) — the run layer is never relocated by
 * smuggling a path into the id.
 *
 * The charset below is deliberately the SAME one the read path already uses
 * (`live-route.ts` `DOC_SAFE_RE`) so a name this gate accepts is a name that
 * route can serve.
 */

/**
 * The accepted shape, as prose that can be embedded in a model-facing parameter
 * description and in a refusal detail, so the rule is stated once.
 */
export const RUN_ID_RULE = 'letters, digits, dot, underscore or dash only, no leading or trailing dot, no path separator, no drive specifier and no ".." segment'

/** Two ids in the shapes the scaffold convention actually produces. */
export const RUN_ID_EXAMPLES = '01-calculator-lib, fixture-run'

/**
 * Longest run id accepted. Directory-name components cap at 255 bytes on NTFS
 * and ext4; a run id also becomes a git ref component (`recursive/<runId>`) and
 * a prefix of every lock/receipt filename inside the run, so the ceiling is set
 * well below the filesystem limit rather than at it.
 */
export const RUN_ID_MAX_LENGTH = 100

/** Directory-name charset — the read path's `DOC_SAFE_RE`, verbatim. */
const RUN_ID_CHARS = /^[A-Za-z0-9._-]+$/

/**
 * Why a run id is refused, or `null` when it is a usable NAME.
 *
 * The returned string is the SPECIFIC problem (which rule the id broke), with no
 * trailing punctuation and no sentence of its own, so a caller can hand it to
 * `toolError('BAD_RUN_ID', …)` as the detail. `RUN_ID_RULE` states the shape.
 *
 * The order of the checks is part of the message quality: a Windows absolute
 * path is reported as a drive-qualified path (what the caller passed) rather
 * than as a separator complaint (what that path is made of).
 */
export function runIdProblem(raw: string): string | null {
  if (raw === '') return 'runId is empty'
  if (raw.length > RUN_ID_MAX_LENGTH) return 'runId is ' + raw.length + ' characters, over the ' + RUN_ID_MAX_LENGTH + ' allowed'
  // A Windows drive-QUALIFIED path (`E:\x`, and the drive-relative `E:x` too).
  if (/^[A-Za-z]:/.test(raw)) return 'runId is a Windows drive-qualified path, starting with "' + raw.slice(0, 2) + '"'
  // Path separators: an absolute POSIX path, a UNC path, or any nested path.
  if (raw.includes('/') || raw.includes('\\')) {
    return 'runId contains the path separator "' + (raw.includes('/') ? '/' : '\\') + '"'
  }
  // A colon that is not a drive prefix is still unmappable on Windows (NTFS
  // alternate data streams), and the run id is a Windows directory name.
  if (raw.includes(':')) return 'runId contains a colon (":"), which is a drive and stream separator on Windows'
  // `..` makes the join resolve to the PARENT of the run layer.
  if (raw.includes('..')) return 'runId contains a ".." segment, which escapes the run directory'
  // `.` and `..` are the parent/current directory segments, and a trailing dot is
  // stripped by the Win32 path parser — `03-foo.` and `03-foo` would then be two
  // names for one directory.
  if (raw.startsWith('.')) return 'runId starts with ".", which makes it a hidden name or a relative path segment'
  if (raw.endsWith('.')) return 'runId ends with "."'
  if (!RUN_ID_CHARS.test(raw)) {
    // Whitespace inside the name is called out separately because the caller can
    // see the id they typed and cannot see why it is refused: the tool trims the
    // ENDS (so `" 03-x "` already names `03-x`), but an interior space is not
    // normalized anywhere and would create a directory the caller cannot retype.
    if (/\s/.test(raw)) return 'runId contains a space or other whitespace character inside the name'
    return 'runId contains a character outside the allowed set'
  }
  return null
}

/** True when `raw` is a usable run NAME. Convenience for callers that only branch. */
export function isValidRunId(raw: string): boolean {
  return runIdProblem(raw) === null
}
