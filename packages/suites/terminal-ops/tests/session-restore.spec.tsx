// @vitest-environment happy-dom
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import auditPlugin from '@snap-rail/audit'
import gatewayPlugin from '@snap-rail/gateway'
import settingsPlugin from '@snap-rail/settings'
import stationRpcPlugin from '@snap-rail/station-rpc'
import { SESSION_OPERATOR_KEY } from '@snap-rail/station-rpc/contract'
import type { ClientRequest, HostChannel } from '@snap-rail/connection'
import { bootClient } from '@snap-rail/client-kernel'
import { createClientRuntime } from '@snap-rail/client-runtime'
import layoutPlugin from '../src/layout.tsx'
import { afterEach, describe, expect, it } from 'vitest'

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  document.body.innerHTML = ''
})

/**
 * A minimal login world: the station bridge (session persists through the
 * settings service) over an in-process channel. The channel holds every
 * `session.current` answer behind a gate so the test can observe the UI
 * while the boot restore probe is still in flight — the window where the
 * login keypad used to flash before a restart's operator landed.
 */
async function makeWorld(persisted: string | null): Promise<{ channel: HostChannel, release: () => void }> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-session-restore-'))
  tempDirs.push(home)
  const host = new Context()
  contexts.push(host)
  host.provide('snapRailHome', home)
  await host.plugin(gatewayPlugin, { name: 'station-shell', version: '0.1.0', bin: 'test' })
  await host.plugin(settingsPlugin)
  await host.plugin(auditPlugin)
  host.provide('pluginLayers', {
    handles: { userLayerPath: join(tmpdir(), 'absent-plugins.yml'), rendererPackages: [] },
  } as never)
  await host.plugin(stationRpcPlugin)
  if (persisted !== null) host.settings.set(SESSION_OPERATOR_KEY, persisted)

  // Held shut until `release()`; only the restore probe waits on it.
  let open = (): void => {}
  const gate = new Promise<void>(resolve => { open = resolve })
  const channel: HostChannel = {
    invoke: async (request: ClientRequest) => {
      if (request.method === 'session.current') await gate
      return host.rpc.handleClientRequest(request)
    },
    openStream: listener => host.rpc.attachDownlink(frame => listener(frame)),
  }
  return { channel, release: open }
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

describe('boot session restore', () => {
  it('holds a blank body while restoring and lands straight on the main view', async () => {
    const { channel, release } = await makeWorld('1001')
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    const runtime = await createClientRuntime(handle, { plugins: [layoutPlugin] })
    await flush()

    // Probe still in flight: no login card, no keypad, no workflow view.
    expect(runtime.ctx.session.restored()).toBe(false)
    expect(document.querySelector('[data-region="session-restoring"]')).not.toBeNull()
    expect(document.querySelector('[data-cell="operator-id"]')).toBeNull()
    expect(document.querySelector('button[data-key]')).toBeNull()

    let restoredTicks = 0
    runtime.ctx.on('session/restored', () => { restoredTicks += 1 })
    release()
    await flush(20)

    // The persisted operator restored straight into the work view; the
    // login surface never rendered.
    expect(restoredTicks).toBe(1)
    expect(runtime.ctx.session.restored()).toBe(true)
    expect(runtime.ctx.session.current()).toBe('1001')
    expect(document.querySelector('[data-region="workflow-list"]')).not.toBeNull()
    expect(document.querySelector('[data-region="session-restoring"]')).toBeNull()
    expect(document.querySelector('[data-cell="operator-id"]')).toBeNull()

    await runtime.dispose()
    element.remove()
  }, 15_000)

  it('shows the login page only after the restore settles with no operator', async () => {
    const { channel, release } = await makeWorld(null)
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    const runtime = await createClientRuntime(handle, { plugins: [layoutPlugin] })
    await flush()

    // Same hold while restoring — the keypad waits for the probe even when
    // the answer will be "nobody signed on".
    expect(runtime.ctx.session.restored()).toBe(false)
    expect(document.querySelector('[data-region="session-restoring"]')).not.toBeNull()
    expect(document.querySelector('[data-cell="operator-id"]')).toBeNull()

    release()
    await flush(20)

    expect(runtime.ctx.session.restored()).toBe(true)
    expect(runtime.ctx.session.current()).toBeNull()
    expect(document.querySelector('[data-cell="operator-id"]')).not.toBeNull()
    expect(document.querySelector('[data-region="session-restoring"]')).toBeNull()

    await runtime.dispose()
    element.remove()
  }, 15_000)
})
