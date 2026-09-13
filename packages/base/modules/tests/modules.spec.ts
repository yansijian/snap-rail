// @vitest-environment happy-dom
/**
 * The plugin module loader: queue→live handoff, seeded shared instances,
 * duplicate/circle failure modes, and the bundle script loader's timeout.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { installModuleLoader, loadPluginBundle, type ModuleLoaderGlobal } from '../src/index.ts'

afterEach(() => {
  delete (globalThis as { __ModuleLoader__?: ModuleLoaderGlobal }).__ModuleLoader__
})

function loader(): { global: { __ModuleLoader__?: ModuleLoaderGlobal }, create: ReturnType<typeof installModuleLoader> } {
  const scope: { __ModuleLoader__?: ModuleLoaderGlobal } = {}
  const create = installModuleLoader(scope)
  return { global: scope, create }
}

describe('plugin module loader', () => {
  it('collects early registrations in queue mode and replays them on create', () => {
    const { global: scope, create } = loader()
    scope.__ModuleLoader__!.load({
      id: 'pkg-a',
      factory: require => ({ value: (require('seeded') as number) + 1 }),
    })
    const system = create()
    system.seed('seeded', 41)
    expect(system.require('pkg-a')).toEqual({ value: 42 })
  })

  it('accepts registrations after create too', () => {
    const { global: scope, create } = loader()
    const system = create()
    system.seed('x', 'shared')
    scope.__ModuleLoader__!.load({ id: 'late', factory: require => ({ x: require('x') }) })
    expect(system.require('late')).toEqual({ x: 'shared' })
  })

  it('executes each factory once and caches exports (shared by identity)', () => {
    const { global: scope, create } = loader()
    let runs = 0
    scope.__ModuleLoader__!.load({ id: 'once', factory: () => { runs += 1; return { tag: {} } } })
    const system = create()
    const first = system.require('once')
    const second = system.require('once')
    expect(runs).toBe(1)
    expect(first).toBe(second)
  })

  it('routes dependency requires through seeds and bundles alike', () => {
    const { global: scope, create } = loader()
    scope.__ModuleLoader__!.load({
      id: 'inner',
      factory: () => ({ n: 7 }),
    })
    scope.__ModuleLoader__!.load({
      id: 'outer',
      factory: require => ({ inner: (require('inner') as { n: number }).n }),
    })
    const system = create()
    expect(system.require('outer')).toEqual({ inner: 7 })
  })

  it('fails loud on duplicate bundle ids and unknown modules', () => {
    const { global: scope, create } = loader()
    scope.__ModuleLoader__!.load({ id: 'dup', factory: () => ({}) })
    const system = create()
    expect(() => scope.__ModuleLoader__!.load({ id: 'dup', factory: () => ({}) })).toThrow(/duplicate/)
    expect(() => system.require('nowhere')).toThrow(/no module named/)
  })

  it('rejects circular requires', () => {
    const { global: scope, create } = loader()
    scope.__ModuleLoader__!.load({ id: 'a', factory: require => (require('b') as object) })
    scope.__ModuleLoader__!.load({ id: 'b', factory: require => (require('a') as object) })
    const system = create()
    expect(() => system.require('a')).toThrow(/circular/)
  })

  it('create rejects a second system per installed global', () => {
    const { create } = loader()
    create()
    expect(() => create()).toThrow(/already created/)
  })

  it('the global require face resolves seeds and bundles once live', () => {
    const { global: scope, create } = loader()
    scope.__ModuleLoader__!.load({ id: 'bundle-x', factory: () => ({ from: 'bundle' }) })
    expect(() => scope.__ModuleLoader__!.require('bundle-x')).toThrow(/not live/)
    const system = create()
    system.seed('seeded', { from: 'seed' })
    expect(scope.__ModuleLoader__!.require('seeded')).toEqual({ from: 'seed' })
    expect(scope.__ModuleLoader__!.require('bundle-x')).toEqual({ from: 'bundle' })
    expect(() => scope.__ModuleLoader__!.require('nowhere')).toThrow(/no module named/)
  })
})

describe('loadPluginBundle', () => {
  it('rejects when the script neither loads nor registers (error or timeout)', async () => {
    await expect(loadPluginBundle(document, 'snap-plugin://pool/ghost/lib/client.js', 25))
      .rejects.toThrow(/timed out|failed to load/)
  })
})
