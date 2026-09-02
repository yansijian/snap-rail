/**
 * Host-side spine resolution anchoring. Plugins loaded from the pool
 * (`<home>/plugins/...`, `file://` URLs) import the shared host-side
 * vocabulary by bare specifier (`@snap-rail/field`, `zod`, `drizzle-orm`)
 * — but Node walks `node_modules` up from the importing file, and the
 * userData tree never contains the app's libraries. One process-wide
 * `module.registerHooks` resolves the anchored specifiers of **pool-resident
 * files** against the application root instead, so pool plugins and the host
 * always share the same instances (a second copy of cordis would split the
 * fiber system; a second copy of zod would break cross-boundary schema
 * identity; drizzle table objects cross the store seam). Imports from
 * anywhere else — the app tree, the workspace, test runners — keep their own
 * resolution. The anchored set is the *shared vocabulary only*: ids whose
 * objects cross package seams. Driver-internal libraries (e.g. modbus-serial)
 * bundle into the plugin's host face instead and never join this list.
 *
 * Zero filesystem side effects; dev (appRoot = repo workspace) and packaged
 * builds take the same path.
 *
 * @module @snap-rail/app-boot/resolve-hooks
 */

import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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
  const parentURL = `${pathToFileURL(join(appRoot, 'package.json')).href}`
  const inPool = poolPredicate(poolDirs)
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isAnchoredSpecifier(specifier) && inPool(context.parentURL)) {
        // Resolve the anchored specifier from the app root's tree; the
        // original parent stays untouched for everything else.
        return nextResolve(specifier, { ...context, parentURL })
      }
      return nextResolve(specifier, context)
    },
  })
}
