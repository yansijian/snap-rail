// @vitest-environment happy-dom
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import auditPlugin from '@snap-rail/audit'
import gatewayPlugin from '@snap-rail/gateway'
import settingsPlugin from '@snap-rail/settings'
import stationRpcPlugin from '@snap-rail/station-rpc'
import pluginsRpcPlugin from '@snap-rail/app-boot/rpc'
import settingsStationPlugin from '../src/index.tsx'
import layoutPlugin from '../../layout-station/src/index.tsx'
import titlebarPlugin from '../../chrome-titlebar/src/index.tsx'
import { bootClient } from '../../kernel/src/index.tsx'
import type { HostChannel } from '../../connection/src/index.tsx'
import { createClientRuntime } from '../../runtime/src/index.tsx'
import { afterEach, describe, expect, it } from 'vitest'

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  document.body.innerHTML = ''
})

/**
 * A station world whose builtin layer and user layer are temp files, so the
 * plugin management page has something real to list and toggle. The layer
 * admin is a recording stub: `setUserRow` succeeds without touching disks.
 */
async function makeWorld(): Promise<HostChannel> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-settings-ui-'))
  tempDirs.push(home)
  const builtinPath = join(home, 'builtins.cordis.yml')
  writeFileSync(builtinPath, [
    "- id: timer",
    "  name: '@snap-rail/cordis-plugin-timer'",
    "- id: mock-demo",
    "  name: '@snap-rail/driver-mock'",
    "  config:",
    "    periodMs: 500",
    "",
  ].join('\n'))
  const host = new Context()
  contexts.push(host)
  host.provide('snapRailHome', home)
  await host.plugin(gatewayPlugin, { name: 'station-shell', version: '0.1.0', bin: 'test' })
  await host.plugin(settingsPlugin)
  await host.plugin(auditPlugin)
  host.provide('pluginLayers', {
    handles: {
      builtinLayerPath: builtinPath,
      userLayerPath: join(home, 'plugins.yml'),
      poolDirs: [],
      rendererPackages: [],
    },
    setUserRow: async (): Promise<void> => {
      // Succeed without touching a disk; the UI asserts on the rpc call only.
    },
    recompose: (): unknown[] => [],
  } as never)
  await host.plugin(stationRpcPlugin)
  await host.plugin(pluginsRpcPlugin)
  return {
    invoke: request => host.gateway.handleClientRequest(request),
    openStream: listener => host.gateway.attachDownlink(frame => listener(frame)),
  }
}

const OCCUPANTS = [layoutPlugin, titlebarPlugin, settingsStationPlugin]

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

describe('settings dialog', () => {
  it('opens from the titlebar gear, lists plugins, and toggles one', async () => {
    const calls: string[] = []
    const channel = await makeWorld()
    const spyingChannel: HostChannel = {
      invoke: async request => {
        calls.push(request.method)
        return channel.invoke(request)
      },
      openStream: channel.openStream,
    }
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel: spyingChannel })
    const runtime = await createClientRuntime(handle, { plugins: OCCUPANTS })
    await flush()

    // Closed by default; the gear button is next to the window controls.
    expect(document.querySelector('[data-region="settings-dialog"]')).toBeNull()
    document.querySelector<HTMLButtonElement>('button[aria-label="设置"]')!.click()
    await flush()

    const dialog = document.querySelector('[data-region="settings-dialog"]')
    expect(dialog).not.toBeNull()
    // The first-party page sorts first and is active; the demo driver row shows.
    const pluginsItem = document.querySelector('[data-settings-page="plugins"]')
    expect(pluginsItem?.getAttribute('aria-current')).toBe('true')
    expect(document.querySelector('[data-active-page="plugins"]')).not.toBeNull()
    const row = document.querySelector('[data-plugin-row="@snap-rail/driver-mock"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('内置')

    // Toggling reaches the host bridge.
    const enable = row!.querySelector<HTMLButtonElement>('button[role="switch"]')!
    expect(enable.getAttribute('data-state')).toBe('checked')
    enable.click()
    await flush()
    expect(calls).toContain('plugins.setEnabled')

    document.querySelector<HTMLButtonElement>('button[aria-label="关闭设置"]')!.click()
    await flush()
    expect(document.querySelector('[data-region="settings-dialog"]')).toBeNull()

    await runtime.dispose()
    element.remove()
  }, 20_000)
})
