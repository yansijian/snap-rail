/**
 * Spine-independence gate: the spine (framework, boot, protocol, field seam,
 * client kernel/slots/runtime) must never import an occupant (UI residents,
 * drivers, the app assembly). Occupants extend the spine; the reverse edge
 * means the seam leaked. The package lists live in the util manifest — the
 * single source shared with the docs. Run via `pnpm run verify:spine`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OCCUPANT_PACKAGES, SPINE_PACKAGE_DIRS } from '../packages/util/util/src/manifest.ts'

const root = join(import.meta.dirname, '..')

const spinePackages = SPINE_PACKAGE_DIRS

const occupantNames = new Set(OCCUPANT_PACKAGES)

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

const importPattern = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g

const violations: string[] = []
let scanned = 0

/** A spine package's manifest must not depend on an occupant either — the
 * edge would leak even without a literal import (types, bundlers, drift). */
function checkManifest(dir: string): void {
  let manifest: { dependencies?: Record<string, unknown>, peerDependencies?: Record<string, unknown> }
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return
  }
  for (const field of ['dependencies', 'peerDependencies'] as const) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (occupantNames.has(name)) {
        violations.push(`${join(dir, 'package.json')}: ${field} includes occupant ${name}`)
      }
    }
  }
}

for (const pattern of spinePackages) {
  for (const dir of expand(pattern)) {
    checkManifest(dir)
    for (const file of walk(dir)) {
      scanned += 1
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1] ?? match[2] ?? match[3] ?? match[4]
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
