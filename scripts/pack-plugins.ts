/**
 * Pack the installable plugin zips for a release: each listed package
 * becomes one final-format zip (release manifest + built faces, never
 * sources) under dist-plugins/ — exactly what the settings page's 安装插件
 * and the kernel's drag-to-install bootstrap page consume, and the same
 * shape the future marketplace serves. The app itself ships base only;
 * this list is the rest of the first-party catalog. The assembly rules
 * live in `@snap-rail/plugin-kit/pack`; this is only the repo's shipment
 * list. Run a build first: `pnpm run build && pnpm run pack:plugins`.
 *
 * @module snap-rail/scripts/pack-plugins
 */

import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
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

async function main(): Promise<void> {
  const outDir = join(repoRoot, 'dist-plugins')
  await mkdir(outDir, { recursive: true })
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
    console.log(`packed ${zipFileName(spec.name)} (${(zipped.length / 1024).toFixed(0)} KiB, ${Object.keys(files).length} files)`)
  }
}

main().catch(cause => {
  console.error(cause)
  process.exitCode = 1
})
