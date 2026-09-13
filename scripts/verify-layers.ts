/**
 * Layer-direction gate: every package declares its layer in
 * `snapRail.layer`; an import edge (source file or manifest dependency) is
 * legal only when it descends into a strictly lower layer — except that
 * base imports base freely, and a package may import a lower layer's seam
 * package (the layer's Service Definition owner) from within its own layer.
 * There is no hand-maintained package list; the manifests are the single
 * source. `apps/*` is the product assembly (may import anything), `vendor/*`
 * is base-ranked. Run via `pnpm run verify:layers`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { edgeAllowed, VENDOR_PACKAGES } from '../packages/base/util/src/manifest.ts'

const root = join(import.meta.dirname, '..')

interface PkgInfo {
  dir: string
  name: string
  layer?: string
  deps: string[]
}

const vendorSet = new Set(VENDOR_PACKAGES)

/** Read one package manifest into gate shape. */
function readPkg(dir: string): PkgInfo | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name?: unknown
      snapRail?: { layer?: unknown }
      dependencies?: Record<string, unknown>
      peerDependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    if (typeof manifest.name !== 'string') return undefined
    const deps = new Set<string>([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ])
    return {
      dir,
      name: manifest.name,
      layer: typeof manifest.snapRail?.layer === 'string' ? manifest.snapRail.layer : undefined,
      deps: [...deps],
    }
  } catch {
    return undefined
  }
}

/** Expand every workspace package directory into package infos. */
function discoverPackages(): PkgInfo[] {
  const out: PkgInfo[] = []
  const groups = readdirSync(join(root, 'packages'), { withFileTypes: true })
  for (const group of groups) {
    if (!group.isDirectory()) continue
    for (const pkg of readdirSync(join(root, 'packages', group.name), { withFileTypes: true })) {
      if (!pkg.isDirectory() || pkg.name === 'node_modules') continue
      const info = readPkg(join(root, 'packages', group.name, pkg.name))
      if (info !== undefined) out.push(info)
    }
  }
  return out
}

const packages = discoverPackages()
const byName = new Map(packages.map(pkg => [pkg.name, pkg]))

/** The `@snap-rail/*` package a specifier addresses (subpath-aware). */
function packageOf(specifier: string): string | undefined {
  if (!specifier.startsWith('@snap-rail/')) return undefined
  const rest = specifier.slice('@snap-rail/'.length)
  const slash = rest.indexOf('/')
  return slash < 0 ? specifier : `@snap-rail/${rest.slice(0, slash)}`
}

/** Collect .ts/.tsx source files under a directory, skipping build outputs. */
function walk(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist' || entry.name === 'lib-client') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full)
  }
  return files
}

const importPattern = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g

const violations: string[] = []
let scanned = 0

for (const pkg of packages) {
  if (pkg.layer === undefined) {
    violations.push(`${join(pkg.dir, 'package.json')}: missing snapRail.layer`)
    continue
  }
  const check = (targetName: string, where: string): void => {
    if (targetName === pkg.name) return // self-imports (tests, subpath faces)
    if (byName.has(targetName)) {
      const target = byName.get(targetName)!
      if (target.layer !== undefined && !edgeAllowed(pkg.layer!, target.layer, targetName)) {
        violations.push(`${where}: layer ${pkg.layer} imports ${targetName} (layer ${target.layer ?? '?'})`)
      }
    }
  }
  for (const dep of pkg.deps) {
    const targetName = packageOf(dep)
    if (targetName !== undefined && !vendorSet.has(targetName)) check(targetName, join(pkg.dir, 'package.json'))
  }
  for (const file of walk(pkg.dir)) {
    scanned += 1
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? match[4]
      if (specifier === undefined) continue
      const targetName = packageOf(specifier)
      if (targetName === undefined || vendorSet.has(targetName)) continue
      check(targetName, file)
    }
  }
}

if (violations.length > 0) {
  console.error(`verify:layers — ${violations.length} violation(s) across ${scanned} files:`)
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log(`verify:layers — clean (${packages.length} packages, ${scanned} files checked)`)
