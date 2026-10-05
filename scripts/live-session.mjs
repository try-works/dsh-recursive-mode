#!/usr/bin/env node
/**
 * FU-10 — THE LIVE-SESSION HARNESS.
 *
 * WHAT IT DOES. Opens a REAL `dsh` session in a temp folder on `E:` with a profile that mounts THIS plugin
 * (by file URL — no install, no dependency added) and a scripted LLM, then reads the session log back.
 *
 * WHY IT EXISTS. FU-9 claims something the in-process harness cannot show: a delegation that reaches a
 * REAL live Agent, because the continuable seam requires the exact Agent ("never a `{ id }` copy"). It is
 * also the only way to measure whether a real session mounts a workflow engine at all, which is what
 * FU-6's live half turns on.
 *
 * ⚠ OUTPUT GOES TO FILES, NOT PIPES. This sandbox denies a child process the piped stdio that capturing
 * stdout needs (measured: EPERM), so the launch redirects the child's stdout/stderr to files and the
 * harness reads those. The same constraint is why FU-5's extractor talks through a response file.
 *
 * ⚠ `src` MODE, because resolution comes from the HARNESS's tsconfig path mappings (`TSX_TSCONFIG_PATH`),
 * not from a `node_modules` beside the temp profile — and `E:` has none.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HARNESS = 'D:\\deepseek-harness'
const PLUGIN = 'D:\\DEV\\dsh-recursive-mode'
const SRC_BIN = join(HARNESS, 'apps', 'cli', 'src', 'bin.ts')
const TSCONFIG = join(HARNESS, 'tsconfig.json')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const base = join(existsSync('E:\\') ? 'E:\\dsh-rm-live' : join(process.env.TEMP ?? '.', 'dsh-rm-live'), 'live-' + stamp)
const home = join(base, '.dsh')
const repo = join(base, 'repo')
const sessions = join(home, 'sessions')
// ⚠ THE PROFILE IS NAMED `headless`, AND NO COMMAND WORD IS PASSED. Measured: invoking the CLI as
// `… headless --profile live` fails with *"select a profile only once"* — the first positional is itself a
// profile selection. The harness's own e2e therefore writes its profile to `profiles/headless` and passes
// only `--profile headless <prompt>`.
const profileDir = join(home, 'profiles', 'headless')

const PROMPT = process.argv[2] ?? 'Run recursive_init for run live-run, then ask recursive_review to review phase 03.'

function fileUrl(path) {
  return 'file:///' + path.replace(/\\/g, '/')
}

mkdirSync(profileDir, { recursive: true })
mkdirSync(sessions, { recursive: true })
mkdirSync(join(repo, 'src'), { recursive: true })
writeFileSync(join(repo, 'README.md'), '# live session scratch repo\n', 'utf8')
spawnSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' })

// The profile: the harness's own two bundles, plus OUR plugin inserted by file URL (the pattern the
// harness uses for its own fixture), plus the scripted LLM.
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-headless',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
}, undefined, 2) + '\n', 'utf8')

writeFileSync(join(profileDir, 'cordis.patch.yml'), [
  '- id: llm-deepseek',
  '  disabled: true',
  '- id: session-persistence-jsonl',
  '  config:',
  "    root: '" + sessions.replace(/\\/g, '/') + "'",
  '    compression: none',
  '- insert:',
  '    - id: live-fixture-llm',
  "      name: '" + fileUrl(join(PLUGIN, 'scripts', 'live', 'fake-llm.mjs')) + "'",
  '    - id: recursive-mode',
  "      name: '" + fileUrl(join(PLUGIN, 'src', 'index.ts')) + "'",
  '',
].join('\n'), 'utf8')

/**
 * ⚠ THE CHILD INHERITS `DSH_PROFILE=web` FROM THE SESSION THAT LAUNCHED IT, which made the CLI fail with
 * "select a profile only once" — the environment supplied one profile and the arguments another. A live
 * session must not inherit its parent's identity at all, so the launch env is filtered rather than spread.
 */
function cleanEnv() {
  const env = { ...process.env }
  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_SHELL', 'DSH_WEB_URL']) {
    delete env[key]
  }
  return env
}
const outFile = join(base, 'stdout.txt')
const errFile = join(base, 'stderr.txt')
const outFd = openSync(outFile, 'w')
const errFd = openSync(errFile, 'w')

console.log('[live] base:    ' + base)
console.log('[live] home:    ' + home)
console.log('[live] repo:    ' + repo)

// ⚠ THE tsx **CLI**, NOT `--import tsx`. Measured: `node --import tsx` resolves the specifier relative to
// the CWD, so a temp repo on `E:` gives `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'`, and `NODE_PATH`
// does not help because it applies to CommonJS resolution only. Running tsx's own CLI by absolute path
// makes it resolve its dependencies from ITS location instead of the session's.
const TSX_CLI = join(HARNESS, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const result = spawnSync(process.execPath, [
  TSX_CLI,
  SRC_BIN,
  'headless',
  '--profile', 'headless',
  PROMPT,
], {
  cwd: repo,
  // ⚠ Files, not pipes — see the header note.
  stdio: ['ignore', outFd, errFd],
  env: {
    ...cleanEnv(),
    DSH_HOME: home,
    DSH_AGENTS_HOME: join(base, '.agents'),
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: '',
    TSX_TSCONFIG_PATH: TSCONFIG,
    // tsx and the harness's own modules live in the checkout, which is not an ancestor of the temp dir.
    NODE_PATH: join(HARNESS, 'node_modules'),
  },
})
closeSync(outFd)
closeSync(errFd)

console.log('[live] exit:    ' + result.status + (result.error ? ' (spawn error: ' + result.error.message + ')' : ''))
const stdout = existsSync(outFile) ? readFileSync(outFile, 'utf8') : ''
const stderr = existsSync(errFile) ? readFileSync(errFile, 'utf8') : ''
console.log('[live] stdout:  ' + stdout.length + ' bytes | stderr: ' + stderr.length + ' bytes')
if (stdout.trim() !== '') console.log('--- stdout tail ---\n' + stdout.trim().split('\n').slice(-12).join('\n'))
if (stderr.trim() !== '') console.log('--- stderr tail ---\n' + stderr.trim().split('\n').slice(-12).join('\n'))

const logs = existsSync(sessions)
  ? readdirSync(sessions, { recursive: true }).map(String).filter((name) => name.endsWith('.jsonl'))
  : []
console.log('[live] session logs: ' + logs.length)
for (const log of logs) console.log('        ' + join(sessions, log))
console.log('[live] reached review marker: ' + stdout.includes('LIVE_SESSION_REACHED_REVIEW'))
process.exit(result.status ?? 1)
