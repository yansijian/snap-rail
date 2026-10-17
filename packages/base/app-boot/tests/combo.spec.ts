import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { archiveKind, inspectComboZip, readComboArchive } from '../src/combo.ts'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'snap-rail-combo-test-'))
  temps.push(dir)
  return join(dir, name)
}

/** One unsigned member zip with a legal package name and optional snapRail. */
function pluginZip(name: string, version: string, snapRail?: Record<string, unknown>): Uint8Array {
  return new Uint8Array(zipSync({
    'package.json': new TextEncoder().encode(JSON.stringify({
      name, version, type: 'module', main: 'lib/index.js',
      ...(snapRail !== undefined ? { snapRail } : {}),
    })),
    'lib/index.js': new TextEncoder().encode('export default { apply() {} }\n'),
  }))
}

const RECIPE = [
  'id: demo-base',
  'version: 1.0.0',
  'title: 演示基座',
  'kind: base',
  'description: demo base',
  'plugins:',
  "  - name: '@snap-rail/mini'",
  "  - name: '@snap-rail/sub'",
  "  - name: '@snap-rail/sub/rpc'",
  '',
].join('\n')

function comboZip(files: Record<string, Uint8Array>): string {
  const path = temp('combo.zip')
  writeFileSync(path, zipSync(files))
  return path
}

function members(overrides: Record<string, Uint8Array> = {}): Record<string, Uint8Array> {
  return {
    'plugins/mini.zip': pluginZip('@snap-rail/mini', '0.3.0'),
    'plugins/sub.zip': pluginZip('@snap-rail/sub', '1.0.0'),
    ...overrides,
  }
}

describe('archiveKind', () => {
  it('reads the root marker: package.json is a plugin, recipe.yml a combo', () => {
    const plugin = temp('plugin.zip')
    writeFileSync(plugin, pluginZip('@scope/pkg', '1.0.0'))
    expect(archiveKind(plugin)).toBe('plugin')

    const combo = comboZip({ 'recipe.yml': new TextEncoder().encode(RECIPE), ...members() })
    expect(archiveKind(combo)).toBe('combo')
  })

  it('supports a single top-level directory and recipe.yaml', () => {
    const combo = comboZip({
      'demo/recipe.yaml': new TextEncoder().encode(RECIPE),
      'demo/plugins/mini.zip': pluginZip('@snap-rail/mini', '0.3.0'),
      'demo/plugins/sub.zip': pluginZip('@snap-rail/sub', '1.0.0'),
    })
    expect(archiveKind(combo)).toBe('combo')
  })

  it('refuses an archive carrying both markers and one carrying neither', () => {
    const both = comboZip({
      'recipe.yml': new TextEncoder().encode(RECIPE),
      'package.json': new TextEncoder().encode('{"name":"@scope/pkg","version":"1.0.0"}'),
      ...members(),
    })
    expect(() => archiveKind(both)).toThrow(/同时含 package.json 与 recipe.yml/)

    const neither = comboZip({ 'readme.md': new TextEncoder().encode('# hi\n') })
    expect(() => archiveKind(neither)).toThrow(/根目录缺少 package.json \/ recipe.yml/)
  })
})

describe('readComboArchive', () => {
  it('orders members by the recipe rows and carries an optional readme', () => {
    const combo = comboZip({
      'recipe.yml': new TextEncoder().encode(RECIPE),
      'readme.md': new TextEncoder().encode('# 演示\n'),
      'plugins/sub.zip': pluginZip('@snap-rail/sub', '1.0.0'),
      'plugins/mini.zip': pluginZip('@snap-rail/mini', '0.3.0'),
    })
    const archive = readComboArchive(combo)
    try {
      expect(archive.recipe.id).toBe('demo-base')
      expect(archive.members.map(member => member.name)).toEqual(['@snap-rail/mini', '@snap-rail/sub'])
      expect(archive.readme).toBe('# 演示\n')
      expect(archive.members[0]!.inspection.signature).toEqual({ state: 'unverified', reason: 'unsigned' })
    } finally {
      rmSync(archive.dir, { recursive: true, force: true })
    }
  })

  it('refuses two zips for the same package', () => {
    const combo = comboZip({
      'recipe.yml': new TextEncoder().encode(RECIPE),
      ...members(),
      'plugins/beta.zip': pluginZip('@snap-rail/sub', '1.0.0'),
    })
    expect(() => readComboArchive(combo)).toThrow(/重复插件 @snap-rail\/sub/)
  })

  it('refuses a referenced package without a zip and a zip without a row', () => {
    const missing = comboZip({
      'recipe.yml': new TextEncoder().encode(RECIPE),
      'plugins/mini.zip': pluginZip('@snap-rail/mini', '0.3.0'),
    })
    expect(() => readComboArchive(missing)).toThrow(/缺少 zip：@snap-rail\/sub/)

    const extra = comboZip({
      'recipe.yml': new TextEncoder().encode(RECIPE),
      ...members(),
      'plugins/extra.zip': pluginZip('@snap-rail/other', '1.0.0'),
    })
    expect(() => readComboArchive(extra)).toThrow(/未在 recipe.yml 引用/)
  })

  it('refuses a plugin archive, an empty plugins dir, and stray root files', () => {
    const plugin = comboZip({ 'package.json': new TextEncoder().encode('{"name":"@scope/pkg","version":"1.0.0"}') })
    expect(() => readComboArchive(plugin)).toThrow(/这是插件包/)

    const empty = comboZip({ 'recipe.yml': new TextEncoder().encode(RECIPE) })
    expect(() => readComboArchive(empty)).toThrow(/没有任何插件 zip/)

    const stray = comboZip({
      'recipe.yml': new TextEncoder().encode(RECIPE),
      'bundle.json': new TextEncoder().encode('{}'),
      ...members(),
    })
    expect(() => readComboArchive(stray)).toThrow(/只能包含 recipe.yml/)
  })

  it('refuses unsafe member paths and strict-invalid recipe documents', () => {
    const unsafe = comboZip({
      'recipe.yml': new TextEncoder().encode(RECIPE),
      'plugins/../evil.zip': pluginZip('@snap-rail/mini', '0.3.0'),
      'plugins/sub.zip': pluginZip('@snap-rail/sub', '1.0.0'),
    })
    expect(() => readComboArchive(unsafe)).toThrow(/越出组合根目录/)

    const badDocument = comboZip({
      'recipe.yml': new TextEncoder().encode('id: Demo Base\nversion: 1.0.0\ntitle: x\nkind: base\nplugins:\n  - name: x\n'),
      ...members(),
    })
    expect(() => readComboArchive(badDocument)).toThrow(/recipe.yml 不合法/)

    const unknownField = comboZip({
      'recipe.yml': new TextEncoder().encode(`${RECIPE.replace('description: demo base', 'futureField: true')}`),
      ...members(),
    })
    expect(() => readComboArchive(unknownField)).toThrow(/recipe.yml 不合法/)
  })
})

describe('inspectComboZip', () => {
  it('annotates each member against the pool: install, update, current, local-newer', () => {
    const combo = comboZip({ 'recipe.yml': new TextEncoder().encode(RECIPE), ...members() })
    const installed: Record<string, string | undefined> = {
      '@snap-rail/mini': '0.2.0',
      '@snap-rail/sub': '1.0.0',
    }
    const inspection = inspectComboZip(combo, { installedVersionOf: name => installed[name] })
    try {
      expect(inspection.combo.plugins.map(plugin => [plugin.name, plugin.action])).toEqual([
        ['@snap-rail/mini', 'update'],
        ['@snap-rail/sub', 'current'],
      ])
      expect(inspection.combo.plugins[0]!.installed).toEqual({ version: '0.2.0' })
      expect(inspection.combo.missing).toEqual([])
    } finally {
      rmSync(inspection.archive.dir, { recursive: true, force: true })
    }

    const localNewer = inspectComboZip(combo, { installedVersionOf: name => name === '@snap-rail/mini' ? '0.4.0' : '2.0.0' })
    try {
      expect(localNewer.combo.plugins.map(plugin => plugin.action)).toEqual(['local-newer', 'local-newer'])
    } finally {
      rmSync(localNewer.archive.dir, { recursive: true, force: true })
    }
  })

  it('aggregates unsatisfied package and seed requirements, satisfied by members or the home', () => {
    const combo = comboZip({
      'recipe.yml': new TextEncoder().encode(RECIPE),
      'plugins/mini.zip': pluginZip('@snap-rail/mini', '0.3.0', {
        requires: ['@snap-rail/sub@^1.0', '@snap-rail/missing', 'service:store'],
      }),
      'plugins/sub.zip': pluginZip('@snap-rail/sub', '1.0.0', {
        client: { entry: 'lib/client.js', externalSeeds: ['@snap-rail/seed-provider/client'] },
      }),
    })
    const inspection = inspectComboZip(combo, { installedVersionOf: () => undefined })
    try {
      // The member satisfies the version-constrained package requirement; the
      // absent package and the absent seed provider stay warnings, while the
      // service requirement is a runtime fact.
      expect(inspection.combo.missing).toEqual([
        '@snap-rail/missing',
        '@snap-rail/seed-provider/client（提供方未安装）',
      ])
      expect(inspection.combo.hasClient).toBe(true)
    } finally {
      rmSync(inspection.archive.dir, { recursive: true, force: true })
    }
  })

  it('flags a version-constrained requirement the installed/member version misses', () => {
    const combo = comboZip({
      'recipe.yml': new TextEncoder().encode(RECIPE),
      'plugins/mini.zip': pluginZip('@snap-rail/mini', '0.3.0', {
        requires: ['@snap-rail/sub@^2.0'],
      }),
      'plugins/sub.zip': pluginZip('@snap-rail/sub', '1.0.0'),
    })
    const inspection = inspectComboZip(combo)
    try {
      expect(inspection.combo.missing).toEqual(['@snap-rail/sub@^2.0'])
    } finally {
      rmSync(inspection.archive.dir, { recursive: true, force: true })
    }
  })
})
