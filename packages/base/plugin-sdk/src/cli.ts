/**
 * Standalone plugin authoring CLI. It intentionally depends only on the
 * public SDK and release format, so an external plugin repository can use it
 * without checking out snap-rail.
 *
 * @module @snap-rail/plugin-sdk/cli
 */

import { createPrivateKey, createPublicKey, readFileSync } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { join } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { definePluginManifest, PLUGIN_TEMPLATES, releaseFiles, signReleaseFiles, verifyReleaseFiles, zipFileName, type PluginTemplate, type ReleaseSpec, type TrustedReleaseKey } from './index.ts'

const usage = `snap-rail-plugin <command>

Commands:
  init <directory> --template <driver|store-provider|ui-view|ui-layout|host-service|tool|suite>
  pack <directory> --out <directory> [--sign-key <key.pem> --key-id <id>]
  doctor <directory>
  inspect <plugin.zip>
  verify <plugin.zip> --public-key <key.pem> --key-id <id>
`

/** Run the standalone plugin CLI. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, target] = argv
  if (command === 'init') {
    await initPlugin(target, option(argv, '--template') as PluginTemplate | undefined)
    return
  }
  if (command === 'inspect' || command === 'verify') {
    if (target === undefined) throw new Error(`${command} requires a zip path`)
    const files = archiveFiles(target)
    if (command === 'verify') {
      const keyPath = option(argv, '--public-key')
      const keyId = option(argv, '--key-id')
      if (keyPath === undefined || keyId === undefined) throw new Error('verify requires --public-key and --key-id')
      const key: TrustedReleaseKey = { keyId, publicKey: createPublicKey(readFileSync(resolve(keyPath))) }
      const metadata = verifyReleaseFiles(files, [key])
      console.log(JSON.stringify({ verified: true, name: metadata.name, version: metadata.version }, null, 2))
    } else {
      const manifest = definePluginManifest(JSON.parse(new TextDecoder().decode(files['package.json']!)))
      console.log(JSON.stringify(manifest, null, 2))
    }
    return
  }
  if (command === 'doctor') {
    if (target === undefined) throw new Error('doctor requires a plugin directory')
    doctorPlugin(target)
    return
  }
  if (command === 'pack') {
    if (target === undefined) throw new Error('pack requires a plugin directory')
    await packPlugin(target, option(argv, '--out'), option(argv, '--sign-key'), option(argv, '--key-id'), option(argv, '--publisher'))
    return
  }
  throw new Error(usage)
}

/** Validate the independent repository contract before spending time on a release build. */
function doctorPlugin(directory: string): void {
  const root = resolve(directory)
  const packagePath = join(root, 'package.json')
  if (!existsSync(packagePath)) throw new Error(`doctor: ${packagePath} 不存在`)
  const source = JSON.parse(readFileSync(packagePath, 'utf8')) as Record<string, unknown>
  const manifest = definePluginManifest(source)
  const snapRail = manifest.snapRail
  const clientEntry = snapRail.client?.entry
  const hostEntry = typeof source.main === 'string' && source.main !== '' ? source.main : undefined
  const clientOnly = snapRail.clientOnly === true
  if (clientOnly && typeof clientEntry !== 'string') throw new Error('doctor: clientOnly 插件必须声明 snapRail.client.entry')
  if (!clientOnly && hostEntry === undefined) throw new Error('doctor: Host 插件必须在 package.json.main 声明宿主入口')
  for (const required of ['tsconfig.json', 'tsdown.config.ts', 'AGENTS.md']) {
    if (!existsSync(join(root, required))) throw new Error(`doctor: 缺少 ${required}`)
  }
  const report = {
    ok: true,
    name: manifest.name,
    version: manifest.version,
    kind: snapRail.kind,
    layer: snapRail.layer,
    hostFace: hostEntry ?? null,
    clientFace: typeof clientEntry === 'string' ? clientEntry : null,
    capabilities: snapRail.capabilities ?? null,
  }
  console.log(JSON.stringify(report, null, 2))
}

async function packPlugin(directory: string, outDirectory: string | undefined, keyPath: string | undefined, keyId: string | undefined, publisher: string | undefined): Promise<void> {
  const root = resolve(directory)
  const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name?: unknown
    version?: unknown
    main?: unknown
    snapRail?: { clientOnly?: unknown, client?: { entry?: unknown }, clientFace?: unknown, exports?: unknown }
    exports?: unknown
  }
  const name = definePluginManifest({ ...source, snapRail: source.snapRail }).name
  const snapRail = source.snapRail ?? {}
  const clientEntry = typeof snapRail.client?.entry === 'string' ? snapRail.client.entry : undefined
  const hostFace = typeof source.main === 'string' && source.main !== '' ? source.main : snapRail.clientOnly === true ? undefined : 'lib/host.js'
  const clientFace = clientEntry === undefined ? undefined : clientEntry.replace(/\/[^/]+$/, '')
  const exports = typeof source.exports === 'object' && source.exports !== null
    ? Object.fromEntries(Object.entries(source.exports as Record<string, unknown>).filter(([key, value]) => key !== '.' && typeof value === 'string')) as Record<string, string>
    : undefined
  const spec: ReleaseSpec = {
    name,
    dir: root,
    ...(hostFace === undefined ? {} : { hostDir: hostFace.replace(/\/[^/]+$/, ''), hostFace }),
    ...(clientFace === undefined ? {} : { clientFace }),
    ...(exports === undefined ? {} : { exports }),
  }
  const unsigned = await releaseFiles(spec)
  if (keyPath === undefined && keyId === undefined) {
    throw new Error('pack requires --sign-key and --key-id; unsigned archives are not installable')
  }
  if (keyPath === undefined || keyId === undefined) throw new Error('pack requires --sign-key and --key-id together')
  const files = signReleaseFiles(unsigned, {
    name,
    version: typeof source.version === 'string' ? source.version : '0.0.0',
    keyId,
    privateKey: createPrivateKey(readFileSync(resolve(keyPath))),
    ...(publisher === undefined ? {} : { publisher }),
  })
  const output = resolve(outDirectory ?? join(root, 'dist'))
  await mkdir(output, { recursive: true })
  const target = join(output, zipFileName(name))
  writeFileSync(target, zipSync(files, { level: 9 }))
  console.log(`packed ${target}`)
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}

function archiveFiles(path: string): Record<string, Uint8Array> {
  const archive = unzipSync(new Uint8Array(readFileSync(resolve(path))))
  const entries = Object.keys(archive).filter(entry => !entry.endsWith('/'))
  const roots = new Set(entries.map(entry => entry.includes('/') ? entry.split('/')[0]! : ''))
  const root = roots.size === 1 && !roots.has('') ? `${[...roots][0]!}/` : ''
  const normalized: Record<string, Uint8Array> = {}
  for (const [entry, data] of Object.entries(archive)) {
    if (entry.endsWith('/')) continue
    normalized[root !== '' && entry.startsWith(root) ? entry.slice(root.length) : entry] = data
  }
  return normalized
}

async function initPlugin(directory: string | undefined, template: PluginTemplate | undefined): Promise<void> {
  if (directory === undefined || template === undefined || !PLUGIN_TEMPLATES.includes(template)) {
    throw new Error(`${usage.trim()}\nAvailable templates: ${PLUGIN_TEMPLATES.join(', ')}`)
  }
  const root = resolve(directory)
  const packageName = `@local/${root.split(/[\\/]/).at(-1) ?? 'snap-plugin'}`.toLowerCase().replaceAll(/[^a-z0-9@/_-]/g, '-')
  await mkdir(resolve(root, 'src'), { recursive: true })
  await mkdir(resolve(root, 'tests'), { recursive: true })
  const manifest = templateManifest(template)
  await writeFile(resolve(root, 'package.json'), `${JSON.stringify({
    name: packageName,
    version: '0.1.0',
    type: 'module',
    ...(template === 'ui-view' || template === 'ui-layout' || template === 'suite' ? {} : { main: 'lib-host/host.js' }),
    scripts: { build: 'tsdown', test: 'vitest run', inspect: 'snap-rail-plugin inspect dist/*.zip' },
    devDependencies: {
      '@snap-rail/plugin-sdk': '^0.1.0',
      '@snap-rail/cordis': '^4.0.1',
      ...(template === 'driver' ? { '@snap-rail/equipment': '^0.1.0' } : {}),
      ...(template === 'store-provider' ? { '@snap-rail/store': '^0.1.0' } : {}),
      ...(template === 'ui-view' || template === 'ui-layout' || template === 'suite'
        ? {
            '@snap-rail/framework-shadcn': '^0.1.0',
            react: '^19.0.0',
            'react-dom': '^19.0.0',
            '@types/react': '^19.0.0',
            '@types/react-dom': '^19.0.0',
          }
        : {}),
    },
    ...(template === 'driver' ? { dependencies: { zod: '^4.4.3' } } : {}),
    snapRail: manifest,
  }, null, 2)}\n`)
  const client = template === 'ui-view' || template === 'ui-layout' || template === 'suite'
  await writeFile(resolve(root, 'tsdown.config.ts'), client
    ? `import { clientBundle } from '@snap-rail/plugin-sdk'\nexport default clientBundle(${JSON.stringify(packageName)}, 'src/client.tsx')\n`
    : `import { hostBundle } from '@snap-rail/plugin-sdk'\nexport default hostBundle('src/index.ts')\n`)
  await writeFile(resolve(root, 'README.md'), `# ${packageName}\n\nGenerated snap-rail ${template} plugin.\n\nBuild with \\`pnpm build\\`; the release zip is assembled by the publisher, never from \\`src/\\`.\n`)
  await writeFile(resolve(root, 'AGENTS.md'), pluginAgentGuide(template))
  await writeFile(resolve(root, client ? 'src/client.tsx' : 'src/index.ts'), templateSource(template))
  await writeFile(resolve(root, 'tsconfig.json'), `${JSON.stringify({ extends: '@snap-rail/plugin-sdk/tsconfig.plugin.json', include: ['src', 'tests'] }, null, 2)}\n`)
  console.log(`initialized ${packageName} in ${root}`)
}

function templateSource(template: PluginTemplate): string {
  if (template === 'driver') return `import '@snap-rail/equipment'\nimport { z } from 'zod'\nimport type { DriverRegistration } from '@snap-rail/equipment/driver'\nimport { definePlugin } from '@snap-rail/plugin-sdk'\n\nconst driver: DriverRegistration = {\n  id: 'generated-driver',\n  title: 'Generated driver',\n  schemas: { device: z.object({}), point: z.object({}) },\n  createConnection: () => ({ update() {}, dispose() {} }),\n}\n\nexport default definePlugin({\n  name: 'generated-driver',\n  inject: ['equipment'],\n  apply(ctx) { ctx.equipment.registerDriver(ctx, driver) },\n})\n`
  if (template === 'store-provider') return `import '@snap-rail/store'\nimport type { StoreService } from '@snap-rail/store'\nimport { definePlugin } from '@snap-rail/plugin-sdk'\n\nconst store: StoreService = {\n  register() { throw new Error('implement the store backend') },\n}\n\nexport default definePlugin({\n  name: 'generated-store-provider',\n  apply(ctx) { ctx.provide('store', store) },\n})\n`
  if (template === 'ui-view') return `import '@snap-rail/framework-shadcn/semantic'\nimport { UI_SLOT_IDS } from '@snap-rail/framework-shadcn/slots'\nimport { definePlugin } from '@snap-rail/plugin-sdk'\n\nexport default definePlugin({\n  name: 'generated-ui-view',\n  inject: ['uiContract'],\n  apply(ctx) {\n    ctx.uiContract.registerView(ctx, { id: 'generated-ui-view', title: 'Generated view', slot: UI_SLOT_IDS.view, order: 100, render: () => null })\n  },\n})\n`
  if (template === 'ui-layout') return `import '@snap-rail/framework-shadcn/semantic'\nimport { UI_SLOT_IDS } from '@snap-rail/framework-shadcn/slots'\nimport { definePlugin } from '@snap-rail/plugin-sdk'\n\nexport default definePlugin({\n  name: 'generated-ui-layout',\n  inject: ['uiContract'],\n  apply(ctx) {\n    ctx.uiContract.registerLayout(ctx, { id: 'generated-ui-layout', order: 0, slots: Object.values(UI_SLOT_IDS), render: () => null })\n  },\n})\n`
  if (template === 'host-service') return `import { definePlugin } from '@snap-rail/plugin-sdk'\n/** Provide a Host capability here. */\nexport default definePlugin({ name: 'generated-host-service', apply() {} })\n`
  if (template === 'tool') return `import { definePlugin } from '@snap-rail/plugin-sdk'\n/** Register a standalone tool here. */\nexport default definePlugin({ name: 'generated-tool', apply() {} })\n`
  return `import { definePlugin } from '@snap-rail/plugin-sdk'\n/** Register a client suite here. */\nexport default definePlugin({ name: 'generated-suite', apply() {} })\n`
}

function templateManifest(template: PluginTemplate): Record<string, unknown> {
  if (template === 'driver') return { kind: 'driver', layer: 'equipment', requires: ['service:equipment'], capabilities: { requires: [{ id: 'equipment.runtime', range: '^1.0.0' }] } }
  if (template === 'store-provider') return { kind: 'plugin', layer: 'store', exclusive: 'store-backend', capabilities: { provides: [{ id: 'store.backend', version: '1.0.0' }] } }
  if (template === 'ui-view') return { kind: 'plugin', layer: 'ui', framework: '@snap-rail/framework-shadcn', clientOnly: true, client: { entry: 'lib-client/client.js' }, capabilities: { requires: [{ id: 'ui.contract', range: '^1.0.0' }] } }
  if (template === 'ui-layout') return { kind: 'plugin', layer: 'ui', framework: '@snap-rail/framework-shadcn', clientOnly: true, client: { entry: 'lib-client/client.js' }, capabilities: { requires: [{ id: 'ui.contract', range: '^1.0.0' }] } }
  if (template === 'host-service') return { kind: 'plugin', layer: 'base' }
  if (template === 'tool') return { kind: 'plugin', layer: 'tool' }
  return { kind: 'suite', layer: 'suite', exclusive: 'suite', framework: '@snap-rail/framework-shadcn', clientOnly: true, client: { entry: 'lib-client/client.js' }, capabilities: { requires: [{ id: 'ui.contract', range: '^1.0.0' }] } }
}

function pluginAgentGuide(template: PluginTemplate): string {
  return `# snap-rail plugin guide\n\nThis repository is an independently developed ${template} plugin. Work only through the public \\`@snap-rail/plugin-sdk\\` surface. Do not import files from a snap-rail checkout or copy host internals.\n\n## Contract rules\n\n- Keep the \\`snapRail\\` manifest complete and validate it with \\`definePluginManifest\\`.\n- Declare every provided and required capability with a version range.\n- Host plugins expose a single host face; renderer plugins expose a CJS client face built by \\`clientBundle\\`.\n- Renderer code may require only the framework seeds and base wire contracts declared by the SDK.\n- Release archives contain built faces and \\`package.json\\` only. Never publish \\`src/\\`.\n\n## Local workflow\n\n\\`pnpm install && pnpm build\\` builds this repository without snap-rail. Use \\`snap-rail-plugin inspect <zip>\\` before publishing and \\`snap-rail-plugin verify <zip> --public-key <key.pem> --key-id <id>\\` to verify a signed artifact.\n`
}

if (process.argv[1]?.endsWith('cli.js') === true) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
