import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@snap-rail/cordis'
import { InProcessApiClient } from '@snap-rail/protocol'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import pluginAdminRpcPlugin from '../src/rpc.ts'
import { boot } from '../src/index.ts'
import type { LayerAdmin } from '../src/index.ts'
import { loadUserLayer, packageNameOf } from '../src/compose.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

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

  it('reports pool plugins from their real mounted state', async () => {
    const world = await makeWorld()
    const poolDir = join(world.home, 'plugins')
    mkdirSync(join(poolDir, '@snap-rail__mini', 'lib'), { recursive: true })
    writeFileSync(join(poolDir, '@snap-rail__mini', 'package.json'), JSON.stringify({
      name: '@snap-rail/mini', version: '0.1.0', type: 'module', main: 'lib/index.js',
      snapRail: { kind: 'plugin' },
    }))
    writeFileSync(join(poolDir, '@snap-rail__mini', 'lib', 'index.js'), 'export default { name: "mini", apply() {} }\n')

    const listed = async (): Promise<Map<string, { source: string, enabled: boolean }>> => {
      const result = await world.client.call('plugins.list', {})
      if (!result.ok) throw new Error('plugins.list failed')
      return new Map(result.value.plugins.map(plugin => [plugin.name, plugin]))
    }

    // Installed but never enabled: listed as an off pool package.
    expect((await listed()).get('@snap-rail/mini')).toMatchObject({ source: 'pool', enabled: false })

    // Explicitly enabled: mounted by composition, so the flag is true.
    writeFileSync(world.userPath, "plugins:\n  - name: '@snap-rail/mini'\n    enabled: true\n")
    expect((await listed()).get('@snap-rail/mini')).toMatchObject({ source: 'pool', enabled: true })

    // Explicitly disabled: the composition omits the entry entirely, and the
    // listing must follow that (a disabled pool plugin is absent, not patched).
    writeFileSync(world.userPath, "plugins:\n  - name: '@snap-rail/mini'\n    enabled: false\n")
    expect((await listed()).get('@snap-rail/mini')).toMatchObject({ source: 'pool', enabled: false })
  })

  it('keeps renderer rows on the user source with the row flag as truth', async () => {
    const world = await makeWorld(undefined, ['@snap-rail/renderer-demo'])
    writeFileSync(world.userPath, [
      'plugins:',
      "  - name: '@snap-rail/renderer-demo'",
      '    enabled: false',
      '',
    ].join('\n'))
    const listed = await world.client.call('plugins.list', {})
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    const byName = new Map(listed.value.plugins.map(plugin => [plugin.name, plugin]))
    expect(byName.get('@snap-rail/renderer-demo')).toMatchObject({ source: 'user', enabled: false })
  })

  it('uninstalls through the wire without leaving a row behind', async () => {
    const world = await makeWorld()
    const poolDir = join(world.home, 'plugins')
    mkdirSync(join(poolDir, '@snap-rail__mini', 'lib'), { recursive: true })
    writeFileSync(join(poolDir, '@snap-rail__mini', 'package.json'), JSON.stringify({
      name: '@snap-rail/mini', version: '0.1.0', type: 'module', main: 'lib/index.js',
    }))
    writeFileSync(join(poolDir, '@snap-rail__mini', 'lib', 'index.js'), 'export default { name: "mini", apply() {} }\n')
    // Enable it first: the uninstall must remove the mounted row entirely,
    // not park it as a disabled row naming a package that is gone.
    writeFileSync(world.userPath, "plugins:\n  - name: '@snap-rail/mini'\n    enabled: true\n")
    await world.layers.apply()

    const off = await world.client.call('plugins.uninstall', { name: '@snap-rail/mini' })
    expect(off).toEqual({ ok: true, value: { removed: true } })
    expect(existsSync(join(poolDir, '@snap-rail__mini'))).toBe(false)
    expect(readFileSync(world.userPath, 'utf8')).not.toContain('@snap-rail/mini')
    // The on-disk layers still compose — the next boot cannot fail on a
    // stale row.
    expect(() => world.layers.recompose()).not.toThrow()
  })

  it('installs a higher version over an installed package and keeps the row', async () => {
    const world = await makeWorld()
    const poolDir = join(world.home, 'plugins')
    const { zipSync } = await import('fflate')
    const writeZip = (version: string): string => {
      const path = join(world.home, `mini-${version}.zip`)
      writeFileSync(path, new Uint8Array(zipSync({
        'package.json': new TextEncoder().encode(JSON.stringify({
          name: '@snap-rail/mini', version, type: 'module', main: 'lib/index.js',
        })),
        'lib/index.js': new TextEncoder().encode(`export default { name: 'mini', apply() {} }\n// v${version}\n`),
      })))
      return path
    }

    // Fresh install lands disabled with updated: false.
    const first = await world.client.call('plugins.install', { zipPath: writeZip('0.1.0') })
    expect(first).toEqual({ ok: true, value: { installed: { name: '@snap-rail/mini', version: '0.1.0', updated: false } } })

    // Inspecting a newer zip names the installed version and the verdict.
    const peek = await world.client.call('plugins.inspect', { zipPath: writeZip('0.2.0') })
    expect(peek.ok).toBe(true)
    if (peek.ok) {
      expect(peek.value.plugin.action).toBe('update')
      expect(peek.value.plugin.installed).toEqual({ version: '0.1.0' })
    }

    // The update goes through the wire: the pool copy is swapped, the user
    // row survives (same package name), and the audit trail says update.
    writeFileSync(world.userPath, "plugins:\n  - name: '@snap-rail/mini'\n    enabled: true\n")
    const second = await world.client.call('plugins.install', { zipPath: writeZip('0.2.0') })
    expect(second).toEqual({ ok: true, value: { installed: { name: '@snap-rail/mini', version: '0.2.0', updated: true } } })
    expect(readFileSync(join(poolDir, '@snap-rail__mini', 'lib', 'index.js'), 'utf8')).toContain('// v0.2.0')
    expect(readFileSync(world.userPath, 'utf8')).toContain("'@snap-rail/mini'")
    expect(() => world.layers.recompose()).not.toThrow()
    const trail = readFileSync(join(world.home, 'audit.jsonl'), 'utf8')
    expect(trail).toContain('"action":"plugin.install"')
    expect(trail).toContain('"action":"plugin.update"')
    expect(trail).toContain('"from":"0.1.0"')
    expect(trail).toContain('"to":"0.2.0"')

    // The list carries the pool version; the older zip is blocked on inspect
    // and refused on install (downgrade goes through an explicit uninstall).
    const listed = await world.client.call('plugins.list', {})
    expect(listed.ok && listed.value.plugins.find(plugin => plugin.name === '@snap-rail/mini')?.version).toBe('0.2.0')
    const back = await world.client.call('plugins.inspect', { zipPath: writeZip('0.1.0') })
    expect(back.ok && back.value.plugin.action).toBe('blocked')
    // Refusal on the wire; the conflict *code* mapping is asserted in the
    // settings-station UI spec (this world mixes source-plane and built
    // protocol instances, so business-error identity stops at ok:false).
    const refused = await world.client.call('plugins.install', { zipPath: writeZip('0.1.0') })
    expect(refused.ok).toBe(false)
  })

  it('serves the market over the wire: catalog verdicts and remote installs', async () => {
    const world = await makeWorld()
    const poolDir = join(world.home, 'plugins')
    const { zipSync } = await import('fflate')
    const zipBytes = (version: string): Uint8Array => new Uint8Array(zipSync({
      'package.json': new TextEncoder().encode(JSON.stringify({
        name: '@snap-rail/mini', version, type: 'module', main: 'lib/index.js',
      })),
      'lib/index.js': new TextEncoder().encode(`export default { name: 'mini', apply() {} }\n// v${version}\n`),
    }))
    const catalog: { plugins: Array<{ name: string, version: string, description: string, file: string }> } = {
      plugins: [{ name: '@snap-rail/mini', version: '0.3.0', description: 'mini market plugin', file: 'mini.zip' }],
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const key = String(url)
      if (key === 'http://feed.test/plugins/index.json') return new Response(JSON.stringify(catalog))
      if (key === `http://feed.test/plugins/${catalog.plugins[0]!.file}`) return new Response(zipBytes(catalog.plugins[0]!.version))
      return new Response('not found', { status: 404 })
    }))

    // Without a configured feed the market refuses before any fetch.
    const unconfigured = await world.client.call('plugins.remote-list', {})
    expect(unconfigured.ok).toBe(false)
    expect(downloadsOf()).toHaveLength(0)

    world.ctx.settings.set('plugins.feedUrl', 'http://feed.test/plugins')
    const listed = await world.client.call('plugins.remote-list', {})
    expect(listed.ok).toBe(true)
    if (listed.ok) {
      expect(listed.value.feedUrl).toBe('http://feed.test/plugins')
      expect(listed.value.plugins[0]).toMatchObject({ name: '@snap-rail/mini', version: '0.3.0', action: 'install' })
    }

    // The remote install lands the pool copy; the audit marks the market path.
    const installed = await world.client.call('plugins.remote-install', { name: '@snap-rail/mini' })
    expect(installed).toEqual({ ok: true, value: { installed: { name: '@snap-rail/mini', version: '0.3.0', updated: false } } })
    expect(readFileSync(join(poolDir, '@snap-rail__mini', 'lib', 'index.js'), 'utf8')).toContain('// v0.3.0')
    const trail = readFileSync(join(world.home, 'audit.jsonl'), 'utf8')
    expect(trail).toContain('"via":"market"')

    // A newer feed version updates in place; an unknown name is a refusal.
    catalog.plugins[0]!.version = '0.4.0'
    const updated = await world.client.call('plugins.remote-install', { name: '@snap-rail/mini' })
    expect(updated).toEqual({ ok: true, value: { installed: { name: '@snap-rail/mini', version: '0.4.0', updated: true } } })
    const absent = await world.client.call('plugins.remote-install', { name: '@snap-rail/absent' })
    expect(absent.ok).toBe(false)
    // The catalog badge follows the pool state: the feed (0.4.0) is now
    // older than the installed copy.
    catalog.plugins[0]!.version = '0.2.0'
    const listedAgain = await world.client.call('plugins.remote-list', {})
    expect(listedAgain.ok && listedAgain.value.plugins[0]?.action).toBe('local-newer')
  })

  /** The fetch stub records nothing itself; assert via its call log. */
  function downloadsOf(): unknown[] {
    const stub = vi.mocked(globalThis.fetch)
    return stub === undefined ? [] : stub.mock.calls
  }

  it('refuses a write that would not compose, leaving the file untouched', async () => {
    const world = await makeWorld()
    // A fresh home has no plugins.yml yet; a rejected write must not create one.
    expect(existsSync(world.userPath)).toBe(false)
    const off = await world.client.call('plugins.set-enabled', { name: '@snap-rail/absent', enabled: true })
    expect(off.ok).toBe(false)
    // A written-but-uncomposable file would brick the next boot; the write
    // is validated before the file ever changes.
    expect(existsSync(world.userPath)).toBe(false)
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
