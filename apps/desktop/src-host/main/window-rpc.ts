/**
 * The shell's window-controls bridge: owns the `window` platform domain on
 * the wire. Split from the IPC carrier so the transport never carries
 * business methods — the carrier moves envelopes, this plugin answers them.
 *
 * Mounted by the desktop main process next to the carrier; single-window
 * shell by design (phase 1), so controls act on the main window whichever
 * frame asked.
 *
 * @module @snap-rail/desktop/main/window-rpc
 */

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

    rpc.claimDomain(ctx, 'window')
    // `close` rides the normal close path so window-all-closed fires.
    rpc.method(
      ctx,
      'window.control',
      { request: z.object({ action: z.enum(['minimize', 'toggle-maximize', 'close']) }).strict() },
      ({ action }) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win === undefined) return { applied: false as const }
        if (action === 'minimize') win.minimize()
        else if (action === 'toggle-maximize') {
          if (win.isMaximized()) win.unmaximize()
          else win.maximize()
        } else win.close()
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
