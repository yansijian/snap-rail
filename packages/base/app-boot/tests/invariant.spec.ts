/**
 * The layer invariant sidecar: violations surface as data for every
 * "always-true" rule of the layer files — unresolvable rows, mutex groups
 * with two live members, enabled packages with unsatisfied requirements —
 * and a clean home reports nothing.
 *
 * @module snap-rail/app-boot/tests/invariant.spec
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@snap-rail/cordis'
import { afterAll, describe, expect, it } from 'vitest'
import { boot } from '../src/index.ts'
import type { LayerAdmin } from '../src/index.ts'
import { collectLayerViolations } from '../src/invariant.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

interface World {
  ctx: Context
  layers: LayerAdmin
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

async function makeWorld(rendererPackages?: readonly string[]): Promise<World> {
  const base = mkdtempSync(join(tmpdir(), 'snap-rail-invariant-'))
  homes.push(base)
  const home = join(base, 'home')
  mkdirSync(home, { recursive: true })
  const appRoot = join(base, 'app')
  const scopeDir = join(appRoot, 'node_modules', '@snap-rail')
  mkdirSync(scopeDir, { recursive: true })
  const link = (name: string, target: string) =>
    symlinkSync(target, join(scopeDir, name), 'junction')
  link('settings', join(repoRoot, 'packages/base/settings'))
  link('audit', join(repoRoot, 'packages/base/audit'))
  link('gateway', join(repoRoot, 'packages/base/gateway'))
  link('app-boot', join(repoRoot, 'packages/base/app-boot'))
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
    "- id: gateway",
    "  name: '@snap-rail/gateway'",
    "  config:",
    "    name: rig",
    "    version: 1.0.0",
    "    bin: test",
  ].join('\n') + '\n')

  const ctx = await boot({
    binName: 'test',
    home,
    builtinLayerPath: builtinPath,
    userLayerPath: join(home, 'plugins.yml'),
    appRoot,
    rendererPackages,
  })
  const world: World = {
    ctx,
    layers: ctx.pluginLayers,
    home,
    userPath: join(home, 'plugins.yml'),
    builtinPath,
  }
  worlds.push(world)
  return world
}

/** Drop a minimal plugin package into the home's pool with the given snapRail manifest. */
function seedPoolPackage(home: string, name: string, snapRail?: Record<string, unknown>): void {
  const dir = join(home, 'plugins', name.replaceAll('/', '__'))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '0.1.0',
    type: 'module',
    main: 'lib/index.js',
    ...snapRail !== undefined ? { snapRail } : {},
  }))
  writeFileSync(join(dir, 'lib', 'index.js'), 'export default { name: "x", apply() {} }\n')
}

describe('layer invariant sidecar', () => {
  it('reports nothing on a clean home', async () => {
    const world = await makeWorld()
    expect(collectLayerViolations(world.layers.handles)).toEqual([])
  })

  it('names a user row the composition could never resolve', async () => {
    const world = await makeWorld()
    writeFileSync(world.userPath, "plugins:\n  - name: '@snap-rail/ghost'\n    enabled: true\n")
    const violations = collectLayerViolations(world.layers.handles)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ code: 'unresolvable-row', name: '@snap-rail/ghost' })
  })

  it('flags a mutex group with two enabled members', async () => {
    const world = await makeWorld()
    seedPoolPackage(world.home, '@snap-rail/suite-a', { kind: 'suite' })
    seedPoolPackage(world.home, '@snap-rail/suite-b', { kind: 'suite' })
    writeFileSync(world.userPath, [
      'plugins:',
      "  - name: '@snap-rail/suite-a'",
      '    enabled: true',
      "  - name: '@snap-rail/suite-b'",
      '    enabled: true',
    ].join('\n') + '\n')
    const violations = collectLayerViolations(world.layers.handles)
    const conflict = violations.find(violation => violation.code === 'mutex-conflict')
    expect(conflict).toBeDefined()
    expect(conflict?.name).toBe('suite')
    expect(conflict?.detail).toContain('@snap-rail/suite-a')
    expect(conflict?.detail).toContain('@snap-rail/suite-b')
  })

  it('flags an enabled package whose requires nobody satisfies', async () => {
    const world = await makeWorld()
    seedPoolPackage(world.home, '@snap-rail/dependent', { requires: ['@snap-rail/absent'] })
    writeFileSync(world.userPath, "plugins:\n  - name: '@snap-rail/dependent'\n    enabled: true\n")
    const violations = collectLayerViolations(world.layers.handles)
    expect(violations.some(violation =>
      violation.code === 'missing-requirement' && violation.name === '@snap-rail/dependent'
      && violation.detail.includes('@snap-rail/absent'))).toBe(true)
  })

  it('counts a missing service requirement against a live-service probe', async () => {
    const world = await makeWorld()
    seedPoolPackage(world.home, '@snap-rail/wants-store', { requires: ['service:store'] })
    writeFileSync(world.userPath, "plugins:\n  - name: '@snap-rail/wants-store'\n    enabled: true\n")
    // No service is live in this bare rig: the requirement must surface.
    const without = collectLayerViolations(world.layers.handles)
    expect(without.some(violation => violation.code === 'missing-requirement')).toBe(true)
    // With the probe answering yes, the same layers come back clean.
    const withService = collectLayerViolations(world.layers.handles, () => true)
    expect(withService).toEqual([])
    expect(existsSync(world.userPath)).toBe(true)
  })
})
