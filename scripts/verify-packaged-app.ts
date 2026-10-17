/**
 * Packaged-app gate: the unpacked desktop build must carry every
 * `@snap-rail/*` package the host face can resolve at runtime. The required
 * set is derived, never hand-maintained — desktop `dependencies` (what the
 * packager is asked to collect) plus app-boot `peerDependencies` (what the
 * boot module statically imports but npm-style collectors refuse to follow).
 * A second sweep reads the built `lib/` faces for bare `@snap-rail/*`
 * specifiers so a future static import that outgrows the manifests fails
 * here instead of as an ERR_MODULE_NOT_FOUND dialog on a factory-fresh
 * terminal. Run via `pnpm run app:pack` / `pnpm run app:dist` (appended), or
 * directly `tsx scripts/verify-packaged-app.ts [unpacked-app-dir]`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const appDir = process.argv[2] !== undefined ? process.argv[2] : join(root, 'apps', 'desktop', 'release-out', 'win-unpacked', 'resources', 'app')

/** Manifest dependency names a runtime path may resolve. */
function snapDeps(manifestPath: string, field: 'dependencies' | 'peerDependencies'): string[] {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    const deps = manifest[field]
    if (deps === undefined || typeof deps !== 'object' || deps === null) return []
    return Object.keys(deps).filter(name => name.startsWith('@snap-rail/'))
  } catch {
    return []
  }
}

const required = new Set<string>([
  ...snapDeps(join(root, 'apps', 'desktop', 'package.json'), 'dependencies'),
  ...snapDeps(join(root, 'packages', 'base', 'app-boot', 'package.json'), 'peerDependencies'),
])

/** The `@snap-rail/*` package a specifier addresses (subpath-aware). */
function packageOf(specifier: string): string | undefined {
  if (!specifier.startsWith('@snap-rail/')) return undefined
  const rest = specifier.slice('@snap-rail/'.length)
  const slash = rest.indexOf('/')
  return slash < 0 ? specifier : `@snap-rail/${rest.slice(0, slash)}`
}

const violations: string[] = []

const poolDir = join(appDir, 'node_modules', '@snap-rail')
if (!existsSync(poolDir)) {
  console.error(`verify:packaged-app — no packaged node_modules at ${poolDir}`)
  process.exit(1)
}

const shipped = new Set<string>()
for (const entry of readdirSync(poolDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const name = `@snap-rail/${entry.name}`
  let declared: string | undefined
  try {
    declared = (JSON.parse(readFileSync(join(poolDir, entry.name, 'package.json'), 'utf8')) as { name?: unknown }).name
  } catch { /* missing/broken manifest is itself a violation */ }
  if (declared !== name) violations.push(`${name}: packaged package.json missing or declares ${String(declared)}`)
  shipped.add(name)
}

for (const name of required) {
  if (!shipped.has(name)) violations.push(`${name}: required by desktop dependencies / app-boot peers but not packaged`)
}

/** Collect built .js faces under a directory. */
function walkJs(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walkJs(full))
    else if (entry.name.endsWith('.js')) files.push(full)
  }
  return files
}

/** Blank template-literal contents so string data never matches as an import. */
function stripTemplateLiterals(source: string): string {
  return source.replace(/`(?:\\[\s\S]|[^`\\])*`/g, span => span.replace(/[^\n]/g, ' '))
}

const importPattern = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g

const scanRoots = [
  join(appDir, 'dist', 'main'),
  ...[...shipped].sort().map(name => join(poolDir, name.slice('@snap-rail/'.length), 'lib')),
]

let scanned = 0
for (const scanRoot of scanRoots) {
  if (!existsSync(scanRoot)) continue
  for (const file of walkJs(scanRoot)) {
    scanned += 1
    const source = stripTemplateLiterals(readFileSync(file, 'utf8'))
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? match[4]
      if (specifier === undefined) continue
      const target = packageOf(specifier)
      if (target === undefined || shipped.has(target)) continue
      violations.push(`${file}: imports ${target} which is not packaged`)
    }
  }
}

/** Best-effort: with 7-Zip around, prove the installer archive itself carries the packages too. */
function checkInstallerArchive(): void {
  const candidates = ['7z', 'C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe']
  const sevenZip = candidates.find(candidate => {
    if (candidate === '7z') return spawnSync('7z', [], { shell: true }).status === 0
    return existsSync(candidate)
  })
  const releaseDir = join(root, 'apps', 'desktop', 'release-out')
  const installers = existsSync(releaseDir)
    ? readdirSync(releaseDir).filter(name => name.endsWith('-setup.exe')).map(name => join(releaseDir, name))
    : []
  if (sevenZip === undefined || installers.length === 0) {
    console.warn('verify:packaged-app — installer archive check skipped (7z or setup exe not found)')
    return
  }
  const listing = spawnSync(sevenZip, ['l', installers[0]!.replaceAll('\\', '/')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: true })
  if (listing.status !== 0) {
    console.warn('verify:packaged-app — installer archive check skipped (7z could not list the NSIS payload)')
    return
  }
  for (const name of required) {
    const pattern = new RegExp(`[@/]${name.slice('@snap-rail/'.length).replaceAll('/', '\\/')}[\\\\/]`)
    if (!pattern.test(listing.stdout)) violations.push(`${name}: absent from installer archive ${installers[0]}`)
  }
}

checkInstallerArchive()

if (violations.length > 0) {
  console.error(`verify:packaged-app — ${violations.length} violation(s) (${shipped.size} packages shipped, ${scanned} faces scanned):`)
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log(`verify:packaged-app — clean (${required.size} required, ${shipped.size} shipped, ${scanned} faces scanned)`)
