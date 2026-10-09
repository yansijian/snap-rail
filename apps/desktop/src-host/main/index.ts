/**
 * The desktop main entry: boot the host plugin tree in the Electron main
 * process, mount the IPC carrier during preparation, then open one frameless
 * window whose renderer is a pure projection client.
 *
 * @module @snap-rail/desktop/main
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import carrierPlugin from './carrier.ts'
import windowRpcPlugin, { trackMainWindow } from './window-rpc.ts'
import updateRpcPlugin from './update-rpc.ts'
import { handlePluginScheme, registerPluginScheme } from './plugin-protocol.ts'
import { startDesktopHost } from './host.ts'

/**
 * The built-in layer ships inside the app directory (packed with the app in
 * both dev source and installed layouts); `getAppPath()` is the one root
 * that names it in both. The shipped list is **base-only** — everything
 * else installs from zips. Dev runs (`SNAP_RAIL_DEV_URL`, the Vite
 * harness) swap in the base overlay from `dev/` so day-to-day base work
 * runs the same rows production does; installable plugins come from the
 * plugin pool. The overlay file lives outside `resources/` so packaging
 * can never ship it.
 */
function builtinLayerPath(): string {
  const devOverlay = process.env.SNAP_RAIL_DEV_URL !== undefined
    ? join(app.getAppPath(), 'dev', 'builtins.dev.cordis.yml')
    : undefined
  if (devOverlay !== undefined && existsSync(devOverlay)) return devOverlay
  return join(app.getAppPath(), 'resources', 'builtins.cordis.yml')
}

async function start(): Promise<void> {
  // The packed app's `app.getName()` reads the package name, which equals the
  // dev package name — without this move, an installed terminal shares the dev
  // home, and a dev-era `plugins.yml` (rows for pool plugins that will never
  // exist in the installed world) bricks boot before the first window.
  if (app.isPackaged) {
    app.setPath('userData', join(app.getPath('appData'), 'snap-rail'))
  }
  registerPluginScheme()
  await app.whenReady()

  const home = app.getPath('userData')
  // Pool plugin assets reach the renderer over the privileged scheme; the
  // handler binds to the same pool dir the boot composition scans.
  handlePluginScheme(join(home, 'plugins'))
  // Every renderer resident arrives through the pool — dev included (the
  // old dev static-occupant carve-out left with the plugin split; install
  // the zips into the dev home instead). clientOnly packages never join
  // the host tree by their own manifest.
  const host = await startDesktopHost({
    binName: 'desktop',
    home,
    builtinLayerPath: builtinLayerPath(),
    userLayerPath: join(home, 'plugins.yml'),
    appRoot: app.getAppPath(),
    prepare: prepared => {
      // Mounts immediately; activates once the gateway mounts in the tree.
      void prepared.plugin(carrierPlugin)
      void prepared.plugin(windowRpcPlugin)
      void prepared.plugin(updateRpcPlugin)
    },
  })

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
    void host.dispose().finally(() => app.quit())
  })
}

start().catch(cause => {
  const detail = cause instanceof Error ? cause.stack ?? cause.message : String(cause)
  // Boot failures must reach the operator: there is no window yet and a
  // double-clicked terminal has no console, so console.error alone dies
  // unseen. The native box works without any BrowserWindow.
  dialog.showErrorBox('snap-rail 启动失败', `${detail}\n\nhome: ${app.getPath('userData')}`)
  console.error(detail)
  app.exit(1)
})
