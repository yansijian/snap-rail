/**
 * The IPC carrier plugin: bridges the four-quadrant gateway into Electron.
 * Uplink rides one well-known invoke channel; downlink ride a dedicated
 * `MessageChannelMain` port acquired through another well-known channel.
 * The renderer preload sees exactly these two primitives and nothing else.
 *
 * Mounted by the desktop main process during boot preparation; activates
 * when the gateway service appears in the tree.
 *
 * @module @snap-rail/desktop/main/carrier
 */

import { ipcMain, MessageChannelMain, type MessagePortMain, type WebContents } from 'electron'
import { Context, type Plugin } from '@snap-rail/cordis'
import type { GatewayService } from '@snap-rail/gateway'

/** Uplink channel: full-form ClientRequest in, full-form ServerResponse out. */
export const INVOKE_CHANNEL = 'snap-rail:invoke'
/** Downlink acquisition signal from the preload. */
export const OPEN_STREAM_CHANNEL = 'snap-rail:open-stream'
/** Port reply channel carrying the fresh MessagePortMain. */
export const STREAM_REPLY_CHANNEL = 'snap-rail:stream-reply'
/** Downlink release signal: after the last local subscriber unsubscribes. */
export const CLOSE_STREAM_CHANNEL = 'snap-rail:close-stream'

/** The carrier plugin; consumes the gateway service. */
const carrierPlugin: Plugin.Object<void> = {
  name: 'desktop-carrier',
  inject: ['gateway'],
  apply(ctx: Context): void {
    const gateway: GatewayService = ctx.gateway
    const streams = new Map<WebContents, MessagePortMain>()

    ipcMain.handle(INVOKE_CHANNEL, (_event, request: unknown) => gateway.handleClientRequest(request))

    ipcMain.on(OPEN_STREAM_CHANNEL, event => {
      if (streams.has(event.sender)) return
      const { port1, port2 } = new MessageChannelMain()
      const detach = gateway.attachDownlink(frame => port1.postMessage(frame))
      streams.set(event.sender, port1)
      // The preload releases its last subscription; teardown detaches the pump.
      port1.once('close', () => {
        detach()
        streams.delete(event.sender)
      })
      event.sender.postMessage(STREAM_REPLY_CHANNEL, null, [port2])
    })

    ipcMain.on(CLOSE_STREAM_CHANNEL, event => {
      streams.get(event.sender)?.close()
    })

    ctx.effect(() => () => {
      ipcMain.removeHandler(INVOKE_CHANNEL)
      for (const [, port] of streams) port.close()
      streams.clear()
    })
  },
}

export default carrierPlugin
