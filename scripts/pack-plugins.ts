/**
 * Pack the installable plugin zips for a release: each listed package
 * becomes one final-format zip (release manifest + built faces, never
 * sources) plus an `index.json` catalog — exactly what the settings page's
 * 安装插件 consumes locally and what the 插件市场 feed serves remotely.
 * The assembly rules live in `@snap-rail/plugin-kit/pack`; this is only the
 * repo's shipment list. Run a build first, then provide the publisher key:
 * `pnpm run build && pnpm run pack:plugins -- --sign-key .keys/release.private.pem --key-id release-2026`.
 *
 * Output lands in `dist-plugins/` by default; pass `--out <dir>` to pack
 * straight into a feed directory (e.g. an nginx docroot).
 *
 * @module snap-rail/scripts/pack-plugins
 */

import { createHash, createPrivateKey } from 'node:crypto'
import { createWriteStream, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import { releaseFiles, zipFileName, type ReleaseSpec } from '@snap-rail/plugin-kit/pack'
import { signReleaseFiles, type ReleaseSignature } from '@snap-rail/plugin-kit/sign'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The packages shipped as installable zips — the non-base catalog. The
 * publish pipeline reuses the list to enrich `catalog.json` from the repo
 * sources (author, repository, readme), so it lives here: the shipment
 * list has exactly one home. */
export const PLUGIN_PACKAGES: readonly ReleaseSpec[] = [
  // 存储后端：drizzle 查询构建器规范的 node:sqlite 实现（全局单活）。
  {
    name: '@snap-rail/store-sqlite',
    dir: join(repoRoot, 'packages/store/store-sqlite'),
    hostDir: 'lib',
    hostFace: 'lib/index.js',
  },
  // 设备底座：配置表 + 点运行时 + 驱动注册缝；./rpc 是设置页/渲染端的
  // wire 桥（启用两行：本包 + @snap-rail/equipment/rpc）。
  {
    name: '@snap-rail/equipment',
    dir: join(repoRoot, 'packages/equipment/equipment'),
    hostDir: 'lib',
    hostFace: 'lib/index.js',
    exports: { './rpc': 'lib/rpc.js', './contract': 'lib/contract.js' },
  },
  {
    name: '@snap-rail/driver-modbus',
    dir: join(repoRoot, 'packages/equipment/driver-modbus'),
    hostDir: 'lib',
    hostFace: 'lib/index.js',
    exports: { './contract': 'lib/contract.js' },
  },
  // EtherNet/IP 驱动（首期对接 OMRON NX1P2）：自研轻量 ENIP/CIP 编解码，
  // 按已发布的全局变量名轮询读写。
  {
    name: '@snap-rail/driver-enip',
    dir: join(repoRoot, 'packages/equipment/driver-enip'),
    hostDir: 'lib',
    hostFace: 'lib/index.js',
    exports: { './contract': 'lib/contract.js' },
  },
  // 界面框架：槽位词汇 + renderer runtime + shadcn 原语 + 主题令牌，
  // clientOnly、单活；client 面把全部面贡献为共享种子。
  {
    name: '@snap-rail/framework-shadcn',
    dir: join(repoRoot, 'packages/ui/framework-shadcn'),
    clientFace: 'lib-client',
  },
  // 界面住户：设置页外壳与统一设备管理页（clientOnly）。
  {
    name: '@snap-rail/settings-station',
    dir: join(repoRoot, 'packages/ui/settings-station'),
    clientFace: 'lib-client',
  },
  {
    name: '@snap-rail/equipment-station',
    dir: join(repoRoot, 'packages/ui/equipment-station'),
    clientFace: 'lib-client',
  },
  // 业务套件：一个工业场景的全部界面 + 宿主侧班产计数（双面包，
  // clientOnly 已移除——场景逻辑收在套件内，不再拆跨包场景工具）。
  {
    name: '@snap-rail/suite-terminal-ops',
    dir: join(repoRoot, 'packages/suite/terminal-ops'),
    hostDir: 'lib',
    hostFace: 'lib/stats.js',
    clientFace: 'lib-client',
    exports: { './stats': 'lib/stats.js' },
  },
]

function dirname(path: string): string {
  const index = path.replaceAll('\\', '/').lastIndexOf('/')
  return index < 0 ? '.' : path.slice(0, index)
}

/** The `--out <dir>` CLI override; defaults to the repo's dist-plugins/. */
function outDirArg(): string {
  const index = process.argv.indexOf('--out')
  if (index < 0) return join(repoRoot, 'dist-plugins')
  const value = process.argv[index + 1]
  if (value === undefined || value === '') {
    throw new Error('pack-plugins: --out requires a directory argument')
  }
  return resolve(value)
}

interface SigningOptions {
  keyId: string
  privateKey: ReturnType<typeof createPrivateKey>
  publisher?: string
}

/** Release signing is mandatory for every installable feed artifact. */
function signingOptions(): SigningOptions {
  const keyPathIndex = process.argv.indexOf('--sign-key')
  const keyIdIndex = process.argv.indexOf('--key-id')
  const keyPath = keyPathIndex >= 0 ? process.argv[keyPathIndex + 1] : undefined
  const keyId = keyIdIndex >= 0 ? process.argv[keyIdIndex + 1] : undefined
  if (keyPath === undefined && keyId === undefined) {
    throw new Error('pack-plugins: releases must be signed; pass --sign-key <private.pem> and --key-id <id>')
  }
  if (keyPath === undefined || keyId === undefined || keyPath === '' || keyId === '') {
    throw new Error('pack-plugins: --sign-key and --key-id must be supplied together')
  }
  const publisherIndex = process.argv.indexOf('--publisher')
  const publisher = publisherIndex >= 0 ? process.argv[publisherIndex + 1] : undefined
  return {
    keyId,
    privateKey: createPrivateKey(readFileSync(resolve(keyPath))),
    ...(publisher === undefined || publisher === '' ? {} : { publisher }),
  }
}

async function main(): Promise<void> {
  const outDir = outDirArg()
  const signing = signingOptions()
  await mkdir(outDir, { recursive: true })
  const entries: Array<Record<string, unknown>> = []
  for (const spec of PLUGIN_PACKAGES) {
    const unsignedFiles = await releaseFiles(spec)
    const sourceManifest = JSON.parse(new TextDecoder().decode(unsignedFiles['package.json']!)) as { name?: string, version?: string }
    const files = signReleaseFiles(unsignedFiles, {
      name: sourceManifest.name ?? spec.name,
      version: sourceManifest.version ?? '0.0.0',
      keyId: signing.keyId,
      privateKey: signing.privateKey,
      ...(signing.publisher === undefined ? {} : { publisher: signing.publisher }),
    })
    const zipped = zipSync(files, { level: 9 })
    const target = join(outDir, zipFileName(spec.name))
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(target)
      stream.on('error', reject)
      stream.on('finish', resolve)
      stream.end(zipped)
    })
    // The catalog entry reads back out of the shipped release manifest, so
    // the feed can never advertise something the zip does not carry. The
    // digest covers the exact zip bytes — the client verifies the download
    // against it before the installer ever sees the file.
    const manifest = JSON.parse(new TextDecoder().decode(files['package.json']!)) as {
      version?: string
      description?: string
      snapRail?: {
        kind?: string
        title?: string
        category?: string
        requires?: string[]
        framework?: string
        permissions?: string[]
        capabilities?: { provides?: { id: string, version: string }[], requires?: { id: string, range: string, optional?: boolean }[] }
        engines?: { snapRail?: string, hostProtocol?: string, renderer?: string }
      }
    }
    const signature = files['META-INF/signature.json']
    const signatureInfo = signature === undefined ? undefined : JSON.parse(new TextDecoder().decode(signature)) as ReleaseSignature
    entries.push({
      name: spec.name,
      version: manifest.version ?? '0.0.0',
      ...(manifest.description !== undefined && manifest.description !== '' ? { description: manifest.description } : {}),
      ...(manifest.snapRail?.kind !== undefined ? { kind: manifest.snapRail.kind } : {}),
      ...(manifest.snapRail?.title !== undefined ? { title: manifest.snapRail.title } : {}),
      ...(manifest.snapRail?.category !== undefined ? { category: manifest.snapRail.category } : {}),
      ...(manifest.snapRail?.requires !== undefined ? { requires: manifest.snapRail.requires } : {}),
      ...(manifest.snapRail?.framework !== undefined ? { framework: manifest.snapRail.framework } : {}),
      ...(manifest.snapRail?.permissions !== undefined ? { permissions: manifest.snapRail.permissions } : {}),
      ...(manifest.snapRail?.capabilities !== undefined ? { capabilities: manifest.snapRail.capabilities } : {}),
      ...(manifest.snapRail?.engines !== undefined ? { engines: manifest.snapRail.engines } : {}),
      file: zipFileName(spec.name),
      sha256: createHash('sha256').update(zipped).digest('hex'),
      size: zipped.length,
      ...(signatureInfo === undefined ? {} : { signature: { algorithm: signatureInfo.algorithm, keyId: signatureInfo.keyId } }),
    })
    console.log(`packed ${zipFileName(spec.name)} (${(zipped.length / 1024).toFixed(0)} KiB, ${Object.keys(files).length} files)`)
  }
  const catalog = `${JSON.stringify({ plugins: entries }, null, 2)}\n`
  await writeFile(join(outDir, 'index.json'), catalog, 'utf8')
  console.log(`packed index.json (${entries.length} plugins)`)
}

// Run only when invoked directly — the publish pipeline imports the
// shipment list and must not trigger a pack as a side effect.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(cause => {
    console.error(cause)
    process.exitCode = 1
  })
}
