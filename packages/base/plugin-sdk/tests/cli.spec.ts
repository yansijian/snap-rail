import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli.ts'
import { definePluginManifest } from '../src/index.ts'

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`))
}

// The CLI reports through console.log; capture instead of spamming the run.
let logs: string[] = []
const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
  logs.push(args.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join(' '))
})
const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

afterEach(() => {
  logs = []
  vi.clearAllMocks()
})

function lastReport(): Record<string, unknown> {
  return JSON.parse(logs.at(-1)!) as Record<string, unknown>
}

describe('snap-rail-plugin init', () => {
  it('scaffolds a complete driver repo pinned to this SDK version', async () => {
    const root = tempRoot('sdk-cli-driver')
    try {
      await main(['init', join(root, 'my-driver'), '--template', 'driver'])
      const dir = join(root, 'my-driver')
      const source = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name: string
        main?: string
        devDependencies: Record<string, string>
        dependencies?: Record<string, string>
        snapRail: { kind?: string, requires?: string[] }
      }
      expect(source.name).toBe('@local/my-driver')
      expect(source.main).toBe('lib-host/host.js')
      expect(source.snapRail).toMatchObject({ kind: 'driver', requires: ['@snap-rail/equipment'] })
      expect(source.dependencies?.zod).toBeDefined()
      expect(source.devDependencies['@snap-rail/plugin-sdk']).toMatch(/^\^0\.2\./)
      expect(source.devDependencies['@snap-rail/equipment']).toBeDefined()
      expect(source.devDependencies.react).toBeUndefined()
      for (const file of ['tsconfig.json', 'tsdown.config.ts', 'AGENTS.md', '.gitignore', 'README.md', 'src/index.ts', 'tests/manifest.spec.ts']) {
        expect(existsSync(join(dir, file)), file).toBe(true)
      }
      expect(readFileSync(join(dir, 'tsdown.config.ts'), 'utf8')).toContain('hostBundle')
      // The generated smoke test must reference the real package name.
      expect(readFileSync(join(dir, 'tests', 'manifest.spec.ts'), 'utf8')).toContain('"@local/my-driver"')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('binds UI templates to the framework and externalizes its seeds', async () => {
    const root = tempRoot('sdk-cli-uiview')
    try {
      const dir = join(root, 'panel')
      await main(['init', dir, '--template', 'ui-view'])
      const source = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        main?: string
        devDependencies: Record<string, string>
        snapRail: { clientOnly?: boolean, requires?: string[], client?: { externalSeeds?: string[] } }
      }
      expect(source.main).toBeUndefined()
      expect(source.snapRail.clientOnly).toBe(true)
      expect(source.snapRail.requires).toEqual(['@snap-rail/framework-shadcn@^0.2.0'])
      expect(source.snapRail.client?.externalSeeds).toContain('@snap-rail/framework-shadcn/ui')
      expect(source.devDependencies['@snap-rail/framework-shadcn']).toBe('^0.2.0')
      expect(source.devDependencies.react).toBeDefined()
      const config = readFileSync(join(dir, 'tsdown.config.ts'), 'utf8')
      expect(config).toContain('clientBundle')
      expect(config).not.toContain('hostBundle')
      // The view builds on the framework primitives, not a hand-rolled stub.
      expect(readFileSync(join(dir, 'src', 'client.tsx'), 'utf8')).toContain('Card')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('honors --framework name@range across manifest, deps, and bundle', async () => {
    const root = tempRoot('sdk-cli-fw')
    try {
      const dir = join(root, 'panel')
      await main(['init', dir, '--template', 'ui-view', '--framework', '@acme/ui@^3'])
      const source = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        devDependencies: Record<string, string>
        snapRail: { requires?: string[], client?: { externalSeeds?: string[] } }
      }
      expect(source.snapRail.requires).toEqual(['@acme/ui@^3'])
      expect(source.devDependencies['@acme/ui']).toBe('^3')
      expect(source.snapRail.client?.externalSeeds).toContain('@acme/ui/ui')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('scaffolds the suite as a dual-face package', async () => {
    const root = tempRoot('sdk-cli-suite')
    try {
      const dir = join(root, 'ops-suite')
      await main(['init', dir, '--template', 'suite'])
      const source = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        main?: string
        snapRail: { kind?: string, clientOnly?: boolean, client?: { entry?: string } }
      }
      expect(source.main).toBe('lib-host/host.js')
      expect(source.snapRail.kind).toBe('suite')
      // Dual-face: NOT clientOnly, yet a client entry exists beside the host.
      expect(source.snapRail.clientOnly).toBeUndefined()
      expect(source.snapRail.client?.entry).toBe('lib-client/client.js')
      const config = readFileSync(join(dir, 'tsdown.config.ts'), 'utf8')
      expect(config).toContain('hostBundle')
      expect(config).toContain('clientBundle')
      expect(existsSync(join(dir, 'src', 'index.ts'))).toBe(true)
      expect(existsSync(join(dir, 'src', 'client.tsx'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a non-empty target without --force', async () => {
    const root = tempRoot('sdk-cli-force')
    try {
      const dir = join(root, 'existing')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), '{}')
      await expect(main(['init', dir, '--template', 'tool'])).rejects.toThrow(/--force/)
      await expect(main(['init', dir, '--template', 'tool', '--force'])).resolves.toBeUndefined()
      const source = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { snapRail: { kind?: string } }
      expect(source.snapRail.kind).toBe('plugin')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('snap-rail-plugin doctor', () => {
  it('passes a fresh scaffold with build warnings, and hard-fails on contract breaks', async () => {
    const root = tempRoot('sdk-cli-doctor')
    try {
      const dir = join(root, 'my-driver')
      await main(['init', dir, '--template', 'driver'])
      await main(['doctor', dir])
      const report = lastReport() as { ok: boolean, warnings: string[] }
      // Faces are not built yet — advisory warnings, not a failure.
      expect(report.warnings.length).toBeGreaterThan(0)
      expect(report.warnings.join(' ')).toContain('pnpm run build')

      rmSync(join(dir, 'tsdown.config.ts'))
      await expect(main(['doctor', dir])).rejects.toThrow(/tsdown\.config\.ts/)

      await main(['init', join(root, 'bad'), '--template', 'driver', '--force'])
      const bad = join(root, 'bad', 'package.json')
      const parsed = JSON.parse(readFileSync(bad, 'utf8')) as { snapRail: { requires?: string[] } }
      parsed.snapRail.requires = ['service:store extra']
      writeFileSync(bad, `${JSON.stringify(parsed, null, 2)}\n`)
      await expect(main(['doctor', join(root, 'bad')])).rejects.toThrow(/requires 条目不合法/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('snap-rail-plugin pack / verify / feed', () => {
  it('round-trips a signed zip into a feed index the client can serve', async () => {
    const root = tempRoot('sdk-cli-pack')
    try {
      const dir = join(root, 'my-driver')
      await main(['init', dir, '--template', 'driver'])
      mkdirSync(join(dir, 'lib-host'), { recursive: true })
      writeFileSync(join(dir, 'lib-host', 'host.js'), 'export default {}\n')

      const { privateKey, publicKey } = generateKeyPairSync('ed25519')
      const keyPath = join(dir, 'release.private.pem')
      const pubPath = join(dir, 'release.public.pem')
      writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }))
      writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }))
      const dist = join(dir, 'dist')

      await main(['pack', dir, '--out', dist, '--sign-key', keyPath, '--key-id', 'test-key', '--publisher', 'tester'])
      const zipPath = join(dist, '@local__my-driver.zip')
      expect(existsSync(zipPath)).toBe(true)
      // pack prints the digest of the exact bytes it wrote.
      const digestLine = logs.find(line => line.includes('sha256'))
      expect(digestLine).toContain(createHash('sha256').update(readFileSync(zipPath)).digest('hex'))

      logs = []
      await main(['verify', zipPath, '--public-key', pubPath, '--key-id', 'test-key'])
      expect(lastReport()).toMatchObject({ verified: true, name: '@local/my-driver' })

      logs = []
      await main(['inspect', zipPath])
      expect(lastReport()).toMatchObject({
        name: '@local/my-driver',
        signed: true,
        signature: { algorithm: 'Ed25519', keyId: 'test-key' },
        publisher: 'tester',
      })

      logs = []
      await main(['feed', dist, '--repository', 'https://github.com/t/my-driver'])
      const index = JSON.parse(readFileSync(join(dist, 'index.json'), 'utf8')) as {
        plugins: Array<{ name: string, file: string, sha256: string, size: number, repository?: string, signature?: { keyId: string } }>
      }
      expect(index.plugins).toHaveLength(1)
      const entry = index.plugins[0]!
      expect(entry).toMatchObject({
        name: '@local/my-driver',
        file: '@local__my-driver.zip',
        repository: 'https://github.com/t/my-driver',
        signature: { keyId: 'test-key' },
      })
      const bytes = readFileSync(join(dist, entry.file))
      expect(entry.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(entry.size).toBe(bytes.length)

      // One package name, one entry: a duplicate zip in the same feed fails.
      writeFileSync(join(dist, 'duplicate.zip'), bytes)
      await expect(main(['feed', dist])).rejects.toThrow(/包名只保留一个条目/)

      // The generated manifest validates against the public schema.
      const manifest = definePluginManifest(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')))
      expect(manifest.name).toBe('@local/my-driver')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('pack refuses to run without a signing key', async () => {
    const root = tempRoot('sdk-cli-unsigned')
    try {
      const dir = join(root, 'my-tool')
      await main(['init', dir, '--template', 'tool'])
      await expect(main(['pack', dir, '--out', join(dir, 'dist')])).rejects.toThrow(/sign-key/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('snap-rail-plugin meta', () => {
  it('help and version print without throwing', async () => {
    await expect(main(['--help'])).resolves.toBeUndefined()
    expect(logs.join('\n')).toContain('Commands:')
    logs = []
    await expect(main(['version'])).resolves.toBeUndefined()
    expect(logs.at(-1)).toMatch(/^snap-rail-plugin \d+\.\d+\.\d+/)
  })
})
