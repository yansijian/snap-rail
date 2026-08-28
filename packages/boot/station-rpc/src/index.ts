/**
 * The station host bridge: operator session (persisted to settings, audited),
 * business-event read/write over the audit log, and renderer-occupant config
 * rows carved out of the shared `plugins.yml`. The actor of every recorded
 * event is the signed-on operator, resolved host-side — the renderer never
 * asserts who it is.
 *
 * @module @snap-rail/station-rpc
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import { RpcBusinessError } from '@snap-rail/protocol'
import type { ClientConfigRow } from '@snap-rail/protocol'
import type { GatewayService } from '@snap-rail/gateway'
import type { AuditService } from '@snap-rail/audit'
import type { SettingsService } from '@snap-rail/settings'
import { loadUserLayer } from '@snap-rail/app-boot'

/** Settings key holding the signed-on operator id (`null` when signed off). */
const OPERATOR_KEY = 'session.operatorId'

/** The station bridge plugin; mount after gateway, settings, audit, and boot. */
const stationRpcPlugin: Plugin.Object<void> = {
  name: 'station-rpc',
  inject: ['gateway', 'audit', 'settings', 'pluginLayers'],
  apply(ctx: Context): void {
    const gateway: GatewayService = ctx.gateway
    const audit: AuditService = ctx.audit
    const settings: SettingsService = ctx.settings
    const layers = ctx.pluginLayers

    const currentOperator = (): string | null =>
      settings.get<string | null>(OPERATOR_KEY) ?? null

    gateway.registerMethod('session.current', () => ({
      operator: currentOperator(),
    }))

    gateway.registerMethod('session.login', ({ operator: raw }) => {
      const operator = raw.trim()
      if (operator === '') {
        throw new RpcBusinessError({
          code: 'bad-request',
          details: { issues: ['工号不能为空'] },
        })
      }
      settings.set(OPERATOR_KEY, operator)
      audit.record({ actor: operator, action: 'session.login' })
      return { applied: true } as const
    })

    gateway.registerMethod('session.logout', () => {
      const previous = currentOperator()
      settings.set<string | null>(OPERATOR_KEY, null)
      audit.record({ actor: previous ?? 'client', action: 'session.logout' })
      return { applied: true } as const
    })

    gateway.registerMethod('audit.list', filter => ({
      entries: audit.list(filter),
    }))

    gateway.registerMethod('audit.record', ({ action, subject, detail }) => {
      const entry = audit.record({
        actor: currentOperator() ?? 'client',
        action,
        ...subject !== undefined ? { subject } : {},
        ...detail !== undefined ? { detail } : {},
      })
      return { time: entry.time } as const
    })

    gateway.registerMethod('client-config.list', () => {
      const rendererPackages = new Set(layers.handles.rendererPackages)
      const rows: ClientConfigRow[] = []
      for (const row of loadUserLayer(layers.handles.userLayerPath).plugins) {
        if (!rendererPackages.has(row.name)) continue
        rows.push({
          name: row.name,
          enabled: row.enabled !== false,
          ...row.config !== undefined ? { config: row.config } : {},
        })
      }
      return { rows }
    })
  },
}

export default stationRpcPlugin
