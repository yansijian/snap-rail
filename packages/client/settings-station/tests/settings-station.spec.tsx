// @vitest-environment happy-dom
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import { z } from 'zod'
import auditPlugin from '@snap-rail/audit'
import gatewayPlugin from '@snap-rail/gateway'
import settingsPlugin from '@snap-rail/settings'
import stationRpcPlugin from '@snap-rail/station-rpc'
import pluginsRpcPlugin from '@snap-rail/app-boot/rpc'
import settingsStationPlugin from '../src/index.tsx'
import layoutPlugin from '../../../suites/terminal-ops/src/layout.tsx'
import titlebarPlugin from '../../../suites/terminal-ops/src/chrome.tsx'
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
    "- id: driver-modbus",
    "  name: '@snap-rail/driver-modbus'",
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
      // The modbus package's renderer face: its row groups with the host
      // entry's row under one master toggle.
      rendererPackages: ['@snap-rail/driver-modbus/station'],
    },
    setUserRow: async (): Promise<void> => {
      // Succeed without touching a disk; the UI asserts on the rpc call only.
    },
    recompose: (): unknown[] => [],
  } as never)
  await host.plugin(stationRpcPlugin)
  await host.plugin(pluginsRpcPlugin)
  return {
    invoke: request => host.rpc.handleClientRequest(request),
    openStream: listener => host.rpc.attachDownlink(frame => listener(frame)),
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
    expect(calls).toContain('plugins.set-enabled')

    document.querySelector<HTMLButtonElement>('button[aria-label="关闭设置"]')!.click()
    await flush()
    expect(document.querySelector('[data-region="settings-dialog"]')).toBeNull()

    await runtime.dispose()
    element.remove()
  }, 20_000)

  it('groups one package\'s rows under a master toggle that flips both', async () => {
    const calls: Array<{ method: string, name?: string }> = []
    const channel = await makeWorld()
    const spyingChannel: HostChannel = {
      invoke: async request => {
        if (request.method === 'plugins.set-enabled') {
          calls.push({ method: request.method, name: (request.payload as { name: string }).name })
        }
        return channel.invoke(request)
      },
      openStream: channel.openStream,
    }
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel: spyingChannel })
    const runtime = await createClientRuntime(handle, { plugins: OCCUPANTS })
    await flush()

    document.querySelector<HTMLButtonElement>('button[aria-label="设置"]')!.click()
    await flush()

    // Single-row packages stay flat; the modbus package renders as one card.
    expect(document.querySelector('[data-plugin-row="@snap-rail/driver-mock"]')).not.toBeNull()
    const card = document.querySelector('[data-plugin-group="@snap-rail/driver-modbus"]')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('2 个条目')

    // Members expand for individual control.
    card!.querySelector<HTMLButtonElement>('button:not([role="switch"])')!.click()
    await flush()
    expect(card!.querySelector('[data-plugin-row="@snap-rail/driver-modbus"]')).not.toBeNull()
    expect(card!.querySelector('[data-plugin-row="@snap-rail/driver-modbus/station"]')).not.toBeNull()

    // The master switch flips every member with one rpc call per row.
    const master = card!.querySelector<HTMLButtonElement>('button[role="switch"]')!
    expect(master.getAttribute('data-state')).toBe('checked')
    master.click()
    await flush()
    expect(calls.map(call => call.name)).toEqual([
      '@snap-rail/driver-modbus',
      '@snap-rail/driver-modbus/station',
    ])

    await runtime.dispose()
    element.remove()
  }, 20_000)

  it('installs into the pool disabled with an uninstall entry, and uninstalling prompts for restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'snap-rail-install-ui-'))
    tempDirs.push(home)
    const poolDir = join(home, 'plugins')
    // A minimal but honest zip: manifest declaring a renderer face plus the
    // host face entry the installer validates.
    const { zipSync } = await import('fflate')
    const zipPath = join(home, 'mini.zip')
    const zip = new Uint8Array(zipSync({
      'package.json': new TextEncoder().encode(JSON.stringify({
        name: '@snap-rail/mini-ui', version: '0.1.0', type: 'module',
        main: 'lib/index.js',
        snapRail: { client: { entry: 'lib-client/client.js' } },
      })),
      'lib/index.js': new TextEncoder().encode('export default { name: "mini", apply() {} }\n'),
      'lib-client/client.js': new TextEncoder().encode('/* bundle */\n'),
    }))
    writeFileSync(zipPath, zip)

    const host = new Context()
    contexts.push(host)
    host.provide('snapRailHome', home)
    writeFileSync(join(home, 'builtins.cordis.yml'), "- id: timer\n  name: '@snap-rail/cordis-plugin-timer'\n")
    await host.plugin(gatewayPlugin, { name: 'install-test', version: '0.1.0', bin: 'test' })
    await host.plugin(settingsPlugin)
    await host.plugin(auditPlugin)
    host.provide('pluginLayers', {
      handles: {
        builtinLayerPath: join(home, 'builtins.cordis.yml'),
        userLayerPath: join(home, 'plugins.yml'),
        poolDirs: [poolDir],
        rendererPackages: [],
      },
      setUserRow: async (): Promise<void> => {},
      removeUserRow: async (): Promise<void> => {},
      apply: async (): Promise<void> => {},
      recompose: (): unknown[] => [],
    } as never)
    await host.plugin(stationRpcPlugin)
    await host.plugin(pluginsRpcPlugin)
    // The native zip picker is an Electron window control; stand in for it.
    host.rpc.claimDomain(host, 'window')
    host.rpc.method(host, 'window.pick-zip', { request: z.object({ title: z.string().optional() }).strict() }, () => zipPath)

    const channel: HostChannel = {
      invoke: request => host.rpc.handleClientRequest(request),
      openStream: listener => host.rpc.attachDownlink(frame => listener(frame)),
    }
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    const runtime = await createClientRuntime(handle, { plugins: OCCUPANTS })
    await flush()

    document.querySelector<HTMLButtonElement>('button[aria-label="设置"]')!.click()
    await flush()
    document.querySelector<HTMLButtonElement>('button[data-install-plugin]')!.click()
    await flush()

    // The inspection lands on the confirm dialog naming the renderer face.
    const confirm = document.querySelector<HTMLButtonElement>('[data-confirm-install]')
    expect(confirm).not.toBeNull()
    expect(document.body.textContent).toContain('含页面')
    confirm!.click()
    await flush(20)

    // Installing is not enabling: no restart prompt, and the new row lists
    // as a disabled pool package whose single row carries the uninstall
    // affordance.
    expect(document.body.textContent).not.toContain('变更待重启生效')
    const row = document.querySelector('[data-plugin-row="@snap-rail/mini-ui"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('插件池')
    expect(row!.querySelector<HTMLButtonElement>('button[role="switch"]')!.getAttribute('data-state')).toBe('unchecked')
    expect(document.querySelector('[data-uninstall-plugin="@snap-rail/mini-ui"]')).not.toBeNull()

    // Uninstalling asks first, then goes through the wire, removes the pool
    // package, drops the row, and prompts for the restart that clears the
    // already-mounted face.
    document.querySelector<HTMLButtonElement>('[data-uninstall-plugin="@snap-rail/mini-ui"]')!.click()
    await flush()
    expect(document.body.textContent).toContain('卸载插件')
    document.querySelector<HTMLButtonElement>('[data-confirm-uninstall]')!.click()
    await flush(20)
    expect(existsSync(join(poolDir, '@snap-rail__mini-ui'))).toBe(false)
    expect(document.querySelector('[data-plugin-row="@snap-rail/mini-ui"]')).toBeNull()
    expect(document.body.textContent).toContain('变更待重启生效')

    await runtime.dispose()
    element.remove()
  }, 20_000)
})
