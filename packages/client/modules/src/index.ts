/**
 * The renderer's plugin module system — the port of deepseek-harness's
 * proven client module model. Installed plugins' renderer faces arrive as
 * **CJS factory bundles**: a classic `<script>` whose whole body is
 * `window.__ModuleLoader__.load({ id, factory: (require) => exports })`.
 * The shared dependencies (react, react-dom, the spine's UI/kernel seam)
 * are seeded once by the shell, so every bundle sees the same instances —
 * a second React would break hooks, a second cordis would split fibers.
 *
 * Queue semantics: bundles register before or after `create()` runs — a
 * queue-mode loader collects early registrations and hands them to the live
 * loader, so script order never matters.
 *
 * @module @snap-rail/client-modules
 */

/** A CJS factory: receives its `require`, `module`, and `exports` (the
 * welded wrapper's signature — the bundle body assigns `module.exports`
 * like any CommonJS module and returns the unwrapped default). */
export type ModuleFactory = (
  require: (id: string) => unknown,
  module: { exports: Record<string, unknown> },
  exports: Record<string, unknown>,
) => unknown

/** One bundle registration as the welded wrapper posts it. */
export interface ModuleRegistration {
  id: string
  factory: ModuleFactory
}

/** The `window.__ModuleLoader__` face bundles talk to. */
export interface ModuleLoaderGlobal {
  /** Bundle wrapper entry point (queue-mode before create, live after). */
  load(registration: ModuleRegistration): void
  /** Resolve one module id against the live system (seeds and registered
   * bundles alike); throws while the system is not live. Lets plugin-provided
   * runners — code outside any bundle wrapper — hand generated plugin code
   * the same seeded `require` the wrappers get, restricted by construction
   * to the ids the system itself knows. */
  require(id: string): unknown
}

/** The live module system returned by {@link installModuleLoader}'s create. */
export interface ModuleSystem {
  /** Resolve a module id: seeded instances and registered bundles alike. */
  require(id: string): unknown
  /** Whether an id resolves (seed or bundle). */
  has(id: string): boolean
  /** Seed shared instances (the shell's static imports); later wins. */
  seed(id: string, instance: unknown): void
}

/** One live system's tables. */
interface SystemTables {
  system: ModuleSystem
  factories: Map<string, ModuleFactory>
  exports: Map<string, unknown>
  seeds: Map<string, unknown>
  /** Factories currently executing (cycle detection). */
  loading: Set<string>
}

/** Live systems by identity — the global routes registrations to this one. */
const liveTables = new WeakMap<ModuleSystem, SystemTables>()

/**
 * Install the global loader in queue mode. Returns the `create()` that
 * swaps it live — bundles that registered early replay into the system in
 * registration order. Installing twice returns a create bound to the same
 * global (the second install's create rejects: one system per page).
 */
export function installModuleLoader(global: { __ModuleLoader__?: ModuleLoaderGlobal }): () => ModuleSystem {
  const pending: ModuleRegistration[] = []
  let tables: SystemTables | undefined

  global.__ModuleLoader__ = {
    load(registration) {
      if (tables !== undefined) {
        register(tables, registration)
        return
      }
      pending.push(registration)
    },
    require(id: string): unknown {
      if (tables === undefined) throw new Error('plugin module loader: not live')
      return resolve(tables, id)
    },
  }

  return () => {
    if (tables !== undefined) throw new Error('plugin module loader: already created')
    const seeds = new Map<string, unknown>()
    const system: ModuleSystem = {
      require(id: string): unknown {
        if (tables === undefined) throw new Error('plugin module loader: not live')
        return resolve(tables, id)
      },
      has(id: string): boolean {
        if (tables === undefined) return false
        return tables.seeds.has(id) || tables.factories.has(id)
      },
      seed(id: string, instance: unknown): void {
        if (tables === undefined) throw new Error('plugin module loader: not live')
        tables.seeds.set(id, instance)
      },
    }
    tables = {
      system,
      factories: new Map(),
      exports: new Map(),
      seeds,
      loading: new Set(),
    }
    liveTables.set(system, tables)
    for (const registration of pending.splice(0)) register(tables, registration)
    return system
  }
}

/** Register one factory; duplicate ids fail loud (two bundles, one name). */
function register(tables: SystemTables, registration: ModuleRegistration): void {
  if (tables.factories.has(registration.id)) {
    throw new Error(`plugin module loader: duplicate bundle "${registration.id}"`)
  }
  tables.factories.set(registration.id, registration.factory)
}

/** Resolve one id: seed, cached exports, or execute the factory. */
function resolve(tables: SystemTables, id: string): unknown {
  const seeded = tables.seeds.get(id)
  if (seeded !== undefined || tables.seeds.has(id)) return seeded
  const cached = tables.exports.get(id)
  if (cached !== undefined || tables.exports.has(id)) return cached
  const factory = tables.factories.get(id)
  if (factory === undefined) throw new Error(`plugin module loader: no module named "${id}"`)
  if (tables.loading.has(id)) {
    throw new Error(`plugin module loader: circular require of "${id}"`)
  }
  tables.loading.add(id)
  try {
    // CommonJS triple-argument invocation: the wrapper's footer returns the
    // interop-unwrapped exports, but a plain `module.exports = …` body that
    // returns nothing still lands through the module object.
    const moduleObject = { exports: {} as Record<string, unknown> }
    const value = factory(
      (dependency: string) => resolve(tables, dependency),
      moduleObject,
      moduleObject.exports,
    )
    const exported = value !== undefined ? value : moduleObject.exports
    tables.exports.set(id, exported)
    return exported
  } finally {
    tables.loading.delete(id)
  }
}

/**
 * Load one plugin bundle: append a classic `<script src>` and resolve once
 * its wrapper registers (the queue-mode global accepts it whichever side of
 * `create()` the tag lands on). Rejects on script error or timeout.
 *
 * @param document - the page document (tag host).
 * @param url - the bundle URL (snap-plugin:// in the app; any origin tests).
 * @param timeoutMs - how long to wait for the registration.
 */
export function loadPluginBundle(
  document: Document,
  url: string,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    script.async = true
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`plugin bundle load timed out: ${url}`))
    }, timeoutMs)
    const onError = (): void => {
      cleanup()
      reject(new Error(`plugin bundle failed to load: ${url}`))
    }
    const onLoad = (): void => {
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      script.removeEventListener('load', onLoad)
      script.removeEventListener('error', onError)
    }
    script.addEventListener('load', onLoad)
    script.addEventListener('error', onError)
    document.head.append(script)
  })
}
