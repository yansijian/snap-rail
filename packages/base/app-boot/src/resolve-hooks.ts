/**
 * Host-side spine resolution anchoring. Plugins loaded from the pool
 * (`<home>/plugins/...`, `file://` URLs) import the shared host-side
 * vocabulary by bare specifier (`@snap-rail/equipment`, `zod`, `drizzle-orm`)
 * — but Node walks `node_modules` up from the importing file, and the
 * userData tree never contains the app's libraries. One process-wide
 * `module.registerHooks` resolves the anchored specifiers of **pool-resident
 * files** against the application root first, so pool plugins and the host
 * share the same instances (a second copy of cordis would split the fiber
 * system; a second copy of zod would break cross-boundary schema identity;
 * drizzle table objects cross the store seam).
 *
 * What the app root does not carry — the installed-only packages (equipment,
 * drivers, tools) — falls back to the pool copy under
 * `<pool>/<pkg with '/'→'__'>/`, resolved through that package's own
 * `exports`/`main` voice. App-root precedence means an installed zip can
 * never shadow a package the app itself ships; the pool fallback means every
 * pool importer shares the pool's single instance of an installed package.
 * Imports from anywhere else — the app tree, the workspace, test runners —
 * keep their own resolution. The anchored set is the *shared vocabulary
 * only*: ids whose objects cross package seams. Driver-internal libraries
 * (e.g. modbus-serial) bundle into the plugin's host face instead and never
 * join this list.
 *
 * Zero filesystem side effects beyond reads; dev (appRoot = repo workspace)
 * and packaged builds take the same path.
 *
 * @module @snap-rail/app-boot/resolve-hooks
 */

import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { poolSubpathFile } from './scan.ts'

/** Bare specifiers that resolve against the application root. Anchored ids
 * anchor as a whole scope — subpaths (`zod/v4`, `drizzle-orm/sqlite-core`)
 * must re-anchor too, or a bundled face imports the package from the pool
 * directory and dies on the first `node_modules` walk-up. */
export function isAnchoredSpecifier(specifier: string): boolean {
  return specifier === 'zod' || specifier.startsWith('zod/')
    || specifier === 'drizzle-orm' || specifier.startsWith('drizzle-orm/')
    || specifier.startsWith('@snap-rail/')
}

/** Build the "is this importing file pool-resident?" predicate. */
export function poolPredicate(poolDirs: readonly string[]): (parentURL: string | undefined) => boolean {
  const prefixes = poolDirs.map(dir => pathToFileURL(join(dir, '.')).href)
  return parentURL => {
    if (parentURL === undefined) return false
    return prefixes.some(prefix => parentURL.startsWith(prefix))
  }
}

/** The root package of a specifier (`@scope/name/sub` → `@scope/name`). */
function rootPackageName(specifier: string): string {
  if (!specifier.startsWith('@')) return specifier.split('/')[0]!
  const parts = specifier.split('/')
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier
}

let anchored = false

/**
 * Install the resolution hook once per process (repeat calls are no-ops).
 *
 * @param appRoot - directory whose `package.json` anchors the resolution;
 * the app installation dir in production, the Electron app dir in dev —
 * either way the tree that carries the host-side dependencies.
 * @param poolDirs - the plugin pool directories; only imports whose parent
 * module lives under one of them are re-anchored.
 */
export function anchorSpineResolution(appRoot: string, poolDirs: readonly string[]): void {
  if (anchored) return
  anchored = true
  const appRootParent = pathToFileURL(join(appRoot, 'package.json')).href
  const inPool = poolPredicate(poolDirs)

  // The pool copy of an anchored specifier: `<pool>/<pkg with '/'→'__'>/`
  // resolved through the package's own exports/main voice (pure filesystem +
  // JSON — never a nested resolution, so the hook cannot recurse).
  const poolEntryFile = (specifier: string): string | undefined => {
    const packageName = rootPackageName(specifier)
    const dirName = packageName.replaceAll('/', '__')
    for (const dir of poolDirs) {
      const pkgDir = join(dir, dirName)
      if (!existsSync(join(pkgDir, 'package.json'))) continue
      const subpath = specifier === packageName ? '.' : `./${specifier.slice(packageName.length + 1)}`
      const file = poolSubpathFile(pkgDir, subpath)
      if (file !== undefined) return file
    }
    return undefined
  }

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isAnchoredSpecifier(specifier) && inPool(context.parentURL)) {
        // Resolve the anchored specifier from the app root's tree first; the
        // original parent stays untouched for everything else. Only when the
        // app does not carry the id does the pool copy answer.
        try {
          return nextResolve(specifier, { ...context, parentURL: appRootParent })
        } catch (appRootError) {
          const file = poolEntryFile(specifier)
          if (file === undefined) throw appRootError
          return { url: pathToFileURL(file).href, shortCircuit: true }
        }
      }
      return nextResolve(specifier, context)
    },
  })
}
