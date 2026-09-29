import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Workspace imports resolve to workspace sources through an explicit
 * resolveId hook: alias replacement values get importer-relativized by the
 * bundler on Windows, and falling back to package main would freeze dev
 * iteration behind stale lib artifacts.
 */
function snapRailSources(): Plugin {
  // Anchor at the workspace marker; forward slashes so the bundler keeps ids
  // absolute instead of reading backslash paths as relative segments.
  let repoRoot = process.cwd().replaceAll('\\', '/')
  while (!existsSync(`${repoRoot}/pnpm-workspace.yaml`)) {
    const parent = dirname(repoRoot)
    if (parent === repoRoot) throw new Error('vite: cannot locate the snap-rail workspace root')
    repoRoot = parent.replaceAll('\\', '/')
  }
  const sourceFiles: Record<string, string> = {
    '@snap-rail/cordis': 'vendor/cordis/src/index.ts',
    '@snap-rail/cordis-plugin-timer': 'vendor/timer/src/index.ts',
    '@snap-rail/cosmokit': 'vendor/cosmokit/src/index.ts',
    '@snap-rail/util': 'packages/base/util/src/index.ts',
    '@snap-rail/protocol': 'packages/base/protocol/src/index.ts',
    '@snap-rail/connection': 'packages/base/connection/src/index.ts',
    '@snap-rail/gateway': 'packages/base/gateway/src/index.ts',
    '@snap-rail/audit': 'packages/base/audit/src/index.ts',
    '@snap-rail/settings': 'packages/base/settings/src/index.ts',
    '@snap-rail/app-boot': 'packages/base/app-boot/src/index.ts',
    '@snap-rail/framework-shadcn/ui': 'packages/ui/framework-shadcn/src/ui/index.ts',
    '@snap-rail/client-kernel': 'packages/base/kernel/src/index.tsx',
    '@snap-rail/framework-shadcn/slots': 'packages/ui/framework-shadcn/src/slots.tsx',
    '@snap-rail/framework-shadcn/semantic': 'packages/ui/framework-shadcn/src/semantic.tsx',
    '@snap-rail/framework-shadcn/session': 'packages/ui/framework-shadcn/src/session.ts',
    '@snap-rail/framework-shadcn/workflows': 'packages/ui/framework-shadcn/src/workflows.ts',
    '@snap-rail/framework-shadcn/settings-pages': 'packages/ui/framework-shadcn/src/settings-pages.ts',
    '@snap-rail/framework-shadcn/variables': 'packages/ui/framework-shadcn/src/variables.ts',
    '@snap-rail/framework-shadcn/runtime': 'packages/ui/framework-shadcn/src/runtime.tsx',
    '@snap-rail/client-modules': 'packages/base/modules/src/index.ts',
    '@snap-rail/framework-shadcn/fallback': 'packages/ui/framework-shadcn/src/fallback.tsx',
    '@snap-rail/suite-terminal-ops': 'packages/suite/terminal-ops/src/index.tsx',
    '@snap-rail/settings-station': 'packages/ui/settings-station/src/index.tsx',
  }
  const sourceOf = new Map<string, string>()
  for (const [name, rel] of Object.entries(sourceFiles)) {
    sourceOf.set(name, `${repoRoot}/${rel}`)
  }
  // Exact-match lookup covers both the package entry and the css subpath.
  sourceOf.set('@snap-rail/framework-shadcn/theme.css', `${repoRoot}/packages/ui/framework-shadcn/src/ui/theme.css`)
  sourceOf.set('@snap-rail/equipment/rpc', `${repoRoot}/packages/equipment/equipment/src/rpc.ts`)
  sourceOf.set('@snap-rail/equipment', `${repoRoot}/packages/equipment/equipment/src/index.ts`)
  // Wire-contract subpaths the renderer imports for types/rows. The stats
  // plugin's plugin entry itself is host-side (node:sqlite) and stays out of
  // the client bundle; the rest are pure contract modules beside their
  // package entries.
  sourceOf.set('@snap-rail/app-boot/contract', `${repoRoot}/packages/base/app-boot/src/contract.ts`)
  sourceOf.set('@snap-rail/station-rpc/contract', `${repoRoot}/packages/base/station-rpc/src/contract.ts`)
  sourceOf.set('@snap-rail/driver-modbus/contract', `${repoRoot}/packages/equipment/driver-modbus/src/contract.ts`)
  sourceOf.set('@snap-rail/trend/contract', `${repoRoot}/packages/tool/trend/src/contract.ts`)
  sourceOf.set('@snap-rail/equipment/contract', `${repoRoot}/packages/equipment/equipment/src/contract.ts`)
  sourceOf.set('@snap-rail/plugin-kit/seeds', `${repoRoot}/packages/base/plugin-kit/src/seeds.ts`)
  // The unified 设备管理 settings page is the field base's renderer face; its
  // entry must never pull the node-side base (store/drizzle) into the client
  // build — it consumes the base only through the wire.
  sourceOf.set('@snap-rail/equipment-station', `${repoRoot}/packages/ui/equipment-station/src/index.tsx`)

  return {
    name: 'snap-rail-source-plane',
    enforce: 'pre',
    resolveId(id) {
      return sourceOf.get(id)
    },
  }
}

/**
 * CSP rides only the production bundle: dev needs Vite's inline module
 * preludes, which a strict script-src would block. `snap-plugin:` carries the
 * pool-installed plugins' client bundles (classic scripts) and their bundled
 * assets, so it rides script-src and img-src alongside 'self'.
 */
function productionCsp(): Plugin {
  return {
    name: 'snap-rail-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="utf-8" />',
        '<meta charset="utf-8" />'
          + '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' snap-plugin:; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: snap-plugin:" />',
      )
    },
  }
}

export default defineConfig({
  root: join(import.meta.dirname, 'src/client'),
  plugins: [react(), tailwindcss(), snapRailSources(), productionCsp()],
  build: {
    outDir: join(import.meta.dirname, 'dist/client'),
    emptyOutDir: true,
  },
})
