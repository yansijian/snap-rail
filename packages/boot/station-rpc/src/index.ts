/**
 * The station host bridge: operator session (persisted to settings, audited),
 * business-event read/write over the audit log, renderer-occupant config
 * rows carved out of the shared `plugins.yml`, and the settings key/value
 * seam for simple persisted configuration (every write broadcasts a
 * `settings/changed` frame so renderer occupants hot-apply). The actor of
 * every recorded event is the signed-on operator, resolved host-side — the
 * renderer never asserts who it is.
 *
 * Domains claimed here: `session`, `settings`, `audit`, `client-config`;
 * signatures and schemas live in the `./contract` module.
 *
 * @module @snap-rail/station-rpc
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import { RpcBusinessError } from '@snap-rail/protocol'
import type { GatewayService } from '@snap-rail/gateway'
import type { AuditService } from '@snap-rail/audit'
import type { SettingsService } from '@snap-rail/settings'
import { loadUserLayer } from '@snap-rail/app-boot'
import { scanPluginPool } from '@snap-rail/app-boot/scan'
import {
  SESSION_OPERATOR_KEY,
  settingsChangedSchema,
  stationRequestSchemas,
  type ClientConfigRow,
} from './contract.ts'

/** The station bridge plugin; mount after rpc, settings, audit, and boot. */
const stationRpcPlugin: Plugin.Object<void> = {
  name: 'station-rpc',
  inject: ['rpc', 'audit', 'settings', 'pluginLayers'],
  apply(ctx: Context): void {
    const rpc: GatewayService = ctx.rpc
    const audit: AuditService = ctx.audit
    const settings: SettingsService = ctx.settings
    const layers = ctx.pluginLayers

    const currentOperator = (): string | null =>
      settings.get<string | null>(SESSION_OPERATOR_KEY) ?? null

    for (const domain of ['session', 'settings', 'audit', 'client-config']) {
      rpc.claimDomain(ctx, domain)
    }

    rpc.method(ctx, 'session.current', { request: stationRequestSchemas['session.current'] }, () => ({
      operator: currentOperator(),
    }))

    rpc.method(ctx, 'session.login', { request: stationRequestSchemas['session.login'] }, ({ operator: raw }) => {
      const operator = raw.trim()
      if (operator === '') {
        throw new RpcBusinessError({
          code: 'bad-request',
          details: { issues: ['工号不能为空'] },
        })
      }
      settings.set(SESSION_OPERATOR_KEY, operator)
      audit.record({ actor: operator, action: 'session.login' })
      return { applied: true } as const
    })

    rpc.method(ctx, 'session.logout', { request: stationRequestSchemas['session.logout'] }, () => {
      const previous = currentOperator()
      settings.set<string | null>(SESSION_OPERATOR_KEY, null)
      audit.record({ actor: previous ?? 'client', action: 'session.logout' })
      return { applied: true } as const
    })

    // The settings key/value seam: simple persisted configuration for
    // renderer occupants. Writes persist atomically and the host event fans
    // out as a frame, so consumers hot-apply instead of waiting for a restart.
    rpc.method(ctx, 'settings.get', { request: stationRequestSchemas['settings.get'] }, ({ key }) => ({
      value: settings.get(key) ?? null,
    }))

    rpc.method(ctx, 'settings.set', { request: stationRequestSchemas['settings.set'] }, ({ key, value }) => {
      settings.set(key, value)
      audit.record({
        actor: currentOperator() ?? 'client',
        action: 'settings.set',
        subject: key,
        detail: { value },
      })
      return { applied: true } as const
    })

    rpc.frame(ctx, 'settings/changed', { payload: settingsChangedSchema })
    rpc.bridgeEvent(ctx, 'settings/changed', 'settings/changed', (key, value) => ({ key, value }))

    rpc.method(ctx, 'audit.list', { request: stationRequestSchemas['audit.list'] }, filter => ({
      entries: audit.list(filter),
    }))

    rpc.method(ctx, 'audit.record', { request: stationRequestSchemas['audit.record'] }, ({ action, subject, detail }) => {
      const entry = audit.record({
        actor: currentOperator() ?? 'client',
        action,
        ...subject !== undefined ? { subject } : {},
        ...detail !== undefined ? { detail } : {},
      })
      return { time: entry.time } as const
    })

    rpc.method(ctx, 'client-config.list', { request: stationRequestSchemas['client-config.list'] }, () => {
      const rendererPackages = new Set(layers.handles.rendererPackages)
      // Pool-installed occupants with a renderer face: the bundle URL rides
      // the row so the renderer's module loader knows what to fetch.
      const pool = scanPluginPool(layers.handles.poolDirs)
      const clientFaces = new Map<string, string>()
      for (const [name, descriptor] of pool) {
        if (descriptor.clientEntry === undefined) continue
        clientFaces.set(name, `snap-plugin://pool/${descriptor.dir.split(/[\\/]/).at(-1)}/${descriptor.clientEntry}`)
      }
      const seen = new Set<string>()
      const rows: ClientConfigRow[] = []
      for (const row of loadUserLayer(layers.handles.userLayerPath).plugins) {
        const clientUrl = clientFaces.get(row.name)
        const isClient = rendererPackages.has(row.name) || clientUrl !== undefined
        if (!isClient) continue
        seen.add(row.name)
        rows.push({
          name: row.name,
          enabled: row.enabled !== false,
          ...row.config !== undefined ? { config: row.config } : {},
          ...clientUrl !== undefined ? { clientUrl } : {},
        })
      }
      // Pool client faces without a user row list as disabled: installing is
      // not enabling, and pool plugins mount (host and renderer alike) only
      // through an explicit user row. The row still rides out so the renderer
      // knows the face exists — boot skips disabled rows, and the settings
      // page can prompt for a restart when the row flips.
      for (const [name, clientUrl] of clientFaces) {
        if (seen.has(name)) continue
        rows.push({ name, enabled: false, clientUrl })
      }
      return { rows }
    })
  },
}

export default stationRpcPlugin
