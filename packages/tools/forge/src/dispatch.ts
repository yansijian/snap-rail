/**
 * The renderer-half dispatcher: pushes generated client halves to the
 * renderer over `forge/gen-mounted`/`forge/gen-unmounted` frames, answers
 * the renderer's boot-time `forge.gen-faces` pull, and turns incoming
 * `forge.client-report` diagnostics into mount-board entries plus — when an
 * agent run is waiting on that plugin — a steering message the loop feeds
 * back to the model (the repair loop's renderer leg).
 *
 * Push alone is not delivery: the renderer may boot after the host's
 * mounts, so the boot pull is authoritative and pushes are the hot path.
 *
 * @module @snap-rail/forge/dispatch
 */

import type { Context } from '@snap-rail/cordis'
import type { GatewayService } from '@snap-rail/gateway'
import type { GenFace } from './contract.ts'
import type { ForgeRegistry } from './registry.ts'

/** One renderer-side diagnostic as the RPC method hands it over. */
export interface ClientReport {
  id: string
  versionId: string
  stage: 'load' | 'render'
  ok: boolean
  message?: string | undefined
}

/** The dispatcher over the gateway, registry, and a steering sink. */
export interface ClientDispatch {
  /** Push one renderer half (mount or replace) to the renderer. */
  mountClient(id: string, versionId: string, src: string): void
  /** Tell the renderer to unload one renderer half. */
  unmountClient(id: string): void
  /** Every enabled plugin's active renderer half — the boot pull's answer. */
  faces(): GenFace[]
  /** Broadcast `forge/plugins-changed` (the workbench reloads its table). */
  notifyPluginsChanged(): void
  /** Handle one `forge.client-report`: board + notify (+ steering). */
  handleReport(report: ClientReport): void
  /** Attach/detach the agent loop's steering sink (one run at a time). */
  setSteering(sink: ((report: ClientReport) => boolean) | null): void
}

/** Construct the dispatcher. */
export function createDispatch(ctx: Context, registry: ForgeRegistry): ClientDispatch {
  const rpc: GatewayService = ctx.rpc
  let steering: ((report: ClientReport) => boolean) | null = null

  return {
    mountClient(id: string, versionId: string, src: string): void {
      rpc.broadcast('forge/gen-mounted', { id, versionId, src })
    },

    unmountClient(id: string): void {
      rpc.broadcast('forge/gen-unmounted', { id })
    },

    faces(): GenFace[] {
      return registry.remountList()
        .filter(entry => entry.clientSrc !== null)
        .map(entry => ({ id: entry.id, versionId: entry.currentVersionId, src: entry.clientSrc as string }))
    },

    notifyPluginsChanged(): void {
      rpc.broadcast('forge/plugins-changed', {})
    },

    handleReport(report: ClientReport): void {
      const text = `渲染半边${report.stage === 'load' ? '加载' : '渲染'}${report.ok ? '成功' : '失败'}`
        + (report.message !== undefined && report.message !== '' ? `：${report.message}` : '')
      if (report.ok) {
        registry.setStatus(report.id, 'running', null)
      } else {
        registry.setStatus(report.id, 'error', text)
      }
      this.notifyPluginsChanged()
      // The running loop consumes the report if it is waiting on this
      // plugin's outcome; otherwise the board alone carries it.
      steering?.(report)
    },

    setSteering(sink: ((report: ClientReport) => boolean) | null): void {
      steering = sink
    },
  }
}
