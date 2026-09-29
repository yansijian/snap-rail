import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  annotateCatalog,
  downloadRemotePluginZip,
  fetchRecipeDocument,
  fetchRemoteCatalog,
  fetchRemoteRecipes,
  MarketError,
} from '../src/market.ts'
import { installPluginFromZip } from '../src/installer.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Serve an in-memory URL → payload map as the global fetch. */
function serve(routes: Record<string, string | Uint8Array | object | Error>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const route = routes[String(url)]
    if (route instanceof Error) throw route
    if (route === undefined) return new Response('not found', { status: 404 })
    if (route instanceof Uint8Array) return new Response(route)
    if (typeof route === 'string') return new Response(route)
    return new Response(JSON.stringify(route))
  }))
}

/** Assert a market call fails with the given machine-readable kind. */
async function expectMarketKind(run: () => Promise<unknown>, kind: MarketError['kind']): Promise<void> {
  await run().catch((cause: unknown) => {
    expect(cause).toBeInstanceOf(MarketError)
    expect((cause as MarketError).kind).toBe(kind)
    return undefined
  })
}

const CATALOG = {
  plugins: [
    {
      name: '@scope/alpha', version: '1.0.0', description: 'alpha plugin', kind: 'driver', file: 'alpha.zip',
      sha256: 'a'.repeat(64), size: 1, signature: { algorithm: 'Ed25519', keyId: 'test-key' },
    },
    {
      name: '@scope/beta', version: '2.0.0', file: 'beta.zip',
      sha256: 'b'.repeat(64), size: 1, signature: { algorithm: 'Ed25519', keyId: 'test-key' },
    },
  ],
}

/** Install `@scope/alpha` at a given version into a fresh pool. */
function poolWithAlpha(version: string): string {
  const base = mkdtempSync(join(tmpdir(), 'snap-rail-market-'))
  const pool = join(base, 'plugins')
  const zip = mkdtempSync(join(tmpdir(), 'snap-rail-market-zip-'))
  const zipPath = join(zip, 'alpha.zip')
  writeFileSync(zipPath, zipSync({
    'package.json': new TextEncoder().encode(JSON.stringify({
      name: '@scope/alpha', version, type: 'module', main: 'lib/index.js',
    })),
    'lib/index.js': new TextEncoder().encode('export default { apply() {} }\n'),
  }))
  installPluginFromZip(zipPath, pool)
  return pool
}

describe('fetchRemoteCatalog', () => {
  it('reads the feed catalog (trailing slash optional)', async () => {
    serve({ 'http://feed.test/plugins/index.json': CATALOG })
    const catalog = await fetchRemoteCatalog('http://feed.test/plugins/')
    expect(catalog.plugins).toHaveLength(2)
    expect(catalog.plugins[0]!.file).toBe('alpha.zip')
    const noSlash = await fetchRemoteCatalog('http://feed.test/plugins')
    expect(noSlash.plugins).toHaveLength(2)
  })

  it('strips unknown fields so newer catalogs keep older hosts working', async () => {
    serve({
      'http://feed.test/index.json': {
        plugins: [{
          name: '@scope/alpha', version: '1.0.0', file: 'alpha.zip',
          sha256: 'a'.repeat(64), size: 1,
          signature: { algorithm: 'Ed25519', keyId: 'test-key' },
          futureField: true,
        }],
      },
    })
    const catalog = await fetchRemoteCatalog('http://feed.test/')
    expect(catalog.plugins[0]!.name).toBe('@scope/alpha')
    expect(catalog.plugins[0]).not.toHaveProperty('futureField')
  })

  it('accepts the enrichment fields (title, category, requires, framework, sha256, size)', async () => {
    serve({
      'http://feed.test/index.json': {
        plugins: [{
          name: '@scope/alpha', version: '1.0.0', file: 'alpha.zip',
          title: '阿尔法', category: '通讯驱动', requires: ['service:store'],
          framework: '@snap-rail/framework-shadcn',
          sha256: 'a'.repeat(64), size: 1024,
          signature: { algorithm: 'Ed25519', keyId: 'test-key' },
        }],
      },
    })
    const catalog = await fetchRemoteCatalog('http://feed.test/')
    expect(catalog.plugins[0]).toMatchObject({
      title: '阿尔法', category: '通讯驱动', requires: ['service:store'],
      framework: '@snap-rail/framework-shadcn', sha256: 'a'.repeat(64), size: 1024,
    })
    // A digest that is not 64 lowercase hex chars is a bad catalog.
    serve({
      'http://feed.test/index.json': {
        plugins: [{ name: '@scope/alpha', version: '1.0.0', file: 'alpha.zip', sha256: 'ZZ' }],
      },
    })
    await expectMarketKind(() => fetchRemoteCatalog('http://feed.test/'), 'bad-catalog')
  })

  it('classifies unreachable feeds, bad answers, and bad catalogs', async () => {
    serve({ 'http://feed.test/index.json': new Error('ECONNREFUSED') })
    await expectMarketKind(() => fetchRemoteCatalog('http://feed.test/'), 'unreachable')

    serve({})
    await expectMarketKind(() => fetchRemoteCatalog('http://feed.test/'), 'unreachable')

    serve({ 'http://feed.test/index.json': '{ broken' })
    await expectMarketKind(() => fetchRemoteCatalog('http://feed.test/'), 'bad-catalog')

    serve({
      'http://feed.test/index.json': {
        plugins: [{ name: '@scope/alpha', version: '1.0.0', file: '../evil.zip' }],
      },
    })
    await expectMarketKind(() => fetchRemoteCatalog('http://feed.test/'), 'bad-catalog')
  })
})

describe('annotateCatalog', () => {
  it('verdicts every entry against the pool: install, update, current, local-newer', () => {
    const pool = poolWithAlpha('0.9.0')
    const catalog = {
      plugins: [
        { name: '@scope/alpha', version: '1.0.0', file: 'alpha.zip' },
        { name: '@scope/beta', version: '2.0.0', file: 'beta.zip' },
      ],
    }
    const rows = annotateCatalog(catalog, pool)
    expect(rows.find(row => row.name === '@scope/alpha')).toMatchObject({
      action: 'update', installed: { version: '0.9.0' },
    })
    expect(rows.find(row => row.name === '@scope/beta')).toMatchObject({ action: 'install' })
    expect(rows.find(row => row.name === '@scope/beta')).not.toHaveProperty('installed')

    // Equal version and a locally-newer pool copy.
    const same = annotateCatalog({ plugins: [{ name: '@scope/alpha', version: '0.9.0', file: 'alpha.zip' }] }, pool)
    expect(same[0]!.action).toBe('current')
    const newer = annotateCatalog({ plugins: [{ name: '@scope/alpha', version: '0.1.0', file: 'alpha.zip' }] }, pool)
    expect(newer[0]!.action).toBe('local-newer')
    rmSync(join(pool, '..'), { recursive: true, force: true })
  })

  it('passes the enrichment fields through to the wire rows', () => {
    const rows = annotateCatalog({
      plugins: [{
        name: '@scope/alpha', version: '1.0.0', file: 'alpha.zip',
        title: '阿尔法', category: '驱动', requires: ['service:store'],
        framework: '@snap-rail/framework-shadcn',
        sha256: 'b'.repeat(64), size: 2048,
      }],
    }, join(tmpdir(), 'absent-pool'))
    expect(rows[0]).toMatchObject({
      title: '阿尔法', category: '驱动', requires: ['service:store'],
      framework: '@snap-rail/framework-shadcn', sha256: 'b'.repeat(64), size: 2048,
      action: 'install',
    })
    expect(rows[0]).not.toHaveProperty('installed')
  })
})

describe('downloadRemotePluginZip checksum', () => {
  const bytes = new Uint8Array(zipSync({
    'package.json': new TextEncoder().encode('{"name":"@scope/alpha","version":"1.0.0"}'),
  }))
  const digest = createHash('sha256').update(bytes).digest('hex')

  it('lands the served bytes when the declared digest matches', async () => {
    serve({ 'http://feed.test/alpha.zip': bytes })
    const target = await downloadRemotePluginZip('http://feed.test/', 'alpha.zip', digest)
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target).equals(bytes)).toBe(true)
    rmSync(target, { force: true })
  })

  it('refuses the download before it touches the disk on a digest mismatch', async () => {
    serve({ 'http://feed.test/alpha.zip': bytes })
    await expectMarketKind(
      () => downloadRemotePluginZip('http://feed.test/', 'alpha.zip', 'c'.repeat(64)),
      'bad-checksum',
    )
  })
})

describe('fetchRemoteRecipes', () => {
  it('reads the recipe catalog and strips unknown fields', async () => {
    serve({
      'http://feed.test/recipes.json': {
        recipes: [{
          id: 'standard-base', version: '1.0.0', title: '标准基座', kind: 'base',
          file: 'standard-base.yml', futureField: true,
        }],
      },
    })
    const recipes = await fetchRemoteRecipes('http://feed.test/')
    expect(recipes.recipes[0]).toEqual({
      id: 'standard-base', version: '1.0.0', title: '标准基座', kind: 'base', file: 'standard-base.yml',
    })
  })

  it('refuses bad ids, non-yml files, and unknown kinds', async () => {
    serve({
      'http://feed.test/recipes.json': {
        recipes: [{ id: '../evil', version: '1.0.0', title: 'x', kind: 'base', file: 'evil.yml' }],
      },
    })
    await expectMarketKind(() => fetchRemoteRecipes('http://feed.test/'), 'bad-catalog')
    serve({
      'http://feed.test/recipes.json': {
        recipes: [{ id: 'x', version: '1.0.0', title: 'x', kind: 'base', file: '../evil.yml' }],
      },
    })
    await expectMarketKind(() => fetchRemoteRecipes('http://feed.test/'), 'bad-catalog')
    serve({
      'http://feed.test/recipes.json': {
        recipes: [{ id: 'x', version: '1.0.0', title: 'x', kind: 'bundle', file: 'x.yml' }],
      },
    })
    await expectMarketKind(() => fetchRemoteRecipes('http://feed.test/'), 'bad-catalog')
  })
})

describe('fetchRecipeDocument', () => {
  it('parses a recipe document with the exact plugins.yml shape', async () => {
    serve({
      'http://feed.test/standard-base.yml':
        "plugins:\n  - name: '@snap-rail/store-sqlite'\n  - name: '@snap-rail/equipment/rpc'\n    enabled: true\n",
    })
    const payload = await fetchRecipeDocument('http://feed.test/', 'standard-base.yml')
    expect(payload.plugins).toHaveLength(2)
    expect(payload.plugins[1]).toMatchObject({ name: '@snap-rail/equipment/rpc', enabled: true })
  })

  it('refuses unknown row fields, bad names, and empty documents (strict)', async () => {
    serve({ 'http://feed.test/bad.yml': "plugins:\n  - name: '@scope/a'\n    futureField: 1\n" })
    await expectMarketKind(() => fetchRecipeDocument('http://feed.test/', 'bad.yml'), 'bad-catalog')

    serve({ 'http://feed.test/bad.yml': 'plugins:\n  - name: ../evil\n' })
    await expectMarketKind(() => fetchRecipeDocument('http://feed.test/', 'bad.yml'), 'bad-catalog')

    serve({ 'http://feed.test/bad.yml': 'plugins: []\n' })
    await expectMarketKind(() => fetchRecipeDocument('http://feed.test/', 'bad.yml'), 'bad-catalog')

    serve({ 'http://feed.test/bad.yml': '{ broken' })
    await expectMarketKind(() => fetchRecipeDocument('http://feed.test/', 'bad.yml'), 'bad-catalog')
  })
})

describe('downloadRemotePluginZip', () => {
  it('lands the served bytes in a temp file', async () => {
    const bytes = new Uint8Array(zipSync({
      'package.json': new TextEncoder().encode('{"name":"@scope/alpha","version":"1.0.0"}'),
    }))
    serve({ 'http://feed.test/alpha.zip': bytes })
    const target = await downloadRemotePluginZip('http://feed.test/', 'alpha.zip')
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target).equals(bytes)).toBe(true)
    rmSync(target, { force: true })
  })

  it('reports failed downloads as unreachable', async () => {
    serve({})
    const target = await downloadRemotePluginZip('http://feed.test/', 'absent.zip').catch((cause: unknown) => cause)
    expect(target).toBeInstanceOf(MarketError)
  })
})
