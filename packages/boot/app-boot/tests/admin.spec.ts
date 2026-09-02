import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@snap-rail/cordis'
import { InProcessApiClient } from '@snap-rail/protocol'
import { afterAll, describe, expect, it } from 'vitest'
import pluginAdminRpcPlugin from '../src/rpc.ts'
import { boot } from '../src/index.ts'
import type { LayerAdmin } from '../src/index.ts'
import { loadUserLayer, packageNameOf } from '../src/compose.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

interface World {
  ctx: Context
  layers: LayerAdmin
  client: InProcessApiClient
  home: string
  userPath: string
  builtinPath: string
}

const worlds: World[] = []
const homes: string[] = []

afterAll(async () => {
  for (const world of worlds.splice(0)) await world.ctx.fiber.dispose()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

async function makeWorld(builtinRows?: string[], rendererPackages?: readonly string[]): Promise<World> {
  const base = mkdtempSync(join(tmpdir(), 'snap-rail-admin-'))
  homes.push(base)
  const home = join(base, 'home')
  mkdirSync(home, { recursive: true })
  const appRoot = join(base, 'app')
  const scopeDir = join(appRoot, 'node_modules', '@snap-rail')
  mkdirSync(scopeDir, { recursive: true })
  const link = (name: string, target: string) =>
    symlinkSync(target, join(scopeDir, name), 'junction')
  link('settings', join(repoRoot, 'packages/settings/settings'))
  link('audit', join(repoRoot, 'packages/audit/audit'))
  link('gateway', join(repoRoot, 'packages/protocol/gateway'))
  link('cordis-plugin-timer', join(repoRoot, 'vendor/timer'))
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'test-app', private: true, type: 'module' }))

  const builtinPath = join(base, 'builtin.cordis.yml')
  writeFileSync(builtinPath, (builtinRows ?? [
    "- id: timer",
    "  name: '@snap-rail/cordis-plugin-timer'",
    "- id: settings",
    "  name: '@snap-rail/settings'",
    "- id: audit",
    "  name: '@snap-rail/audit'",
    "- id: gateway",
    "  name: '@snap-rail/gateway'",
    "  config:",
    "    name: rig",
    "    version: 1.0.0",
    "    bin: test",
  ]).join('\n') + '\n')

  const ctx = await boot({
    binName: 'test',
    home,
    builtinLayerPath: builtinPath,
    userLayerPath: join(home, 'plugins.yml'),
    appRoot,
    rendererPackages,
  })
  await ctx.plugin(pluginAdminRpcPlugin)
  const world: World = {
    ctx,
    layers: ctx.pluginLayers,
    client: new InProcessApiClient(request => ctx.rpc.handleClientRequest(request)),
    home,
    userPath: join(home, 'plugins.yml'),
    builtinPath,
  }
  worlds.push(world)
  return world
}

async function sleepUntil(predicate: () => boolean, ms = 3000): Promise<void> {
  for (let waited = 0; !predicate() && waited < ms; waited += 50) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe('plugin layers admin', () => {
  it('disables a builtin entry through the wire, remounts it on enable', async () => {
    const world = await makeWorld()
    expect(world.ctx.get('timer')).toBeDefined()

    const off = await world.client.call('plugins.set-enabled', { name: '@snap-rail/cordis-plugin-timer', enabled: false })
    expect(off).toEqual({ ok: true, value: { applied: true } })
    expect(world.ctx.get('timer')).toBeUndefined()

    const userLayer = readFileSync(world.userPath, 'utf8')
    expect(userLayer).toContain("'@snap-rail/cordis-plugin-timer'")
    expect(userLayer).toContain('enabled: false')

    const on = await world.client.call('plugins.set-enabled', { name: '@snap-rail/cordis-plugin-timer', enabled: true })
    expect(on.ok).toBe(true)
    expect(world.ctx.get('timer')).toBeDefined()
  })

  it('lists the merged view: builtin, user rows, and pool extras', async () => {
    const world = await makeWorld()
    const listed = await world.client.call('plugins.list', {})
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    const byName = new Map(listed.value.plugins.map(plugin => [plugin.name, plugin]))
    expect(byName.get('@snap-rail/gateway')?.source).toBe('builtin')
    expect(byName.get('@snap-rail/gateway')?.enabled).toBe(true)
    // Pool extras: plugins available in the app tree but not mounted.
    expect(byName.get('@snap-rail/settings')?.enabled).toBe(true)
    // Every row carries its package so the management page can group.
    expect(byName.get('@snap-rail/gateway')?.packageName).toBe('@snap-rail/gateway')
  })

  it('replaces a config through setConfig and hot-applies it', async () => {
    const world = await makeWorld()
    const result = await world.client.call('plugins.set-config', {
      name: '@snap-rail/gateway',
      config: { name: 'renamed', version: '2.0.0', bin: 'test' },
    })
    expect(result).toEqual({ ok: true, value: { applied: true } })
    const described = await world.client.call('host.describe', {})
    expect(described.ok && described.value.name).toBe('renamed')
  })

  it('keeps the mounted tree when the user layer goes bad, then recovers', async () => {
    const world = await makeWorld()
    writeFileSync(world.userPath, 'plugins: [ broken')
    await expect(world.layers.apply()).rejects.toThrow(/user layer/)
    // The mounted tree is untouched by the failed recompose.
    expect(world.ctx.get('timer')).toBeDefined()

    writeFileSync(world.userPath, 'plugins: []')
    const changed = await world.layers.apply()
    expect(changed).toBe(false)
  })

  it('hot-applies external edits through the watch (the Agent path)', async () => {
    const world = await makeWorld()
    const stop = world.layers.startWatch()
    try {
      writeFileSync(world.userPath, [
        'plugins:',
        "  - name: '@snap-rail/cordis-plugin-timer'",
        '    enabled: false',
        '',
      ].join('\n'))
      await sleepUntil(() => world.ctx.get('timer') === undefined)
      expect(world.ctx.get('timer')).toBeUndefined()

      writeFileSync(world.userPath, 'plugins: []\n')
      await sleepUntil(() => world.ctx.get('timer') !== undefined)
      expect(world.ctx.get('timer')).toBeDefined()
    } finally {
      stop()
    }
  })

  it('audits enable and config mutations', async () => {
    const world = await makeWorld()
    await world.client.call('plugins.set-enabled', { name: '@snap-rail/settings', enabled: false })
    await world.client.call('plugins.set-config', {
      name: '@snap-rail/settings',
      config: {},
    })
    const trail = readFileSync(join(world.home, 'audit.jsonl'), 'utf8')
    expect(trail).toContain('"action":"plugin.disable"')
    expect(trail).toContain('"action":"plugin.config"')
  })

  it('renames retired row names on load and drops fully retired rows', async () => {
    // Package merges retired several row names: rows still naming them
    // rename to their successors in memory (first row wins collisions), and
    // rows whose successor no longer exists anywhere (the unified field
    // settings page replaced the ModbusTCP station face) drop on load —
    // the file converges on rewrite either way.
    const world = await makeWorld()
    writeFileSync(world.userPath, [
      'plugins:',
      "  - name: '@snap-rail/modbus-station'",
      '    enabled: false',
      "  - name: '@snap-rail/driver-modbus'",
      "  - name: '@snap-rail/driver-modbus/rpc'",
      '    enabled: false',
      "  - name: '@snap-rail/production-stats'",
      '    config:',
      '      flushMs: 250',
      '',
    ].join('\n'))
    const layer = loadUserLayer(world.userPath)
    expect(layer.plugins.map(row => [row.name, row.enabled ?? null, row.config])).toEqual([
      ['@snap-rail/driver-modbus', null, undefined],
      ['@snap-rail/suite-terminal-ops/stats', null, { flushMs: 250 }],
    ])
  })

  it('activating a suite deactivates the other suites in one write', async () => {
    // Two fake suite packages in the app tree: kind = suite in the manifest,
    // a trivial plugin entry each.
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-suite-'))
    homes.push(base)
    const home = join(base, 'home')
    const appRoot = join(base, 'app')
    const scopeDir = join(appRoot, 'node_modules', '@snap-rail')
    mkdirSync(join(scopeDir, 'suite-a', 'lib'), { recursive: true })
    mkdirSync(join(scopeDir, 'suite-b', 'lib'), { recursive: true })
    const fakeSuite = (id: string): void => {
      writeFileSync(join(scopeDir, id, 'package.json'), JSON.stringify({
        name: `@snap-rail/${id}`,
        version: '0.0.0',
        type: 'module',
        main: 'lib/index.js',
        snapRail: { kind: 'suite' },
      }))
      writeFileSync(join(scopeDir, id, 'lib', 'index.js'),
        `export default { name: '${id}', apply() {} }\n`)
    }
    fakeSuite('suite-a')
    fakeSuite('suite-b')
    symlinkSync(join(repoRoot, 'packages/protocol/gateway'), join(scopeDir, 'gateway'), 'junction')
    symlinkSync(join(repoRoot, 'packages/audit/audit'), join(scopeDir, 'audit'), 'junction')
    writeFileSync(join(appRoot, 'package.json'), JSON.stringify({ name: 'test-app', private: true, type: 'module' }))
    mkdirSync(home, { recursive: true })
    const builtinPath = join(base, 'builtin.cordis.yml')
    writeFileSync(builtinPath, [
      "- id: audit",
      "  name: '@snap-rail/audit'",
      "- id: gateway",
      "  name: '@snap-rail/gateway'",
      "  config:",
      "    name: rig",
      "    version: 1.0.0",
      "    bin: test",
      "- id: suite-a",
      "  name: '@snap-rail/suite-a'",
      "- id: suite-b",
      "  name: '@snap-rail/suite-b'",
    ].join('\n') + '\n')
    const ctx = await boot({
      binName: 'test',
      home,
      builtinLayerPath: builtinPath,
      userLayerPath: join(home, 'plugins.yml'),
      appRoot,
    })
    await ctx.plugin(pluginAdminRpcPlugin)
    worlds.push({ ctx, layers: ctx.pluginLayers, client: new InProcessApiClient(request => ctx.rpc.handleClientRequest(request)), home, userPath: join(home, 'plugins.yml'), builtinPath })
    const world = worlds[worlds.length - 1]!

    // Both suites are listed with their kind.
    const listed = await world.client.call('plugins.list', {})
    const byName = new Map(listed.ok ? listed.value.plugins.map(plugin => [plugin.name, plugin]) : [])
    expect(byName.get('@snap-rail/suite-a')?.kind).toBe('suite')
    expect(byName.get('@snap-rail/suite-b')?.kind).toBe('suite')

    // Activating b deactivates a in the same batched write.
    const on = await world.client.call('plugins.set-enabled', { name: '@snap-rail/suite-b', enabled: true })
    expect(on.ok).toBe(true)
    const rows = loadUserLayer(world.userPath).plugins.map(row => [row.name, row.enabled])
    expect(rows).toContainEqual(['@snap-rail/suite-b', true])
    expect(rows).toContainEqual(['@snap-rail/suite-a', false])
  })

  it('composes a file still carrying the retired station row', async () => {
    // The station row drops on load, so composition succeeds instead of
    // failing on a row that resolves nowhere anymore.
    const world = await makeWorld()
    writeFileSync(world.userPath, [
      'plugins:',
      "  - name: '@snap-rail/driver-modbus/station'",
      '    enabled: false',
      '',
    ].join('\n'))
    await expect(world.layers.apply()).resolves.toBeDefined()
  })
})

describe('packageNameOf', () => {
  it('keeps the scope and package of a subpath entry, passes others through', () => {
    expect(packageNameOf('@snap-rail/driver-modbus/station')).toBe('@snap-rail/driver-modbus')
    expect(packageNameOf('@snap-rail/driver-modbus')).toBe('@snap-rail/driver-modbus')
    expect(packageNameOf('@snap-rail')).toBe('@snap-rail')
    expect(packageNameOf('cordis:timer')).toBe('cordis:timer')
    expect(packageNameOf('./local/plugin')).toBe('./local/plugin')
  })
})
