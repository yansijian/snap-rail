/**
 * The shell's window-controls bridge: owns the `window` platform domain on
 * the wire. Split from the IPC carrier so the transport never carries
 * business methods — the carrier moves envelopes, this plugin answers them.
 *
 * Mounted by the desktop main process next to the carrier; the main window
 * is the only target (registered here when it opens).
 *
 * @module @snap-rail/desktop/main/window-rpc
 */

import { app, BrowserWindow, dialog } from 'electron'
import { Context, type Plugin } from '@snap-rail/cordis'
import type { GatewayService } from '@snap-rail/gateway'
import { z } from 'zod'

/** The un-targeted window controls drive the main window; the desktop entry
 * registers it here when it opens. Never guess via `getAllWindows()` — its
 * order is not stable once a second window exists. */
let mainWindow: BrowserWindow | null = null

/** Register the main window with the window-controls bridge. */
export function trackMainWindow(win: BrowserWindow): void {
  mainWindow = win
  win.once('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
}

/** The window-controls bridge plugin; consumes the rpc service. */
const windowRpcPlugin: Plugin.Object<void> = {
  name: 'desktop-window-rpc',
  inject: ['rpc', 'pluginLayers'],
  apply(ctx: Context): void {
    const rpc: GatewayService = ctx.rpc

    rpc.claimDomain(ctx, 'window')
    // `close` rides the normal close path so window-all-closed fires.
    rpc.method(
      ctx,
      'window.control',
      {
        request: z.object({
          action: z.enum(['minimize', 'toggle-maximize', 'close']),
        }).strict(),
      },
      ({ action }) => {
        if (mainWindow === null || mainWindow.isDestroyed()) return { applied: false as const }
        if (action === 'minimize') mainWindow.minimize()
        else if (action === 'toggle-maximize') {
          if (mainWindow.isMaximized()) mainWindow.unmaximize()
          else mainWindow.maximize()
        } else mainWindow.close()
        return { applied: true as const }
      },
    )

    // Host-side file picking (native dialogs never open in the renderer);
    // the plugin installer's zip flow is the first consumer.
    rpc.method(
      ctx,
      'window.pick-zip',
      { request: z.object({ title: z.string().default('选择插件包') }).strict() },
      async ({ title: requested }) => {
        const picked = await dialog.showOpenDialog({
          title: requested ?? '选择插件包',
          properties: ['openFile'],
          filters: [{ name: '插件包', extensions: ['zip'] }],
        })
        const path = picked.filePaths[0]
        return path === undefined ? null : path
      },
    )

    // The save-side twin: where generated-plugin exports land.
    rpc.method(
      ctx,
      'window.save-zip',
      {
        request: z.object({
          title: z.string().default('保存插件包'),
          defaultFileName: z.string().min(1).max(255),
        }).strict(),
      },
      async ({ title: requested, defaultFileName }) => {
        const picked = await dialog.showSaveDialog({
          title: requested ?? '保存插件包',
          defaultPath: defaultFileName,
          filters: [{ name: '插件包', extensions: ['zip'] }],
        })
        return picked.canceled || picked.filePath === undefined ? null : picked.filePath
      },
    )

    // The suite-switch "restart now" path: relaunch exits this process and
    // starts a fresh one (renderer rows only take effect at boot).
    rpc.method(
      ctx,
      'window.relaunch',
      { request: z.object({}).strict() },
      () => {
        app.relaunch()
        app.quit()
        return { applied: true as const }
      },
    )
  },
}

export default windowRpcPlugin
