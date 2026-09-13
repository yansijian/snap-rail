/**
 * The desktop main entry: boot the host plugin tree in the Electron main
 * process, mount the IPC carrier during preparation, then open one frameless
 * window whose renderer is a pure projection client.
 *
 * @module @snap-rail/desktop/main
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { boot } from '@snap-rail/app-boot'
import type { Context } from '@snap-rail/cordis'
import carrierPlugin from './carrier.ts'
import windowRpcPlugin, { trackMainWindow } from './window-rpc.ts'
import { handlePluginScheme, registerPluginScheme } from './plugin-protocol.ts'
import { RENDERER_PACKAGES } from './renderer-packages.ts'

/**
 * The built-in layer ships inside the app directory (packed with the app in
 * both dev source and installed layouts); `getAppPath()` is the one root
 * that names it in both. The shipped list is **base-only** — everything
 * else installs from zips. Dev runs (`SNAP_RAIL_DEV_URL`, the Vite
 * harness) swap in the full overlay from `dev/` so day-to-day work keeps
 * every first-party plugin mounted; the overlay file lives outside
 * `resources/` so packaging can never ship it.
 */
function builtinLayerPath(): string {
  const devOverlay = process.env.SNAP_RAIL_DEV_URL !== undefined
    ? join(app.getAppPath(), 'dev', 'builtins.dev.cordis.yml')
    : undefined
  if (devOverlay !== undefined && existsSync(devOverlay)) return devOverlay
  return join(app.getAppPath(), 'resources', 'builtins.cordis.yml')
}

async function start(): Promise<void> {
  registerPluginScheme()
  await app.whenReady()
  wireUpdateChannel()

  const home = app.getPath('userData')
  // Pool plugin assets reach the renderer over the privileged scheme; the
  // handler binds to the same pool dir the boot composition scans.
  handlePluginScheme(join(home, 'plugins'))
  // The static-occupant carve-out is a dev-harness concern: production
  // ships base only, and every renderer resident arrives through the pool
  // (clientOnly packages never join the host tree by their own manifest).
  const dev = process.env.SNAP_RAIL_DEV_URL !== undefined
  const ctx: Context = await boot({
    binName: 'desktop',
    home,
    builtinLayerPath: builtinLayerPath(),
    userLayerPath: join(home, 'plugins.yml'),
    appRoot: app.getAppPath(),
    rendererPackages: dev ? RENDERER_PACKAGES : [],
    prepare: prepared => {
      // Mounts immediately; activates once the gateway mounts in the tree.
      void prepared.plugin(carrierPlugin)
      void prepared.plugin(windowRpcPlugin)
    },
  })

  // Hot layer reload: hand-edited or Agent-written plugins.yml (and pool or
  // built-in list changes) re-compose and apply transactionally.
  ctx.effect(() => ctx.pluginLayers.startWatch())

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(app.getAppPath(), 'dist/preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  // The un-targeted window controls (the suite titlebar) drive this window.
  trackMainWindow(win)
  win.once('ready-to-show', () => win.show())

  const devUrl = process.env.SNAP_RAIL_DEV_URL
  if (devUrl !== undefined) await win.loadURL(devUrl)
  else await win.loadFile(join(app.getAppPath(), 'dist/client/index.html'))

  app.on('window-all-closed', () => {
    void ctx.fiber.dispose().finally(() => app.quit())
  })
}

start().catch(cause => {
  console.error(cause instanceof Error ? cause.stack ?? cause.message : cause)
  app.exit(1)
})

/**
 * The update channel seat: only a packaged build with a configured publish
 * provider checks; dev and unconfigured installs stay idle. Configure
 * `publish` in electron-builder.yml (e.g. the GitHub provider) to activate.
 */
function wireUpdateChannel(): void {
  if (!app.isPackaged) return
  void (async () => {
    try {
      const { autoUpdater } = (await import('electron-updater')) as typeof import('electron-updater')
      autoUpdater.autoDownload = false
      const available = await autoUpdater.checkForUpdates()
      if (available !== null) {
        console.log(`[updater] ${available.updateInfo.version} available (manual download; auto-install lands with the channel)`)
      }
    } catch (cause) {
      console.log('[updater] channel not configured, staying idle:', cause instanceof Error ? cause.message : cause)
    }
  })()
}
