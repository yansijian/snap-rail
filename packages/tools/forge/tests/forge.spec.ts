/**
 * The assembly-chain tests: the full creation loop over a real host world
 * (gateway + settings + store + audit) with a scripted fake LLM stream —
 * define → run → live domain, the pre-flight repair loop, renderer-report
 * steering mid-run, version semantics and rollback, boot remounting from
 * the persisted registry, and the forge RPC surface's business failures.
 *
 * @module snap-rail/forge/tests/forge.spec
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import gatewayPlugin from '@snap-rail/gateway'
import settingsPlugin from '@snap-rail/settings'
import storePlugin from '@snap-rail/store'
import auditPlugin from '@snap-rail/audit'
import { InProcessApiClient } from '@snap-rail/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createActivator } from '../src/activate.ts'
import { FORGE_LLM_KEY, type LlmConfig, type SessionDelta } from '../src/contract.ts'
import { createDispatch, type ClientReport } from '../src/dispatch.ts'
import forgePlugin from '../src/index.ts'
import { createLoop } from '../src/loop.ts'
import type { LlmStreamEvent } from '../src/llm.ts'
import { createRegistry, type ForgeRegistry } from '../src/registry.ts'
import { createRunner } from '../src/runner.ts'
import { createTools } from '../src/tools.ts'

/** A good host half: claims a wire domain, so `rpc.describe` proves mounting. */
const GOOD_HOST = [
  "const { z } = require('zod')",
  'return {',
  "  name: 'gen-demo-host',",
  "  inject: ['rpc'],",
  '  apply(ctx) {',
  "    ctx.rpc.claimDomain(ctx, 'gendemo')",
  "    ctx.rpc.method(ctx, 'gendemo.ping', { request: z.object({}).strict() }, () => ({ pong: true }))",
  '  },',
  '}',
].join('\n')

/** A host half whose apply throws — mount diagnostics must surface. */
const THROWING_HOST = [
  'return {',
  "  name: 'gen-broken-host',",
  '  apply() {',
    "    throw new Error('boom-at-mount')",
  '  },',
  '}',
].join('\n')

const CONFIG: LlmConfig = { baseUrl: 'https://gw.local/v1', apiKey: 'sk-t', model: 'fake' }

interface World {
  ctx: Context
  home: string
  registry: ForgeRegistry
  dispatch: ReturnType<typeof createDispatch>
  tools: ReturnType<typeof createTools>
  loop: ReturnType<typeof createLoop>
  /** Every broadcast frame, oldest first. */
  frames: Array<{ method: string, payload: unknown }>
  /** The scripted stream the loop runs on. */
  script: Array<(options: { messages: readonly unknown[] }) => AsyncGenerator<LlmStreamEvent>>
}

const worlds: World[] = []
const homes: string[] = []

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.ctx.fiber.dispose().catch(() => {})
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** Mount the manual-assembly world (host.apply unfolded, scriptable stream). */
async function makeWorld(options?: { home?: string }): Promise<World> {
  const home = options?.home ?? mkdtempSync(join(tmpdir(), 'snap-rail-forge-'))
  homes.push(home)
  const ctx = new Context()
  ctx.provide('snapRailHome', home)
  await ctx.plugin(gatewayPlugin, { name: 'forge-test', version: '0.1.0', bin: 'test' })
  await ctx.plugin(settingsPlugin)
  await ctx.plugin(storePlugin)
  await ctx.plugin(auditPlugin)
  const world: World = {
    ctx,
    home,
    registry: undefined as never,
    dispatch: undefined as never,
    tools: undefined as never,
    loop: undefined as never,
    frames: [],
    script: [],
  }
  const frames = world.frames
  ctx.rpc.attachDownlink(frame => { frames.push({ method: frame.method, payload: frame.payload }) })
  const db = ctx.store.register(ctx, 'forge', (await import('../src/tables.ts')).FORGE_SCHEMA)
  const registry = createRegistry(db)
  const runner = createRunner(ctx, registry)
  const dispatch = createDispatch(ctx, registry)
  const { activate } = createActivator(registry, runner, dispatch)
  const tools = createTools({ ctx, registry, runner, dispatch, activate })
  const loop = createLoop({
    ctx,
    registry,
    dispatch,
    tools,
    readConfig: () => CONFIG,
    stream: options2 => {
      const step = world.script.shift()
      if (step === undefined) throw new Error('script exhausted')
      return step({ messages: options2.messages as readonly unknown[] })
    },
  })
  Object.assign(world, { registry, dispatch, tools, loop })
  worlds.push(world)
  return world
}

/** One scripted model turn: yields the given events, one per pull. */
function turn(...events: LlmStreamEvent[]): (options: { messages: readonly unknown[] }) => AsyncGenerator<LlmStreamEvent> {
  return () => (async function* (): AsyncGenerator<LlmStreamEvent> {
    for (const event of events) yield event
  })()
}

/** A tool-call event fragment the OpenAI stream shape carries. */
function toolCall(id: string, name: string, args: unknown): LlmStreamEvent {
  return { type: 'tool-call', index: 0, id, name, args: JSON.stringify(args) }
}

/** The session deltas the world broadcast, session-filtered. */
const deltasOf = (world: World): SessionDelta[] =>
  world.frames.filter(frame => frame.method === 'forge/session-delta').map(frame => frame.payload as SessionDelta)

describe('the creation loop end to end', () => {
  it('runs define → run → final answer, landing a live wire domain', async () => {
    const world = await makeWorld()
    const session = world.registry.createSession('造个演示插件')
    world.registry.appendMessage(session.id, 'user', '造一个 ping 插件')
    world.script.push(turn(
      toolCall('c1', 'rail_define', {
        kind: 'new', id: 'demo-ping', title: '演示', summary: '首个版本',
        hostSrc: GOOD_HOST,
      }),
      { type: 'finish', reason: 'tool_calls' },
    ))
    world.script.push(turn(
      toolCall('c2', 'rail_run', { pluginId: 'demo-ping' }),
      { type: 'finish', reason: 'tool_calls' },
    ))
    world.script.push(turn({ type: 'text', text: '做好了。' }, { type: 'finish', reason: 'stop' }))
    await world.loop.run({ sessionId: session.id })

    // The persisted conversation: user, assistant(+tool_calls), tool ×2, final.
    const log = world.registry.listMessages(session.id).map(row => row.role)
    expect(log).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])
    // The plugin: one version, activated, host half mounted live.
    const info = world.registry.listPlugins()[0]
    expect(info).toMatchObject({ id: 'demo-ping', status: 'running', currentVersionId: 'v1', versionCount: 1 })
    const described = world.ctx.rpc.describe()
    expect(described.domains.map(domain => domain.prefix)).toContain('gendemo')
    // The run's frames streamed to the workbench.
    const states = deltasOf(world).filter(delta => delta.kind === 'state').map(delta => (delta as { state: string }).state)
    expect(states).toEqual(['running', 'idle'])
  })

  it('feeds pre-flight failures back and accepts the repaired version', async () => {
    const world = await makeWorld()
    const session = world.registry.createSession('修复环')
    world.registry.appendMessage(session.id, 'user', '造一个会挂的，再修好')
    world.script.push(turn(
      toolCall('c1', 'rail_define', {
        kind: 'new', id: 'demo-fix', title: '修复演示', summary: '坏版本',
        hostSrc: 'return {',
      }),
      { type: 'finish', reason: 'tool_calls' },
    ))
    world.script.push(turn(
      toolCall('c2', 'rail_define', {
        kind: 'new', id: 'demo-fix', title: '修复演示', summary: '修好的版本',
        hostSrc: GOOD_HOST.replace('gendemo', 'genfix'),
      }),
      { type: 'finish', reason: 'tool_calls' },
    ))
    world.script.push(turn({ type: 'text', text: '修好了。' }, { type: 'finish', reason: 'stop' }))
    await world.loop.run({ sessionId: session.id })

    const [toolFail, toolOk] = world.registry.listMessages(session.id)
      .filter(row => row.role === 'tool')
      .map(row => JSON.parse(row.text) as { ok: boolean, stage?: string })
    expect(toolFail).toMatchObject({ ok: false, stage: 'preflight-host' })
    expect(toolOk).toMatchObject({ ok: true })
    expect(world.registry.listPlugins()[0]).toMatchObject({ id: 'demo-fix', status: 'stopped', versionCount: 1 })
  })

  it('captures host-mount diagnostics as the plugin status', async () => {
    const world = await makeWorld()
    const defined = world.registry.definePlugin({
      kind: 'new', id: 'demo-broken', title: '挂载即炸', summary: 'v1',
      hostSrc: THROWING_HOST, clientSrc: null,
    })
    const { activate } = createActivator(world.registry, createRunner(world.ctx, world.registry), world.dispatch)
    const result = await activate('demo-broken', defined.versionId)
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toContain('boom-at-mount')
    expect(world.registry.listPlugins()[0]).toMatchObject({ status: 'error' })
  })

  it('steers a renderer failure report into the next model turn', async () => {
    const world = await makeWorld()
    const session = world.registry.createSession('渲染修复')
    world.registry.appendMessage(session.id, 'user', '造个带界面的')
    world.script.push(turn(
      toolCall('c1', 'rail_define', {
        kind: 'new', id: 'demo-ui', title: '界面演示', summary: 'v1',
        clientSrc: "const R = require('react')\nreturn { name: 'ui', apply() {} }",
      }),
      { type: 'finish', reason: 'tool_calls' },
    ))
    world.script.push(turn(
      toolCall('c2', 'rail_run', { pluginId: 'demo-ui' }),
      { type: 'finish', reason: 'tool_calls' },
    ))
    // Turn 3: the renderer failure lands mid-stream (the run already touched
    // the plugin), then the model reads the plugin back; the loop drains the
    // steering note after the tool round.
    world.script.push(() => (async function* (): AsyncGenerator<LlmStreamEvent> {
      world.dispatch.handleReport({ id: 'demo-ui', versionId: 'v1', stage: 'load', ok: false, message: 'UI 炸了' })
      yield toolCall('c3', 'rail_read', { pluginId: 'demo-ui' })
      yield { type: 'finish', reason: 'tool_calls' }
    })())
    let seenByFinalTurn: readonly unknown[] = []
    world.script.push((options: { messages: readonly unknown[] }) => {
      seenByFinalTurn = options.messages
      return turn({ type: 'text', text: '已修复。' }, { type: 'finish', reason: 'stop' })(options)
    })
    await world.loop.run({ sessionId: session.id })

    // The board carries the renderer diagnostics; the persisted log and the
    // final turn's input both open to the injected note.
    expect(world.registry.readPlugin('demo-ui')?.info.diagnostics).toContain('渲染半边加载失败')
    expect(world.registry.listMessages(session.id).some(row => row.role === 'user' && row.text.startsWith('[系统回报]'))).toBe(true)
    const lastUser = [...seenByFinalTurn].reverse().find(message => (message as { role?: string }).role === 'user') as { content: string } | undefined
    expect(lastUser?.content).toContain('[系统回报]')
  })

  it('rolls versions back by pointer moves and remounts', async () => {
    const world = await makeWorld()
    world.registry.definePlugin({ kind: 'new', id: 'demo-roll', title: '回滚', summary: 'v1', hostSrc: GOOD_HOST, clientSrc: null })
    world.registry.definePlugin({ kind: 'existing', id: 'demo-roll', title: '回滚', summary: 'v2', hostSrc: GOOD_HOST.replaceAll('gendemo', 'genroll'), clientSrc: null })
    const runner = createRunner(world.ctx, world.registry)
    const { activate } = createActivator(world.registry, runner, world.dispatch)
    expect((await activate('demo-roll', 'v2')).ok).toBe(true)
    expect(world.registry.readPlugin('demo-roll')?.info.currentVersionId).toBe('v2')
    expect((await activate('demo-roll', 'v1')).ok).toBe(true)
    expect(world.registry.readPlugin('demo-roll')?.info.currentVersionId).toBe('v1')
    // One mounted host half per plugin — the second activation replaced it.
    expect(runner.mountedIds()).toEqual(['demo-roll'])
  })

  it('remounts enabled plugins from the persisted registry on restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'snap-rail-forge-restart-'))
    homes.push(home)
    const first = await makeWorld({ home })
    first.registry.definePlugin({ kind: 'new', id: 'demo-persist', title: '持久', summary: 'v1', hostSrc: GOOD_HOST, clientSrc: null })
    const runnerA = createRunner(first.ctx, first.registry)
    await runnerA.mountHost('demo-persist', 'v1', GOOD_HOST)
    first.registry.setCurrent('demo-persist', 'v1')
    first.registry.setStatus('demo-persist', 'running', null)
    await first.ctx.fiber.dispose()
    worlds.splice(worlds.indexOf(first), 1)

    const second = await makeWorld({ home })
    expect(second.registry.remountList().map(entry => entry.id)).toEqual(['demo-persist'])
    const runnerB = createRunner(second.ctx, second.registry)
    for (const entry of second.registry.remountList()) {
      if (entry.hostSrc !== null) await runnerB.mountHost(entry.id, entry.currentVersionId, entry.hostSrc)
    }
    expect(second.ctx.rpc.describe().domains.map(domain => domain.prefix)).toContain('gendemo')
    // Sessions and versions survived the restart too.
    expect(second.registry.readPlugin('demo-persist')?.info.versionCount).toBe(1)
  })
})

describe('the forge RPC surface', () => {
  it('serves sessions, plugin admin, and faces over the wire', async () => {
    const home = mkdtempSync(join(tmpdir(), 'snap-rail-forge-rpc-'))
    homes.push(home)
    const ctx = new Context()
    ctx.provide('snapRailHome', home)
    await ctx.plugin(gatewayPlugin, { name: 'forge-rpc-test', version: '0.1.0', bin: 'test' })
    await ctx.plugin(settingsPlugin)
    await ctx.plugin(storePlugin)
    await ctx.plugin(auditPlugin)
    await ctx.plugin(forgePlugin)
    worlds.push({ ctx, home } as World)
    const client = new InProcessApiClient(request => ctx.rpc.handleClientRequest(request))

    // Sessions start empty; a send without an LLM config still starts and
    // lands the configuration hint as the assistant turn.
    expect((await client.call('forge.session.list', {})).value.sessions).toHaveLength(0)
    const sent = await client.call('forge.session.send', { text: '你好' })
    expect(sent.value.started).toBe(true)
    const messages = await client.call('forge.session.messages', { sessionId: sent.value.sessionId })
    expect(messages.value.messages.map(row => row.role)).toEqual(['user', 'assistant'])
    expect(messages.value.messages[1]?.text).toContain('AI 创造')

    // Plugin admin over an empty registry; unknown ids are business failures.
    expect((await client.call('forge.plugin.list', {})).value.plugins).toHaveLength(0)
    expect((await client.call('forge.plugin.set-enabled', { id: 'ghost', enabled: true })).ok).toBe(false)
    expect((await client.call('forge.plugin.remove', { id: 'ghost' })).ok).toBe(false)
    expect((await client.call('forge.gen-faces', {})).value.faces).toHaveLength(0)

    // Configuring the endpoint makes the next send reach the loop's stream.
    await client.call('settings.set', { key: FORGE_LLM_KEY, value: CONFIG })
    const second = await client.call('forge.session.send', { sessionId: sent.value.sessionId, text: '再来' })
    expect(second.ok).toBe(true)
  })
})
