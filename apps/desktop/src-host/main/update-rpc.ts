/**
 * The desktop shell's update bridge: owns the `update` wire domain on the
 * wire. Backed by electron-updater in the packaged build — check on mount
 * (config-gated), download in the background, and install only through the
 * operator's explicit restart. The status rides the `update/status` frame as
 * full snapshots; the settings seats (`update.feedUrl`, `update.autoCheck`)
 * make the channel a pure projection of configuration.
 *
 * Mounted by the desktop main process next to the window bridge; the state
 * machine itself lives in `./update-machine` (Electron-free, testable).
 *
 * @module @snap-rail/desktop/main/update-rpc
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { Context, type Plugin } from '@snap-rail/cordis'
import {
  UPDATE_AUTO_CHECK_KEY,
  UPDATE_FEED_URL_KEY,
  updateRequestSchemas,
  updateStatusSchema,
  type UpdateStatus,
} from '@snap-rail/app-boot/contract'
import type { GatewayService } from '@snap-rail/gateway'
import type { SettingsService } from '@snap-rail/settings'
import { createUpdateChannel } from './update-machine.ts'

/** The update bridge plugin; consumes the rpc and settings services. */
const updateRpcPlugin: Plugin.Object<void> = {
  name: 'desktop-update-rpc',
  inject: ['rpc', 'settings'],
  apply(ctx: Context): void {
    const rpc: GatewayService = ctx.rpc
    const settings: SettingsService = ctx.settings

    rpc.claimDomain(ctx, 'update')
    rpc.frame(ctx, 'update/status', { payload: updateStatusSchema })

    const channel = createUpdateChannel({
      currentVersion: app.getVersion(),
      load: async () => {
        if (!app.isPackaged) return null
        const { autoUpdater } = (await import('electron-updater')) as typeof import('electron-updater')
        // Check and download automatically; installing stays an explicit
        // operator act — a running terminal must never restart itself.
        autoUpdater.autoDownload = true
        autoUpdater.autoInstallOnAppQuit = false
        return autoUpdater
      },
      hasPackagedFeed: app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml')),
      resolveFeedUrl: () => {
        const url = settings.get<string>(UPDATE_FEED_URL_KEY)
        return typeof url === 'string' && url !== '' ? url : undefined
      },
      autoCheck: settings.get<boolean>(UPDATE_AUTO_CHECK_KEY) !== false,
      broadcast: (status: UpdateStatus) => {
        ctx.rpc.broadcast('update/status', status)
      },
    })

    rpc.method(ctx, 'update.state', { request: updateRequestSchemas['update.state'] }, () => ({
      status: channel.status(),
    }))
    rpc.method(ctx, 'update.check', { request: updateRequestSchemas['update.check'] }, async () => ({
      status: await channel.check(),
    }))
    rpc.method(ctx, 'update.download', { request: updateRequestSchemas['update.download'] }, async () => ({
      status: await channel.download(),
    }))
    rpc.method(ctx, 'update.install', { request: updateRequestSchemas['update.install'] }, () => {
      channel.install()
      return { applied: true } as const
    })
  },
}

export default updateRpcPlugin
