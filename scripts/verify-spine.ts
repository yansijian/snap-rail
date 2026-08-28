/**
 * Spine-independence gate: the spine (framework, boot, protocol, field seam,
 * client kernel/slots/runtime) must never import an occupant (UI residents,
 * drivers, the app assembly). Occupants extend the spine; the reverse edge
 * means the seam leaked. Run via `pnpm run verify:spine`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')

const spinePackages = [
  'vendor/*',
  'packages/util/util',
  'packages/settings/settings',
  'packages/audit/audit',
  'packages/boot/app-boot',
  'packages/boot/station-rpc',
  'packages/protocol/*',
  'packages/field/field',
  'packages/client/ui',
  'packages/client/kernel',
  'packages/client/slots',
  'packages/client/session',
  'packages/client/workflows',
  'packages/client/runtime',
]

const occupantNames = new Set([
  '@snap-rail/layout-station',
  '@snap-rail/chrome-titlebar',
  '@snap-rail/process-maintenance',
  '@snap-rail/process-production',
  '@snap-rail/process-sampling',
  '@snap-rail/process-fault',
  '@snap-rail/process-downtime',
  '@snap-rail/driver-mock',
])

/** Expand one glob-ish package dir into its package name from the manifest. */
function resolveName(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
    return typeof manifest.name === 'string' ? manifest.name : undefined
  } catch {
    return undefined
  }
}

function expand(pattern: string): string[] {
  if (!pattern.endsWith('/*')) {
    return pattern.includes('/') && resolveName(join(root, pattern)) ? [join(root, pattern)] : []
  }
  const base = pattern.slice(0, -2)
  const parent = join(root, base)
  let entries: string[]
  try {
    entries = readdirSync(parent, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry.isDirectory() && entry.name !== 'node_modules')
    .map(entry => join(parent, entry.name))
    .filter(dir => resolveName(dir) !== undefined)
}

/** Collect .ts/.tsx source files under a directory, skipping build outputs. */
function walk(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full)
  }
  return files
}

const importPattern = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g

const violations: string[] = []
let scanned = 0

for (const pattern of spinePackages) {
  for (const dir of expand(pattern)) {
    for (const file of walk(dir)) {
      scanned += 1
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1] ?? match[2]
        if (specifier === undefined) continue
        // Occupant packages, their subpaths, or a relative hop into apps/.
        if (occupantNames.has(specifier) || [...occupantNames].some(name => specifier.startsWith(`${name}/`))) {
          violations.push(`${file}: imports occupant ${specifier}`)
        }
        if (specifier.includes('/apps/') || specifier.startsWith('apps/')) {
          violations.push(`${file}: imports the app assembly (${specifier})`)
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`verify:spine — ${violations.length} violation(s) across ${scanned} spine files:`)
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log(`verify:spine — clean (${scanned} spine files checked)`)
