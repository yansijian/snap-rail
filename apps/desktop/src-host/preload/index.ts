/**
 * The preload: exposes exactly two carrier primitives on `window.snapRail`.
 * One global downlink port serves every subscriber through local
 * demultiplexing; the acquisition and release signals follow the refcount so
 * the host pump detaches once the last subscription ends.
 *
 * @module @snap-rail/desktop/preload
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

const listeners = new Set<(frame: unknown) => void>()
let streamPort: MessagePort | null = null
let refCount = 0

let acquiring: Promise<void> = Promise.resolve()

function acquire(): void {
  refCount += 1
  if (refCount > 1) return
  acquiring = new Promise<void>(resolve => {
    const onReply = (event: IpcRendererEvent): void => {
      ipcRenderer.removeListener('snap-rail:stream-reply', onReply)
      const [port] = event.ports
      if (port === undefined) return
      streamPort = port
      port.addEventListener('message', e => {
        for (const listener of listeners) listener((e as MessageEvent).data)
      })
      // addEventListener does not implicitly start the port (only the
      // onmessage setter does); without this no frame ever arrives.
      port.start()
      resolve()
    }
    ipcRenderer.on('snap-rail:stream-reply', onReply)
    ipcRenderer.send('snap-rail:open-stream')
  })
}

function release(): void {
  refCount -= 1
  if (refCount > 0) return
  void acquiring.then(() => {
    // Between the counter hitting zero and this run, an acquire may have
    // started again; only close when still idle.
    if (refCount > 0 || streamPort === null) return
    ipcRenderer.send('snap-rail:close-stream')
    streamPort.close()
    streamPort = null
  })
}

contextBridge.exposeInMainWorld('snapRail', {
  invoke: async (request: unknown): Promise<unknown> => ipcRenderer.invoke('snap-rail:invoke', request),
  openStream: (listener: (frame: unknown) => void) => {
    listeners.add(listener)
    acquire()
    let active = true
    return () => {
      if (!active) return
      active = false
      listeners.delete(listener)
      release()
    }
  },
})
