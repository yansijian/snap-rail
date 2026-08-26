/**
 * Append-only audit log: one JSONL file under the snap-rail home records who
 * changed what and when — plugin enable/disable, config edits, connection
 * changes, control writes. The service is provided as `ctx.audit`.
 *
 * @module @snap-rail/audit
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Context, Service, type Plugin } from '@snap-rail/cordis'

declare module '@snap-rail/cordis' {
  interface Context {
    audit: AuditService
  }

  interface Events {
    /** An audit entry was appended and is durable on disk.
     * @param entry - the full entry, including its assigned `time`.
     */
    'audit/event'(entry: AuditEntry): void
  }
}

/** One durable audit record. */
export interface AuditEntry {
  /** Wall-clock epoch milliseconds, assigned by the service. */
  time: number
  /** Who caused the change (`user`, `agent`, `system`, a plugin id, ...). */
  actor: string
  /** What happened (`plugin.enable`, `config.change`, `point.write`, ...). */
  action: string
  /** What the action targeted, when a single target exists. */
  subject?: string
  /** Action-specific detail; must be JSON-serializable. */
  detail?: unknown
}

/** Audit log exposed on `ctx.audit`. */
export interface AuditService {
  /** Append one entry, assign `time`, persist, and emit `audit/event`.
   * @param entry - the entry without `time`.
   * @returns the full entry with its assigned timestamp.
   */
  record(entry: Omit<AuditEntry, 'time'> & { time?: number }): AuditEntry
}

class AuditServiceImpl extends Service {
  private readonly file: string

  constructor(ctx: Context) {
    super(ctx, 'audit')
    const home = ctx.get('snapRailHome') as string | undefined
    if (home === undefined) throw new Error('audit: snapRailHome is not provided')
    this.file = join(home, 'audit.jsonl')
    mkdirSync(home, { recursive: true })
  }

  record(entry: Omit<AuditEntry, 'time'> & { time?: number }): AuditEntry {
    const { time, ...rest } = entry
    const full: AuditEntry = { time: time ?? Date.now(), ...rest }
    let serialized: string
    try {
      serialized = JSON.stringify(full)
    } catch (cause) {
      throw new Error(`audit: entry for ${full.action} is not JSON-serializable`, { cause })
    }
    appendFileSync(this.file, `${serialized}\n`)
    this.ctx.emit('audit/event', full)
    return full
  }
}

/** Audit plugin: mounts `ctx.audit`; requires the `snapRailHome` provided value. */
const auditPlugin: Plugin.Function = Object.assign(
  function audit(ctx: Context): void {
    new AuditServiceImpl(ctx)
  },
  { inject: ['snapRailHome'] },
)

export default auditPlugin
