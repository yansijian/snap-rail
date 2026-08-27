/**
 * Runtime layer administration: recompute the two-layer composition, apply it
 * through the include entry's transactional `refresh()`, persist user-layer
 * edits, and watch the layer files for external edits (hand-edited or Agent
 * written — the file is the interface).
 *
 * Failure semantics: a layer file that no longer composes (bad YAML, unknown
 * plugin) keeps the currently mounted tree running and surfaces the error to
 * the caller/watch log; nothing is written and nothing unmounts.
 *
 * @module @snap-rail/app-boot/admin
 */

import { existsSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { dump } from 'js-yaml'
import type { Context } from '@snap-rail/cordis'
import { composeEntries, loadBuiltinLayer, loadUserLayer } from './compose.ts'
import type { UserLayer, UserPluginRow } from './compose.ts'
import { scanPluginPool } from './scan.ts'
import type { EntryOptions } from '@snap-rail/cordis-plugin-loader'

/** Everything the administrator needs to reach the layers and the tree. */
export interface LayerHandles {
  /** Absolute path of the read-only built-in entry list. */
  builtinLayerPath: string
  /** Absolute path of the user layer (`plugins.yml`); may not exist yet. */
  userLayerPath: string
  /** Directory whose dependency tree resolves built-in plugin names. */
  appRoot: string
  /** Plugin pool directories. */
  poolDirs: readonly string[]
  /** Absolute path of the derived composed file the include mounts. */
  composedPath: string
  /** Loader entry id of the root include. */
  includeId: string
}

/** Minimal structural face of the vendored include entry (`refresh`). */
interface Refreshable {
  refresh(): Promise<void>
}

const WRITE_RETRY_LIMIT = 10
const WRITE_RETRY_DELAY_MS = 50

function retryableWriteError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EBUSY' || code === 'EPERM'
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content)
  for (let retry = 0; ; retry++) {
    try {
      renameSync(tmp, path)
      return
    } catch (error) {
      if (!retryableWriteError(error) || retry >= WRITE_RETRY_LIMIT) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WRITE_RETRY_DELAY_MS)
    }
  }
}

/**
 * The layer administrator mounted by {@link ./boot.ts | boot} and provided as
 * `ctx.pluginLayers`. All mutations serialize through one queue so a watch
 * reaction and an rpc call cannot interleave a read-modify-write.
 */
export class LayerAdmin {
  private queue: Promise<unknown> = Promise.resolve()
  private watchers: Array<{ close(): void }> = []
  private watchTimer: NodeJS.Timeout | undefined

  constructor(private readonly ctx: Context, readonly handles: LayerHandles) {}

  /** Recompute the composition from the layer files (fail loud, no writes). */
  recompose(): EntryOptions[] {
    const pool = scanPluginPool(this.handles.poolDirs)
    return composeEntries({
      builtin: loadBuiltinLayer(this.handles.builtinLayerPath),
      userLayer: loadUserLayer(this.handles.userLayerPath),
      pool,
      appRoot: this.handles.appRoot,
    })
  }

  /**
   * Apply the current layer files to the mounted tree: recompose, skip when
   * the derived artifact is unchanged, otherwise rewrite it and refresh the
   * include (transactional per entry, rolling back on failure).
   *
   * @returns whether the composed artifact changed.
   * @throws whatever recomposition or the include refresh raised; in both
   * cases the previously mounted tree keeps running.
   */
  async apply(): Promise<boolean> {
    const composed = this.recompose()
    const serialized = dump(composed)
    const current = existsSync(this.handles.composedPath)
      ? readFileSync(this.handles.composedPath, 'utf8')
      : undefined
    if (serialized === current) return false

    const include = this.ctx.loader.store[this.handles.includeId]?.subtree as Refreshable | undefined
    if (include === undefined) {
      throw new Error('pluginLayers: the root include entry is no longer mounted')
    }
    atomicWrite(this.handles.composedPath, serialized)
    await include.refresh()
    this.ctx.emit('plugin-layers/applied', composed)
    return true
  }

  /**
   * Upsert one user-layer row and apply. Unknown extra fields the row already
   * carries (Agent annotations, comments data) survive the rewrite.
   *
   * @param name - the plugin's package name (the row key).
   * @param changes - the fields to set; `undefined` leaves a field untouched,
   * `null`-free by the row's own types.
   */
  async setUserRow(name: string, changes: { enabled?: boolean, config?: unknown }): Promise<void> {
    const run = this.queue.then(async () => {
      const layer = loadUserLayer(this.handles.userLayerPath)
      const rows = [...layer.plugins]
      const index = rows.findIndex(row => row.name === name)
      const base: UserPluginRow = index === -1 ? { name } : { ...rows[index]! }
      if (changes.enabled !== undefined) base.enabled = changes.enabled
      if (changes.config !== undefined) base.config = changes.config
      if (index === -1) rows.push(base)
      else rows[index] = base
      atomicWrite(this.handles.userLayerPath, dump({ plugins: rows } satisfies UserLayer))
      await this.apply()
    })
    this.queue = run.catch(() => {})
    await run
  }

  /**
   * Watch the layer files (and pool directories) for external edits and
   * re-apply, debounced. Errors from a broken intermediate state are logged
   * and swallowed: the watch keeps running for the next, fixed write.
   *
   * @returns the disposer stopping all watchers.
   */
  startWatch(): () => void {
    const targets = [
      ...new Set([
        dirname(this.handles.builtinLayerPath),
        dirname(this.handles.userLayerPath),
        ...this.handles.poolDirs,
      ]),
    ]
    for (const dir of targets) {
      if (!existsSync(dir)) continue
      try {
        this.watchers.push(watch(dir, (event, filename) => this.onWatchEvent(dir, event, filename)))
      } catch {
        this.ctx.logger('pluginLayers').warn?.(`cannot watch ${dir}`)
      }
    }
    return () => {
      for (const watcher of this.watchers.splice(0)) watcher.close()
      if (this.watchTimer !== undefined) clearTimeout(this.watchTimer)
    }
  }

  private onWatchEvent(dir: string, eventType: string, filename: string | Buffer | null): void {
    const isPoolDir = this.handles.poolDirs.includes(dir)
    if (isPoolDir) {
      // Pool membership changes on folder drops/removals only.
      if (eventType !== 'rename') return
    } else {
      const name = typeof filename === 'string' ? filename : null
      if (name !== basename(this.handles.builtinLayerPath) && name !== basename(this.handles.userLayerPath)) return
    }
    if (this.watchTimer !== undefined) clearTimeout(this.watchTimer)
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined
      const run = this.queue.then(() => this.apply())
      this.queue = run.catch(() => {})
      run.catch(cause => {
        this.ctx.logger('pluginLayers').error?.(cause)
      })
    }, 150)
  }
}
