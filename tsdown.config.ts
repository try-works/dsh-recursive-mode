/**
 * tsdown config for dsh-recursive-mode (Phase D R4): two independent builds
 * sharing the lib/ outDir (clean: false so neither wipes the other's output):
 *
 *  1. Server half  — plain ESM lib/index.js from src/index.ts (platform: node),
 *     mirroring @try-works/dsh-cloudflare. Self-contained except @deepseek-ai/*
 *     peers, which the host provides at load time; zod is bundled inline because
 *     projection.ts imports it at runtime while it is only a devDependency here.
 *  2. Client half  — lib/client.js from src/client/index.ts as a browser CJS
 *     module-loader closure factory (window.__ModuleLoader__.load({id, factory})).
 *     The dsh.client.inject packages are HOST-INJECTED at compose time and never
 *     bundled: the loader links them at runtime.
 *
 * The tsc step (tsconfig.build.json, emitDeclarationOnly) emits the flat
 * lib/*.d.ts declarations: lib/index.d.ts for the server entry and
 * lib/client/index.d.ts for the client — package.json types/exports must match
 * that FLAT layout (not a lib/types/ dir).
 */
import { defineConfig } from 'tsdown'

const id = '@try-works/dsh-recursive-mode'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['es'],
    platform: 'node',
    target: 'es2022',
    dts: false,
    sourcemap: false,
    clean: false,
    external: [/^@deepseek-ai\//],
    outputOptions: {
      entryFileNames: '[name].js',
    },
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: false,
    clean: false,
    external: [/^@deepseek-ai\//, /^react$/],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(id) + ', factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
