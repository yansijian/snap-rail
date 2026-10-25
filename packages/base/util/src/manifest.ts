/**
 * Repo governance vocabulary — the layer taxonomy every package declares in
 * its manifest's `snapRail.layer`, plus the dependency-direction rules the
 * gate (`scripts/verify-layers.ts`) enforces from those manifests. There is
 * no hand-maintained spine list: a package's layer IS the single source,
 * and the gate derives everything from it. `base` packages are built-ins —
 * replaceable only by rebuilding from source, never through the UI or the
 * plugins RPC. Wire-domain allocation is NOT listed here: domains are
 * claimed at runtime through `ctx.rpc.claimDomain` (first-wins), and
 * `rpc.describe` reports the live claims.
 *
 * @module @snap-rail/util/manifest
 */

/**
 * The layer names, ordered from substrate to business. A package may only
 * import into strictly lower layers, with two exceptions: base imports base
 * freely, and any package may import a lower layer's seam package even
 * within its own layer.
 */
export const PLUGIN_LAYERS = ['base', 'store', 'equipment', 'ui', 'tool', 'suite'] as const

/** The plugin layers as a plain string union. */
export type PluginLayer = typeof PLUGIN_LAYERS[number]

/** The rank of each layer for the import-direction rule (lower = substrate). */
export const LAYER_RANK: Readonly<Record<string, number>> = {
  base: 0,
  store: 1,
  equipment: 2,
  ui: 3,
  tool: 4,
  suite: 5,
}

/**
 * Each layer's seam package — the one same-layer target others may import
 * (the layer's Service Definition owner). Everything else in the layer is
 * mutually independent: drivers never import drivers, tools never import
 * tools, suites never import suites.
 */
export const LAYER_SEAMS: Readonly<Record<string, string>> = {
  store: '@snap-rail/store',
  equipment: '@snap-rail/equipment',
  // The semantic UI substrate is a base package (`@snap-rail/ui`), so every
  // ui-layer package may import it through the ordinary lower-layer rule.
  // There is no same-layer ui seam: layouts, pages and skins stay independent.
}

/** The vendored framework packages — treated as base-ranked imports. */
export const VENDOR_PACKAGES: readonly string[] = [
  '@snap-rail/cosmokit',
  '@snap-rail/schemastery',
  '@snap-rail/cordis',
  '@snap-rail/cordis-plugin-loader',
  '@snap-rail/cordis-plugin-include',
  '@snap-rail/cordis-plugin-group',
  '@snap-rail/cordis-plugin-timer',
  '@snap-rail/cordis-plugin-hmr',
  '@snap-rail/cordis-plugin-logger-console',
]

/**
 * Whether an import edge from a package of `fromLayer` onto `toPackage`
 * (of `toLayer`) is legal under the layer rules: descend strictly, or land
 * on a lower/equal layer's seam package (drivers onto the equipment seam,
 * store backends onto the store seam).
 */
export function edgeAllowed(fromLayer: string, toLayer: string, toPackage: string): boolean {
  const from = LAYER_RANK[fromLayer]
  const to = LAYER_RANK[toLayer]
  if (from === undefined || to === undefined) return false
  if (to < from) return true
  if (fromLayer === 'base' && toLayer === 'base') return true
  return to === from && LAYER_SEAMS[toLayer] === toPackage
}
