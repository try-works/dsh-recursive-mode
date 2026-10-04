#!/usr/bin/env node
/**
 * install-preset.js — materialize the `recursive` agent preset into the user's
 * DSH home so `agentPreset.list` returns `recursive` and selecting it mounts the
 * full per-session recursive-mode surface.
 *
 * R2 resolution (02-to-be-plan.addendum-r4-r2-mount-resolution.md), option (B):
 * the preset's server-surface row is written as an ABSOLUTE file URL into the
 * PROFILE-installed package (lib/index.js), NOT a vendored copy. This keeps the
 * nested @deepseek-ai/cordis + @deepseek-ai/dsh-tools imports resolving through
 * the profile's flat-fallback junctions (same cordis symbols => Service identity
 * preserved), and `ctx.recursive` resolves correctly inside the isolate realm.
 *
 * Idempotent + atomic: writes to a temp file in the same directory, then renames.
 *
 * Usage: node install-preset.js [--profile <name>] [--dsh-home <dir>] [--force]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(__dirname, '..')
const PRESET_SOURCE_DIR = join(PACKAGE_ROOT, 'preset', 'recursive')
const PRESET_SOURCE = join(PRESET_SOURCE_DIR, 'agent.cordis.yml')
const PRESET_METADATA_SOURCE = join(PRESET_SOURCE_DIR, 'preset.yml')
const PLACEHOLDER = '@@RECURSIVE_SERVER_ENTRY@@'
const PKG_NAME = '@try-works/dsh-recursive-mode'

function parseArgs(argv) {
  const out = { profile: 'web', dshHome: '', force: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--profile' && argv[i + 1]) { out.profile = argv[++i]; continue }
    if (a === '--dsh-home' && argv[i + 1]) { out.dshHome = argv[++i]; continue }
    if (a === '--force') { out.force = true; continue }
  }
  return out
}

function fail(msg) {
  console.error('[install-preset] FAIL: ' + msg)
  process.exitCode = 1
}

const args = parseArgs(process.argv.slice(2))
const dshHome = args.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')

// Locate the profile install dir and its lib/index.js.
const profilePkgDir = join(dshHome, 'profiles', args.profile, 'node_modules', ...PKG_NAME.split('/'))
const serverEntry = join(profilePkgDir, 'lib', 'index.js')

if (!existsSync(serverEntry)) {
  fail(
    'Profile-installed package entry not found: ' + serverEntry + "\n" +
    '  Install the package into the profile first: pnpm dsh plugin --profile ' + args.profile + ' add ' + PKG_NAME,
  )
  process.exit(1)
}

const serverUrl = pathToFileURL(serverEntry).href

// Read the preset template and materialize the placeholder.
const template = readFileSync(PRESET_SOURCE, 'utf8')
if (!template.includes(PLACEHOLDER)) {
  fail('Preset template missing placeholder ' + PLACEHOLDER + ' in ' + PRESET_SOURCE)
  process.exit(1)
}
const materialized = template.replaceAll(PLACEHOLDER, serverUrl)

// Destination: ~/.dsh/.agent-presets/recursive/agent.cordis.yml
const presetDir = join(dshHome, '.agent-presets', 'recursive')
const presetFile = join(presetDir, 'agent.cordis.yml')

if (existsSync(presetFile) && !args.force) {
  const existing = readFileSync(presetFile, 'utf8')
  if (existing === materialized) {
    console.log('[install-preset] OK (already up to date): ' + presetFile)
    console.log('  server entry: ' + serverUrl)
    process.exit(0)
  }
}

mkdirSync(presetDir, { recursive: true })
const tmp = join(presetDir, '.agent.cordis.yml.tmp')
writeFileSync(tmp, materialized, 'utf8')
renameSync(tmp, presetFile)

// Copy the optional display metadata (preset.yml) beside the composition so the
// picker shows the human-facing name instead of the id. Absent source is fine.
const metadataFile = join(presetDir, 'preset.yml')
if (existsSync(PRESET_METADATA_SOURCE)) {
  const metadataTmp = join(presetDir, '.preset.yml.tmp')
  writeFileSync(metadataTmp, readFileSync(PRESET_METADATA_SOURCE, 'utf8'), 'utf8')
  renameSync(metadataTmp, metadataFile)
}

console.log('[install-preset] OK: ' + presetFile)
console.log('  server entry: ' + serverUrl)
console.log('  (re-run is idempotent; add --force to overwrite an existing file)')
