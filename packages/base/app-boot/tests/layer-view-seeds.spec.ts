/** The contributed-seed precheck: a consumer's `client.externalSeeds` must
 * name ids that an installed provider declares among its `client.seeds`.
 * The fixture builds real pool packages so the scan→manifest→view path is
 * exercised end to end.
 *
 * @module snap-rail/app-boot/tests/layer-view-seeds
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLayerView } from '../src/layer-view.ts'
import type { LayerHandles } from '../src/admin.ts'
import { scanPluginPool } from '../src/scan.ts'

const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeWorld(): { dir: string, handles: LayerHandles, poolDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'layer-view-seeds-'))
  roots.push(dir)
  const builtinPath = join(dir, 'builtins.cordis.yml')
  writeFileSync(builtinPath, '[]\n')
  const poolDir = join(dir, 'pool')
  mkdirSync(poolDir, { recursive: true })
  const handles = {
    builtinLayerPath: builtinPath,
    userLayerPath: join(dir, 'plugins.yml'),
    presetDirs: [join(dir, 'presets')],
    poolDirs: [poolDir],
    appRoot: dir,
    rendererPackages: [],
  } as LayerHandles
  return { dir, handles, poolDir }
}

function writePackage(poolDir: string, name: string, snapRail: Record<string, unknown>): void {
  const pkgDir = join(poolDir, name.replaceAll('/', '__'))
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'lib/index.js', snapRail }))
}

describe('layer view: contributed-seed precheck', () => {
  it('a declared seed with a declaring provider is satisfied', () => {
    const { handles, poolDir } = makeWorld()
    writePackage(poolDir, '@acme/framework-x', { client: { entry: 'lib/client.js', seeds: ['ui'] } })
    writePackage(poolDir, '@t/widget', { framework: '@acme/framework-x', client: { entry: 'lib/client.js', externalSeeds: ['@acme/framework-x/ui'] } })
    const view = createLayerView(handles)
    expect(view.missingSeeds('@t/widget', scanPluginPool([poolDir]))).toEqual([])
  })

  it('an undeclared subpath is reported against its installed provider', () => {
    const { handles, poolDir } = makeWorld()
    writePackage(poolDir, '@acme/framework-x', { client: { entry: 'lib/client.js', seeds: ['ui'] } })
    writePackage(poolDir, '@t/widget', { client: { entry: 'lib/client.js', externalSeeds: ['@acme/framework-x/ui', '@acme/framework-x/charts'] } })
    const view = createLayerView(handles)
    expect(view.missingSeeds('@t/widget', scanPluginPool([poolDir]))).toEqual([
      '@acme/framework-x/charts（提供方 @acme/framework-x 未声明该贡献面）',
    ])
  })

  it('an absent provider reports every seed it owes', () => {
    const { handles, poolDir } = makeWorld()
    writePackage(poolDir, '@t/widget', { client: { entry: 'lib/client.js', externalSeeds: ['@acme/framework-x/ui', 'plain/ext'] } })
    const view = createLayerView(handles)
    expect(view.missingSeeds('@t/widget', scanPluginPool([poolDir]))).toEqual([
      '@acme/framework-x/ui（提供方 @acme/framework-x 未安装）',
      'plain/ext（提供方 plain 未安装）',
    ])
  })

  it('a package without externalSeeds is always satisfied', () => {
    const { handles, poolDir } = makeWorld()
    writePackage(poolDir, '@t/plain', {})
    const view = createLayerView(handles)
    expect(view.missingSeeds('@t/plain', scanPluginPool([poolDir]))).toEqual([])
  })
})
