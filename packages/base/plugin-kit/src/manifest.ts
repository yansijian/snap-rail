/**
 * The plugin author's manifest vocabulary: the `snapRail` field of a plugin
 * package's `package.json`. One source of truth for the shape — the
 * installer validates against it, the pool scan records it, and authors
 * import the types.
 *
 * @module @snap-rail/plugin-kit/manifest
 */

import { z } from 'zod'
import { PLUGIN_LAYERS } from '@snap-rail/util/manifest'

/** Plugin package kinds. `suite` and `framework` packages are single-active. */
export const PLUGIN_KINDS = ['suite', 'driver', 'framework', 'plugin'] as const

/** The layer taxonomy — single source in `@snap-rail/util/manifest`. */
export { PLUGIN_LAYERS }

/** The seed-ABI stamp a pack writes into a client face's manifest (shape of
 * `snapRail.client.seedAbi`). Computed by the packer from the built bundle
 * and the build tree's resolved seed versions — authors never hand-write it. */
export const seedAbiSchema = z.object({
  /** The seed-contract revision the face was built against. */
  revision: z.number().int().min(1),
  /** Base-package versions of the seeds the bundle requires, by seed id. */
  versions: z.record(z.string().min(1), z.string().min(1)),
}).strict()

/** The renderer face declaration: where the client bundle lives. */
export const clientFaceSchema = z.object({
  /** Path of the CJS factory bundle inside the package (from its root). */
  entry: z.string().min(1).default('lib/client.js'),
  /**
   * Subpaths this client face registers as contributed seeds (e.g. framework
   * primitives like `./ui`): each becomes a `__ModuleLoader__` id other
   * plugins' client bundles may `require` — same instance, one execution.
   */
  seeds: z.array(z.string().min(1)).optional(),
  /**
   * Contributed seed ids (`<package>/<subpath>`) this client face requires
   * from other installed plugins (a framework's primitives, an extension
   * pack's components). Build-time plumbing: `clientBundle` externalizes
   * exactly these ids so they resolve from the shell's seed table at
   * runtime instead of being inlined as private copies; the enable precheck
   * verifies each provider is installed and declares the id. It is not a
   * compatibility declaration — package/version compatibility rides
   * `requires`.
   */
  externalSeeds: z.array(z.string().min(1)).optional(),
  /**
   * The seed-contract stamp the packer computed at pack time (see
   * `@snap-rail/plugin-kit/seeds` for the comparison contract). Present in
   * the release manifest only; the installer and the renderer boot both
   * check it against the live table, absent declarations pass untouched.
   */
  seedAbi: seedAbiSchema.optional(),
}).strict()

/**
 * Declared dependencies — the single compatibility declaration a plugin
 * makes, checked before an enable/disable/uninstall lands. Three entry
 * forms:
 *
 * - `name` — a package requirement (`@snap-rail/equipment`): satisfied when
 *   that package is installed and enabled.
 * - `name@range` — the same, with a version range on the resolved versions
 *   (`@snap-rail/framework-shadcn@^0.1`): also requires the installed
 *   version to satisfy the range (`@snap-rail/util/semver` semantics).
 *   A renderer face's ecosystem binding IS this form: requiring the
 *   framework package is what binds a component to it — there is no
 *   separate framework field.
 * - `service:id` — a live cordis service (`service:store`), checked
 *   against the running service table.
 *
 * An unmet requirement refuses the write instead of leaving the next boot
 * to fail.
 */
const requiresSchema = z.array(z.string().min(1)).optional()

/** The `snapRail` manifest field's schema. */
export const snapRailManifestSchema = z.object({
  /** Role declaration; `suite` and `framework` packages are single-active. */
  kind: z.enum(PLUGIN_KINDS).optional(),
  /** The layer this package belongs to; gates the import direction. */
  layer: z.enum(PLUGIN_LAYERS).optional(),
  /**
   * The human-facing display name shown wherever the plugin is listed (the
   * management page, install confirmations). The package author names it
   * freely (Chinese included); absent → surfaces fall back to the package
   * name.
   */
  title: z.string().min(1).max(64).optional(),
  /**
   * The classification marker shown in the management UI. Open vocabulary —
   * the package author names it freely (Chinese included); the app groups
   * rows by the raw marker and never validates it against an enum. Absent →
   * the management page files the row under 其他.
   */
  category: z.string().min(1).max(64).optional(),
  /**
   * Mutex group: enabling a package of group X deactivates every other
   * enabled package of group X in the same batched write. Suites default
   * to `'suite'`, frameworks to `'framework'`.
   */
  exclusive: z.string().min(1).optional(),
  requires: requiresSchema,
  /**
   * True for packages with no host face at all (frameworks, renderer
   * stations): their rows are config-only — never mounted into the host
   * tree, served to the renderer through `client-config.list`.
   */
  clientOnly: z.boolean().optional(),
  /** The renderer face; omit for host-only plugins. */
  client: clientFaceSchema.optional(),
  /** Permission declarations — shown at install time, enforced later. */
  permissions: z.array(z.string()).optional(),
  /** Host and renderer versions the built faces support. */
  engines: z.object({
    snapRail: z.string().min(1).optional(),
    hostProtocol: z.string().min(1).optional(),
    renderer: z.string().min(1).optional(),
  }).strict().optional(),
})
// Not `.strict()` on purpose: retired vocabulary in already-published zips
// (the pre-consolidation `framework` binding and `capabilities` blocks) is
// stripped at validation and never checked — the same forward tolerance the
// seedAbi grace uses. New manifests simply stop declaring them; zips
// carrying them install untouched.


/** The validated manifest field. */
export type SnapRailManifestInput = z.input<typeof snapRailManifestSchema>
export type SnapRailManifest = z.output<typeof snapRailManifestSchema>
