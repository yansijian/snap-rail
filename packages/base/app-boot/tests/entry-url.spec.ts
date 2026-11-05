import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { poolEntryUrl, scanPluginPool } from '../src/scan.ts'
import { resolveModuleSpecifier } from '../src/compose.ts'

const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A minimal pool package with one host entry (and optional extra files). */
function seedPool(files: Record<string, string> = {}, manifest: Record<string, unknown> = {}): string {
  const poolDir = mkdtempSync(join(tmpdir(), 'snap-rail-entryurl-'))
  dirs.push(poolDir)
  const packageDir = join(poolDir, '@scope__demo')
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@scope/demo', version: '0.1.0', type: 'module', main: 'lib/index.js',
    ...manifest,
  }))
  writeFileSync(join(packageDir, 'lib', 'index.js'), 'export default { apply() {} }\n')
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(packageDir, name)), { recursive: true })
    writeFileSync(join(packageDir, name), body)
  }
  return poolDir
}

describe('pool entry URLs (the ESM cache-busting query)', () => {
  it('is stable while the face bytes are unchanged, so unchanged packages never re-mount', () => {
    const poolDir = seedPool()
    const first = scanPluginPool([poolDir]).get('@scope/demo')!.entryUrl
    const second = scanPluginPool([poolDir]).get('@scope/demo')!.entryUrl
    expect(first).toContain('?v=')
    expect(second).toBe(first)
    // Deterministic across processes of the same bytes: a rewritten-but-
    // identical file keeps the same URL (no needless plugin restart).
    const packageDir = join(poolDir, '@scope__demo')
    writeFileSync(join(packageDir, 'lib', 'index.js'), 'export default { apply() {} }\n')
    expect(scanPluginPool([poolDir]).get('@scope/demo')!.entryUrl).toBe(first)
  })

  it('changes when the entry or a sibling chunk changes, so the loader re-imports the fresh module', () => {
    const poolDir = seedPool()
    const packageDir = join(poolDir, '@scope__demo')
    const first = scanPluginPool([poolDir]).get('@scope/demo')!.entryUrl

    // A rebuild that only touches the shared chunk beside the entry.
    writeFileSync(join(packageDir, 'lib', 'chunk-abc.js'), 'export const x = 1\n')
    const afterChunk = scanPluginPool([poolDir]).get('@scope/demo')!.entryUrl
    expect(afterChunk).not.toBe(first)
    expect(afterChunk).toContain('?v=')

    // And a rebuild that rewrites the entry itself.
    writeFileSync(join(packageDir, 'lib', 'index.js'), 'export default { apply() {}, v: 2 }\n')
    const afterEntry = scanPluginPool([poolDir]).get('@scope/demo')!.entryUrl
    expect(afterEntry).not.toBe(first)
    expect(afterEntry).not.toBe(afterChunk)
  })

  it('digests only script files — asset changes do not disturb the host entry URL', () => {
    const poolDir = seedPool({ 'lib/assets/logo.svg': '<svg/>' })
    const first = scanPluginPool([poolDir]).get('@scope/demo')!.entryUrl
    writeFileSync(join(poolDir, '@scope__demo', 'lib', 'assets', 'logo.svg'), '<svg width="1"/>')
    expect(scanPluginPool([poolDir]).get('@scope/demo')!.entryUrl).toBe(first)
  })

  it('subpath rows over a pool package carry the same digest as their package entry', () => {
    const poolDir = seedPool(
      { 'lib/rpc.js': 'export default { apply() {} }\n' },
      { exports: { '.': './lib/index.js', './rpc': './lib/rpc.js' } },
    )
    const pool = scanPluginPool([poolDir])
    const root = resolveModuleSpecifier('@scope/demo', pool, dirname(poolDir))
    const subpath = resolveModuleSpecifier('@scope/demo/rpc', pool, dirname(poolDir))
    // Same face directory → same digest query → one module instance shared by
    // the entry import and every subpath importer.
    expect(new URL(root).searchParams.get('v')).toBe(new URL(subpath).searchParams.get('v'))
    expect(subpath).toContain('rpc.js')
    // The digest also matches poolEntryUrl derived straight from the file —
    // the resolve-hook pool fallback resolves to the identical URL.
    expect(subpath).toBe(poolEntryUrl(join(poolDir, '@scope__demo', 'lib', 'rpc.js')))
  })
})
