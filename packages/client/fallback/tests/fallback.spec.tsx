// @vitest-environment happy-dom
/**
 * The fallback shell's titlebar seam: occupant-contributed
 * `titlebar-actions` buttons (the forge studio's AI 创造 entry) render even
 * with no suite active, beside the built-in settings and window controls —
 * a fresh install keeps its way into the pool-installed tools.
 *
 * @module snap-rail/client-fallback/tests/fallback.spec
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from '@snap-rail/cordis'
import { Context } from '@snap-rail/cordis'
import auditPlugin from '@snap-rail/audit'
import gatewayPlugin from '@snap-rail/gateway'
import settingsPlugin from '@snap-rail/settings'
import stationRpcPlugin from '@snap-rail/station-rpc'
import type { ReactNode } from 'react'
import { bootClient } from '../../kernel/src/index.tsx'
import type { HostChannel } from '../../connection/src/index.tsx'
import { createClientRuntime } from '../../runtime/src/index.tsx'
import fallbackShellPlugin from '../src/index.tsx'
import { afterEach, describe, expect, it } from 'vitest'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
    const home = ctx.get('snapRailHome') as string | undefined
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  }
  document.body.innerHTML = ''
})

/** A station world: gateway + settings + audit + the station bridge. */
async function makeWorld(): Promise<HostChannel> {
  const host = new Context()
  contexts.push(host)
  host.provide('snapRailHome', mkdtempSync(join(tmpdir(), 'snap-rail-fallback-')))
  await host.plugin(gatewayPlugin, { name: 'fallback-shell', version: '0.1.0', bin: 'test' })
  await host.plugin(settingsPlugin)
  await host.plugin(auditPlugin)
  host.provide('pluginLayers', {
    handles: { userLayerPath: join(tmpdir(), 'absent-plugins.yml'), rendererPackages: [] },
  } as never)
  await host.plugin(stationRpcPlugin)
  return {
    invoke: request => host.rpc.handleClientRequest(request),
    openStream: listener => host.rpc.attachDownlink(frame => listener(frame)),
  }
}

/** A stand-in for the forge studio's titlebar button. */
const stubActionPlugin: Plugin.Object<void> = {
  name: 'stub-titlebar-action',
  inject: ['uiSlots'],
  apply(ctx: Context): void {
    ctx.uiSlots.register(ctx, 'titlebar-actions', {
      id: 'stub-ai',
      order: 10,
      render(): ReactNode {
        return <button type="button" aria-label="stub AI">AI</button>
      },
    })
  },
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

describe('the fallback shell titlebar', () => {
  it('renders titlebar-actions occupants beside the built-in controls', async () => {
    const channel = await makeWorld()
    const sent: Array<{ method?: unknown, payload?: unknown }> = []
    const spying: HostChannel = {
      invoke: async request => {
        sent.push({ method: request.method, payload: request.payload })
        return channel.invoke(request)
      },
      openStream: channel.openStream,
    }
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel: spying })
    const runtime = await createClientRuntime(handle, {
      plugins: [fallbackShellPlugin, stubActionPlugin],
    })
    await flush()

    expect(document.querySelector('[data-region="fallback-shell"]')).not.toBeNull()
    const stub = document.querySelector<HTMLButtonElement>('button[aria-label="stub AI"]')
    expect(stub).not.toBeNull()

    // The built-in window controls still fire through the same channel.
    stub!.click()
    document.querySelector<HTMLButtonElement>('button[aria-label="最小化"]')!.click()
    await flush()
    expect(sent.filter(entry => entry.method === 'window.control')).toHaveLength(1)

    await runtime.dispose()
    element.remove()
  }, 20_000)
})
