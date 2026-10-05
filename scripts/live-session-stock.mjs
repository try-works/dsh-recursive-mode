#!/usr/bin/env node
/**
 * FU-10 step 1 — THE STOCK SESSION, copied VERBATIM from the harness's own e2e.
 *
 * WHY A SEPARATE SCRIPT. My first attempt added this plugin on the very first run, which mixed two
 * unknowns: whether the launch works at all, and whether my plugin mounts. This script removes the second
 * unknown completely — it is the harness's own fixture (same profile package.json, same bundles, same
 * patch, same scripted LLM, same prompt, same invocation) with nothing of mine added. If this boots, the
 * remaining question is only how to mount a plugin; if it does not, the route is blocked here and no
 * amount of plugin work would have fixed it.
 *
 * Source of every line below: apps/cli/tests/agent-team-headless.e2e.ts (L21-78) and the invocation
 * printed from resolveExampleLaunch.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HARNESS = 'D:\\deepseek-harness'
const SRC_BIN = join(HARNESS, 'apps', 'cli', 'src', 'bin.ts')
const TSCONFIG = join(HARNESS, 'tsconfig.json')
// The absolute file URL to tsx's loader, exactly as resolveExampleLaunch emits it.
const TSX_LOADER = 'file:///D:/deepseek-harness/node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/loader.mjs'
const FIXTURE_LLM = join(HARNESS, 'apps', 'cli', 'tests', 'profiles', 'headless', 'tests', 'fixtures', 'team-llm.mjs')
// The prompt the e2e uses, which is what its scripted LLM is written against.
const PROMPT = '请先运行 workflow 检查，再使用 Agent Teams 把调研和实现拆给两个 teammate，等待完成后汇总。'

const fileUrl = (path) => 'file:///' + path.replace(/\\/g, '/')
const base = join(existsSync('E:\\') ? 'E:\\dsh-rm-live' : tmpdir(), 'stock-' + new Date().toISOString().replace(/[:.]/g, '-'))
const home = join(base, '.dsh')
const sessions = join(home, 'sessions')
const profileDir = join(home, 'profiles', 'headless')

mkdirSync(profileDir, { recursive: true })
mkdirSync(sessions, { recursive: true })

// 1:1 with the e2e's profile.
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

// 1:1 with the e2e's patch: real provider off, sessions into the temp home, fixture LLM inserted.
writeFileSync(join(profileDir, 'cordis.patch.yml'), [
  '- id: llm-deepseek',
  '  disabled: true',
  '- id: session-persistence-jsonl',
  '  config:',
  "    root: '" + sessions.replace(/\\/g, '/') + "'",
  '    compression: none',
  '- insert:',
  '    - id: team-fixture-llm',
  "      name: '" + fileUrl(FIXTURE_LLM) + "'",
  '',
].join('\n'), 'utf8')

const outFile = join(base, 'stdout.txt')
const errFile = join(base, 'stderr.txt')
const outFd = openSync(outFile, 'w')
const errFd = openSync(errFile, 'w')

// ⚠ The child must not inherit this session's identity: DSH_PROFILE=web made the CLI see two profiles.
const env = { ...process.env }
for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_SHELL', 'DSH_WEB_URL']) delete env[key]

console.log('[stock] base: ' + base)
const result = spawnSync(process.execPath, [
  '--import', TSX_LOADER,
  SRC_BIN,
  '--profile', 'headless',
  PROMPT,
], {
  cwd: base,
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
console.log('[stock] exit: ' + result.status + (result.error ? ' (spawn error: ' + result.error.message + ')' : ''))
console.log('[stock] stdout: ' + stdout.length + ' bytes | stderr: ' + stderr.length + ' bytes')
if (stdout.trim() !== '') console.log('--- stdout tail ---\n' + stdout.trim().split('\n').slice(-10).join('\n'))
if (stderr.trim() !== '') console.log('--- stderr tail ---\n' + stderr.trim().split('\n').slice(-10).join('\n'))
const logs = existsSync(sessions) ? readdirSync(sessions, { recursive: true }).map(String).filter((n) => n.endsWith('.jsonl')) : []
console.log('[stock] session logs: ' + logs.length)
console.log('[stock] workflow marker (TEAM_WORKFLOW_OK): ' + stdout.includes('TEAM_WORKFLOW_OK'))
