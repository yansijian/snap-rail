/**
 * Standalone plugin authoring CLI. It intentionally depends only on the
 * public SDK and release format, so an external plugin repository can use it
 * without checking out snap-rail.
 *
 * @module @snap-rail/plugin-sdk/cli
 */

import { createPrivateKey, createPublicKey } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { join } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { definePluginManifest, PLUGIN_TEMPLATES, releaseFiles, signReleaseFiles, verifyReleaseFiles, zipFileName, type PluginTemplate, type ReleaseSpec, type TrustedReleaseKey } from './index.ts'

const usage = `snap-rail-plugin <command>

Commands:
  init <directory> --template <driver|store-provider|ui-view|ui-layout|ui-extension|host-service|tool|suite> [--framework <package>]
  pack <directory> --out <directory> [--sign-key <key.pem> --key-id <id>]
  doctor <directory>
  inspect <plugin.zip>
  verify <plugin.zip> --public-key <key.pem> --key-id <id>
`

/** Run the standalone plugin CLI. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, target] = argv
  if (command === 'init') {
    await initPlugin(target, option(argv, '--template') as PluginTemplate | undefined, option(argv, '--framework'))
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
    requires: snapRail.requires ?? [],
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
  // A clientOnly zip's `main` is the client bundle; the npm `main` names the
  // npm ESM barrel and never names a zip face.
  const hostFace = snapRail.clientOnly === true
    ? undefined
    : typeof source.main === 'string' && source.main !== '' ? source.main : 'lib/host.js'
  const hostDir = hostFace === undefined ? undefined : hostFace.replace(/\/[^/]+$/, '')
  const clientFace = clientEntry === undefined ? undefined : clientEntry.replace(/\/[^/]+$/, '')
  // The release manifest carries a flat subpath → target map. Source exports
  // use the standard conditional shape (`{ types, default }`) — flatten to the
  // `default` target. The `.` voice and the `./package.json` self-export are
  // npm conventions: the trimmed release manifest is the zip's package.json,
  // so neither names a zip path the packer must verify. The npm package's
  // remaining subpaths describe the npm layout (the ESM faces, templates,
  // docs) — only targets inside a shipped face directory can ride the zip
  // (a clientOnly zip carries no lib/ at all).
  const faceDirs = [hostDir, clientFace].filter(dir => dir !== undefined)
  const exports = typeof source.exports === 'object' && source.exports !== null
    ? Object.fromEntries(Object.entries(source.exports as Record<string, unknown>).flatMap(([key, value]): Array<[string, string]> => {
        if (key === '.' || key === './package.json') return []
        const raw = typeof value === 'string'
          ? value
          : value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>).default === 'string'
            ? (value as { default: string }).default
            : undefined
        // Zip paths are package-relative without the `./` the npm exports
        // voice spells.
        const target = raw?.replace(/^\.\//, '')
        if (target === undefined || !faceDirs.some(dir => target.startsWith(`${dir}/`))) return []
        return [[key, target]]
      }))
    : undefined
  const spec: ReleaseSpec = {
    name,
    dir: root,
    ...(hostFace === undefined ? {} : { hostDir, hostFace }),
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

async function initPlugin(directory: string | undefined, template: PluginTemplate | undefined, framework: string | undefined): Promise<void> {
  if (directory === undefined || template === undefined || !PLUGIN_TEMPLATES.includes(template)) {
    throw new Error(`${usage.trim()}\nAvailable templates: ${PLUGIN_TEMPLATES.join(', ')}`)
  }
  if (framework !== undefined && template !== 'ui-view' && template !== 'ui-layout' && template !== 'ui-extension' && template !== 'suite') {
    throw new Error('init: --framework applies to the ui-view, ui-layout, ui-extension, and suite templates')
  }
  // The UI faces bind one framework package: its name rides the manifest
  // binding, the devDependencies, the template imports, and — through
  // `client.externalSeeds` — the bundle's external surface (the framework's
  // contributed seeds stay single-instance at runtime).
  const ui = framework ?? '@snap-rail/framework-shadcn'
  const root = resolve(directory)
  const packageName = `@local/${root.split(/[\\/]/).at(-1) ?? 'snap-plugin'}`.toLowerCase().replaceAll(/[^a-z0-9@/_-]/g, '-')
  await mkdir(resolve(root, 'src'), { recursive: true })
  await mkdir(resolve(root, 'tests'), { recursive: true })
  const client = template === 'ui-view' || template === 'ui-layout' || template === 'ui-extension' || template === 'suite'
  const manifest = templateManifest(template, client ? ui : undefined)
  await writeFile(resolve(root, 'package.json'), `${JSON.stringify({
    name: packageName,
    version: '0.1.0',
    type: 'module',
    ...(client ? {} : { main: 'lib-host/host.js' }),
    scripts: { build: 'tsdown', test: 'vitest run', inspect: 'snap-rail-plugin inspect dist/*.zip' },
    devDependencies: {
      '@snap-rail/plugin-sdk': '^0.1.0',
      '@snap-rail/cordis': '^4.0.1',
      tsdown: '^0.22.2',
      vitest: '^3.2.4',
      ...(template === 'driver' ? { '@snap-rail/equipment': '^0.1.0' } : {}),
      ...(template === 'store-provider' ? { '@snap-rail/store': '^0.1.0' } : {}),
      ...(client
        ? {
            [ui]: '^0.1.0',
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
  await writeFile(resolve(root, 'tsdown.config.ts'), client
    ? `import { clientBundle } from '@snap-rail/plugin-sdk'\nexport default clientBundle(${JSON.stringify(packageName)}, 'src/client.tsx')\n`
    : `import { hostBundle } from '@snap-rail/plugin-sdk'\nexport default hostBundle('src/index.ts')\n`)
  await writeFile(resolve(root, 'README.md'), `# ${packageName}\n\nGenerated snap-rail ${template} plugin${client ? ` bound to ${ui}` : ''}.\n\nBuild with \`pnpm build\`; the release zip is assembled by the publisher, never from \`src/\`.\n`)
  await writeFile(resolve(root, 'AGENTS.md'), pluginAgentGuide(template))
  await writeFile(resolve(root, client ? 'src/client.tsx' : 'src/index.ts'), templateSource(template, client ? ui : undefined))
  await writeFile(resolve(root, 'tsconfig.json'), `${JSON.stringify({ extends: '@snap-rail/plugin-sdk/tsconfig.plugin.json', include: ['src', 'tests'] }, null, 2)}\n`)
  console.log(`initialized ${packageName} in ${root}${client ? ` (framework: ${ui})` : ''}`)
}

function templateSource(template: PluginTemplate, ui?: string): string {
  const boundUi = ui ?? '@snap-rail/framework-shadcn'
  if (template === 'driver') return `import '@snap-rail/equipment'\nimport { z } from 'zod'\nimport type { DriverRegistration } from '@snap-rail/equipment/driver'\nimport { definePlugin } from '@snap-rail/plugin-sdk'\n\nconst driver: DriverRegistration = {\n  id: 'generated-driver',\n  title: 'Generated driver',\n  schemas: { device: z.object({}), point: z.object({}) },\n  createConnection: () => ({ update() {}, dispose() {} }),\n}\n\nexport default definePlugin({\n  name: 'generated-driver',\n  inject: ['equipment'],\n  apply(ctx) { ctx.equipment.registerDriver(ctx, driver) },\n})\n`
  if (template === 'store-provider') return `import '@snap-rail/store'\nimport type { StoreService } from '@snap-rail/store'\nimport { definePlugin } from '@snap-rail/plugin-sdk'\n\nconst store: StoreService = {\n  register() { throw new Error('implement the store backend') },\n}\n\nexport default definePlugin({\n  name: 'generated-store-provider',\n  apply(ctx) { ctx.provide('store', store) },\n})\n`
  if (template === 'ui-view') return `import '${boundUi}/semantic'\nimport { UI_SLOT_IDS } from '${boundUi}/slots'\nimport { definePlugin } from '@snap-rail/plugin-sdk'\n\nexport default definePlugin({\n  name: 'generated-ui-view',\n  inject: ['uiContract'],\n  apply(ctx) {\n    ctx.uiContract.registerView(ctx, { id: 'generated-ui-view', title: 'Generated view', slot: UI_SLOT_IDS.view, order: 100, render: () => null })\n  },\n})\n`
  if (template === 'ui-layout') return `import '${boundUi}/semantic'\nimport { UI_SLOT_IDS } from '${boundUi}/slots'\nimport { definePlugin } from '@snap-rail/plugin-sdk'\n\nexport default definePlugin({\n  name: 'generated-ui-layout',\n  inject: ['uiContract'],\n  apply(ctx) {\n    ctx.uiContract.registerLayout(ctx, { id: 'generated-ui-layout', order: 0, slots: Object.values(UI_SLOT_IDS), render: () => null })\n  },\n})\n`
  if (template === 'ui-extension') return `import * as ui from '${boundUi}/ui'\n\n/** Shared components contributed back to every component plugin: the\n * client face exports a \`seeds\` map — the shell seeds \`<package>/<key>\`\n * ids from it and all consumers share these single instances. Build each\n * component on the framework's own primitives (the \`ui\` namespace), never\n * on a private copy. */\nconst widget = () => null\n\nexport default {\n  seeds: { widget },\n}\n`
  if (template === 'host-service') return `import { definePlugin } from '@snap-rail/plugin-sdk'\n/** Provide a Host capability here. */\nexport default definePlugin({ name: 'generated-host-service', apply() {} })\n`
  if (template === 'tool') return `import { definePlugin } from '@snap-rail/plugin-sdk'\n/** Register a standalone tool here. */\nexport default definePlugin({ name: 'generated-tool', apply() {} })\n`
  return `import { definePlugin } from '@snap-rail/plugin-sdk'\n/** Register a client suite here. */\nexport default definePlugin({ name: 'generated-suite', apply() {} })\n`
}

function templateManifest(template: PluginTemplate, ui?: string): Record<string, unknown> {
  const boundUi = ui ?? '@snap-rail/framework-shadcn'
  // The framework binding IS a requires entry (name@range) — the single
  // compatibility declaration; there is no separate framework field.
  if (template === 'driver') return { kind: 'driver', layer: 'equipment', requires: ['service:equipment'] }
  if (template === 'store-provider') return { kind: 'plugin', layer: 'store', exclusive: 'store-backend' }
  if (template === 'ui-view') {
    return {
      kind: 'plugin', layer: 'ui', clientOnly: true,
      requires: [`${boundUi}@^0.1`],
      client: { entry: 'lib-client/client.js', externalSeeds: [`${boundUi}/slots`, `${boundUi}/semantic`] },
    }
  }
  if (template === 'ui-layout') {
    return {
      kind: 'plugin', layer: 'ui', clientOnly: true,
      requires: [`${boundUi}@^0.1`],
      client: { entry: 'lib-client/client.js', externalSeeds: [`${boundUi}/slots`, `${boundUi}/semantic`] },
    }
  }
  if (template === 'ui-extension') {
    return {
      kind: 'plugin', layer: 'ui', clientOnly: true,
      // The extension's own shared components ride `client.seeds`; the
      // components themselves build on the framework's contributed seeds.
      requires: [`${boundUi}@^0.1`],
      client: { entry: 'lib-client/client.js', seeds: ['widget'], externalSeeds: [`${boundUi}/ui`] },
    }
  }
  if (template === 'host-service') return { kind: 'plugin', layer: 'base' }
  if (template === 'tool') return { kind: 'plugin', layer: 'tool' }
  return { kind: 'suite', layer: 'suite', exclusive: 'suite', requires: [`${boundUi}@^0.1`], client: { entry: 'lib-client/client.js' } }
}

function pluginAgentGuide(template: PluginTemplate): string {
  return `# snap-rail plugin guide\n\nThis repository is an independently developed ${template} plugin. Work only through the public \`@snap-rail/plugin-sdk\` surface. Do not import files from a snap-rail checkout or copy host internals.\n\n## Contract rules\n\n- Keep the \`snapRail\` manifest complete and validate it with \`definePluginManifest\`.\n- Declare every dependency once in \`requires\` — package names, \`name@range\` version-constrained packages (the framework binding is \`@snap-rail/framework-shadcn@^0.1\`), or \`service:\` ids.\n- Host plugins expose a single host face; renderer plugins expose a CJS client face built by \`clientBundle\`.\n- Renderer code may require only the framework seeds and base wire contracts declared by the SDK.\n- Release archives contain built faces and \`package.json\` only. Never publish \`src/\`.\n\n## Local workflow\n\n\`pnpm install && pnpm build\` builds this repository without snap-rail. Use \`snap-rail-plugin inspect <zip>\` before publishing and \`snap-rail-plugin verify <zip> --public-key <key.pem> --key-id <id>\` to verify a signed artifact.\n`
}

if (process.argv[1]?.endsWith('cli.js') === true) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
