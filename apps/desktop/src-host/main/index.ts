/**
 * The desktop main entry: boot the host plugin tree in the Electron main
 * process, mount the IPC carrier during preparation, then open one frameless
 * window whose renderer is a pure projection client.
 *
 * @module @snap-rail/desktop/main
 */

import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { boot } from '@snap-rail/app-boot'
import type { Context } from '@snap-rail/cordis'
import carrierPlugin from './carrier.ts'

/**
 * Where the read-only built-in layer lives: beside the source tree in dev,
 * flattened into process.resourcesPath when packaged.
 */
function resourcesDir(): string {
  return process.env.SNAP_RAIL_DEV_URL === undefined
    ? process.resourcesPath
    : join(app.getAppPath(), 'resources')
}

async function start(): Promise<void> {
  await app.whenReady()

  const home = app.getPath('userData')
  const ctx: Context = await boot({
    binName: 'desktop',
    home,
    builtinLayerPath: join(resourcesDir(), 'builtins.cordis.yml'),
    userLayerPath: join(home, 'plugins.yml'),
    appRoot: app.getAppPath(),
    prepare: prepared => {
      // Mounts immediately; activates once the gateway mounts in the tree.
      void prepared.plugin(carrierPlugin)
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
