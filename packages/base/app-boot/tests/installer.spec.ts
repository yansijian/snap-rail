import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { signReleaseFiles, type TrustedReleaseKey } from '@snap-rail/plugin-kit/sign'
import { compareVersions, InstallError, installPluginFromZip, installedVersionOf, inspectPluginZip, pluginDataFile, uninstallPlugin } from '../src/installer.ts'
import { loadTrustedReleaseKeys } from '../src/trust.ts'

function makeZip(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'snap-rail-zip-'))
  const path = join(dir, 'plugin.zip')
  const encoded: Record<string, Uint8Array> = {}
  for (const [name, content] of Object.entries(files)) {
    encoded[name] = new TextEncoder().encode(content)
  }
  writeFileSync(path, zipSync(encoded))
  return path
}

const MANIFEST = JSON.stringify({
  name: '@scope/demo-plugin',
  version: '1.2.3',
  type: 'module',
  main: 'lib/index.js',
  snapRail: { kind: 'driver', permissions: ['net:demo'] },
})

/** One install zip for `@scope/demo-plugin` at the given version, with a
 * version-tagged entry file so overwrite tests can see the swap. */
function demoZip(version: string, entryName: string): string {
  return makeZip({
    'demo-plugin/package.json': JSON.stringify({
      name: '@scope/demo-plugin', version, type: 'module', main: `lib/${entryName}`,
    }),
    [`demo-plugin/lib/${entryName}`]: `export default { version: "${version}" }`,
  })
}

describe('compareVersions', () => {
  it('orders numeric segments numerically, not lexicographically', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('2.0', '2.0.0')).toBe(0)
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0)
    expect(compareVersions('0.9', '1.0')).toBeLessThan(0)
  })

  it('orders a prerelease before its release and compares identifiers', () => {
    expect(compareVersions('1.2.3-beta', '1.2.3')).toBeLessThan(0)
    expect(compareVersions('1.2.3-beta.2', '1.2.3-beta.1')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3-beta', '1.2.3-alpha')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3-2', '1.2.3-10')).toBeLessThan(0)
  })
})

describe('installedVersionOf', () => {
  it('reads the declared version and reports absent or broken installs', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const pool = join(base, 'plugins')
    expect(installedVersionOf(pool, '@scope/demo-plugin')).toBeUndefined()
    installPluginFromZip(makeZip({ 'p/package.json': MANIFEST }), pool)
    expect(installedVersionOf(pool, '@scope/demo-plugin')).toBe('1.2.3')
    // A broken manifest reads as 0.0.0: any real version may repair it.
    writeFileSync(join(pool, '@scope__demo-plugin', 'package.json'), '{ broken')
    expect(installedVersionOf(pool, '@scope/demo-plugin')).toBe('0.0.0')
    rmSync(base, { recursive: true, force: true })
  })
})

describe('plugin installer', () => {
  it('installs a single-root zip into the pool and reports the package', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const zip = makeZip({
      'demo-plugin/package.json': MANIFEST,
      'demo-plugin/lib/index.js': 'export default { name: "demo", apply() {} }',
    })
    const result = installPluginFromZip(zip, join(base, 'plugins'))
    expect(result.name).toBe('@scope/demo-plugin')
    expect(result.version).toBe('1.2.3')
    expect(result.updated).toBe(false)
    const entry = readFileSync(join(result.dir, 'lib', 'index.js'), 'utf8')
    expect(entry).toContain('apply()')
    expect(result.dir.startsWith(join(base, 'plugins'))).toBe(true)
    rmSync(base, { recursive: true, force: true })
  })

  it('installs a zip whose package sits at the archive root', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const zip = makeZip({ 'package.json': MANIFEST })
    const result = installPluginFromZip(zip, join(base, 'plugins'))
    expect(existsSync(join(result.dir, 'package.json'))).toBe(true)
    rmSync(base, { recursive: true, force: true })
  })

  it('rejects zips without a manifest and illegal names', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const noManifest = makeZip({ 'lib/index.js': 'x' })
    expect(() => installPluginFromZip(noManifest, join(base, 'plugins'))).toThrow(InstallError)
    try {
      installPluginFromZip(noManifest, join(base, 'plugins'))
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('bad-manifest')
    }
    const badName = makeZip({ 'p/package.json': JSON.stringify({ name: 'Not A Name' }) })
    try {
      installPluginFromZip(badName, join(base, 'plugins'))
      expect.unreachable()
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('bad-manifest')
    }
    const badKind = makeZip({ 'p/package.json': JSON.stringify({ name: 'ok-name', snapRail: { kind: 'Not Kebab' } }) })
    try {
      installPluginFromZip(badKind, join(base, 'plugins'))
      expect.unreachable()
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('bad-manifest')
    }
    const badTitle = makeZip({ 'p/package.json': JSON.stringify({ name: 'ok-name', snapRail: { title: 'x'.repeat(65) } }) })
    try {
      installPluginFromZip(badTitle, join(base, 'plugins'))
      expect.unreachable()
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('bad-manifest')
    }
    rmSync(base, { recursive: true, force: true })
  })

  it('inspects a zip with its display name and markers', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const zip = makeZip({
      'p/package.json': JSON.stringify({
        name: '@scope/named-plugin', version: '2.0.0', type: 'module', main: 'lib/index.js',
        snapRail: { title: '示例插件', category: '工具' },
      }),
    })
    const plugin = inspectPluginZip(zip)
    expect(plugin.title).toBe('示例插件')
    expect(plugin.category).toBe('工具')
    expect(plugin.hasClient).toBe(false)
    rmSync(base, { recursive: true, force: true })
  })

  it('updates an installed package in place when the zip is strictly higher', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const pool = join(base, 'plugins')
    const home = join(base, 'home')
    mkdirSync(join(home, 'data'), { recursive: true })

    const v1 = installPluginFromZip(demoZip('1.0.0', 'old.js'), pool)
    // The update must not touch the package's namespaced data.
    const data = pluginDataFile(home, '@scope/demo-plugin')
    writeFileSync(data, 'x')

    const v2 = installPluginFromZip(demoZip('1.1.0', 'new.js'), pool)
    expect(v2.updated).toBe(true)
    expect(v2.dir).toBe(v1.dir)
    // The swap replaced the tree: new content in, dropped files gone.
    expect(readFileSync(join(v2.dir, 'lib', 'new.js'), 'utf8')).toContain('1.1.0')
    expect(existsSync(join(v2.dir, 'lib', 'old.js'))).toBe(false)
    expect(installedVersionOf(pool, '@scope/demo-plugin')).toBe('1.1.0')
    // No staging directory is left behind in the pool.
    expect(readdirSync(pool).filter(name => name.includes('.update-'))).toEqual([])
    expect(existsSync(data)).toBe(true)
    rmSync(base, { recursive: true, force: true })
  })

  it('refuses to update when the zip version is not strictly higher', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const pool = join(base, 'plugins')
    installPluginFromZip(demoZip('1.2.3', 'index.js'), pool)
    // Equal version: reinstalling is refused.
    try {
      installPluginFromZip(demoZip('1.2.3', 'index.js'), pool)
      expect.unreachable()
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('conflict')
      expect((cause as InstallError).message).toContain('1.2.3')
    }
    // Lower version: downgrading goes through an explicit uninstall.
    try {
      installPluginFromZip(demoZip('1.0.0', 'old.js'), pool)
      expect.unreachable()
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('conflict')
    }
    // The refused attempts left the installed copy intact.
    expect(installedVersionOf(pool, '@scope/demo-plugin')).toBe('1.2.3')
    rmSync(base, { recursive: true, force: true })
  })

  it('repairs a broken install: an unreadable manifest counts as 0.0.0', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const pool = join(base, 'plugins')
    installPluginFromZip(demoZip('1.0.0', 'index.js'), pool)
    writeFileSync(join(pool, '@scope__demo-plugin', 'package.json'), '{ broken')
    const repaired = installPluginFromZip(demoZip('1.0.0', 'index.js'), pool)
    expect(repaired.updated).toBe(true)
    expect(installedVersionOf(pool, '@scope/demo-plugin')).toBe('1.0.0')
    rmSync(base, { recursive: true, force: true })
  })

  it('refuses a reserved built-in name before anything lands', () => {
    // The reserved gate is the anti-impersonation guard: a zip claiming a
    // shipped package's name is a conflict, and the same zip installs fine
    // into an unreserved pool.
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const zip = makeZip({
      'p/package.json': JSON.stringify({ name: '@snap-rail/settings', version: '9.9.9', type: 'module', main: 'lib/index.js' }),
    })
    try {
      installPluginFromZip(zip, join(base, 'plugins'), { reserved: ['@snap-rail/settings'] })
      expect.unreachable()
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('conflict')
    }
    expect(existsSync(join(base, 'plugins', '@snap-rail__settings'))).toBe(false)
    const result = installPluginFromZip(zip, join(base, 'plugins'))
    expect(result.name).toBe('@snap-rail/settings')
    rmSync(base, { recursive: true, force: true })
  })

  it('uninstalls the pool directory and the namespaced data files', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-install-'))
    const pool = join(base, 'plugins')
    const home = join(base, 'home')
    mkdirSync(join(home, 'data'), { recursive: true })
    const zip = makeZip({ 'p/package.json': MANIFEST })
    const installed = installPluginFromZip(zip, pool)
    const data = pluginDataFile(home, '@scope/demo-plugin')
    writeFileSync(data, 'x')
    writeFileSync(`${data}-wal`, 'y')

    uninstallPlugin('@scope/demo-plugin', pool, home)
    expect(existsSync(installed.dir)).toBe(false)
    expect(existsSync(data)).toBe(false)
    expect(existsSync(`${data}-wal`)).toBe(false)
    try {
      uninstallPlugin('@scope/demo-plugin', pool, home)
      expect.unreachable()
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('not-installed')
    }
    rmSync(base, { recursive: true, force: true })
  })
})

describe('seed ABI precheck', () => {
  const hostAbi = { revision: 1, versions: { 'zod': '4.4.3' } }

  function abiZip(seedAbi: Record<string, unknown> | undefined): string {
    const snapRail: Record<string, unknown> = { kind: 'driver' }
    if (seedAbi !== undefined) snapRail.client = { entry: 'lib/client.js', seedAbi }
    return makeZip({
      'p/package.json': JSON.stringify({
        name: '@scope/demo-plugin', version: '1.0.0', type: 'module', main: 'lib/index.js', snapRail,
      }),
      'p/lib/client.js': 'module.exports = {}',
    })
  }

  it('refuses a foreign revision before anything lands', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-abi-'))
    const pool = join(base, 'plugins')
    try {
      installPluginFromZip(abiZip({ revision: 99, versions: {} }), pool, { seedAbi: hostAbi })
      expect.unreachable()
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('conflict')
      expect((cause as InstallError).message).toContain('r99')
    }
    expect(existsSync(join(pool, '@snap-rail__demo-plugin'))).toBe(false)
    rmSync(base, { recursive: true, force: true })
  })

  it('refuses a major drift on a declared seed', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-abi-'))
    const pool = join(base, 'plugins')
    expect(() => installPluginFromZip(abiZip({ revision: 1, versions: { 'zod': '5.0.0' } }), pool, { seedAbi: hostAbi }))
      .toThrow(/主版本不一致/)
    expect(existsSync(join(pool, '@snap-rail__demo-plugin'))).toBe(false)
    rmSync(base, { recursive: true, force: true })
  })

  it('passes same-major stamps and absent declarations', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-abi-'))
    const pool = join(base, 'plugins')
    installPluginFromZip(abiZip({ revision: 1, versions: { 'zod': '4.9.1' } }), pool, { seedAbi: hostAbi })
    expect(installedVersionOf(pool, '@scope/demo-plugin')).toBe('1.0.0')
    const plain = makeZip({
      'p/package.json': JSON.stringify({ name: '@scope/demo-plugin', version: '2.0.0', type: 'module', main: 'lib/index.js' }),
    })
    const updated = installPluginFromZip(plain, pool, { seedAbi: hostAbi })
    expect(updated.updated).toBe(true)
    rmSync(base, { recursive: true, force: true })
  })
})

describe('signature gate (three-state open policy)', () => {
  /** A fresh throwaway pool per call — installs never collide across tests. */
  function pool(): string {
    return join(mkdtempSync(join(tmpdir(), 'snap-rail-gate-')), 'plugins')
  }
  /** An Ed25519 key pair plus the trust-store row that trusts its public half. */
  function makeKey(keyId: string, publisher?: string): { row: TrustedReleaseKey, privateKeyPem: string } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    return {
      row: {
        keyId,
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        ...(publisher !== undefined ? { publisher } : {}),
      },
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }
  }

  /** A plugin zip, Ed25519-signed when a key is given. */
  function releaseZip(options: {
    name?: string
    version?: string
    keyId?: string
    privateKeyPem?: string
    tamper?: boolean
  }): string {
    const name = options.name ?? '@scope/demo-plugin'
    const version = options.version ?? '1.0.0'
    let files: Record<string, Uint8Array> = {
      'package.json': new TextEncoder().encode(JSON.stringify({
        name, version, type: 'module', main: 'lib/index.js',
      })),
      'lib/index.js': new TextEncoder().encode('export default { apply() {} }\n'),
    }
    if (options.keyId !== undefined && options.privateKeyPem !== undefined) {
      files = signReleaseFiles(files, {
        name, version, keyId: options.keyId, privateKey: options.privateKeyPem,
        // The trusted key's publisher check compares against this claim —
        // the tests sign as the org they trust.
        publisher: 'snap-rail-org',
      })
    }
    // Tampering swaps bytes after signing — the digest table no longer
    // matches, exactly what a modified-in-transit archive looks like.
    if (options.tamper === true) {
      files['lib/index.js'] = new TextEncoder().encode('export default { tampered: true }\n')
    }
    const dir = mkdtempSync(join(tmpdir(), 'snap-rail-signed-'))
    const path = join(dir, 'plugin.zip')
    writeFileSync(path, zipSync(files))
    return path
  }

  it('verifies a trusted-key signature and reports the publisher', () => {
    const org = makeKey('org-2026', 'snap-rail-org')
    const zip = releaseZip({ keyId: 'org-2026', privateKeyPem: org.privateKeyPem })
    const plugin = inspectPluginZip(zip, { trustedKeys: [org.row] })
    expect(plugin.signature).toEqual({ state: 'verified', keyId: 'org-2026', publisher: 'snap-rail-org' })
    expect(installPluginFromZip(zip, pool(), { trustedKeys: [org.row] }).name).toBe('@scope/demo-plugin')
  })

  it('hard-refuses when a trusted key verifies against tampered bytes', () => {
    const org = makeKey('org-2026', 'snap-rail-org')
    const zip = releaseZip({ keyId: 'org-2026', privateKeyPem: org.privateKeyPem, tamper: true })
    try {
      inspectPluginZip(zip, { trustedKeys: [org.row] })
      expect.unreachable()
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('bad-signature')
    }
  })

  it('unsigned archives read unverified: open installs, inspect surfaces the verdict', () => {
    const org = makeKey('org-2026', 'snap-rail-org')
    const zip = releaseZip({})
    const plugin = inspectPluginZip(zip, { trustedKeys: [org.row] })
    expect(plugin.signature).toEqual({ state: 'unverified', reason: 'unsigned' })
    // Open policy (the default) lets it through…
    expect(installPluginFromZip(zip, pool(), { trustedKeys: [org.row] }).name).toBe('@scope/demo-plugin')
    // …and strict refuses.
    try {
      installPluginFromZip(zip, pool(), { trustedKeys: [org.row], signaturePolicy: 'strict' })
      expect.unreachable()
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('bad-signature')
      expect((cause as InstallError).message).toContain('严格签名策略')
    }
  })

  it('an unregistered key reads unverified: open installs, strict refuses', () => {
    const org = makeKey('org-2026', 'snap-rail-org')
    const author = makeKey('author-2026')
    const zip = releaseZip({ keyId: 'author-2026', privateKeyPem: author.privateKeyPem })
    const plugin = inspectPluginZip(zip, { trustedKeys: [org.row] })
    expect(plugin.signature).toEqual({ state: 'unverified', keyId: 'author-2026', reason: 'unknown-key' })
    expect(installPluginFromZip(zip, pool(), { trustedKeys: [org.row] }).name).toBe('@scope/demo-plugin')
    expect(() => installPluginFromZip(zip, pool(), { trustedKeys: [org.row], signaturePolicy: 'strict' }))
      .toThrow(/author-2026/)
  })

  it('the @snap-rail/* namespace refuses unless verified, whatever the policy', () => {
    const org = makeKey('org-2026', 'snap-rail-org')
    const zip = releaseZip({ name: '@snap-rail/rogue' })
    try {
      installPluginFromZip(zip, pool(), { trustedKeys: [org.row] })
      expect.unreachable()
    } catch (cause) {
      expect((cause as InstallError).kind).toBe('bad-signature')
      expect((cause as InstallError).message).toContain('@snap-rail/*')
    }
    // The dev path (no trust store) stays ungated.
    expect(installPluginFromZip(zip, pool()).name).toBe('@snap-rail/rogue')
    // The org's own signature satisfies the namespace under the open policy.
    const signed = releaseZip({ name: '@snap-rail/official-ext', keyId: 'org-2026', privateKeyPem: org.privateKeyPem })
    expect(installPluginFromZip(signed, pool(), { trustedKeys: [org.row] }).name).toBe('@snap-rail/official-ext')
  })
})

describe('loadTrustedReleaseKeys (factory ∪ home)', () => {
  /** A throwaway home + resources pair with an Ed25519 public key each. */
  function keyDoc(kid: string, publisher: string): string {
    const { publicKey } = require('node:crypto').generateKeyPairSync('ed25519')
    return JSON.stringify({ keys: [{ keyId: kid, publisher, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }] })
  }

  it('merges the factory layer with the home layer; home wins on keyId', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-trust-'))
    const home = join(base, 'home')
    const resources = join(base, 'resources')
    mkdirSync(home, { recursive: true })
    mkdirSync(resources, { recursive: true })
    // Neither layer: the empty store still fails closed.
    expect(loadTrustedReleaseKeys(home, resources)).toEqual([])
    // Factory alone.
    writeFileSync(join(resources, 'trusted-release-keys.json'), keyDoc('org', 'snap-rail'))
    let keys = loadTrustedReleaseKeys(home, resources)
    expect(keys.map(key => key.keyId)).toEqual(['org'])
    // Home adds one and overrides the factory publisher remap for another.
    writeFileSync(join(home, 'trusted-release-keys.json'), JSON.stringify({
      keys: [
        { keyId: 'org', publisher: 'site-remap', publicKeyPem: JSON.parse(keyDoc('org', 'x')).keys[0].publicKeyPem },
        { keyId: 'site', publisher: 'site', publicKeyPem: JSON.parse(keyDoc('site', 'x')).keys[0].publicKeyPem },
      ],
    }))
    keys = loadTrustedReleaseKeys(home, resources)
    expect(keys.map(key => key.keyId).sort()).toEqual(['org', 'site'])
    expect(keys.find(key => key.keyId === 'org')?.publisher).toBe('site-remap')
    rmSync(base, { recursive: true, force: true })
  })

  it('skips the factory layer when no resources dir is given', () => {
    const base = mkdtempSync(join(tmpdir(), 'snap-rail-trust-'))
    writeFileSync(join(base, 'trusted-release-keys.json'), keyDoc('only', 'home'))
    const keys = loadTrustedReleaseKeys(base)
    expect(keys.map(key => key.keyId)).toEqual(['only'])
    rmSync(base, { recursive: true, force: true })
  })
})
