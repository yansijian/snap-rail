import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createLayerView } from '../src/layer-view.ts'
import { loadBuiltinLayer } from '../src/compose.ts'
import type { LayerHandles } from '../src/admin.ts'

const roots: string[] = []

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeHandles(): LayerHandles {
  const root = mkdtempSync(join(tmpdir(), 'snap-rail-default-'))
  roots.push(root)
  const builtinLayerPath = join(root, 'builtins.yml')
  writeFileSync(builtinLayerPath, [
    '- id: default-store',
    "  name: '@snap-rail/default-store'",
    '  default: true',
    '- id: hard',
    "  name: '@snap-rail/hard'",
  ].join('\n'))
  return {
    builtinLayerPath,
    userLayerPath: join(root, 'plugins.yml'),
    presetDirs: [],
    appRoot: root,
    poolDirs: [join(root, 'plugins')],
    composedPath: join(root, 'composed.yml'),
    includeId: 'composed',
    rendererPackages: [],
  }
}

describe('builtin-default rows', () => {
  it('parses the default marker and keeps it out of the protected set', () => {
    const handles = makeHandles()
    const rows = loadBuiltinLayer(handles.builtinLayerPath)
    expect(rows.find(row => row.id === 'default-store')?.default).toBe(true)
    expect(rows.find(row => row.id === 'hard')?.default).toBeUndefined()

    const view = createLayerView(handles)
    expect(view.shippedNames().has('@snap-rail/default-store')).toBe(false)
    expect(view.shippedNames().has('@snap-rail/hard')).toBe(true)
    expect(view.reservedNames().has('@snap-rail/default-store')).toBe(true)
    expect(view.reservedNames().has('@snap-rail/hard')).toBe(true)
    expect(view.enabledPackages(new Map()).has('@snap-rail/default-store')).toBe(true)
  })
})