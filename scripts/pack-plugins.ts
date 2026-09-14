/**
 * Pack the installable plugin zips for a release: each listed package
 * becomes one final-format zip (release manifest + built faces, never
 * sources) plus an `index.json` catalog — exactly what the settings page's
 * 安装插件 consumes locally and what the 插件市场 feed serves remotely.
 * The assembly rules live in `@snap-rail/plugin-kit/pack`; this is only the
 * repo's shipment list. Run a build first: `pnpm run build && pnpm run pack:plugins`.
 *
 * Output lands in `dist-plugins/` by default; pass `--out <dir>` to pack
 * straight into a feed directory (e.g. an nginx docroot).
 *
 * @module snap-rail/scripts/pack-plugins
 */

import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import { releaseFiles, zipFileName, type ReleaseSpec } from '@snap-rail/plugin-kit/pack'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The packages shipped as installable zips — the non-base catalog. */
const PLUGIN_PACKAGES: readonly ReleaseSpec[] = [
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
  // 工具：班产统计（宿主计数器）与 forge（AI 创造）。
  {
    name: '@snap-rail/trend',
    dir: join(repoRoot, 'packages/tool/trend'),
    hostDir: 'lib',
    hostFace: 'lib/index.js',
    exports: { './contract': 'lib/contract.js' },
  },
  {
    name: '@snap-rail/forge',
    dir: join(repoRoot, 'packages/tool/forge'),
    hostDir: 'lib',
    hostFace: 'lib/index.js',
    clientFace: 'lib-client',
    exports: { './contract': 'lib/contract.js' },
  },
  // 业务套件：一个工业场景的全部界面（clientOnly、单活）。
  {
    name: '@snap-rail/suite-terminal-ops',
    dir: join(repoRoot, 'packages/suite/terminal-ops'),
    clientFace: 'lib-client',
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

async function main(): Promise<void> {
  const outDir = outDirArg()
  await mkdir(outDir, { recursive: true })
  const entries: Array<Record<string, unknown>> = []
  for (const spec of PLUGIN_PACKAGES) {
    const files = await releaseFiles(spec)
    const zipped = zipSync(files, { level: 9 })
    const target = join(outDir, zipFileName(spec.name))
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(target)
      stream.on('error', reject)
      stream.on('finish', resolve)
      stream.end(zipped)
    })
    // The catalog entry reads back out of the shipped release manifest, so
    // the feed can never advertise something the zip does not carry.
    const manifest = JSON.parse(new TextDecoder().decode(files['package.json']!)) as {
      version?: string
      description?: string
      snapRail?: { kind?: string }
    }
    entries.push({
      name: spec.name,
      version: manifest.version ?? '0.0.0',
      ...(manifest.description !== undefined && manifest.description !== '' ? { description: manifest.description } : {}),
      ...(manifest.snapRail?.kind !== undefined ? { kind: manifest.snapRail.kind } : {}),
      file: zipFileName(spec.name),
    })
    console.log(`packed ${zipFileName(spec.name)} (${(zipped.length / 1024).toFixed(0)} KiB, ${Object.keys(files).length} files)`)
  }
  const catalog = `${JSON.stringify({ plugins: entries }, null, 2)}\n`
  await writeFile(join(outDir, 'index.json'), catalog, 'utf8')
  console.log(`packed index.json (${entries.length} plugins)`)
}

main().catch(cause => {
  console.error(cause)
  process.exitCode = 1
})
