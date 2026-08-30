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

async function makeWorld(builtinRows?: string[]): Promise<World> {
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
})
