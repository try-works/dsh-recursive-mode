# dsh-recursive-mode — Implementation Notes (Phase 3 seam reference)

Verified against the DSH checkout at `D:\deepseek-harness` (dsh `0.1.0-rc.5`) and the vendored `cordis-plugin-loader` `1.0.2`. All claims cite file:line evidence.

## 0. Local setup — read this before cloning

**Peer deps are `link:`ed into a DSH checkout, and that used to make the checkout's location load-bearing. It no longer does — the commands repair it (T34).**

```powershell
# 1. Clone anywhere, on any drive, at any depth. That used to break every
#    @deepseek-ai/* import: package.json declares the deps as ABSOLUTE `link:`
#    specs, but pnpm records the target RELATIVE in pnpm-lock.yaml
#    (`version: link:../../deepseek-harness/vendor/cordis`), so the links only
#    resolved at the exact depth the lockfile assumed.
#
#    Now `pnpm typecheck`, `pnpm test` and `pnpm build` run a repair first (see
#    scripts/link-dsh.mjs), which rebuilds every link from the absolute specs in
#    package.json. So the plain workflow works unattended:
#
#        git clone <this repo> <anywhere>
#        pnpm install --ignore-scripts
#        pnpm test                  # repairs the links, then runs
#
#    Verified: a clone at E:\t34-drive2\deep\repo (different drive, deeper path)
#    reported `[link-dsh] linked 15, unresolved 0` and 61 files / 479 tests green.
#
#    If the checkout lives somewhere unexpected, point at it explicitly:
#        DSH_HARNESS_ROOT=/path/to/deepseek-harness pnpm run link:dsh
#    With no checkout at all, the repair says so and exits 0: the repo stays
#    readable and the failure you eventually see is "this module is not linked"
#    rather than a crash. There is deliberately NO postinstall hook — it cannot
#    see the checkout during pnpm's install phase and reported the targets as
#    missing, so the repair lives in the commands that need it instead.

pnpm install --ignore-scripts   # --ignore-scripts skips the `prepare` build
pnpm typecheck                  # repairs links, then tsc --noEmit
pnpm test                       # vitest run
pnpm build                      # declarations + tsdown bundles into lib/
npx tsx scripts/test-recursive-mode-smoke.ts
```

**Two fixture preconditions are deliberate — do not "clean them up".** A fresh clone of this repo was red until both were fixed, so they are load-bearing:

- `tests/fixtures/lint-golden/.recursive/memory/.gitkeep` — a zero-byte placeholder.
  Git cannot store an empty directory, so without it a clone loses the directory and the
  golden lint verdict changes from `MEMORY.md: Memory router file is missing` to
  `memory: Memory plane directory is missing`, failing `lint-parity`.
- `tests/global-setup.ts` — stamps the two run directories under
  `tests/fixtures/repo/.recursive/run/` to fixed distinct mtimes. `getLatestRunDirectory`
  (`src/run.ts`) picks the active run **by mtime**, and that fixture deliberately holds two
  runs whose order is the point (`fixture-run` newer than `older-run`). Git does not store
  mtimes, so a clone ties them and the winner follows unspecified directory order, failing
  `status.parity` and `smoke` with `expected 'older-run' to be 'fixture-run'`.

`.gitattributes` pins `eol=lf` for the same reason: the byte-exact markdown goldens cannot survive a `core.autocrlf=true` checkout.

## 1. Bundle manifest (package.json)

**Claim:** a bundle is an npm package whose manifest declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`. The profile launcher resolves the bundle by name, reads its manifest, and applies the declared patch file as one layer.

**Evidence:**
- `packages/boot/app-boot/src/profile.ts:41-45` — `DshBundleManifest { patch: string }`.
- `profile.ts:388-397` — `loadProfile` resolves each `dsh.profile.bundles` entry to its package dir, reads `package.json`, requires `dsh.bundle.patch`, and loads it as a patch layer.
- `packages/bundle/base/package.json` — real in-box bundle uses exactly this shape.
- `apps/cli/tests/built-bin.e2e.ts:105-110` — e2e bundle manifest: `{ name, version, type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } }`.

**Required fields:** `name`, `version`, `type: 'module'`, `dsh.bundle.patch`. Plus (for resolution + tests): `main`/`exports` for the plugin entry, `peerDependencies` on `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-system-prompt`, and `devDependencies` (vitest, tsx, typescript).

**Implication:** `dsh-recursive-mode/package.json` must declare `dsh.bundle.patch` → `./cordis.patch.yml` and the peer deps pinned to the running dsh version.

## 2. Patch format (cordis.patch.yml)

**Claim:** a patch is a YAML array of patch rows. A row can be an `- insert:` list of entries (`id`, `name`, `config`) or an id-targeted override (`- id: <existing>` + `config:`). Later layers override earlier by id (last write wins per row).

**Evidence:**
- `packages/bundle/base/cordis.patch.yml:15-20` — `- insert:` with `- id: timer`, `- name: '@deepseek-ai/cordis-plugin-timer'`.
- Header comment (lines 1-13): "A patch replaces the targeted row's whole `config`".
- `apps/cli/tests/built-bin.e2e.ts:99-104` — insert pattern with a `pathToFileURL(...).href` name.

**Implication:** our patch = one `- insert:` with two child rows: the bundle entry `recursive` (`name: './src/index.ts'` or the package name) and the `cordis:group` isolate realm row (see §3).

## 3. cordis:group in a real profile (isolate realm)

**Claim:** `name: cordis:group` is a loader builtin (`cordis:` prefix → `ctx.loader.builtins`). A real profile patch can declare a group row with `isolate: {...}` and `config: [child rows]` to share one isolate realm across a provider + consumer, exactly like the bootTree fixture.

**Evidence:**
- `cordis-plugin-loader/src/config/tree.ts:145-148` — `if (name.startsWith('cordis:')) return this.ctx.loader.builtins[name.slice(7)]` — `cordis:group` is a builtin, no package needed.
- `packages/boot/app-boot/tests/config-reload.spec.ts:391-430` — a booted composition shares one isolate realm across a group: row `name: cordis:group`, `isolate: { demoRealmSvc: true }`, `config: [provider, consumer]`.
- The no-collision mechanism (lines 417-425): `provide` mints the root symbol unconditionally, but no implementation is stored under it in the root realm, so a second composition mounting the same rows cannot collide.

**Implication:** `cordis.patch.yml` should carry a `recursive-realm` row: `name: cordis:group`, `isolate: { recursive: true }`, `config: [{ id: recursive, name: ./src/index.ts }]`. The service provides under the realm symbol; the root realm can't resolve it, satisfying R2's "registered exactly once".

## 4. Module resolution (bundle `name:` in a profile)

**Claim:** two-anchor resolution. A bundle's *package name* (in `dsh.profile.bundles`) resolves from (1) the dsh installation's own dependency closure, then (2) the profile directory's `node_modules`. Within a patch, a row's `name:` is resolved by the Loader: `cordis:` → builtin; `.`-relative → against `ctx.baseUrl` (the profile dir); bare → Node module resolution (Node ESM loader).

**Evidence:**
- `profile.ts:15-21` (module doc): "a bundle name resolves first from the dsh installation ... then from the profile directory".
- `profile.ts:344-355` — `resolveBundleDir` tries `[installAnchor, profileDir/package.json]`.
- `app-boot/src/index.ts:769` — `ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'` (profile dir).
- `cordis-plugin-loader/src/config/tree.ts:154-160` — `internal.import(name, baseUrl)` / `new URL(name, baseUrl)` for relative / bare `import(name)`.

**Implication:** shipping raw `.ts` as the row `name` (e.g. `./src/index.ts`) resolves if the profile runs under `node --import tsx/esm` (the web profile does). For robustness, the plan keeps a `name: dsh-recursive-mode` (package exports) primary and a relative `./src/index.ts` file-URL fallback; the e2e fixture proves the file-URL path works.

## 5. Plugin module shape (name + apply)

**Claim:** a plugin module exports `name` (string) and `apply(ctx)`; a service is a `Service` subclass with `super(ctx, 'name')`, registered via `ctx.plugin(Class)`. `ctx.effect` must use the generator form `ctx.effect(function* () {...})` for clean unload.

**Evidence:**
- `docs/cordis-tutorial/01-first-plugin.md` — `export const name = '...'` + `export function apply(ctx) {...}`.
- `docs/cordis-tutorial/03-services.md` — Service subclass + `super(ctx, 'recursive')`.
- e2e fixture `apps/cli/tests/built-bin.e2e.ts:85-96` — `ctx.effect(() => () => { ... })` for disposal.

**Implication:** `src/index.ts` exports `name = 'dsh-recursive-mode'` + `apply(ctx)` that registers the service inside `ctx.effect(function* () { ... })`.

## 6. Tool registration (defineTool + register)

**Claim:** a read-only tool = `defineTool({ name, description, parameters, output: { schema, render }, execute })`; `ctx.tools.register(def)` returns a disposer `() => void`. `run_code` is reserved and cannot be registered.

**Evidence:**
- `packages/core/tools/src/schema.ts:545-584` — `defineTool` signature + `ToolDefinition` construction.
- `packages/core/tools/src/index.ts:1037-1059` — `register(definition): () => void`; throws for missing `output.render`/`schema`, and for `name === RUN_CODE_NAME`.
- `packages/core/tools/tests/tools.spec.ts:23-34` — `defineTool` echo example with `parameters`, `output.schema`, `output.render`, `execute`.

**Implication:** `recursive_status` = `defineTool({ name: 'recursive_status', description, parameters: { runId?: string }, output: { schema: {...}, render }, execute })`, registered via `ctx.tools.register(...)`. Name `run_code` is off-limits.

## 7. Test harness (bare Context + vitest)

**Claim:** tests mount a bare `new Context()` + `ctx.plugin(SystemPrompt)` + `ctx.plugin(ToolRuntime)`, then `ctx.tools.register`. A standalone package under `D:\DEV\recursive-mode\dsh-recursive-mode` can run vitest against `@deepseek-ai/cordis` + `@deepseek-ai/dsh-tools` if they resolve (workspace `file:` deps, or via tsx with the DSH workspace).

**Evidence:**
- `packages/core/tools/tests/tools.spec.ts:16-21` — `setup()` = `new Context()` + `ctx.plugin(SystemPrompt)` + `ctx.plugin(ToolRuntime)`.
- DSH is a pnpm workspace; `@deepseek-ai/*` packages use `workspace:`/`file:` protocol and resolve to `src` via tsx in dev.

**Implication:** recommend `devDependencies: { vitest, tsx, typescript, '@deepseek-ai/cordis': 'file:<dsh>/packages/...' }` (or a workspace link) so `npx vitest run` works from the package dir. Exact resolution needs a build or a path link; the smoke spec is the proof.

## 8. Install flow (dsh plugin CLI)

**Claim:** `dsh plugin --profile <name> add <spec>` = thin pnpm forwarder: init profile if needed, run `pnpm <args>` in the profile dir (anchoring relative path specs to the invoking cwd), then reconcile `dsh.profile.bundles` against installed state — a dependency resolving to a `dsh.bundle`-declaring package joins the layer stack.

**Evidence:**
- `apps/cli/src/plugin.ts:120-157` — `runPlugin` (init → pnpm spawn → `reconcilePlugins`).
- `plugin.ts:59-91` — `reconcilePlugins`: package with `dsh.bundle` in manifest is added to `dsh.profile.bundles`.
- `plugin.ts:104-112` — `anchorPathSpec` rewrites relative `file:`/path specs against the invoking cwd.

**Implication:** install a local bundle with `dsh plugin --profile web add <absolute-or-file:path-to-dsh-recursive-mode>`. pnpm writes the real package name; `reconcilePlugins` adds it to the web profile's `bundles`. Remove with `dsh plugin --profile web remove dsh-recursive-mode`. A local path package works (pnpm handles `file:`/link).

## Phase 3 Checklist (exact file contents decisions)

1. `dsh-recursive-mode/package.json` — `name: dsh-recursive-mode`, `version: 0.1.0`, `type: module`, `main/exports` → `./src/index.ts`, `dsh.bundle.patch` → `./cordis.patch.yml`, peerDeps `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-system-prompt` pinned `0.1.0-rc.5`, devDeps vitest/tsx/typescript.
2. `dsh-recursive-mode/cordis.patch.yml` — `- insert:` with `- id: recursive` (`name: ./src/index.ts`) and `- id: recursive-realm` (`name: cordis:group`, `isolate: { recursive: true }`, `config: [ recursive ]`).
3. `dsh-recursive-mode/src/index.ts` — `export const name` + `apply(ctx)` with `ctx.effect(function* () {...})`, registering `RecursiveRuntime extends Service` (`super(ctx, 'recursive')`).
4. `dsh-recursive-mode/src/status.ts` — TS port of `recursive-status.py` fold (RUN_ARTIFACT_SEQUENCE, `get_md_field_value`, `lock_hash_from_content`, `get_artifact_state`, `get_latest_run_directory`).
5. `dsh-recursive-mode/src/recursive_status.tool.ts` — `defineTool` + `ctx.tools.register` returning `{ runId, currentPhase, phases }`.
6. `dsh-recursive-mode/tests/smoke.spec.ts` — bare-Context mount + provide + tool read path (R2 no-collision + R5).
7. `dsh-recursive-mode/tests/status.parity.spec.ts` — golden parity against `tests/fixtures/` (R3). Compare with newline normalization (goldens captured CRLF on this box).
8. Fixture already built under `tests/fixtures/` by the fixture-builder subagent (verified vs `recursive-status.py`).