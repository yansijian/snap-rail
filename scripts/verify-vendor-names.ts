/**
 * Assert the vendored tree carries no stale `@deepseek-ai/` scope references:
 * every vendored name must resolve to this workspace's `@snap-rail/` packages.
 * Run via `pnpm run verify-vendor-names`.
 *
 * The walk is manual (not `readdirSync({ recursive: true })`) because pnpm's
 * Windows junctions under vendor/<pkg>/node_modules would otherwise be followed
 * into the whole virtual store.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const vendorDir = join(root, 'vendor')
const textExtensions = new Set(['.ts', '.json', '.md', '.mjs', '.js', '.cjs', '.yml', '.yaml'])
const skippedDirs = new Set(['node_modules', 'lib', 'dist'])

let checked = 0
const violations: string[] = []

function walk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!skippedDirs.has(entry.name)) walk(full)
      continue
    }
    if (!entry.isFile()) continue
    const dot = entry.name.lastIndexOf('.')
    if (dot === -1 || !textExtensions.has(entry.name.slice(dot))) continue
    const content = readFileSync(full, 'utf8')
    checked++
    if (content.includes('@deepseek-ai/')) violations.push(full.slice(root.length + 1))
  }
}

for (const pkg of readdirSync(vendorDir, { withFileTypes: true })) {
  if (pkg.isDirectory()) walk(join(vendorDir, pkg.name))
}

if (violations.length > 0) {
  console.error(`verify-vendor-names: stale @deepseek-ai/ scope in ${violations.length} file(s):`)
  for (const file of violations) console.error(`  ${file}`)
  process.exit(1)
}
console.log(`verify-vendor-names: ${checked} files clean`)
