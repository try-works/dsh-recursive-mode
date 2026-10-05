#!/usr/bin/env node
/**
 * FU-10 step 2 — THE LIVE SESSION WITH THIS PLUGIN MOUNTED.
 *
 * Derived from `live-session-stock.mjs`, which is PROVEN to boot (exit 0, agents ran, session logs
 * written). Exactly two things change, and nothing else — that is the point of deriving rather than
 * rewriting:
 *
 *   1. the scripted LLM is OURS (`scripts/live/fake-llm.mjs`), scripting `recursive_init` then
 *      `recursive_review`, so a session that gets that far has reached the delegated review path;
 *   2. THIS PLUGIN is inserted into the profile **by file URL**, the pattern the harness uses for its own
 *      fixture — so no install and no dependency added to this repo.
 *
 * ⚠ EVERYTHING ELSE IS THE PROVEN RECIPE: the fixture's `dependencies` AND its three bundles (my
 * hand-written profile was rejected as invalid without them), the same patch shape, the filtered env (a
 * child must not inherit this session's `DSH_PROFILE=web`), and the absolute tsx loader file URL.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HARNESS = 'D:\\deepseek-harness'
const PLUGIN = 'D:\\DEV\\dsh-recursive-mode'
const SRC_BIN = join(HARNESS, 'apps', 'cli', 'src', 'bin.ts')
const TSCONFIG = join(HARNESS, 'tsconfig.json')
const TSX_LOADER = 'file:///D:/deepseek-harness/node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/loader.mjs'
const PROMPT = 'Run recursive_init for run live-run, then ask recursive_review to review phase 03.'

const fileUrl = (path) => 'file:///' + path.replace(/\\/g, '/')
const base = join(existsSync('E:\\') ? 'E:\\dsh-rm-live' : tmpdir(), 'plugin-' + new Date().toISOString().replace(/[:.]/g, '-'))
const home = join(base, '.dsh')
const repo = join(base, 'repo')
const sessions = join(home, 'sessions')
const profileDir = join(home, 'profiles', 'headless')

mkdirSync(profileDir, { recursive: true })
mkdirSync(sessions, { recursive: true })
mkdirSync(join(repo, 'src'), { recursive: true })
writeFileSync(join(repo, 'README.md'), '# live session scratch repo\n', 'utf8')
spawnSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' })

// The PROVEN profile (fixture deps + fixture bundles), verbatim.
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-headless',
  private: true,
  dependencies: { '@deepseek-ai/dsh-experimental-agent-team-profile': 'workspace:^' },
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-headless',
        '@deepseek-ai/dsh-experimental-agent-team-profile',
      ],
    },
  },
}, undefined, 2) + '\n', 'utf8')

// The patch: real provider off, sessions into the temp home, OUR LLM and OUR PLUGIN inserted by file URL.
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

const outFile = join(base, 'stdout.txt')
const errFile = join(base, 'stderr.txt')
const outFd = openSync(outFile, 'w')
const errFd = openSync(errFile, 'w')

const env = { ...process.env }
for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_SHELL', 'DSH_WEB_URL']) delete env[key]

console.log('[plugin] base: ' + base)
console.log('[plugin] repo: ' + repo)
const result = spawnSync(process.execPath, [
  '--import', TSX_LOADER,
  SRC_BIN,
  '--profile', 'headless',
  PROMPT,
], {
  cwd: repo,
  stdio: ['ignore', outFd, errFd],
  env: {
    ...env,
    DSH_HOME: home,
    DSH_AGENTS_HOME: join(base, '.agents'),
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: '',
    TSX_TSCONFIG_PATH: TSCONFIG,
  },
})
closeSync(outFd)
closeSync(errFd)

const stdout = existsSync(outFile) ? readFileSync(outFile, 'utf8') : ''
const stderr = existsSync(errFile) ? readFileSync(errFile, 'utf8') : ''
console.log('[plugin] exit: ' + result.status + (result.error ? ' (spawn error: ' + result.error.message + ')' : ''))
console.log('[plugin] stdout: ' + stdout.length + ' bytes | stderr: ' + stderr.length + ' bytes')
if (stdout.trim() !== '') console.log('--- stdout tail ---\n' + stdout.trim().split('\n').slice(-14).join('\n'))
if (stderr.trim() !== '') console.log('--- stderr tail ---\n' + stderr.trim().split('\n').slice(-14).join('\n'))

/**
 * FU-9 — THE SECOND, RESUMED INVOCATION.
 *
 * ⚠ WHY IT IS NEEDED, MEASURED: the review PARKS (T36's turn-shaped driver treats waiting as not-an-error)
 * and a ONE-SHOT session exits before the child's first turn is ever scheduled — a run left no child
 * session, no settlement and no reply. The headless app supports `--session-id`, documented as *"resumes a
 * conversation that already exists"* (`packages/bundle/headless/src/index.ts`, via
 * `agents.resume({ resumeSessionId })`), so the parked round gets a later turn in the SAME conversation —
 * which is the shape this plugin was built for.
 */
function sessionIdUnder(root) {
  if (!existsSync(root)) return null
  for (const scoped of readdirSync(root, { withFileTypes: true })) {
    if (!scoped.isDirectory()) continue
    for (const inner of readdirSync(join(root, scoped.name), { withFileTypes: true })) {
      // ⚠ THE PREFIX STAYS. Measured: passing the bare uuid gives
      // `dsh: session "<uuid>" does not exist; omit --session-id to start a new Session` — the session id
      // the CLI knows is the whole `session-<uuid>`, which is also what the log's first record carries.
      if (inner.isDirectory() && inner.name.startsWith('session-')) return inner.name
    }
  }
  return null
}

const sessionId = sessionIdUnder(sessions)
if (sessionId !== null) {
  const outFile2 = join(base, 'stdout-resume.txt')
  const errFile2 = join(base, 'stderr-resume.txt')
  const outFd2 = openSync(outFile2, 'w')
  const errFd2 = openSync(errFile2, 'w')
  console.log('[plugin] resuming session: ' + sessionId)
  const resumed = spawnSync(process.execPath, [
    '--import', TSX_LOADER,
    SRC_BIN,
    '--profile', 'headless',
    '--session-id', sessionId,
    'The reviewer has replied. Continue the review round and report the verdict.',
  ], {
    cwd: repo,
    stdio: ['ignore', outFd2, errFd2],
    env: {
      ...env,
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(base, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: '',
      TSX_TSCONFIG_PATH: TSCONFIG,
    },
  })
  closeSync(outFd2)
  closeSync(errFd2)
  const out2 = existsSync(outFile2) ? readFileSync(outFile2, 'utf8') : ''
  console.log('[plugin] resume exit: ' + resumed.status + ' | stdout: ' + out2.trim().split('\n').slice(-4).join(' / '))
} else {
  console.log('[plugin] resume SKIPPED: no session id found to resume')
}

// The evidence a run happened: OUR plugin's run directory, written by its own tools in a real session.
const runDir = join(repo, '.recursive', 'run', 'live-run')
console.log('[plugin] run directory exists: ' + existsSync(runDir))
if (existsSync(runDir)) {
  const files = readdirSync(runDir).slice(0, 12)
  console.log('[plugin] run artifacts: ' + files.join(', '))
}
const reviews = existsSync(join(runDir, 'subagents')) ? readdirSync(join(runDir, 'subagents')).slice(0, 6) : []
console.log('[plugin] subagents dir: ' + (reviews.length > 0 ? reviews.join(', ') : '(none)'))
const logs = existsSync(sessions) ? readdirSync(sessions, { recursive: true }).map(String).filter((n) => n.endsWith('.jsonl')) : []
console.log('[plugin] session logs: ' + logs.length)
