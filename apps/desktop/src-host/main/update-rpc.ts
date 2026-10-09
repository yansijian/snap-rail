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
  updateContract,
  type UpdateStatus,
} from '@snap-rail/app-boot/contract'
import type { GatewayService } from '@snap-rail/gateway'
import type { SettingsService } from '@snap-rail/settings'
import { createUpdateChannel } from './update-machine.ts'

/** The built-in default feed seat; mirrors the packaged publish config. */
const DEFAULT_FEED_URL = 'http://192.168.1.9:3000/snap-rail/snap-rail/raw/branch/feed/desktop/'

/** The update bridge plugin; consumes the rpc and settings services. */
const updateRpcPlugin: Plugin.Object<void> = {
  name: 'desktop-update-rpc',
  inject: ['rpc', 'settings'],
  apply(ctx: Context): void {
    const rpc: GatewayService = ctx.rpc
    const settings: SettingsService = ctx.settings

    rpc.claimDomain(ctx, 'update')

    const channel = createUpdateChannel({
      currentVersion: app.getVersion(),
      load: async () => {
        if (!app.isPackaged) return null
        // electron-updater is CJS: this build's `autoUpdater` named export is
        // not statically detectable on the ESM namespace, so read it off the
        // default export first and fail loud when neither seat carries it.
        const mod = (await import('electron-updater')) as typeof import('electron-updater') & {
          default?: typeof import('electron-updater')
        }
        const autoUpdater = mod.autoUpdater ?? mod.default?.autoUpdater
        if (autoUpdater === undefined) throw new Error('electron-updater 未暴露 autoUpdater')
        // Check and download automatically; installing stays an explicit
        // operator act — a running terminal must never restart itself.
        autoUpdater.autoDownload = true
        autoUpdater.autoInstallOnAppQuit = false
        return autoUpdater
      },
      hasPackagedFeed: app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml')),
      resolveFeedUrl: () => {
        const url = settings.get<string>(UPDATE_FEED_URL_KEY)
        if (typeof url === 'string' && url !== '') return url
        // Directory packs (and deployments whose app-update.yml is absent)
        // still get the documented default seat instead of a dead channel.
        return app.isPackaged && !existsSync(join(process.resourcesPath, 'app-update.yml'))
          ? DEFAULT_FEED_URL
          : undefined
      },
      autoCheck: settings.get<boolean>(UPDATE_AUTO_CHECK_KEY) !== false,
      broadcast: (status: UpdateStatus) => {
        rpc.broadcast('update/status', status)
      },
    })

    rpc.serveContract(ctx, updateContract, {
      'update.state': () => ({ status: channel.status() }),
      'update.check': async () => ({ status: await channel.check() }),
      'update.download': async () => ({ status: await channel.download() }),
      'update.install': () => {
        channel.install()
        return { applied: true } as const
      },
    })
  },
}

export default updateRpcPlugin
