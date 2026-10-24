#!/usr/bin/env node
/**
 * Standalone plugin authoring CLI. It intentionally depends only on the
 * public SDK and release format, so an external plugin repository can use it
 * without checking out snap-rail.
 *
 * The shebang is load-bearing: npm writes POSIX/Windows bin shims that call
 * `node <entry>` only when the built file starts with `#!`; without it the
 * shim hands the `.js` to the OS as a document — Windows opens the
 * "choose an app" dialog and exits 0 without running the CLI.
 *
 * @module @snap-rail/plugin-sdk/cli
 */

import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { zipSync, unzipSync } from 'fflate'
import { catalogEntryFromZip, definePluginManifest, PLUGIN_TEMPLATES, releaseFiles, signReleaseFiles, verifyReleaseFiles, zipFileName, type PluginTemplate, type ReleaseSpec, type TrustedReleaseKey } from './index.ts'

/** The SDK's own published version — generated repos pin this as `^<version>`. */
const sdkVersion = createRequire(import.meta.url)('../package.json').version as string

/** The UI framework a component plugin binds to. The manifest `requires`
 * entry, the devDependency, and the bundle's external seeds all derive from
 * this one pair — templates can never disagree about the binding. */
const DEFAULT_FRAMEWORK = '@snap-rail/framework-shadcn'
const FRAMEWORK_RANGE = '^0.2.0'

interface FrameworkBinding {
  name: string
  range: string
}

const usage = `snap-rail-plugin <command>

Commands:
  init <directory> --template <driver|store-provider|ui-view|ui-layout|ui-extension|host-service|tool|suite>
      [--framework <package[@range]>] [--force]
  doctor <directory>
      Validate the repository contract (manifest, faces, built entries).
  pack <directory> --out <dir> --sign-key <key.pem> --key-id <id> [--publisher <name>]
      Assemble and sign the installable zip (unsigned archives are not installable).
  feed <zip-directory> [--out <dir>] [--repository <url>]
      Build index.json from the directory's signed zips (the rolling-release feed).
  inspect <plugin.zip>
      Identity, faces, and signature summary (no key needed).
  verify <plugin.zip> --public-key <key.pem> --key-id <id>
  version | help
`

/** Run the standalone plugin CLI. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, target] = argv
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    console.log(usage)
    return
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(`snap-rail-plugin ${sdkVersion}`)
    return
  }
  if (command === 'init') {
    await initPlugin(target, option(argv, '--template') as PluginTemplate | undefined, option(argv, '--framework'), hasFlag(argv, '--force'))
    return
  }
  if (command === 'inspect' || command === 'verify') {
    if (target === undefined) throw new Error(`${command} requires a zip path`)
    const files = unzipArchiveFiles(target)
    if (command === 'verify') {
      const keyPath = option(argv, '--public-key')
      const keyId = option(argv, '--key-id')
      if (keyPath === undefined || keyId === undefined) throw new Error('verify requires --public-key and --key-id')
      const key: TrustedReleaseKey = { keyId, publicKey: createPublicKey(readFileSync(resolve(keyPath))) }
      const metadata = verifyReleaseFiles(files, [key])
      console.log(JSON.stringify({ verified: true, name: metadata.name, version: metadata.version }, null, 2))
    } else {
      inspectArchive(files)
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
  if (command === 'feed') {
    if (target === undefined) throw new Error('feed requires a directory of signed zips')
    feedIndex(target, option(argv, '--out'), option(argv, '--repository'))
    return
  }
  throw new Error(usage)
}

/** Validate the independent repository contract before spending time on a
 * release build. Exit is green with warnings (advisory), red on contract
 * violations — a broken repository never reaches pack quietly. */
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
  const warnings: string[] = []
  for (const entry of snapRail.requires ?? []) {
    if (!/^(?:service:[a-z0-9-]+|(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*(?:@\S+)?)$/.test(entry)) {
      throw new Error(`doctor: requires 条目不合法：${entry}（应为 包名 / name@range / service:id）`)
    }
  }
  if (hostEntry !== undefined && !existsSync(join(root, hostEntry))) {
    warnings.push(`宿主入口尚未构建：${hostEntry} 不存在（先 pnpm run build，否则 pack 会拒绝）`)
  }
  if (typeof clientEntry === 'string' && !existsSync(join(root, clientEntry))) {
    warnings.push(`渲染入口尚未构建：${clientEntry} 不存在（先 pnpm run build，否则 pack 会拒绝）`)
  }
  // A scoped package *name* starts with `@` too; a version binding is the
  // only form with an `@` after the first character (`pkg@^1`,
  // `@scope/pkg@^1`). `requires: ['@snap-rail/equipment']` is a name, not a
  // framework binding, and must not silence this warning.
  const versionBound = (snapRail.requires ?? []).some(entry => entry.lastIndexOf('@') > 0)
  if (snapRail.client !== undefined && !versionBound) {
    warnings.push('渲染面插件应声明框架绑定（requires: <framework>@<range>）——绑定即生态依赖')
  }
  if (manifest.name.startsWith('@snap-rail/')) {
    warnings.push('@snap-rail/* 命名空间在终端侧强制受信签名（官方）——社区包请使用你自己的 scope')
  }
  const report = {
    ok: warnings.length === 0,
    warnings,
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
    : typeof source.main === 'string' && source.main !== '' ? source.main : 'lib-host/host.js'
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
  // Fail fast on a missing key before spending time assembling faces.
  if (keyPath === undefined && keyId === undefined) {
    throw new Error('pack requires --sign-key and --key-id; unsigned archives are not installable')
  }
  if (keyPath === undefined || keyId === undefined) throw new Error('pack requires --sign-key and --key-id together')
  const unsigned = await releaseFiles(spec)
  const files = signReleaseFiles(unsigned, {
    name,
    version: typeof source.version === 'string' ? source.version : '0.0.0',
    keyId,
    privateKey: createPrivateKey(readFileSync(resolve(keyPath))),
    ...(publisher === undefined ? {} : { publisher }),
  })
  const output = resolve(outDirectory ?? join(root, 'dist'))
  await mkdir(output, { recursive: true })
  const zipped = zipSync(files, { level: 9 })
  const target = join(output, zipFileName(name))
  writeFileSync(target, zipped)
  console.log(`packed ${target}`)
  console.log(`  sha256 ${createHash('sha256').update(zipped).digest('hex')}`)
  console.log(`  size   ${zipped.length}`)
  console.log('下一步：snap-rail-plugin feed <dist 目录> 产出 index.json，随 zip 一起平铺上传到你仓库的滚动 Release（tag: feed）。')
}

/**
 * Build the rolling-release `index.json` from a directory of signed zips —
 * the piece a community author's feed release needs besides the zips
 * themselves (the client downloads `index.json`, verifies each entry's
 * sha256/size, and resolves same-directory `file` names against the feed
 * root). Refuses unsigned zips and duplicate package names.
 */
function feedIndex(directory: string, outDirectory: string | undefined, repository: string | undefined): void {
  const root = resolve(directory)
  const out = resolve(outDirectory ?? root)
  const zips = readdirSync(root).filter(file => file.endsWith('.zip')).sort()
  if (zips.length === 0) throw new Error(`feed: ${root} 里没有 zip —— 先 pack`)
  const byName = new Map<string, ReturnType<typeof catalogEntryFromZip>>()
  for (const file of zips) {
    const bytes = new Uint8Array(readFileSync(join(root, file)))
    const entry = catalogEntryFromZip(bytes, file, file.replace(/\.zip$/, ''), {
      requireSignature: true,
      ...(repository === undefined || repository === '' ? {} : { repository }),
    })
    const previous = byName.get(entry.name)
    if (previous !== undefined) {
      throw new Error(`feed: ${previous.file} 与 ${file} 都声明包名 ${entry.name} —— 一个源里每个包名只保留一个条目（同目录只放最新版）`)
    }
    byName.set(entry.name, entry)
    console.log(`feed: ${entry.name}@${entry.version} → ${file}`)
  }
  writeFileSync(join(out, 'index.json'), `${JSON.stringify({ plugins: [...byName.values()] }, null, 2)}\n`)
  console.log(`feed: wrote ${join(out, 'index.json')} (${byName.size} plugins)`)
}

/** Print a zip's identity, faces, and signature state (no key required). */
function inspectArchive(files: Record<string, Uint8Array>): void {
  const manifestFile = files['package.json']
  if (manifestFile === undefined) throw new Error('inspect: zip 缺少 package.json')
  const manifest = definePluginManifest(JSON.parse(new TextDecoder().decode(manifestFile)))
  const releaseFile = files['META-INF/release.json']
  const release = releaseFile === undefined
    ? undefined
    : JSON.parse(new TextDecoder().decode(releaseFile)) as { publisher?: string, createdAt?: string }
  const signatureFile = files['META-INF/signature.json']
  const signature = signatureFile === undefined
    ? undefined
    : JSON.parse(new TextDecoder().decode(signatureFile)) as { algorithm?: string, keyId?: string }
  const snapRail = manifest.snapRail
  console.log(JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    kind: snapRail.kind ?? null,
    title: snapRail.title ?? null,
    category: snapRail.category ?? null,
    requires: snapRail.requires ?? [],
    hostFace: snapRail.clientOnly === true ? null : manifest.main ?? null,
    clientFace: snapRail.client?.entry ?? null,
    files: Object.keys(files).length,
    signed: signature !== undefined,
    signature: signature !== undefined ? { algorithm: signature.algorithm, keyId: signature.keyId } : null,
    publisher: release?.publisher ?? null,
    createdAt: release?.createdAt ?? null,
  }, null, 2))
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name)
}

/**
 * Resolve a zip's file map, normalizing away an optional single top-level
 * directory (macOS archives and manual uploads often nest one).
 */
function unzipArchiveFiles(path: string): Record<string, Uint8Array> {
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

async function initPlugin(directory: string | undefined, template: PluginTemplate | undefined, frameworkOption: string | undefined, force: boolean): Promise<void> {
  if (directory === undefined || template === undefined || !PLUGIN_TEMPLATES.includes(template)) {
    throw new Error(`${usage.trim()}\nAvailable templates: ${PLUGIN_TEMPLATES.join(', ')}`)
  }
  const uiTemplates: readonly PluginTemplate[] = ['ui-view', 'ui-layout', 'ui-extension', 'suite']
  if (frameworkOption !== undefined && !uiTemplates.includes(template)) {
    throw new Error('init: --framework applies to the ui-view, ui-layout, ui-extension, and suite templates')
  }
  const framework = parseFrameworkBinding(frameworkOption)
  const root = resolve(directory)
  if (!force && (existsSync(join(root, 'package.json')) || existsSync(join(root, 'src')))) {
    throw new Error(`init: ${root} 不是空目录（确认后加 --force 覆盖）`)
  }
  const packageName = `@local/${root.split(/[\\/]/).at(-1) ?? 'snap-plugin'}`.toLowerCase().replaceAll(/[^a-z0-9@/_-]/g, '-')
  // The suite is the one dual-face template: a scene's host logic and its
  // renderer face ship in one package.
  const isClient = uiTemplates.includes(template)
  const isHost = !isClient || template === 'suite'
  await mkdir(resolve(root, 'src'), { recursive: true })
  await mkdir(resolve(root, 'tests'), { recursive: true })
  const manifest = templateManifest(template, framework)
  await writeFile(resolve(root, 'package.json'), `${JSON.stringify({
    name: packageName,
    version: '0.1.0',
    description: `A snap-rail ${template} plugin`,
    license: 'Apache-2.0',
    type: 'module',
    ...(isHost ? { main: 'lib-host/host.js' } : {}),
    scripts: {
      build: 'tsdown',
      test: 'vitest run',
      doctor: 'snap-rail-plugin doctor .',
      pack: 'snap-rail-plugin pack . --out dist --sign-key .keys/release.private.pem --key-id my-key',
      feed: 'snap-rail-plugin feed dist',
    },
    devDependencies: {
      '@snap-rail/plugin-sdk': `^${sdkVersion}`,
      '@snap-rail/cordis': '^4.0.1',
      // `tsconfig.plugin.json` sets `types: ["node"]`; without this the
      // generated repo's editor/tsc cannot resolve node builtins.
      '@types/node': '^22.20.0',
      tsdown: '^0.22.2',
      vitest: '^3.2.4',
      ...(template === 'driver' ? { '@snap-rail/equipment': '^0.1.0' } : {}),
      ...(template === 'store-provider' ? { '@snap-rail/store': '^0.1.0' } : {}),
      ...(isClient
        ? {
            [framework.name]: framework.range,
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
  await writeFile(resolve(root, 'tsdown.config.ts'), tsdownConfigSource(template, packageName))
  await writeFile(resolve(root, 'tsconfig.json'), `${JSON.stringify({ extends: '@snap-rail/plugin-sdk/tsconfig.plugin.json', include: ['src', 'tests'] }, null, 2)}\n`)
  await writeFile(resolve(root, '.gitignore'), gitignoreSource)
  await writeFile(resolve(root, 'README.md'), readmeSource(template, packageName, framework, isHost))
  await writeFile(resolve(root, 'AGENTS.md'), agentGuide(template, framework))
  await writeFile(resolve(root, 'tests', 'manifest.spec.ts'), sampleTestSource(packageName, template))
  if (isHost) await writeFile(resolve(root, 'src', 'index.ts'), hostSource(template, packageName))
  if (isClient) await writeFile(resolve(root, 'src', 'client.tsx'), clientSource(template, packageName, framework))
  console.log(`initialized ${packageName} in ${root}${isClient ? ` (framework: ${framework.name}@${framework.range})` : ''}`)
}

/** `--framework <package[@range]>`; the default is the first-party framework. */
function parseFrameworkBinding(value: string | undefined): FrameworkBinding {
  if (value === undefined || value === '') return { name: DEFAULT_FRAMEWORK, range: FRAMEWORK_RANGE }
  const scoped = value.startsWith('@')
  const separator = value.indexOf('@', scoped ? 1 : 0)
  if (separator <= 0) {
    if (!/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(value)) {
      throw new Error(`init: --framework 不是合法的包名：${value}`)
    }
    return { name: value, range: FRAMEWORK_RANGE }
  }
  const name = value.slice(0, separator)
  const range = value.slice(separator + 1)
  if (name === '' || range === '') throw new Error(`init: --framework 需要 <package> 或 <package>@<range>（收到 ${value}）`)
  return { name, range }
}

function tsdownConfigSource(template: PluginTemplate, packageName: string): string {
  if (template === 'suite') {
    return `import { clientBundle, hostBundle } from '@snap-rail/plugin-sdk'

// 双面套件：宿主面（场景私有逻辑）+ 渲染面（场景界面）在同一个包里。
export default [
  hostBundle('src/index.ts'),
  clientBundle(${JSON.stringify(packageName)}, 'src/client.tsx'),
]
`
  }
  if (template === 'ui-view' || template === 'ui-layout' || template === 'ui-extension') {
    return `import { clientBundle } from '@snap-rail/plugin-sdk'

// 渲染面：CJS 工厂包，种子模块（框架原语/契约）外部化到运行时种子表。
export default clientBundle(${JSON.stringify(packageName)}, 'src/client.tsx')
`
  }
  return `import { hostBundle } from '@snap-rail/plugin-sdk'

// 宿主面：ESM node 包；package.json 依赖保持外部，其余打进包里。
export default hostBundle('src/index.ts')
`
}

const gitignoreSource = `node_modules/
lib-host/
lib-client/
dist/
*.tsbuildinfo
.keys/
`

function readmeSource(template: PluginTemplate, packageName: string, framework: FrameworkBinding, isHost: boolean): string {
  const binding = isHost && template !== 'suite' ? '' : `（绑定 ${framework.name}@${framework.range}）`
  return `# ${packageName}

snap-rail ${template} 插件，由 \`@snap-rail/plugin-sdk\` init 生成${binding}。

## 开发

\`\`\`sh
pnpm install
pnpm run build    # 宿主面 → lib-host/，渲染面 → lib-client/
pnpm run test
pnpm run doctor   # 发布前的仓库契约自检
\`\`\`

## 打包与发布

\`\`\`sh
# 1. 生成你自己的 Ed25519 密钥（一次性；.keys/ 已在 .gitignore 里）
openssl genpkey -algorithm ed25519 -out .keys/release.private.pem

# 2. 打包并签名（scripts.pack 里的 key-id 换成你自己的）
pnpm run pack

# 3. 由已签名 zip 产出 index.json（客户端插件源的目录清单）
pnpm run feed

# 4. 把 dist/ 里的 index.json + *.zip 平铺上传到你仓库的滚动 Release（tag: feed），
#    再给仓库打上 GitHub topic: snap-rail-plugin —— 这就是你的"上架"。
\`\`\`

文档：官网《插件开发》 <https://www.snap-rail.top/dev.html> ·
仓库文档 <https://github.com/yansijian/snap-rail/blob/master/docs/plugin-development.md>
`
}

function agentGuide(template: PluginTemplate, framework: FrameworkBinding): string {
  return `# snap-rail plugin guide

This repository is an independently developed ${template} plugin. Work only
through the public \`@snap-rail/plugin-sdk\` surface. Do not import files from a
snap-rail checkout or copy host internals.

## Contract rules

- Keep the \`snapRail\` manifest complete and validate it with
  \`definePluginManifest\`. \`title\`/\`category\` are free vocabulary (Chinese
  included); the management page groups by the raw marker.
- Declare every plugin dependency once in \`requires\` — package names
  (\`@snap-rail/equipment\`), version-constrained packages
  (\`${framework.name}@${framework.range}\` — the framework binding IS this
  entry), or \`service:\` ids. npm type packages (the SDK's \`/api\` facade,
  \`@snap-rail/protocol\`) are not plugins: put them in
  \`dependencies\`/\`devDependencies\`, never in \`requires\`.
- Host faces build with \`hostBundle\` → \`lib-host/host.js\` (the manifest
  \`main\`); renderer faces build with \`clientBundle\` →
  \`lib-client/client.js\` (a CJS factory package the module loader executes).
- Renderer code may \`require\` only base seeds plus the framework-contributed
  seeds declared in \`client.externalSeeds\`, via **named or star imports** (a
  default import breaks CJS interop at runtime — the build fails it on
  purpose). Base seeds (connection/protocol/util/shell-contract/
  equipment-contract/react/zod) are always seeded — never declare them in
  \`externalSeeds\`. UI pages compose the framework primitives
  (\`${framework.name}/ui\`), never hand-rolled widgets.
- Release archives contain the trimmed manifest and built faces only —
  never \`src/\`. \`pack\` refuses to ship one.

## Face capabilities

- Host wire/RPC: \`inject: ['rpc']\`; register with
  \`ctx.rpc.claimDomain(ctx, domain)\` and
  \`ctx.rpc.serveContract(ctx, contract, handlers)\`. Type it with
  \`import type { GatewayService } from '@snap-rail/plugin-sdk/api'\` — the
  gateway service is built into the terminal; never add it to \`requires\` or
  \`package.json\`.
- Host settings: \`inject: ['settings']\`; type it with
  \`import type { SettingsService } from '@snap-rail/plugin-sdk/api'\`.
- Renderer link/frames: the framework runtime provides \`ctx.client\`
  (\`{ link, surface }\`); subscribe with
  \`subscribeFrame(ctx.client.link, name, schema, cb)\` imported from
  \`@snap-rail/plugin-sdk/api/client\` (also \`rpcErrorText\`, \`HostLink\`). The
  underlying \`@snap-rail/connection\` is a base seed and an SDK dependency —
  never list it in \`client.externalSeeds\`.
- Wire contracts: \`defineContract\` / \`method\` / \`RpcBusinessError\` come from
  \`@snap-rail/protocol\`; import them as values in the host face and keep
  \`@snap-rail/protocol\` in \`dependencies\`.
- Entries use \`satisfies Plugin\` (type-only import from
  \`@snap-rail/cordis\`); never value-import \`@snap-rail/plugin-sdk\` in an
  entry — it drags the build/pack barrel into the bundle.

## Local workflow

\`pnpm install && pnpm run build\` builds this repository without snap-rail.
Before publishing: \`pnpm run doctor\`, \`pnpm run pack\` (signed with your own
Ed25519 key), \`pnpm run feed\` (the \`index.json\` your rolling Release serves),
and \`snap-rail-plugin verify <zip> --public-key <key.pem> --key-id <id>\`.
`
}

function sampleTestSource(packageName: string, template: PluginTemplate): string {
  return `import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { definePluginManifest } from '@snap-rail/plugin-sdk'

describe('the plugin manifest', () => {
  it('validates the snapRail block', () => {
    const source = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const manifest = definePluginManifest(source)
    expect(manifest.name).toBe(${JSON.stringify(packageName)})
    expect(manifest.snapRail.kind).toBe(${JSON.stringify(template === 'store-provider' || template === 'host-service' || template === 'tool' || template.startsWith('ui-') ? 'plugin' : template)})
  })
})
`
}

function hostSource(template: PluginTemplate, packageName: string): string {
  if (template === 'driver') {
    return `import '@snap-rail/equipment'
import { z } from 'zod'
import type { DriverRegistration } from '@snap-rail/equipment/driver'
import type { Plugin } from '@snap-rail/cordis'

const driver: DriverRegistration = {
  id: 'generated-driver',
  title: 'Generated driver',
  schemas: { device: z.object({}), point: z.object({}) },
  createConnection: () => ({ update() {}, dispose() {} }),
}

export default {
  name: 'generated-driver',
  inject: ['equipment'],
  apply(ctx) { ctx.equipment.registerDriver(ctx, driver) },
} satisfies Plugin
`
  }
  if (template === 'store-provider') {
    return `import '@snap-rail/store'
import type { StoreService } from '@snap-rail/store'
import type { Plugin } from '@snap-rail/cordis'

const store: StoreService = {
  register() { throw new Error('implement the store backend') },
}

export default {
  name: 'generated-store-provider',
  apply(ctx) { ctx.provide('store', store) },
} satisfies Plugin
`
  }
  if (template === 'suite') {
    return `import type { Plugin } from '@snap-rail/cordis'

/** 套件的宿主面：场景私有宿主逻辑住这里——服务、wire 方法/帧、store
 * 命名空间。渲染面（src/client.tsx）通过协作服务与这里通信，永不 import
 * 宿主代码。 */
export default {
  name: ${JSON.stringify(packageName)},
  apply() {
    // 在这里注册套件的服务与 store 命名空间（ctx.store.register / ctx.provide）。
  },
} satisfies Plugin
`
  }
  if (template === 'tool') {
    return `import type { Plugin } from '@snap-rail/cordis'

/** 工具插件：工具之间互不依赖（层门禁强制）；跨包的场景私有逻辑请收进
 * 套件，不要拆成跨包工具。 */
export default { name: ${JSON.stringify(packageName)}, apply() {} } satisfies Plugin
`
  }
  return `import type { Plugin } from '@snap-rail/cordis'

/** 宿主服务插件：在宿主进程贡献一个能力——ctx.provide 注册 cordis 服务、
 * ./contract 声明 wire 方法/帧后 claimDomain/serveContract 挂载。 */
export default { name: ${JSON.stringify(packageName)}, apply() {} } satisfies Plugin
`
}

function clientSource(template: PluginTemplate, packageName: string, framework: FrameworkBinding): string {
  const fw = framework.name
  if (template === 'ui-extension') {
    return `import { Card, CardContent } from '${fw}/ui'

/** 共享组件贡献面：\`snapRail.client.seeds\` 里声明的每个键都会成为
 * \`<package>/<key>\` 种子 id，其他组件插件的渲染面可以 require 到同一实例。
 * 组件必须建在框架原语（${fw}/ui）上，不许私有拷贝。 */
const widget = () => (
  <Card>
    <CardContent>${packageName} widget</CardContent>
  </Card>
)

export default {
  seeds: { widget },
}
`
  }
  if (template === 'ui-layout') {
    return `import '${fw}/semantic'
import { UI_SLOT_IDS } from '${fw}/slots'
import type { Plugin } from '@snap-rail/cordis'

export default {
  name: ${JSON.stringify(packageName)},
  inject: ['uiContract'],
  apply(ctx) {
    ctx.uiContract.registerLayout(ctx, {
      id: ${JSON.stringify(`${packageName}-layout`)},
      order: 0,
      slots: Object.values(UI_SLOT_IDS),
      render: () => null,
    })
  },
} satisfies Plugin
`
  }
  // ui-view and the suite's renderer face: a real view on the framework
  // primitives, so the generated project renders something honest.
  const id = template === 'suite' ? `${packageName}-view` : packageName
  const title = template === 'suite' ? 'Suite' : 'Generated view'
  const note = template === 'suite'
    ? `/** 套件的渲染面：整个场景的界面从这里挂进框架槽位。只组合框架原语
 * (${fw}/ui)，不手搓交互组件。 */`
    : `/** 渲染面：一个挂进 shell.view 槽位的界面。用框架原语搭出真实界面，
 * 需要 shell 之外的 seat（标题栏/侧栏/状态栏）就换 slot id。 */`
  return `import '${fw}/semantic'
import { UI_SLOT_IDS } from '${fw}/slots'
import { Card, CardContent, CardHeader, CardTitle } from '${fw}/ui'
import type { Plugin } from '@snap-rail/cordis'

${note}
export default {
  name: ${JSON.stringify(packageName)},
  inject: ['uiContract'],
  apply(ctx) {
    ctx.uiContract.registerView(ctx, {
      id: ${JSON.stringify(id)},
      title: ${JSON.stringify(title)},
      slot: UI_SLOT_IDS.view,
      order: 100,
      render: () => (
        <Card>
          <CardHeader>
            <CardTitle>${title}</CardTitle>
          </CardHeader>
          <CardContent>从这里开始你的界面。</CardContent>
        </Card>
      ),
    })
  },
} satisfies Plugin
`
}

function templateManifest(template: PluginTemplate, framework: FrameworkBinding): Record<string, unknown> {
  const binding = `${framework.name}@${framework.range}`
  const uiExternalSeeds = [`${framework.name}/slots`, `${framework.name}/semantic`, `${framework.name}/ui`]
  if (template === 'driver') {
    return { kind: 'driver', layer: 'equipment', title: 'Generated driver', category: '设备', requires: ['@snap-rail/equipment'] }
  }
  if (template === 'store-provider') {
    return { kind: 'plugin', layer: 'store', title: 'Generated store provider', exclusive: 'store-backend' }
  }
  if (template === 'ui-view') {
    return {
      kind: 'plugin', layer: 'ui', title: 'Generated view', clientOnly: true,
      requires: [binding],
      client: { entry: 'lib-client/client.js', externalSeeds: uiExternalSeeds },
    }
  }
  if (template === 'ui-layout') {
    return {
      kind: 'plugin', layer: 'ui', title: 'Generated layout', clientOnly: true,
      requires: [binding],
      client: { entry: 'lib-client/client.js', externalSeeds: uiExternalSeeds },
    }
  }
  if (template === 'ui-extension') {
    return {
      kind: 'plugin', layer: 'ui', title: 'Generated extension', clientOnly: true,
      // The extension's own shared components ride `client.seeds`; the
      // components themselves build on the framework's contributed seeds.
      requires: [binding],
      client: { entry: 'lib-client/client.js', seeds: ['widget'], externalSeeds: [`${framework.name}/ui`] },
    }
  }
  if (template === 'host-service') {
    return { kind: 'plugin', layer: 'tool', title: 'Generated host service' }
  }
  if (template === 'tool') {
    return { kind: 'plugin', layer: 'tool', title: 'Generated tool' }
  }
  // suite: dual-face (host logic + renderer UI in one package), single-active.
  return {
    kind: 'suite', layer: 'suite', title: 'Generated suite', exclusive: 'suite',
    requires: [binding],
    client: { entry: 'lib-client/client.js', externalSeeds: uiExternalSeeds },
  }
}

// Run only when invoked as the CLI binary; the tests import `main` directly.
if (process.argv[1]?.endsWith('cli.js') === true) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
