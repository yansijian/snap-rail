import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { annotateCatalog, downloadRemotePluginZip, fetchRemoteCatalog, MarketError } from '../src/market.ts'
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
    { name: '@scope/alpha', version: '1.0.0', description: 'alpha plugin', kind: 'driver', file: 'alpha.zip' },
    { name: '@scope/beta', version: '2.0.0', file: 'beta.zip' },
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
        plugins: [{ name: '@scope/alpha', version: '1.0.0', file: 'alpha.zip', futureField: true }],
      },
    })
    const catalog = await fetchRemoteCatalog('http://feed.test/')
    expect(catalog.plugins[0]!.name).toBe('@scope/alpha')
    expect(catalog.plugins[0]).not.toHaveProperty('futureField')
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
