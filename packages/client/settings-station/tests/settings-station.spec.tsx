// @vitest-environment happy-dom
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { afterEach, describe, expect, it, vi } from 'vitest'

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
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

  it('updates an installed package in place and blocks a downgrade in the confirm dialog', async () => {
    const home = mkdtempSync(join(tmpdir(), 'snap-rail-update-ui-'))
    tempDirs.push(home)
    const poolDir = join(home, 'plugins')
    const { zipSync } = await import('fflate')
    const makeMiniZip = (version: string): string => {
      const path = join(home, `mini-ui-${version}.zip`)
      writeFileSync(path, new Uint8Array(zipSync({
        'package.json': new TextEncoder().encode(JSON.stringify({
          name: '@snap-rail/mini-ui', version, type: 'module', main: 'lib/index.js',
        })),
        'lib/index.js': new TextEncoder().encode('export default { name: "mini", apply() {} }\n'),
      })))
      return path
    }

    const host = new Context()
    contexts.push(host)
    host.provide('snapRailHome', home)
    writeFileSync(join(home, 'builtins.cordis.yml'), "- id: timer\n  name: '@snap-rail/cordis-plugin-timer'\n")
    await host.plugin(gatewayPlugin, { name: 'update-test', version: '0.1.0', bin: 'test' })
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
    // The picker hands over whichever zip the test parked last.
    let pickedZip = makeMiniZip('0.1.0')
    host.rpc.claimDomain(host, 'window')
    host.rpc.method(host, 'window.pick-zip', { request: z.object({ title: z.string().optional() }).strict() }, () => pickedZip)

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

    // First install: the plain install dialog, button reads 安装.
    document.querySelector<HTMLButtonElement>('button[data-install-plugin]')!.click()
    await flush()
    expect(document.body.textContent).toContain('安装插件')
    expect(document.querySelector<HTMLButtonElement>('[data-confirm-install]')!.textContent).toBe('安装')
    document.querySelector<HTMLButtonElement>('[data-confirm-install]')!.click()
    await flush(20)
    expect(document.querySelector('[data-plugin-row="@snap-rail/mini-ui"]')).not.toBeNull()

    // Second install of the same package at 0.2.0: the dialog becomes an
    // update — installed and incoming versions side by side, button 更新.
    pickedZip = makeMiniZip('0.2.0')
    document.querySelector<HTMLButtonElement>('button[data-install-plugin]')!.click()
    await flush()
    expect(document.body.textContent).toContain('更新插件')
    expect(document.body.textContent).toContain('已安装版本')
    expect(document.body.textContent).toContain('0.1.0')
    expect(document.body.textContent).toContain('将更新至')
    expect(document.querySelector<HTMLButtonElement>('[data-confirm-install]')!.textContent).toBe('更新')
    document.querySelector<HTMLButtonElement>('[data-confirm-install]')!.click()
    await flush(20)
    // The pool copy is swapped and the row now shows the new version.
    const manifest = JSON.parse(readFileSync(join(poolDir, '@snap-rail__mini-ui', 'package.json'), 'utf8')) as { version: string }
    expect(manifest.version).toBe('0.2.0')
    expect(document.querySelector('[data-plugin-row="@snap-rail/mini-ui"]')!.textContent).toContain('v0.2.0')

    // Re-picking the older zip: the dialog blocks the downgrade outright.
    pickedZip = makeMiniZip('0.1.0')
    document.querySelector<HTMLButtonElement>('button[data-install-plugin]')!.click()
    await flush()
    expect(document.querySelector('[data-install-blocked]')).not.toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[data-confirm-install]')!.disabled).toBe(true)

    await runtime.dispose()
    element.remove()
  }, 30_000)

  it('renders the update page as a live snapshot: check, progress frame, and install', async () => {
    const home = mkdtempSync(join(tmpdir(), 'snap-rail-update-page-'))
    tempDirs.push(home)
    const host = new Context()
    contexts.push(host)
    host.provide('snapRailHome', home)
    writeFileSync(join(home, 'builtins.cordis.yml'), "- id: timer\n  name: '@snap-rail/cordis-plugin-timer'\n")
    await host.plugin(gatewayPlugin, { name: 'update-page-test', version: '0.1.0', bin: 'test' })
    await host.plugin(settingsPlugin)
    await host.plugin(auditPlugin)
    host.provide('pluginLayers', {
      handles: {
        builtinLayerPath: join(home, 'builtins.cordis.yml'),
        userLayerPath: join(home, 'plugins.yml'),
        poolDirs: [],
        rendererPackages: [],
      },
      setUserRow: async (): Promise<void> => {},
      recompose: (): unknown[] => [],
    } as never)
    await host.plugin(stationRpcPlugin)
    await host.plugin(pluginsRpcPlugin)

    // A fake update domain: mutable snapshot, frame broadcasts like the
    // desktop bridge, and an install button that records the call.
    const { updateStatusSchema } = await import('@snap-rail/app-boot/contract')
    let status: Record<string, unknown> = { phase: 'idle', currentVersion: '1.0.0' }
    let installCalled = false
    host.rpc.claimDomain(host, 'update')
    host.rpc.frame(host, 'update/status', { payload: updateStatusSchema })
    host.rpc.method(host, 'update.state', { request: z.object({}).strict() }, () => ({ status }))
    host.rpc.method(host, 'update.check', { request: z.object({}).strict() }, () => {
      status = { phase: 'available', currentVersion: '1.0.0', version: '1.1.0' }
      host.rpc.broadcast('update/status', status)
      return { status }
    })
    host.rpc.method(host, 'update.download', { request: z.object({}).strict() }, () => ({ status }))
    host.rpc.method(host, 'update.install', { request: z.object({}).strict() }, () => {
      installCalled = true
      return { applied: true } as const
    })

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
    document.querySelector<HTMLButtonElement>('[data-settings-page="update"]')!.click()
    await flush()

    // The mount read seeds the snapshot; the check button is the idle action.
    const region = document.querySelector('[data-region="update-page"]')
    expect(region).not.toBeNull()
    expect(document.querySelector('[data-update-status="idle"]')).not.toBeNull()
    expect(document.body.textContent).toContain('1.0.0')

    // 检查更新 → the host broadcast (not just the return value) flips the card.
    document.querySelector<HTMLButtonElement>('[data-update-check]')!.click()
    await flush()
    expect(document.querySelector('[data-update-status="available"]')).not.toBeNull()
    expect(document.body.textContent).toContain('1.1.0')

    // Progress rides the same frame as full snapshots.
    host.rpc.broadcast('update/status', { phase: 'downloading', currentVersion: '1.0.0', version: '1.1.0', percent: 50 })
    await flush()
    expect(document.querySelector('[data-update-status="downloading"]')).not.toBeNull()
    expect(document.querySelector('[data-update-progress="50"]')).not.toBeNull()

    // Ready → the restart-and-install button reaches the update domain.
    host.rpc.broadcast('update/status', { phase: 'ready', currentVersion: '1.0.0', version: '1.1.0' })
    await flush()
    expect(document.querySelector('[data-update-status="ready"]')).not.toBeNull()
    document.querySelector<HTMLButtonElement>('[data-update-install]')!.click()
    await flush()
    expect(installCalled).toBe(true)

    await runtime.dispose()
    element.remove()
  }, 20_000)

  it('browses the market feed and installs a plugin from it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'snap-rail-market-ui-'))
    tempDirs.push(home)
    const poolDir = join(home, 'plugins')
    const { zipSync } = await import('fflate')
    const zipBytes = new Uint8Array(zipSync({
      'package.json': new TextEncoder().encode(JSON.stringify({
        name: '@snap-rail/mini-ui', version: '0.1.0', type: 'module', main: 'lib/index.js',
      })),
      'lib/index.js': new TextEncoder().encode('export default { name: "mini", apply() {} }\n'),
    }))
    const catalog = {
      plugins: [{ name: '@snap-rail/mini-ui', version: '0.1.0', description: 'a market plugin', file: 'mini-ui.zip' }],
    }
    // The feed is an in-memory nginx stand-in.
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const key = String(url)
      if (key === 'http://market.test/plugins/index.json') return new Response(JSON.stringify(catalog))
      if (key === 'http://market.test/plugins/mini-ui.zip') return new Response(zipBytes)
      return new Response('not found', { status: 404 })
    }))

    const host = new Context()
    contexts.push(host)
    host.provide('snapRailHome', home)
    writeFileSync(join(home, 'builtins.cordis.yml'), "- id: timer\n  name: '@snap-rail/cordis-plugin-timer'\n")
    await host.plugin(gatewayPlugin, { name: 'market-test', version: '0.1.0', bin: 'test' })
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
    host.settings.set('plugins.feedUrl', 'http://market.test/plugins/')

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
    document.querySelector<HTMLButtonElement>('[data-settings-page="market"]')!.click()
    await flush()

    // The catalog row renders with its description and the install verdict.
    const row = document.querySelector('[data-market-row="@snap-rail/mini-ui"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('a market plugin')
    expect(row!.textContent).toContain('v0.1.0')
    expect(document.querySelector('[data-market-action="install"]')).not.toBeNull()

    // 安装 rides the market pipeline: the pool copy lands and the row flips
    // to 已是最新 with no install button left.
    document.querySelector<HTMLButtonElement>('[data-market-install="@snap-rail/mini-ui"]')!.click()
    await flush(20)
    expect(existsSync(join(poolDir, '@snap-rail__mini-ui'))).toBe(true)
    expect(document.querySelector('[data-market-action="current"]')).not.toBeNull()
    expect(document.querySelector('[data-market-install="@snap-rail/mini-ui"]')).toBeNull()
    expect(document.body.textContent).not.toContain('变更待重启生效')

    await runtime.dispose()
    element.remove()
  }, 20_000)
})
