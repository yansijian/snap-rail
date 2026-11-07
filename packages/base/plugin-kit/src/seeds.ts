/**
 * The renderer's shared-module vocabulary, in two tiers.
 *
 * `SEED_MODULES` is the **base tier**: the ids the shell itself seeds (by
 * importing them statically into the app bundle) and parity-checks at boot.
 * Everything a client bundle `require`s beyond this list must either be
 * bundled in or contributed (below). Cross-plugin value imports are
 * forbidden (collaboration goes through cordis services and slots); spine
 * contract faces (`./contract` — zod + types only) and pure utility faces
 * qualify; package host entries never do — the node side (store, drizzle,
 * node:sqlite) must stay out of the client graph. Adding a base id is a
 * spine decision.
 *
 * `CONTRIBUTED_SEED_MODULES` is the **installed tier**: ids that arrive with
 * an installed plugin's client face (the framework's primitives, an
 * extension pack's components). The provider's client entry default-exports
 * a `seeds` map (`{ seeds: { ui: namespace, … } }`); the shell requires the
 * face once and seeds every `<package>/<key>` id from that map, so every
 * consumer shares the provider's single instances. The shell never seeds
 * these itself — an absent provider simply leaves the ids unseeded and
 * dependent faces skip with a load error instead of mounting half a UI.
 *
 * `CLIENT_EXTERNALS` (the union) is the external surface client bundles
 * build against: the plugin-kit's client preset externalizes exactly these
 * ids.
 *
 * @module @snap-rail/plugin-kit/seeds
 */

import { compareVersions, sameCompatLane, satisfiesRange } from '@snap-rail/util/semver'

/** Module ids the shell seeds and every client bundle may require. */
export const SEED_MODULES: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@snap-rail/cordis',
  '@snap-rail/cordis-plugin-timer',
  '@snap-rail/client-kernel',
  '@snap-rail/client-modules',
  '@snap-rail/connection',
  '@snap-rail/protocol',
  '@snap-rail/shell/contract',
  '@snap-rail/station-rpc/contract',
  '@snap-rail/app-boot/contract',
  '@snap-rail/equipment/contract',
  '@snap-rail/ui',
  '@snap-rail/ui/components',
  '@snap-rail/ui/charts',
  '@snap-rail/ui/contract',
  '@snap-rail/ui/slots',
  '@snap-rail/ui/skins',
  '@snap-rail/ui/settings',
  '@snap-rail/ui/runtime',
  '@snap-rail/ui/pages',
  '@snap-rail/ui/fallback',
  '@snap-rail/util',
  'zod',
]

/**
 * Module ids installed plugins contribute through their client face's
 * `seeds` map — the framework tier: every face of an installed UI framework
 * (primitives, slot registry, runtime, fallback) serves as a shared
 * instance for the components bound to it. The equipment wire contract
 * rides the base tier instead — it is the station platform's API surface,
 * not an installed framework's; a scenario's own contract stays inside its
 * suite package. A third-party framework contributes its own ids; this
 * list covers the in-repo builds.
 */
export const CONTRIBUTED_SEED_MODULES: readonly string[] = []

/** The full external surface for in-repo client-bundle builds. */
export const CLIENT_EXTERNALS: readonly string[] = [...SEED_MODULES, ...CONTRIBUTED_SEED_MODULES]

/**
 * The seed contract's ABI revision. Bump when the contract between the
 * shell's seed table and client bundles changes shape — interop semantics,
 * a seed id's export shape. Packs stamp every client face with the revision
 * it was built against (`snapRail.client.seedAbi`); the shell refuses a
 * face stamped with a foreign revision instead of letting it crash the
 * renderer (r1 exists because a seed default-import compiled to a namespace
 * where the author meant a class — the shape must be checkable; r2→r3
 * because the theme contract collapsed to one token set per theme).
 */
export const SEED_ABI_REVISION = 3

/** What a client face declares about the seed table it was built against. */
export interface SeedAbi {
  /** The contract revision the face was built against. */
  revision: number
  /** Base-package versions of the seeds the bundle requires, by seed id. */
  versions: Record<string, string>
}

/** The verdict of comparing a face's declaration against the live table. */
export interface SeedAbiVerdict {
  /** Whether the face may load. */
  ok: boolean
  /** The face carries no declaration — the grace-window pass. */
  undeclared: boolean
  /** Human-readable refusal reason; absent when `ok`. */
  reason?: string
}

/**
 * Compare a client face's stamped seed ABI against the live table. Only the
 * ids present in BOTH maps are compared (a stamp covers exactly what its
 * build could resolve): the revision must match exactly, and every shared
 * version must sit in the live version's npm caret lane (`^` semantics — the
 * minor is the boundary across `0.x`, so a face built against `ui` 0.2
 * refuses a 0.3 host). First-party seeds (`@snap-rail/*`) evolve with the
 * SDK a face was built against, so the host must also carry at least that
 * version — a face using a component an older terminal lacks is refused at
 * install instead of crashing at render. Third-party seeds resolve
 * independently in every repository (a plugin's lockfile may hold a newer
 * patch than the shell), so lane agreement is enough there. An absent
 * declaration passes — zips predating the stamping stay installable, marked
 * for the caller to log.
 */
export function checkSeedAbi(declared: SeedAbi | undefined, host: SeedAbi): SeedAbiVerdict {
  if (declared === undefined) return { ok: true, undeclared: true }
  if (declared.revision !== host.revision) {
    return {
      ok: false,
      undeclared: false,
      reason: `插件构建于种子 ABI r${declared.revision}，宿主为 r${host.revision} —— 请更新插件包或桌面应用`,
    }
  }
  for (const [id, version] of Object.entries(declared.versions)) {
    const live = host.versions[id]
    if (live === undefined) continue
    const compatible = id.startsWith('@snap-rail/')
      ? satisfiesRange(live, `^${version}`)
      : sameCompatLane(version, live)
    if (!compatible) {
      const hostOlder = compareVersions(live, version) < 0
      return {
        ok: false,
        undeclared: false,
        reason: hostOlder
          ? `插件构建于 ${id}@${version}，宿主提供 ${live}（宿主版本较旧，请更新桌面应用）`
          : `插件构建于 ${id}@${version}，宿主提供 ${live}（兼容版本线不一致，请用新版 SDK 重新构建插件）`,
      }
    }
  }
  return { ok: true, undeclared: false }
}
