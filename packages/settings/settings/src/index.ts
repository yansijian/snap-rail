/**
 * App settings persistence: a JSON document under the snap-rail home, written
 * atomically on every change. The service is provided as `ctx.settings`.
 *
 * @module @snap-rail/settings
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context, Service, type Plugin } from '@snap-rail/cordis'

declare module '@snap-rail/cordis' {
  interface Context {
    settings: SettingsService
  }

  interface Events {
    /** A settings key changed and the new value is durable on disk.
     * @param key - the changed settings key.
     * @param value - the new value.
     */
    'settings/changed'(key: string, value: unknown): void
  }
}

/** Persisted key/value settings exposed on `ctx.settings`. */
export interface SettingsService {
  /** Read the current value of a settings key. */
  get<T>(key: string): T | undefined
  /** Write a settings key, persist durably, and emit `settings/changed`. */
  set<T>(key: string, value: T): void
}

const RETRY_LIMIT = 5
const RETRY_DELAY_MS = 50

function isRetryableRename(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EBUSY' || code === 'EPERM'
}

class SettingsServiceImpl extends Service {
  private readonly file: string
  private values: Record<string, unknown> = {}

  constructor(ctx: Context) {
    super(ctx, 'settings')
    const home = ctx.get('snapRailHome') as string | undefined
    if (home === undefined) throw new Error('settings: snapRailHome is not provided')
    this.file = join(home, 'settings.json')
    this.reload()
  }

  private reload(): void {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      // A missing file is a fresh home; any other read failure is real.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`settings: ${this.file} is not a settings object`)
    }
    this.values = parsed as Record<string, unknown>
  }

  get<T>(key: string): T | undefined {
    return this.values[key] as T | undefined
  }

  set<T>(key: string, value: T): void {
    this.values[key] = value
    this.persist()
    this.ctx.emit('settings/changed', key, value)
  }

  private persist(): void {
    const serialized = `${JSON.stringify(this.values, null, 2)}\n`
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${randomUUID()}.tmp`
    writeFileSync(temp, serialized)
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temp, this.file)
        return
      } catch (error) {
        // Windows can briefly retain a destination handle after a reader
        // closes it; a bounded retry absorbs the transient window.
        if (!isRetryableRename(error) || attempt >= RETRY_LIMIT) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_DELAY_MS)
      }
    }
  }
}

/** Settings plugin: mounts `ctx.settings`; requires the `snapRailHome` provided value. */
const settingsPlugin: Plugin.Function = Object.assign(
  function settings(ctx: Context): void {
    new SettingsServiceImpl(ctx)
  },
  { inject: ['snapRailHome'] },
)

export default settingsPlugin
