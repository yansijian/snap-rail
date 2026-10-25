import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  annotateCatalog,
  downloadPluginZipFromUrl,
  downloadRemotePluginZip,
  FeedError,
  fetchRemoteCatalog,
  fetchRemoteCatalogs,
  mergeCatalogs,
  resolvePluginFeedUrls,
  resolveSignaturePolicy,
  updatableFromCatalog,
} from '../src/feed.ts'
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

/** Assert a feed call fails with the given machine-readable kind. */
async function expectFeedKind(run: () => Promise<unknown>, kind: FeedError['kind']): Promise<void> {
  await run().catch((cause: unknown) => {
    expect(cause).toBeInstanceOf(FeedError)
    expect((cause as FeedError).kind).toBe(kind)
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
  const base = mkdtempSync(join(tmpdir(), 'snap-rail-feed-'))
  const pool = join(base, 'plugins')
  const zip = mkdtempSync(join(tmpdir(), 'snap-rail-feed-zip-'))
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

  it('accepts the enrichment fields (title, category, requires, sha256, size); retired fields strip', async () => {
    serve({
      'http://feed.test/index.json': {
        plugins: [{
          name: '@scope/alpha', version: '1.0.0', file: 'alpha.zip',
          title: '阿尔法', category: '通讯驱动', requires: ['service:store'],
          framework: '@legacy/framework',
          sha256: 'a'.repeat(64), size: 1024,
          signature: { algorithm: 'Ed25519', keyId: 'test-key' },
        }],
      },
    })
    const catalog = await fetchRemoteCatalog('http://feed.test/')
    // Legacy feeds may still carry the retired framework field — the schema
    // strips it instead of failing the feed.
    expect(catalog.plugins[0]).toMatchObject({
      title: '阿尔法', category: '通讯驱动', requires: ['service:store'],
      sha256: 'a'.repeat(64), size: 1024,
    })
    expect(catalog.plugins[0]).not.toHaveProperty('framework')
    // A digest that is not 64 lowercase hex chars is a bad catalog.
    serve({
      'http://feed.test/index.json': {
        plugins: [{ name: '@scope/alpha', version: '1.0.0', file: 'alpha.zip', sha256: 'ZZ' }],
      },
    })
    await expectFeedKind(() => fetchRemoteCatalog('http://feed.test/'), 'bad-catalog')
  })

  it('classifies unreachable feeds, bad answers, and bad catalogs', async () => {
    serve({ 'http://feed.test/index.json': new Error('ECONNREFUSED') })
    await expectFeedKind(() => fetchRemoteCatalog('http://feed.test/'), 'unreachable')

    serve({})
    await expectFeedKind(() => fetchRemoteCatalog('http://feed.test/'), 'unreachable')

    serve({ 'http://feed.test/index.json': '{ broken' })
    await expectFeedKind(() => fetchRemoteCatalog('http://feed.test/'), 'bad-catalog')

    serve({
      'http://feed.test/index.json': {
        plugins: [{ name: '@scope/alpha', version: '1.0.0', file: '../evil.zip' }],
      },
    })
    await expectFeedKind(() => fetchRemoteCatalog('http://feed.test/'), 'bad-catalog')
  })
})

describe('annotateCatalog', () => {
  it('verdicts every entry against the pool: install, update, current, local-newer', () => {
    const pool = poolWithAlpha('0.9.0')
    const entries = [
      { name: '@scope/alpha', version: '1.0.0', file: 'alpha.zip', sha256: 'a'.repeat(64), size: 1, signature: { algorithm: 'Ed25519' as const, keyId: 'k' }, feedUrl: 'http://feed.test/', source: 'feed.test' },
      { name: '@scope/beta', version: '2.0.0', file: 'beta.zip', sha256: 'b'.repeat(64), size: 1, signature: { algorithm: 'Ed25519' as const, keyId: 'k' }, feedUrl: 'http://feed.test/', source: 'feed.test' },
    ]
    const rows = annotateCatalog(entries, pool)
    expect(rows.find(row => row.name === '@scope/alpha')).toMatchObject({
      action: 'update', installed: { version: '0.9.0' }, source: 'feed.test', feedUrl: 'http://feed.test/',
    })
    expect(rows.find(row => row.name === '@scope/beta')).toMatchObject({ action: 'install' })
    expect(rows.find(row => row.name === '@scope/beta')).not.toHaveProperty('installed')

    // Equal version and a locally-newer pool copy.
    const same = annotateCatalog([{ ...entries[0]!, version: '0.9.0' }], pool)
    expect(same[0]!.action).toBe('current')
    const newer = annotateCatalog([{ ...entries[0]!, version: '0.1.0' }], pool)
    expect(newer[0]!.action).toBe('local-newer')
    rmSync(join(pool, '..'), { recursive: true, force: true })
  })

  it('passes the enrichment fields through to the wire rows (retired fields stripped)', () => {
    const rows = annotateCatalog([{
      name: '@scope/alpha', version: '1.0.0', file: 'alpha.zip',
      title: '阿尔法', category: '驱动', requires: ['service:store'],
      sha256: 'b'.repeat(64), size: 2048,
      signature: { algorithm: 'Ed25519', keyId: 'k' },
      feedUrl: 'http://feed.test/', source: '聚合源',
    }], join(tmpdir(), 'absent-pool'))
    expect(rows[0]).toMatchObject({
      title: '阿尔法', category: '驱动', requires: ['service:store'],
      sha256: 'b'.repeat(64), size: 2048,
      source: '聚合源', feedUrl: 'http://feed.test/',
      action: 'install',
    })
    expect(rows[0]).not.toHaveProperty('installed')
  })
})

describe('federation entries and multi-source merge', () => {
  it('accepts an absolute url in place of a same-directory file', async () => {
    serve({
      'http://feed.test/index.json': {
        title: '社区聚合',
        plugins: [{
          name: '@author/pkg', version: '1.0.0',
          url: 'http://author.test/releases/pkg-1.0.0.zip',
          sha256: 'a'.repeat(64), size: 1,
          signature: { algorithm: 'Ed25519', keyId: 'author-key' },
        }],
      },
    })
    const catalog = await fetchRemoteCatalog('http://feed.test/')
    expect(catalog.title).toBe('社区聚合')
    expect(catalog.plugins[0]!.url).toBe('http://author.test/releases/pkg-1.0.0.zip')
    // Neither form present is a bad catalog.
    serve({
      'http://feed.test/index.json': {
        plugins: [{ name: '@author/pkg', version: '1.0.0', sha256: 'a'.repeat(64), size: 1, signature: { algorithm: 'Ed25519', keyId: 'k' } }],
      },
    })
    await expectFeedKind(() => fetchRemoteCatalog('http://feed.test/'), 'bad-catalog')
  })

  it('merges multiple feeds: highest version wins, entries carry their source', async () => {
    serve({
      'http://org.test/index.json': {
        title: '官方源',
        plugins: [{ name: '@scope/a', version: '1.0.0', file: 'a.zip', sha256: 'a'.repeat(64), size: 1, signature: { algorithm: 'Ed25519', keyId: 'org' } }],
      },
      'http://community.test/index.json': {
        plugins: [
          { name: '@scope/a', version: '1.1.0', file: 'a.zip', sha256: 'a'.repeat(64), size: 1, signature: { algorithm: 'Ed25519', keyId: 'org' } },
          { name: '@author/b', version: '2.0.0', url: 'http://author.test/b.zip', sha256: 'b'.repeat(64), size: 1, signature: { algorithm: 'Ed25519', keyId: 'author' } },
        ],
      },
      'http://dead.test/index.json': new Error('ECONNREFUSED'),
    })
    const fetched = await fetchRemoteCatalogs(['http://org.test/', 'http://community.test/', 'http://dead.test/'])
    expect(fetched).toHaveLength(2)
    const merged = mergeCatalogs(fetched)
    expect(merged.find(entry => entry.name === '@scope/a')).toMatchObject({ version: '1.1.0', source: 'community.test', feedUrl: 'http://community.test/' })
    expect(merged.find(entry => entry.name === '@author/b')).toMatchObject({ source: 'community.test', url: 'http://author.test/b.zip' })
    // Every feed dead re-throws the feed error.
    await expectFeedKind(() => fetchRemoteCatalogs(['http://dead.test/']), 'unreachable')
  })

  it('downloads a federation entry from its absolute url (digest still enforced)', async () => {
    const bytes = new Uint8Array(zipSync({
      'package.json': new TextEncoder().encode('{"name":"@author/b","version":"2.0.0"}'),
    }))
    const digest = createHash('sha256').update(bytes).digest('hex')
    serve({ 'http://author.test/b.zip': bytes })
    const target = await downloadRemotePluginZip('http://feed.test/', { url: 'http://author.test/b.zip' }, digest)
    expect(readFileSync(target).equals(bytes)).toBe(true)
    rmSync(target, { force: true })
    serve({ 'http://author.test/b.zip': bytes })
    await expectFeedKind(
      () => downloadRemotePluginZip('http://feed.test/', { url: 'http://author.test/b.zip' }, 'c'.repeat(64)),
      'bad-checksum',
    )
  })
})

describe('downloadRemotePluginZip checksum', () => {
  const bytes = new Uint8Array(zipSync({
    'package.json': new TextEncoder().encode('{"name":"@scope/alpha","version":"1.0.0"}'),
  }))
  const digest = createHash('sha256').update(bytes).digest('hex')

  it('lands the served bytes when the declared digest matches', async () => {
    serve({ 'http://feed.test/alpha.zip': bytes })
    const target = await downloadRemotePluginZip('http://feed.test/', { file: 'alpha.zip' }, digest)
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target).equals(bytes)).toBe(true)
    rmSync(target, { force: true })
  })

  it('refuses the download before it touches the disk on a digest mismatch', async () => {
    serve({ 'http://feed.test/alpha.zip': bytes })
    await expectFeedKind(
      () => downloadRemotePluginZip('http://feed.test/', { file: 'alpha.zip' }, 'c'.repeat(64)),
      'bad-checksum',
    )
  })
})

describe('downloadRemotePluginZip', () => {
  it('lands the served bytes in a temp file', async () => {
    const bytes = new Uint8Array(zipSync({
      'package.json': new TextEncoder().encode('{"name":"@scope/alpha","version":"1.0.0"}'),
    }))
    serve({ 'http://feed.test/alpha.zip': bytes })
    const target = await downloadRemotePluginZip('http://feed.test/', { file: 'alpha.zip' })
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target).equals(bytes)).toBe(true)
    rmSync(target, { force: true })
  })

  it('reports failed downloads as unreachable', async () => {
    serve({})
    const target = await downloadRemotePluginZip('http://feed.test/', { file: 'absent.zip' }).catch((cause: unknown) => cause)
    expect(target).toBeInstanceOf(FeedError)
  })
})

describe('updatableFromCatalog', () => {
  const entries = [
    { name: '@scope/alpha', version: '2.0.0', file: 'alpha.zip', sha256: 'a'.repeat(64), signature: { algorithm: 'Ed25519' as const, keyId: 'k1' }, feedUrl: 'http://feed.test/' },
    { name: '@scope/beta', version: '1.0.0', file: 'beta.zip', sha256: 'b'.repeat(64), signature: { algorithm: 'Ed25519' as const, keyId: 'k2' }, feedUrl: 'http://feed.test/' },
    { name: '@scope/new', version: '1.0.0', file: 'new.zip', sha256: 'c'.repeat(64), signature: { algorithm: 'Ed25519' as const, keyId: 'k3' }, feedUrl: 'http://feed.test/' },
  ]

  it('collects strictly-higher feed versions; never downgrades or first-installs', () => {
    const installed: Record<string, string | undefined> = {
      '@scope/alpha': '1.5.0',
      '@scope/beta': '2.0.0',
      '@scope/gone': '0.9.0',
    }
    expect(updatableFromCatalog(entries, name => installed[name])).toEqual([
      {
        name: '@scope/alpha', installedVersion: '1.5.0', feedVersion: '2.0.0',
        feedUrl: 'http://feed.test/', file: 'alpha.zip', sha256: 'a'.repeat(64),
        keyId: 'k1', keyChanged: true,
      },
    ])
  })

  it('flags keyChanged only against a differing installed key; same key stays anchored', () => {
    const installedKey: Record<string, string | undefined> = {
      '@scope/alpha': 'k1',
      '@scope/beta': undefined,
    }
    const installed: Record<string, string | undefined> = {
      '@scope/alpha': '1.5.0',
      '@scope/beta': '0.5.0',
    }
    const rows = updatableFromCatalog(entries, name => installed[name], name => installedKey[name])
    const alpha = rows.find(row => row.name === '@scope/alpha')
    const beta = rows.find(row => row.name === '@scope/beta')
    expect(alpha?.keyChanged).toBeUndefined()
    // An unsigned install has no anchor: any signed feed update is a key change.
    expect(beta?.keyChanged).toBe(true)
  })

  it('reports nothing for an empty pool', () => {
    expect(updatableFromCatalog(entries, () => undefined)).toEqual([])
  })
})

describe('resolvePluginFeedUrls', () => {
  /** A throwaway home + resources pair wired the way the host wires them. */
  function layers(userValue: unknown, defaultValue: unknown, userFile = 'settings.json'): { home: string, resources: string } {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-feed-'))
    const home = join(base, 'home')
    const resources = join(base, 'resources')
    mkdirSync(home, { recursive: true })
    mkdirSync(resources, { recursive: true })
    if (userValue !== undefined) {
      writeFileSync(join(home, userFile), JSON.stringify(userValue))
    }
    if (defaultValue !== undefined) {
      writeFileSync(join(resources, 'defaults.json'), JSON.stringify(defaultValue))
    }
    return { home, resources }
  }

  it('prefers the user list over the factory default', () => {
    const { home, resources } = layers(
      { 'plugins.feedUrls': ['http://user.test/', 'http://author.test/releases/download/feed/'] },
      { 'plugins.feedUrls': ['http://default.test/'] },
    )
    expect(resolvePluginFeedUrls(home, resources)).toEqual(['http://user.test/', 'http://author.test/releases/download/feed/'])
  })

  it('falls back to the factory default when the user never wrote the key', () => {
    const { home, resources } = layers(undefined, { 'plugins.feedUrls': ['http://default.test/'] })
    expect(resolvePluginFeedUrls(home, resources)).toEqual(['http://default.test/'])
  })

  it('the legacy singular key reads as a one-element list on both layers', () => {
    const { home, resources } = layers(
      { 'plugins.feedUrl': 'http://legacy-user.test/' },
      { 'plugins.feedUrl': 'http://legacy-default.test/' },
    )
    expect(resolvePluginFeedUrls(home, resources)).toEqual(['http://legacy-user.test/'])
    expect(resolvePluginFeedUrls(join(home, 'absent'), resources)).toEqual(['http://legacy-default.test/'])
  })

  it('reads neither from blank values nor blank defaults', () => {
    const { home, resources } = layers(
      { 'plugins.feedUrls': [''], 'plugins.feedUrl': '' },
      { 'plugins.feedUrls': [] },
    )
    expect(resolvePluginFeedUrls(home, resources)).toBeUndefined()
  })

  it('a broken settings.json degrades to the default, a broken default to nothing', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-feed-'))
    const home = join(base, 'home')
    const resources = join(base, 'resources')
    mkdirSync(home, { recursive: true })
    mkdirSync(resources, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{not json')
    writeFileSync(join(resources, 'defaults.json'), JSON.stringify({ 'plugins.feedUrls': ['http://default.test/'] }))
    expect(resolvePluginFeedUrls(home, resources)).toEqual(['http://default.test/'])
    writeFileSync(join(resources, 'defaults.json'), '{not json')
    expect(resolvePluginFeedUrls(home, resources)).toBeUndefined()
  })
})

describe('resolveSignaturePolicy', () => {
  function layers(user: Record<string, unknown> | undefined, factory: Record<string, unknown> | undefined): { home: string, resources: string } {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-policy-'))
    const home = join(base, 'home')
    const resources = join(base, 'resources')
    mkdirSync(home, { recursive: true })
    mkdirSync(resources, { recursive: true })
    if (user !== undefined) writeFileSync(join(home, 'settings.json'), JSON.stringify(user))
    if (factory !== undefined) writeFileSync(join(resources, 'defaults.json'), JSON.stringify(factory))
    return { home, resources }
  }

  it('defaults to open when neither layer names a policy', () => {
    const { home, resources } = layers(undefined, undefined)
    expect(resolveSignaturePolicy(home, resources)).toBe('open')
  })

  it('strict rides the user layer, the factory layer, and wins over open defaults', () => {
    const { home, resources } = layers({ 'plugins.signaturePolicy': 'strict' }, undefined)
    expect(resolveSignaturePolicy(home, resources)).toBe('strict')
    const factory = layers(undefined, { 'plugins.signaturePolicy': 'strict' })
    expect(resolveSignaturePolicy(factory.home, factory.resources)).toBe('strict')
    const both = layers({ 'plugins.signaturePolicy': 'open' }, { 'plugins.signaturePolicy': 'strict' })
    expect(resolveSignaturePolicy(both.home, both.resources)).toBe('open')
  })

  it('an unknown value reads as open', () => {
    const { home, resources } = layers({ 'plugins.signaturePolicy': 'paranoid' }, undefined)
    expect(resolveSignaturePolicy(home, resources)).toBe('open')
  })
})

describe('downloadPluginZipFromUrl', () => {
  it('lands the served bytes in a temp file', async () => {
    const bytes = new Uint8Array(zipSync({
      'package.json': new TextEncoder().encode('{"name":"@scope/alpha","version":"1.0.0"}'),
    }))
    serve({ 'http://direct.test/pkg.zip': bytes })
    const target = await downloadPluginZipFromUrl('http://direct.test/pkg.zip')
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target).equals(bytes)).toBe(true)
    rmSync(target, { force: true })
  })

  it('refuses non-http(s) and unparseable addresses as bad-url', async () => {
    await expectFeedKind(() => downloadPluginZipFromUrl('file:///etc/passwd'), 'bad-url')
    await expectFeedKind(() => downloadPluginZipFromUrl('not a url'), 'bad-url')
  })

  it('reports failed downloads as unreachable', async () => {
    serve({})
    await expectFeedKind(() => downloadPluginZipFromUrl('http://direct.test/absent.zip'), 'unreachable')
  })

  it('refuses a body past the size ceiling before reading it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('', { status: 200, headers: { 'content-length': String(Number.MAX_SAFE_INTEGER) } })))
    await expectFeedKind(() => downloadPluginZipFromUrl('http://direct.test/huge.zip'), 'too-large')
  })
})
