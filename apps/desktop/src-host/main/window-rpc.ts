/**
 * The shell's window-controls bridge: owns the `window` platform domain on
 * the wire. Split from the IPC carrier so the transport never carries
 * business methods — the carrier moves envelopes, this plugin answers them.
 *
 * Mounted by the desktop main process next to the carrier. The main window
 * stays the default target; the AI 创造 studio window (opened via
 * `window.open-forge`, one per app) is addressed explicitly with
 * `target: 'forge'` so its own titlebar drives its own window.
 *
 * @module @snap-rail/desktop/main/window-rpc
 */

import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { Context, type Plugin } from '@snap-rail/cordis'
import type { GatewayService } from '@snap-rail/gateway'
import { z } from 'zod'

/** The window-controls bridge plugin; consumes the rpc service. */
const windowRpcPlugin: Plugin.Object<void> = {
  name: 'desktop-window-rpc',
  inject: ['rpc'],
  apply(ctx: Context): void {
    const rpc: GatewayService = ctx.rpc

    // The studio window singleton: reopening focuses instead of stacking.
    let forgeWin: BrowserWindow | null = null

    const openForgeWindow = async (): Promise<void> => {
      if (forgeWin !== null && !forgeWin.isDestroyed()) {
        forgeWin.focus()
        return
      }
      const win = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 880,
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
      forgeWin = win
      win.once('ready-to-show', () => win.show())
      win.once('closed', () => {
        if (forgeWin === win) forgeWin = null
      })
      // Same renderer entry as the main window, branched by the query —
      // the studio window mounts only the forge face (see src/client/main.tsx).
      const devUrl = process.env.SNAP_RAIL_DEV_URL
      if (devUrl !== undefined) await win.loadURL(new URL('?window=forge', devUrl).toString())
      else await win.loadFile(join(app.getAppPath(), 'dist/client/index.html'), { query: { window: 'forge' } })
    }

    rpc.claimDomain(ctx, 'window')
    // `close` rides the normal close path so window-all-closed fires.
    rpc.method(
      ctx,
      'window.control',
      {
        request: z.object({
          action: z.enum(['minimize', 'toggle-maximize', 'close']),
          target: z.literal('forge').optional(),
        }).strict(),
      },
      ({ action, target }) => {
        const win = target === 'forge' && forgeWin !== null
          ? forgeWin
          : BrowserWindow.getAllWindows()[0]
        if (win === undefined) return { applied: false as const }
        if (action === 'minimize') win.minimize()
        else if (action === 'toggle-maximize') {
          if (win.isMaximized()) win.unmaximize()
          else win.maximize()
        } else win.close()
        return { applied: true as const }
      },
    )

    // The AI 创造 studio entry point (the titlebar button's click).
    rpc.method(
      ctx,
      'window.open-forge',
      { request: z.object({}).strict() },
      async () => {
        await openForgeWindow()
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
