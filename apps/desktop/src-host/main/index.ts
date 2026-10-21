/**
 * The desktop main entry: boot the host plugin tree in the Electron main
 * process, mount the IPC carrier during preparation, then open the operator
 * window whose renderer is a pure projection client.
 *
 * The window is the app's only *default* surface — the floating ball and its
 * panel are created on demand by the Shell adapter (`./shell`), which also
 * owns the tray icon and OS notifications. Closing the operator window still
 * quits (X = quit, unchanged); hiding it into the tray is an explicit tray
 * action, never a side effect of a close.
 *
 * @module @snap-rail/desktop/main
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import carrierPlugin from './carrier.ts'
import windowRpcPlugin, { currentMainWindow, trackMainWindow } from './window-rpc.ts'
import updateRpcPlugin from './update-rpc.ts'
import shellPlugin from './shell/index.ts'
import { handlePluginScheme, registerPluginScheme } from './plugin-protocol.ts'
import { startDesktopHost, type DesktopHost } from './host.ts'

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

/** The dev server URL, normalized to a directory URL (renderers append paths). */
function devUrl(): string | undefined {
  const url = process.env.SNAP_RAIL_DEV_URL
  if (url === undefined) return undefined
  return url.endsWith('/') ? url : `${url}/`
}

async function start(): Promise<void> {
  // The packed app's `app.getName()` reads the package name, which equals the
  // dev package name — without this move, an installed terminal shares the dev
  // home, and a dev-era `plugins.yml` (rows for pool plugins that will never
  // exist in the installed world) bricks boot before the first window.
  if (app.isPackaged) {
    app.setPath('userData', join(app.getPath('appData'), 'snap-rail'))
  }
  // Windows attributes toasts to this id. Packaged builds use the installer's
  // appId (electron-builder writes it into the Start Menu shortcut — without a
  // matching id the toast never appears); dev builds fall back to the
  // executable, which is what the un-packaged notification area knows.
  app.setAppUserModelId(app.isPackaged ? 'io.snaprail.desktop' : process.execPath)

  // One terminal per home: a second launch must not open a second host over
  // the same plugins.yml and settings.json. The second process hands focus to
  // the first and exits.
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', () => {
    const win = currentMainWindow()
    if (win === undefined || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

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
  let quitting = false
  let host: DesktopHost | undefined
  const quitApplication = (): void => {
    if (quitting) return
    quitting = true
    void (host === undefined ? Promise.resolve() : host.dispose()).finally(() => app.quit())
  }

  host = await startDesktopHost({
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
      // The OS integration seam: notifications, tray, and the auxiliary
      // surfaces. `mainWindow` is read lazily — a plugin may present a
      // surface before the operator window exists.
      void prepared.plugin(shellPlugin, {
        mainWindow: currentMainWindow,
        renderer: {
          preloadPath: join(app.getAppPath(), 'dist/preload/index.cjs'),
          ...devUrl() !== undefined ? { devUrl: devUrl()! } : {},
          clientRoot: join(app.getAppPath(), 'dist/client'),
        },
        trayIconPath: join(app.getAppPath(), 'resources', 'tray.png'),
      })
    },
  })

  // The Shell seam is a first-party capability a plugin can `require`
  // (`service:shell`): if its adapter died during activation, every pool
  // plugin that depends on it degrades with it, and nothing else would say
  // why. A plugin fiber's failure is only as loud as the logger attached to
  // it — which a packaged terminal has none of — so assert it here instead.
  const served = host.ctx.rpc.describe().methods.map(method => method.name)
  const missingShell = ['shell.toast', 'shell.surface.present', 'shell.ball.state']
    .filter(name => !served.includes(name))
  if (missingShell.length > 0) {
    console.error(`snap-rail: Shell 适配器未挂载（缺 ${missingShell.join(', ')}）——通知、托盘与悬浮球不可用`)
  }

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
  // X = quit. Closing the operator window ends the app even while a ball or
  // panel window is still alive — those are satellites, not the app.
  win.once('closed', () => quitApplication())

  const url = devUrl()
  if (url !== undefined) await win.loadURL(url)
  else await win.loadFile(join(app.getAppPath(), 'dist/client/index.html'))

  app.on('window-all-closed', () => quitApplication())
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