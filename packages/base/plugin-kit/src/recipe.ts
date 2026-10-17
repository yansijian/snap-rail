/**
 * The combo (recipe) document shipped inside an offline combo archive: the
 * exact `plugins.yml` row shape plus the combination's identity. The archive
 * itself is a plain zip — `recipe.yml` at the root, one signed plugin zip per
 * referenced package under `plugins/` — so an offline terminal can install a
 * whole scenario without any feed request.
 *
 * @module @snap-rail/plugin-kit/recipe
 */

import { z } from 'zod'

/** A row may address a package or one of its subpath entries
 * (`@snap-rail/equipment/rpc`) — the same names `plugins.yml` accepts. */
const recipeRowNamePattern = /^(@[a-z0-9-]+\/[a-z0-9-]+|[a-z0-9-]+)(\/[a-z0-9-]+)*$/

/** One combo row: exactly the user-layer row shape, strict. */
export const recipeRowSchema = z.object({
  name: z.string().regex(recipeRowNamePattern),
  enabled: z.boolean().optional(),
  config: z.unknown().optional(),
}).strict()

/** A combo package's document: identity + the rows the preset carries. */
export const recipeDocumentSchema = z.object({
  /** Stable id; also the preset file name (`recipe-<id>.yml`). */
  id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(['base', 'scenario']),
  description: z.string().optional(),
  plugins: z.array(recipeRowSchema).min(1),
}).strict()

/** One parsed combo row. */
export type RecipeRow = z.output<typeof recipeRowSchema>

/** One parsed combo document. */
export type RecipeDocument = z.output<typeof recipeDocumentSchema>

/**
 * The real package names a combo references, deduplicated in document order.
 * A subpath row (`@snap-rail/equipment/rpc`) addresses the package
 * `@snap-rail/equipment`; the combo archive carries one zip per package.
 *
 * @param document - the parsed combo document.
 * @returns unique package names in first-reference order.
 */
export function recipePackageNames(document: RecipeDocument): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const row of document.plugins) {
    const name = packageNameOf(row.name)
    if (seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/**
 * The npm package a row belongs to (`@scope/pkg/sub` → `@scope/pkg`).
 *
 * @param name - a package name or subpath entry.
 * @returns the package name.
 */
export function packageNameOf(name: string): string {
  if (!name.startsWith('@')) return name.split('/')[0]!
  const slash = name.indexOf('/')
  if (slash < 0) return name
  const second = name.indexOf('/', slash + 1)
  return second < 0 ? name : name.slice(0, second)
}
