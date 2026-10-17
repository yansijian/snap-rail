import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@snap-rail/cordis'
import { afterAll, describe, expect, it } from 'vitest'
import { COMPOSED_CONFIG_NAME, boot, composeEntries, loadBuiltinLayer, loadPresetLayers, loadUserLayer, mergeLayers } from '../src/index.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

/** A disposable test world: fresh home plus an app root linking the plugins. */
function makeWorld(): { home: string, appRoot: string, builtinPath: string, userPath: string } {
  const base = mkdtempSync(join(tmpdir(), 'snap-rail-boot-'))
  const home = join(base, 'home')
  mkdirSync(home, { recursive: true })
  const appRoot = join(base, 'app')
  const scopeDir = join(appRoot, 'node_modules', '@snap-rail')
  mkdirSync(scopeDir, { recursive: true })
  const link = (name: string, target: string) =>
    symlinkSync(target, join(scopeDir, name), 'junction')
  link('settings', join(repoRoot, 'packages/base/settings'))
  link('audit', join(repoRoot, 'packages/base/audit'))
  link('cordis-plugin-timer', join(repoRoot, 'vendor/timer'))
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'test-app', private: true, type: 'module' }))
  const builtinPath = join(base, 'builtin.cordis.yml')
  writeFileSync(builtinPath, [
    "- id: timer",
    "  name: '@snap-rail/cordis-plugin-timer'",
    "- id: settings",
    "  name: '@snap-rail/settings'",
    "- id: audit",
    "  name: '@snap-rail/audit'",
    '',
  ].join('\n'))
  const userPath = join(home, 'plugins.yml')
  return { home, appRoot, builtinPath, userPath }
}

const contexts: Context[] = []

afterAll(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
})

async function bootWorld(world: ReturnType<typeof makeWorld>): Promise<Context> {
  const ctx = await boot({
    binName: 'test',
    home: world.home,
    builtinLayerPath: world.builtinPath,
    userLayerPath: world.userPath,
    appRoot: world.appRoot,
  })
  contexts.push(ctx)
  return ctx
}

describe('boot', () => {
  it('mounts the built-in layer with services live and durable', async () => {
    const world = makeWorld()
    const ctx = await bootWorld(world)

    expect(ctx.get('settings')).toBeDefined()
    expect(ctx.get('audit')).toBeDefined()
    expect(ctx.get('timer')).toBeDefined()
    expect(ctx.get('snapRailHome')).toBe(world.home)

    ctx.settings.set('locale', 'zh-CN')
    expect(JSON.parse(readFileSync(join(world.home, 'settings.json'), 'utf8'))).toEqual({ locale: 'zh-CN' })

    const events: string[] = []
    ctx.on('audit/event', entry => events.push(entry.action))
    ctx.audit.record({ actor: 'test', action: 'plugin.enable', subject: 'timer' })
    const lines = readFileSync(join(world.home, 'audit.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).action).toBe('plugin.enable')
    expect(events).toEqual(['plugin.enable'])
  })

  it('writes the derived composition into the home', async () => {
    const world = makeWorld()
    await bootWorld(world)
    const composed = readFileSync(join(world.home, COMPOSED_CONFIG_NAME), 'utf8')
    expect(composed).toContain('- id: timer')
    expect(composed).toContain('- id: settings')
    // Entry rows carry resolved file URLs, not bare names.
    expect(composed).toContain('name: file://')
  })

  it('applies the user layer: disable a built-in plugin', async () => {
    const world = makeWorld()
    writeFileSync(world.userPath, [
      'plugins:',
      "  - name: '@snap-rail/audit'",
      '    enabled: false',
      '',
    ].join('\n'))
    const ctx = await bootWorld(world)

    expect(ctx.get('audit')).toBeUndefined()
    expect(ctx.get('settings')).toBeDefined()
  })

  it('inserts a pool plugin referenced by the user layer', async () => {
    const world = makeWorld()
    const poolDir = join(world.home, 'plugins', 'demo-plugin')
    mkdirSync(join(poolDir, 'lib'), { recursive: true })
    writeFileSync(join(poolDir, 'package.json'), JSON.stringify({
      name: 'demo-plugin', version: '0.0.1', type: 'module', main: 'lib/index.js',
    }))
    writeFileSync(join(poolDir, 'lib', 'index.js'), [
      'export default function demo(ctx) {',
      "  ctx.provide('demo.greeting', 'hi from the pool')",
      '}',
      '',
    ].join('\n'))
    writeFileSync(world.userPath, [
      'plugins:',
      '  - name: demo-plugin',
      '    enabled: true',
      '',
    ].join('\n'))
    const ctx = await bootWorld(world)

    expect(ctx.get('demo.greeting')).toBe('hi from the pool')
  })

  it('mounts a Config-declaring plugin from a row without a config key (absent reads as empty)', async () => {
    // The terminal-ops suite failure, minimized: a strict zod `Config`
    // schema rejects `undefined` outright, but a layer row that carries no
    // config must mean "apply the schema's defaults" — not a boot failure.
    const world = makeWorld()
    const poolDir = join(world.home, 'plugins', 'strict-config')
    mkdirSync(join(poolDir, 'lib'), { recursive: true })
    writeFileSync(join(poolDir, 'package.json'), JSON.stringify({
      name: 'strict-config', version: '0.0.1', type: 'module', main: 'lib/index.js',
    }))
    writeFileSync(join(poolDir, 'lib', 'index.js'), [
      "import { z } from 'zod'",
      'export default {',
      "  name: 'strict-config',",
      '  Config: z.object({ flushMs: z.number().int().min(10).default(1000) }).strict(),',
      '  apply(ctx, config) {',
      "    ctx.provide('strict-config.seen', config)",
      '  },',
      '}',
      '',
    ].join('\n'))
    // The pool entry imports zod — resolve through the app root like the
    // host's bare-import boundary does.
    symlinkSync(join(repoRoot, 'node_modules'), join(poolDir, 'node_modules'), 'junction')
    writeFileSync(world.userPath, [
      'plugins:',
      '  - name: strict-config',
      '    enabled: true',
      '',
    ].join('\n'))
    const ctx = await bootWorld(world)

    expect(ctx.get('strict-config.seen')).toEqual({ flushMs: 1000 })
  })

  it('fails loud on a user row naming an unknown plugin', async () => {
    const world = makeWorld()
    writeFileSync(world.userPath, [
      'plugins:',
      '  - name: no-such-plugin',
      '',
    ].join('\n'))
    await expect(boot({
      binName: 'test',
      home: world.home,
      builtinLayerPath: world.builtinPath,
      userLayerPath: world.userPath,
      appRoot: world.appRoot,
    })).rejects.toThrow(/no-such-plugin/)
  })
})

describe('composeEntries', () => {
  const world = () => makeWorld()

  it('replaces whole-entry config and re-disables via the user layer', () => {
    const w = world()
    const builtin = loadBuiltinLayer(w.builtinPath)
    const composed = composeEntries({
      builtin,
      userLayer: { plugins: [
        { name: '@snap-rail/settings', config: { theme: 'dark' } },
        { name: '@snap-rail/audit', enabled: false },
      ] },
      pool: new Map(),
      appRoot: w.appRoot,
    })
    const settings = composed.find(entry => entry.id === 'settings')
    expect(settings?.config).toEqual({ theme: 'dark' })
    expect(composed.find(entry => entry.id === 'audit')?.disabled).toBe(true)
  })

  it('resolves bare names through the app root to file URLs', () => {
    const w = world()
    const composed = composeEntries({
      builtin: loadBuiltinLayer(w.builtinPath),
      userLayer: { plugins: [] },
      pool: new Map(),
      appRoot: w.appRoot,
    })
    const settings = composed.find(entry => entry.id === 'settings')
    expect(settings?.name.startsWith('file://')).toBe(true)
    expect(settings?.name).toContain('packages/base/settings/lib/index.js')
  })

  it('keeps passthrough specifiers untouched', () => {
    const w = world()
    const composed = composeEntries({
      builtin: [{ id: 'raw', name: 'cordis:include' }],
      userLayer: { plugins: [] },
      pool: new Map(),
      appRoot: w.appRoot,
    })
    expect(composed[0]?.name).toBe('cordis:include')
  })

  it('loads a missing user layer as empty and rejects malformed documents', async () => {
    const w = world()
    expect(loadUserLayer(w.userPath)).toEqual({ plugins: [] })
    writeFileSync(w.userPath, 'plugins: 42\n', 'utf8')
    expect(() => loadUserLayer(w.userPath)).toThrow(/non-array "plugins"/)
  })
})

describe('preset layers', () => {
  const world = () => makeWorld()

  it('stacks beneath the user layer; the user wins per field', () => {
    const merged = mergeLayers([
      { plugins: [
        { name: '@snap-rail/settings', config: { theme: 'factory' }, enabled: true },
        { name: '@snap-rail/audit', config: { keep: 'preset' } },
        { name: '@snap-rail/mini', enabled: true },
      ] },
      { plugins: [
        { name: '@snap-rail/settings', config: { theme: 'user' } },
        { name: '@snap-rail/mini', enabled: false },
      ] },
    ])
    const settings = merged.plugins.find(row => row.name === '@snap-rail/settings')
    expect(settings?.config).toEqual({ theme: 'user' })
    // A field only the preset carries survives the merge.
    const audit = merged.plugins.find(row => row.name === '@snap-rail/audit')
    expect(audit?.config).toEqual({ keep: 'preset' })
    // The user's explicit disable overrides the preset's enable.
    const mini = merged.plugins.find(row => row.name === '@snap-rail/mini')
    expect(mini?.enabled).toBe(false)
  })

  it('a preset row mounts a pool package the user never named', () => {
    const w = world()
    const pool = new Map([['@snap-rail/mini', {
      name: '@snap-rail/mini',
      version: '0.1.0',
      dir: join(w.home, 'plugins', 'mini'),
      entryUrl: 'file:///plugins/mini/lib/index.js',
      permissions: [],
    }]])
    const composed = composeEntries({
      builtin: loadBuiltinLayer(w.builtinPath),
      presetLayers: [{ plugins: [{ name: '@snap-rail/mini', enabled: true }] }],
      userLayer: { plugins: [] },
      pool,
      appRoot: w.appRoot,
    })
    const mini = composed.find(entry => entry.id === '@snap-rail/mini')
    expect(mini).toBeDefined()
    expect(mini?.name).toBe('file:///plugins/mini/lib/index.js')
  })

  it('the user layer still wins when both carry the pool row', () => {
    const w = world()
    const pool = new Map([['@snap-rail/mini', {
      name: '@snap-rail/mini',
      version: '0.1.0',
      dir: join(w.home, 'plugins', 'mini'),
      entryUrl: 'file:///plugins/mini/lib/index.js',
      permissions: [],
    }]])
    const composed = composeEntries({
      builtin: loadBuiltinLayer(w.builtinPath),
      presetLayers: [{ plugins: [{ name: '@snap-rail/mini', enabled: true, config: { from: 'preset' } }] }],
      userLayer: { plugins: [{ name: '@snap-rail/mini', enabled: false }] },
      pool,
      appRoot: w.appRoot,
    })
    expect(composed.find(entry => entry.id === '@snap-rail/mini')).toBeUndefined()
  })

  it('loadPresetLayers stacks directories in lexical file order and skips missing dirs', () => {
    const w = world()
    const presetDir = join(w.home, 'presets')
    mkdirSync(presetDir, { recursive: true })
    writeFileSync(join(presetDir, '10-base.preset.yml'), "plugins:\n  - name: '@snap-rail/settings'\n    config: { tier: 1 }\n", 'utf8')
    writeFileSync(join(presetDir, '20-override.preset.yml'), "plugins:\n  - name: '@snap-rail/settings'\n    config: { tier: 2 }\n", 'utf8')
    const layers = loadPresetLayers([join(w.home, 'no-such-dir'), presetDir])
    expect(layers).toHaveLength(2)
    const merged = mergeLayers([...layers, { plugins: [] }])
    expect(merged.plugins[0]?.config).toEqual({ tier: 2 })
  })

  it('a broken preset file throws (the caller keeps the mounted tree)', () => {
    const w = world()
    const presetDir = join(w.home, 'presets')
    mkdirSync(presetDir, { recursive: true })
    writeFileSync(join(presetDir, 'bad.preset.yml'), 'plugins: [unclosed\n', 'utf8')
    expect(() => loadPresetLayers([presetDir])).toThrow(/failed to parse/)
  })
})
