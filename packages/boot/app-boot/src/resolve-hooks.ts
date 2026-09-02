/**
 * Host-side spine resolution anchoring. Plugins loaded from the pool
 * (`<home>/plugins/...`, `file://` URLs) import the spine by bare specifier
 * (`@snap-rail/field`, `zod`) — but Node walks `node_modules` up from the
 * importing file, and the userData tree never contains the app's libraries.
 * One process-wide `module.registerHooks` resolves the anchored specifiers
 * of **pool-resident files** against the application root instead, so pool
 * plugins and the host always share the same instances (a second copy of
 * cordis would split the fiber system; a second copy of zod would break
 * cross-boundary schema identity). Imports from anywhere else — the app
 * tree, the workspace, test runners — keep their own resolution.
 *
 * Zero filesystem side effects; dev (appRoot = repo workspace) and packaged
 * builds take the same path.
 *
 * @module @snap-rail/app-boot/resolve-hooks
 */

import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Bare specifiers that resolve against the application root. */
export function isAnchoredSpecifier(specifier: string): boolean {
  return specifier === 'zod' || specifier.startsWith('@snap-rail/')
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
 * the app installation dir in production, the repo root in dev.
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
