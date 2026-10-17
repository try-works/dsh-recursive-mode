/**
 * THE RECURSIVE GATES FILE + ROUTE — the configuration surface's host half.
 *
 * WHAT THIS SPEC PINS, in the owner's terms: the config surface must be reachable "via the Recursive
 * tab in the chat context view", which means the settings must be readable from a WORKSPACE FILE and
 * writable through the host route. The assertions below are ordered by the contract:
 *
 *   1. the file validates and writes atomically; unknown keys / bad default labels / a disabled
 *      run-start ask / malformed JSON are REFUSED BY NAME, never silently ignored;
 *   2. the precedende rule: a non-default plugin Config wins, the file fills the Config's defaults,
 *      no file is today's behaviour;
 *   3. the file is read at USE time (a save after mount changes the next lint / ask / dispatch), which
 *      is proven through the REAL runtime — not only through the resolver;
 *   4. GET /gates reports the effective settings plus their sources, PUT writes, a bad PUT is a 4xx
 *      with the named problem and the file on disk is untouched.
 */
import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '../src/index.ts'
import {
  gatesConfigPath,
  readGatesConfig,
  resolveEffectiveGates,
  validateEffectiveGates,
  validateGatesFile,
  writeGatesConfig,
} from '../src/gates-config.ts'
import { makeRecursiveRoutes, type RecursiveRouteHost } from '../src/live-route.ts'

const RUN = 'gates-run'
const QA_ARTIFACT = '05-manual-qa.md'

/** A minimal phase-5 artifact that gets PAST the header check (the human-review rules live below it). */
function qaArtifact(mode = 'agent-operated'): string {
  return [
    'Run: `/.recursive/run/' + RUN + '/`',
    'Phase: `05 Manual QA`',
    'Status: `DRAFT`',
    'Inputs:',
    '- `/.recursive/run/' + RUN + '/02-to-be-plan.md`',
    'Outputs:',
    '- `/.recursive/run/' + RUN + '/05-manual-qa.md`',
    'Scope note: the gates-config fixture run.',
    '',
    '- QA Execution Mode: ' + mode,
    '',
  ].join('\n')
}

/** The tool result's JSON payload — the same reader the sibling ask specs use. */
function payload(result: unknown): Record<string, unknown> {
  const env = JSON.parse(JSON.stringify(result)) as { value?: unknown; content?: Array<{ text: string }> }
  if (env.value !== undefined && env.value !== null && typeof env.value === 'object') {
    return env.value as Record<string, unknown>
  }
  if (Array.isArray(env.content) && env.content[0]?.text !== undefined) {
    return JSON.parse(env.content[0].text) as Record<string, unknown>
  }
  return env as unknown as Record<string, unknown>
}

interface Mount {
  ctx: Context
  repo: string
  call: (args: Record<string, unknown>, callId: string) => Promise<unknown>
  asked: unknown[]
  dispose: () => Promise<void>
}

/** Mount the REAL plugin in a temp repo, scaffold one run, and record channel traffic. */
async function mount(config: Record<string, unknown> = {}): Promise<Mount> {
  const repo = mkdtempSync(join(tmpdir(), 'rm-gates-host-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(plugin as never, { serverSurface: true, repoRoot: repo, ...config } as never)
  await ctx.recursive.initRun(RUN)
  const asked: unknown[] = []
  ctx.recursive.attachUserQuestions({
    ask: (request: never) => {
      asked.push(request)
      const parsed = request as unknown as { questions: Array<{ id: string }> }
      return Promise.resolve({ answers: [{ id: parsed.questions[0]!.id, selected: ['pragmatic'] }] })
    },
  })
  return {
    ctx,
    repo,
    asked,
    call: (args, callId) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(callId),
      name: 'recursive_ask',
      arguments: args,
      agent: { session: { header: { cwd: repo } } },
    } as never),
    dispose: async () => {
      await ctx.fiber.dispose()
      rmSync(repo, { recursive: true, force: true })
    },
  }
}

/** Write a raw gates file (including deliberately invalid content) under a repo root. */
function writeRaw(repo: string, body: string): void {
  mkdirSync(join(repo, '.recursive', 'config'), { recursive: true })
  writeFileSync(gatesConfigPath(repo), body, 'utf8')
}

/* ========================================================================== */
/* 1. the file: shape, defaults, atomic write, named refusals                 */
/* ========================================================================== */

describe('the workspace gates file', () => {
  it('1a. a missing file is today\'s behaviour: ok with no value', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-gates-missing-'))
    try {
      expect(readGatesConfig(root)).toEqual({ ok: true, value: null })
      expect(gatesConfigPath(root)).toBe(join(root, '.recursive', 'config', 'recursive-gates.json'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('1b. writes atomically (temp + rename, no temp left) and reads back the same value', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-gates-write-'))
    try {
      const path = writeGatesConfig(root, {
        qa: { humanReview: true },
        gates: { tddMode: { ask: false, default: 'strict' } },
      })
      expect(path).toBe(gatesConfigPath(root))
      expect(readdirSync(join(root, '.recursive', 'config'))).toEqual(['recursive-gates.json'])
      const read = readGatesConfig(root)
      expect(read.ok).toBe(true)
      if (!read.ok) return
      expect(read.value?.qa?.humanReview).toBe(true)
      expect(read.value?.gates?.tddMode).toEqual({ ask: false, default: 'strict' })
      // Defaults fill only the sections the file named; a section it did not name stays absent.
      expect(read.value?.gates?.qaSignoff?.default).toBe('agent-operated')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('1c. refuses an UNKNOWN KEY by name, listing the keys that are allowed', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-gates-unknown-'))
    try {
      writeRaw(root, JSON.stringify({ gates: { tddMode: { ask: true, bogus: 1 } } }))
      const read = readGatesConfig(root)
      expect(read.ok).toBe(false)
      if (read.ok) return
      expect(read.problem).toContain('RM1147')
      expect(read.problem).toContain('gates.tddMode.bogus')
      expect(read.problem).toContain('allowed keys here: ask, default')
      // And the WRITE path refuses it too, with the file on disk untouched.
      const before = readFileSync(gatesConfigPath(root), 'utf8')
      expect(() => writeGatesConfig(root, { gates: { nope: { ask: true } } })).toThrow(/RM1147[\s\S]*unknown key "gates.nope"/)
      expect(readFileSync(gatesConfigPath(root), 'utf8')).toBe(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('1d. refuses a default that is not a label of its gate (RM1145)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-gates-label-'))
    try {
      writeRaw(root, JSON.stringify({ gates: { tddMode: { default: 'banana' } } }))
      const read = readGatesConfig(root)
      expect(read.ok).toBe(false)
      if (read.ok) return
      expect(read.problem).toContain('RM1145')
      expect(read.problem).toContain('gates.tddMode.default is "banana"')
      expect(read.problem).toContain('strict | pragmatic')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('1e. refuses a disabled run-start ask (RM1146) and a malformed file (RM1147)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-gates-runstart-'))
    try {
      writeRaw(root, JSON.stringify({ gates: { runStart: { ask: false } } }))
      const runStart = readGatesConfig(root)
      expect(runStart.ok).toBe(false)
      if (!runStart.ok) {
        expect(runStart.problem).toContain('RM1146')
        expect(runStart.problem).toContain('gates.runStart.ask is false')
      }
      writeRaw(root, '{ not json')
      const broken = readGatesConfig(root)
      expect(broken.ok).toBe(false)
      if (!broken.ok) {
        expect(broken.problem).toContain('RM1147')
        expect(broken.problem).toContain('not valid JSON')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/* ========================================================================== */
/* 2. precedence: a non-default Config wins; the file fills the defaults      */
/* ========================================================================== */

describe('precedence', () => {
  it('2a. with no Config and no file, the documented defaults apply (tdd asks nobody, records strict)', () => {
    const resolution = resolveEffectiveGates(undefined, null)
    expect(resolution.effective).toEqual({
      qa: { humanReview: false },
      gates: {
        runStart: { ask: true },
        tddMode: { ask: false, default: 'strict' },
        qaSignoff: { ask: true, default: 'agent-operated' },
        gateBlock: { ask: true },
      },
      teammate: { primitiveRoles: [] },
    })
    expect(resolution.sources['gates.tddMode.ask']).toBe('default')
  })

  it('2b. the file fills what the Config left at its default, and the sources say so per field', () => {
    const resolution = resolveEffectiveGates(undefined, {
      qa: { humanReview: true },
      gates: { tddMode: { ask: false, default: 'pragmatic' }, qaSignoff: { ask: true, default: 'hybrid' } },
      teammate: { primitiveRoles: ['code-reviewer'] },
    })
    expect(resolution.effective.qa.humanReview).toBe(true)
    expect(resolution.effective.gates.tddMode).toEqual({ ask: false, default: 'pragmatic' })
    expect(resolution.effective.gates.qaSignoff).toEqual({ ask: true, default: 'hybrid' })
    expect(resolution.effective.teammate.primitiveRoles).toEqual(['code-reviewer'])
    expect(resolution.sources).toMatchObject({
      'qa.humanReview': 'file',
      'gates.tddMode.ask': 'file',
      'gates.tddMode.default': 'file',
      // The file NAMED this gate, so the file decides it even though the value it wrote happens to
      // equal the schema default. A named field is a decision; an absent one is what defaults fill.
      'gates.qaSignoff.ask': 'file',
      'gates.qaSignoff.default': 'file',
      'teammate.primitiveRoles': 'file',
    })
    expect(resolution.fromFile['gates.tddMode.default']).toBe('pragmatic')
    expect(resolution.fromConfig).toEqual({})
  })

  it('2c. a CONFIG value away from its schema default WINS over the file, per field', () => {
    // The Config asks for the tdd-mode question (its default is not to ask), requires human review
    // (default false) and silences gate-block (default true); the file contradicts all three. The Config
    // must win on exactly those fields.
    const resolution = resolveEffectiveGates(
      { qa: { humanReview: true }, gates: { tddMode: { ask: true }, gateBlock: { ask: false } } },
      {
        qa: { humanReview: false },
        gates: {
          tddMode: { ask: false, default: 'pragmatic' },
          qaSignoff: { ask: true, default: 'human' },
          gateBlock: { ask: true },
        },
      },
    )
    expect(resolution.effective.qa.humanReview).toBe(true)
    expect(resolution.effective.gates.tddMode.ask).toBe(true)
    // The Config did not move the default away from 'strict', so the FILE fills that field —
    // precedence is per FIELD, not per section.
    expect(resolution.effective.gates.tddMode.default).toBe('pragmatic')
    // A gate the Config never mentions is decided by the file.
    expect(resolution.effective.gates.qaSignoff.ask).toBe(true)
    expect(resolution.effective.gates.qaSignoff.default).toBe('human')
    expect(resolution.effective.gates.gateBlock.ask).toBe(false)
    expect(resolution.sources['gates.tddMode.ask']).toBe('config')
    expect(resolution.sources['gates.tddMode.default']).toBe('file')
    expect(resolution.sources['gates.qaSignoff.ask']).toBe('file')
    expect(resolution.sources['gates.gateBlock.ask']).toBe('config')
    expect(resolution.fromConfig).toMatchObject({ 'qa.humanReview': true, 'gates.tddMode.ask': true, 'gates.gateBlock.ask': false })
  })

  it('2d. the effective contradiction is refused by name, whichever layer caused it', () => {
    expect(validateEffectiveGates(undefined, { qa: { humanReview: true }, gates: { qaSignoff: { ask: false } } }))
      .toMatch(/RM2203[\s\S]*qaSignoff/)
    // The Config asks for human review; the file silences the ask. Neither file-only nor Config-only
    // validation sees this, which is why the check is on the EFFECTIVE settings.
    expect(validateEffectiveGates({ qa: { humanReview: true } }, { gates: { qaSignoff: { ask: false } } }))
      .toMatch(/RM2203/)
    expect(validateEffectiveGates(undefined, { qa: { humanReview: true }, gates: { qaSignoff: { ask: true } } })).toBeNull()
  })
})

/* ========================================================================== */
/* 3. use time, through the REAL runtime                                      */
/* ========================================================================== */

describe('the runtime reads the file at USE time', () => {
  it('3a. file qa.humanReview:true makes the phase-5 lint refuse agent-operated (Config silent)', async () => {
    const m = await mount()
    try {
      // The file is written AFTER the plugin mounted, so a lint that still read its apply-time snapshot
      // cannot pass this test.
      writeRaw(m.repo, JSON.stringify({ qa: { humanReview: true } }))
      writeFileSync(join(m.repo, '.recursive', 'run', RUN, QA_ARTIFACT), qaArtifact('agent-operated'), 'utf8')
      const refused = await m.ctx.recursive.lintArtifact(RUN, QA_ARTIFACT)
      const hit = refused.errors.find((error) => error.includes('refused by configuration'))
      expect(hit, 'the file did not reach the phase-5 lint: ' + JSON.stringify(refused.errors.filter((e) => e.includes('qa.')))).toBeDefined()
      expect(String(hit)).toContain('qa.humanReview')

      // Control: remove the file and the SAME artifact no longer produces the config refusal. This is
      // what proves the assertion above came from the FILE rather than from a hardcoded lint.
      rmSync(gatesConfigPath(m.repo), { force: true })
      const allowed = await m.ctx.recursive.lintArtifact(RUN, QA_ARTIFACT)
      expect(allowed.errors.some((error) => error.includes('refused by configuration'))).toBe(false)
    } finally {
      await m.dispose()
    }
  })

  it('3b. file gates.tddMode ask:false, default:strict records strict with source config and asks nobody', async () => {
    const m = await mount()
    try {
      writeRaw(m.repo, JSON.stringify({ gates: { tddMode: { ask: false, default: 'strict' } } }))
      // The file is the layer that decided these fields (the Config is silent), so the source proves
      // the file was actually consulted rather than the Config default producing the same behaviour.
      const view = m.ctx.recursive.gatesView(m.repo)
      expect(view.sources['gates.tddMode.ask']).toBe('file')
      expect(view.sources['gates.tddMode.default']).toBe('file')

      const result = payload(await m.call({ gate: 'tdd-mode', runId: RUN }, 'tdd-file-1'))
      expect(m.asked, 'the channel must not be asked when the file disables the ask').toHaveLength(0)
      expect(result.answer).toBe('strict')
      expect(result.source).toBe('config')
      expect(result.ask).toBe('disabled')
      expect(readFileSync(join(m.repo, '.recursive', 'run', RUN, '03-implementation-summary.md'), 'utf8'))
        .toContain('- TDD Mode: strict')
    } finally {
      await m.dispose()
    }
  })

  it('3c. a file ask:true (away from the Config default) really re-enables the question', async () => {
    const m = await mount()
    try {
      writeRaw(m.repo, JSON.stringify({ gates: { tddMode: { ask: true } } }))
      expect(m.ctx.recursive.gateAsk('tdd-mode', m.repo)).toEqual({ ask: true, default: 'strict' })
      const result = payload(await m.call({ gate: 'tdd-mode', runId: RUN }, 'tdd-file-2'))
      expect(m.asked).toHaveLength(1)
      expect(result.source).toBe('channel')
      expect(result.answer).toBe('pragmatic')
    } finally {
      await m.dispose()
    }
  })

  it('3d. an explicitly configured Config wins over a contradicting file, on the ask path and the lint', async () => {
    const m = await mount({ qa: { humanReview: true }, gates: { tddMode: { ask: true } } })
    try {
      writeRaw(m.repo, JSON.stringify({ qa: { humanReview: false }, gates: { tddMode: { ask: false, default: 'strict' } } }))
      // Config wins on both fields: human review stays ON, the ask stays ON.
      expect(m.ctx.recursive.qaHumanReviewFor(m.repo)).toBe(true)
      expect(m.ctx.recursive.gateAsk('tdd-mode', m.repo).ask).toBe(true)
      const result = payload(await m.call({ gate: 'tdd-mode', runId: RUN }, 'tdd-config-1'))
      expect(m.asked).toHaveLength(1)
      expect(result.source).toBe('channel')

      writeFileSync(join(m.repo, '.recursive', 'run', RUN, QA_ARTIFACT), qaArtifact('agent-operated'), 'utf8')
      const lint = await m.ctx.recursive.lintArtifact(RUN, QA_ARTIFACT)
      expect(lint.errors.some((error) => error.includes('refused by configuration'))).toBe(true)
    } finally {
      await m.dispose()
    }
  })

  it('3e. a malformed file is NOT silently ignored: the use-time reader throws the named problem', async () => {
    const m = await mount()
    try {
      writeRaw(m.repo, JSON.stringify({ gates: { tddMode: { ask: true, typo: 1 } } }))
      expect(() => m.ctx.recursive.gateAsk('tdd-mode', m.repo)).toThrow(/RM1147[\s\S]*unknown key "gates.tddMode.typo"/)
      expect(() => m.ctx.recursive.qaHumanReviewFor(m.repo)).toThrow(/RM1147/)
      // A write of an invalid value is refused and leaves the file exactly as it was.
      const before = readFileSync(gatesConfigPath(m.repo), 'utf8')
      const written = m.ctx.recursive.writeGates(m.repo, { gates: { runStart: { ask: false } } })
      expect(written.ok).toBe(false)
      if (written.ok) return
      expect(written.problem).toContain('RM1146')
      expect(readFileSync(gatesConfigPath(m.repo), 'utf8')).toBe(before)
    } finally {
      await m.dispose()
    }
  })

  it('3f. the contradiction ACROSS the two layers is refused before it is written', async () => {
    // The Config requires a human QA sign-off; the candidate FILE (internally consistent) silences the
    // question that obtains it. `validateGatesFile` cannot see this — only the EFFECTIVE settings can —
    // so this is the wiring proof that `runtime.writeGates` composes before it writes.
    const m = await mount({ qa: { humanReview: true } })
    try {
      const target = gatesConfigPath(m.repo)
      expect(() => readFileSync(target)).toThrow()
      const written = m.ctx.recursive.writeGates(m.repo, { gates: { qaSignoff: { ask: false } } })
      expect(written.ok).toBe(false)
      if (written.ok) return
      expect(written.problem).toContain('RM2203')
      // Nothing was created: a refused save cannot leave a half-configuration behind.
      expect(() => readFileSync(target)).toThrow()
      // The Config half still decides the effective answer (it is the layer that won), which is why the
      // contradiction is a refusal rather than a silent choice between the two instructions.
      expect(m.ctx.recursive.qaHumanReviewFor(m.repo)).toBe(true)
    } finally {
      await m.dispose()
    }
  })
})

/* ========================================================================== */
/* 4. the route: GET effective + sources, PUT writes, bad PUT is a named 4xx  */
/* ========================================================================== */

interface FakeResponse {
  status: number
  headers: Record<string, string>
  body: string
}

function fakeResponse(): { res: ServerResponse; done: Promise<FakeResponse> } {
  const result: FakeResponse = { status: 0, headers: {}, body: '' }
  let resolve!: (value: FakeResponse) => void
  const done = new Promise<FakeResponse>((r) => { resolve = r })
  const res = {
    writeHead: (status: number, headers: Record<string, string>) => { result.status = status; result.headers = headers },
    end: (body?: string) => { result.body = body ?? ''; resolve(result) },
    write: (chunk: string) => { result.body += chunk },
  } as unknown as ServerResponse
  return { res, done }
}

function request(method: string, url: string, headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }): IncomingMessage {
  return { method, url, headers } as unknown as IncomingMessage
}

function requestWithBody(method: string, url: string, body: string): IncomingMessage {
  const stream = Readable.from([body]) as unknown as IncomingMessage & { method: string; url: string; headers: Record<string, string> }
  stream.method = method
  stream.url = url
  stream.headers = { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
  return stream
}

/** The route's REAL host: the mounted runtime's own effective-view / write methods. */
function routeHost(recursive: Context['recursive'], repo: string): RecursiveRouteHost {
  return {
    resolveRoot: async (sessionId: string | undefined, cwd: string) => (sessionId === 's1' || cwd === repo ? repo : null),
    snapshot: async () => ({}),
    revision: () => 1,
    gates: (root) => recursive.gatesView(root),
    writeGates: (root, value) => recursive.writeGates(root, value),
  }
}

describe('GET/PUT /.recursive/api/gates', () => {
  it('4a. GET reports the effective values and the layer that decided each one', async () => {
    const m = await mount({ gates: { tddMode: { ask: true } } })
    try {
      writeRaw(m.repo, JSON.stringify({ qa: { humanReview: true }, gates: { tddMode: { ask: false, default: 'pragmatic' } } }))
      const [, , , gates] = makeRecursiveRoutes(routeHost(m.ctx.recursive, m.repo))
      expect(gates.path).toBe('/.recursive/api/gates')
      const { res, done } = fakeResponse()
      await gates.handler(request('GET', '/.recursive/api/gates?sessionId=s1'), res)
      const response = await done
      expect(response.status).toBe(200)
      const body = JSON.parse(response.body) as {
        root: string
        effective: { qa: { humanReview: boolean }; gates: { tddMode: { ask: boolean; default: string } } }
        sources: Record<string, string>
        fromConfig: Record<string, unknown>
        fromFile: Record<string, unknown>
      }
      expect(body.root).toBe(m.repo)
      expect(body.effective.qa.humanReview).toBe(true)
      // Config asks (non-default true) so it wins the ask; the file's default fills the Config default.
      expect(body.effective.gates.tddMode).toEqual({ ask: true, default: 'pragmatic' })
      expect(body.sources['qa.humanReview']).toBe('file')
      expect(body.sources['gates.tddMode.ask']).toBe('config')
      expect(body.sources['gates.tddMode.default']).toBe('file')
      expect(body.fromConfig['gates.tddMode.ask']).toBe(true)
      expect(body.fromFile['qa.humanReview']).toBe(true)
    } finally {
      await m.dispose()
    }
  })

  it('4b. PUT writes the file, and a subsequent GET reflects it', async () => {
    const m = await mount()
    try {
      const [, , , gates] = makeRecursiveRoutes(routeHost(m.ctx.recursive, m.repo))
      const value = {
        qa: { humanReview: true },
        gates: {
          runStart: { ask: true },
          tddMode: { ask: false, default: 'pragmatic' },
          qaSignoff: { ask: true, default: 'hybrid' },
          gateBlock: { ask: false },
        },
        teammate: { primitiveRoles: ['code-reviewer'] },
      }
      const put = fakeResponse()
      await gates.handler(requestWithBody('PUT', '/.recursive/api/gates?sessionId=s1', JSON.stringify(value)), put.res)
      const putResponse = await put.done
      expect(putResponse.status).toBe(200)
      const putBody = JSON.parse(putResponse.body) as { ok: boolean; path: string }
      expect(putBody.ok).toBe(true)
      expect(putBody.path).toBe(gatesConfigPath(m.repo))
      const onDisk = readGatesConfig(m.repo)
      expect(onDisk.ok).toBe(true)
      if (onDisk.ok) {
        expect(onDisk.value?.gates?.tddMode).toEqual({ ask: false, default: 'pragmatic' })
        expect(onDisk.value?.teammate?.primitiveRoles).toEqual(['code-reviewer'])
      }

      const get = fakeResponse()
      await gates.handler(request('GET', '/.recursive/api/gates?sessionId=s1'), get.res)
      const getBody = JSON.parse((await get.done).body) as { effective: { gates: { tddMode: { default: string } }; teammate: { primitiveRoles: string[] } }; sources: Record<string, string> }
      expect(getBody.effective.gates.tddMode.default).toBe('pragmatic')
      expect(getBody.effective.teammate.primitiveRoles).toEqual(['code-reviewer'])
      expect(getBody.sources['gates.tddMode.default']).toBe('file')
    } finally {
      await m.dispose()
    }
  })

  it('4c. PUT with garbage is a 4xx with the NAMED problem, and the file on disk is unchanged', async () => {
    const m = await mount()
    try {
      writeRaw(m.repo, JSON.stringify({ qa: { humanReview: true } }))
      const before = readFileSync(gatesConfigPath(m.repo), 'utf8')
      const [, , , gates] = makeRecursiveRoutes(routeHost(m.ctx.recursive, m.repo))

      const unknown = fakeResponse()
      await gates.handler(requestWithBody('PUT', '/.recursive/api/gates?sessionId=s1', JSON.stringify({ gates: { wat: true } })), unknown.res)
      const unknownBody = JSON.parse((await unknown.done).body) as { ok: boolean; problem: string }
      expect(unknown.done).toBeDefined()
      expect((await unknown.done).status).toBe(400)
      expect(unknownBody.ok).toBe(false)
      expect(unknownBody.problem).toContain('RM1147')
      expect(unknownBody.problem).toContain('gates.wat')

      const contradiction = fakeResponse()
      const contradictory = {
        qa: { humanReview: true },
        gates: { qaSignoff: { ask: false } },
      }
      await gates.handler(requestWithBody('PUT', '/.recursive/api/gates?sessionId=s1', JSON.stringify(contradictory)), contradiction.res)
      const contradictionBody = JSON.parse((await contradiction.done).body) as { ok: boolean; problem: string }
      expect((await contradiction.done).status).toBe(400)
      expect(contradictionBody.problem).toContain('RM2203')

      const notJson = fakeResponse()
      await gates.handler(requestWithBody('PUT', '/.recursive/api/gates?sessionId=s1', '{ nope'), notJson.res)
      expect((await notJson.done).status).toBe(400)
      expect((JSON.parse((await notJson.done).body) as { problem: string }).problem).toContain('not valid JSON')

      expect(readFileSync(gatesConfigPath(m.repo), 'utf8'), 'a refused PUT must not touch the file').toBe(before)
    } finally {
      await m.dispose()
    }
  })

  it('4d. the route resolves its root like /state and never trusts a client path', async () => {
    const m = await mount()
    try {
      const [, , , gates] = makeRecursiveRoutes(routeHost(m.ctx.recursive, m.repo))
      const { res, done } = fakeResponse()
      // A client-supplied `root` is not a parameter the route reads; an unknown session+cwd resolves null.
      await gates.handler(request('GET', '/.recursive/api/gates?sessionId=unknown&cwd=' + encodeURIComponent('C:/elsewhere')), res)
      const response = await done
      expect(response.status).toBe(200)
      const body = JSON.parse(response.body) as { root: string | null; effective: unknown; problem: string }
      expect(body.root).toBeNull()
      expect(body.effective).toBeNull()
      expect(body.problem).toContain('no recursive control-plane root')

      const put = fakeResponse()
      await gates.handler(requestWithBody('PUT', '/.recursive/api/gates?sessionId=unknown&cwd=C%3A%2Felsewhere', '{}'), put.res)
      expect((await put.done).status).toBe(400)
      expect(readdirSync(m.repo).includes('.recursive')).toBe(true)
      expect(() => readFileSync(gatesConfigPath(m.repo))).toThrow()
    } finally {
      await m.dispose()
    }
  })
})

/* ========================================================================== */
/* 5. the file's shape mirrors the Config's (one schema, one validation)      */
/* ========================================================================== */

describe('the file schema is composed from the Config schemas', () => {
  it('5a. every gate the Config declares is accepted by the file schema, and no extra gate is', () => {
    const accepted = validateGatesFile({ gates: { runStart: { ask: true }, tddMode: { ask: false }, qaSignoff: { ask: true }, gateBlock: { ask: true } } })
    expect(Object.keys(accepted.gates ?? {})).toEqual(['runStart', 'tddMode', 'qaSignoff', 'gateBlock'])
    expect(() => validateGatesFile({ gates: { fifthGate: { ask: true } } })).toThrow(/RM1147[\s\S]*fifthGate/)
  })

  it('5b. the file refuses fields the Config schema does not declare, at every level', () => {
    for (const bad of [
      { nope: true },
      { qa: { humanReview: true, extra: true } },
      { gates: { tddMode: { ask: true, default: 'strict', extra: true } } },
      { teammate: { primitiveRoles: [], extra: true } },
    ]) {
      expect(() => validateGatesFile(bad), JSON.stringify(bad)).toThrow(/RM1147/)
    }
  })
})
