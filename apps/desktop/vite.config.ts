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
    '@snap-rail/protocol': 'packages/protocol/protocol/src/index.ts',
    '@snap-rail/connection': 'packages/protocol/connection/src/index.ts',
    '@snap-rail/gateway': 'packages/protocol/gateway/src/index.ts',
    '@snap-rail/audit': 'packages/audit/audit/src/index.ts',
    '@snap-rail/settings': 'packages/settings/settings/src/index.ts',
    '@snap-rail/app-boot': 'packages/boot/app-boot/src/index.ts',
    '@snap-rail/driver-mock': 'packages/field/driver-mock/src/index.ts',
    '@snap-rail/client-ui': 'packages/client/ui/src/index.ts',
    '@snap-rail/client-kernel': 'packages/client/kernel/src/index.tsx',
    '@snap-rail/client-slots': 'packages/client/slots/src/index.tsx',
    '@snap-rail/client-session': 'packages/client/session/src/index.ts',
    '@snap-rail/client-workflows': 'packages/client/workflows/src/index.ts',
    '@snap-rail/client-runtime': 'packages/client/runtime/src/index.tsx',
    '@snap-rail/layout-station': 'packages/client/layout-station/src/index.tsx',
    '@snap-rail/chrome-titlebar': 'packages/client/chrome-titlebar/src/index.tsx',
    '@snap-rail/process-maintenance': 'packages/client/process-maintenance/src/index.tsx',
    '@snap-rail/process-production': 'packages/client/process-production/src/index.tsx',
    '@snap-rail/process-sampling': 'packages/client/process-sampling/src/index.tsx',
    '@snap-rail/process-fault': 'packages/client/process-fault/src/index.tsx',
    '@snap-rail/process-downtime': 'packages/client/process-downtime/src/index.tsx',
  }
  const sourceOf = new Map<string, string>()
  for (const [name, rel] of Object.entries(sourceFiles)) {
    sourceOf.set(name, `${repoRoot}/${rel}`)
  }
  // Exact-match lookup covers both the package entry and the css subpath.
  sourceOf.set('@snap-rail/client-ui/theme.css', `${repoRoot}/packages/client/ui/src/theme.css`)
  sourceOf.set('@snap-rail/field/rpc', `${repoRoot}/packages/field/field/src/rpc.ts`)
  sourceOf.set('@snap-rail/field', `${repoRoot}/packages/field/field/src/index.ts`)

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
 * preludes, which a strict script-src would block.
 */
function productionCsp(): Plugin {
  return {
    name: 'snap-rail-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="utf-8" />',
        '<meta charset="utf-8" />'
          + '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:" />',
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
