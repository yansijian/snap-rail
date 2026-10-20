/**
 * The repo-side voice of the shared catalog-entry emitter. The single
 * implementation lives in `@snap-rail/plugin-kit/pack` (so the standalone
 * `snap-rail-plugin feed` command and this pipeline can never drift); this
 * module keeps the existing `scripts/*` import paths stable.
 *
 * @module snap-rail/scripts/lib/catalog-entry
 */

export { catalogEntryFromZip, type FeedEntry } from '@snap-rail/plugin-kit/pack'
