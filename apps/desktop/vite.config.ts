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
    '@snap-rail/client-kernel': 'packages/base/kernel/src/index.tsx',
    '@snap-rail/client-modules': 'packages/base/modules/src/index.ts',
  }
  const sourceOf = new Map<string, string>()
  for (const [name, rel] of Object.entries(sourceFiles)) {
    sourceOf.set(name, `${repoRoot}/${rel}`)
  }
  // Wire-contract subpaths the renderer imports for types/rows. Installable
  // plugins (framework, drivers, suites) never ride this table — their faces
  // arrive from the plugin pool, exactly like production.
  sourceOf.set('@snap-rail/equipment/rpc', `${repoRoot}/packages/equipment/equipment/src/rpc.ts`)
  sourceOf.set('@snap-rail/equipment', `${repoRoot}/packages/equipment/equipment/src/index.ts`)
  sourceOf.set('@snap-rail/app-boot/contract', `${repoRoot}/packages/base/app-boot/src/contract.ts`)
  sourceOf.set('@snap-rail/station-rpc/contract', `${repoRoot}/packages/base/station-rpc/src/contract.ts`)
  sourceOf.set('@snap-rail/equipment/contract', `${repoRoot}/packages/equipment/equipment/src/contract.ts`)
  sourceOf.set('@snap-rail/plugin-kit/seeds', `${repoRoot}/packages/base/plugin-kit/src/seeds.ts`)

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
