// @vitest-environment happy-dom
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { sectionOf } from '../src/plugins-page.tsx'
import layoutPlugin from '../../../suite/terminal-ops/src/layout.tsx'
import titlebarPlugin from '../../../suite/terminal-ops/src/chrome.tsx'
import { bootClient } from '../../../base/kernel/src/index.tsx'
import type { HostChannel } from '../../connection/src/index.tsx'
import { createClientRuntime } from '../../framework-shadcn/src/runtime.tsx'
import { afterEach, describe, expect, it, vi } from 'vitest'

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  document.body.innerHTML = ''
})

/**
 * A station world whose builtin layer and user layer are temp files, so the
 * plugin management page has something real to list and toggle. The
 * toggleable plugin lives in the home's pool (a release-style package with
 * a `./station` subpath voice) — shipped rows are read-only now. The layer
 * admin is a recording stub: writes succeed without touching disks.
 */
async function makeWorld(): Promise<HostChannel> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-settings-ui-'))
  tempDirs.push(home)
  const builtinPath = join(home, 'builtins.cordis.yml')
  writeFileSync(builtinPath, "- id: timer\n  name: '@snap-rail/cordis-plugin-timer'\n")
  // A pool package with two entry rows: the main host face and a `./station`
  // subpath the exports map voices — the management page groups both under
  // one master toggle.
  const poolDir = join(home, 'plugins')
  const modbusDir = join(poolDir, '@snap-rail__driver-modbus')
  mkdirSync(join(modbusDir, 'lib'), { recursive: true })
  writeFileSync(join(modbusDir, 'package.json'), JSON.stringify({
    name: '@snap-rail/driver-modbus',
    version: '0.1.0',
    type: 'module',
    main: 'lib/index.js',
    exports: { '.': './lib/index.js', './bridge': './lib/bridge.js' },
    snapRail: { kind: 'driver', title: 'ModbusTCP 驱动', category: '驱动' },
  }))
  writeFileSync(join(modbusDir, 'lib', 'index.js'), 'export default { name: "driver-modbus", apply() {} }\n')
  writeFileSync(join(modbusDir, 'lib', 'bridge.js'), 'export default { name: "modbus-bridge", apply() {} }\n')
  writeFileSync(join(home, 'plugins.yml'), [
    'plugins:',
    "  - name: '@snap-rail/driver-modbus'",
    "  - name: '@snap-rail/driver-modbus/bridge'",
    '',
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
      presetDirs: [],
      poolDirs: [poolDir],
      rendererPackages: [],
    },
    setUserRow: async (): Promise<void> => {
      // Succeed without touching a disk; the UI asserts on the rpc call only.
    },
    recompose: (): unknown[] => [
      { id: 'timer', name: '@snap-rail/cordis-plugin-timer' },
      { id: '@snap-rail/driver-modbus', name: '@snap-rail/driver-modbus' },
      { id: '@snap-rail/driver-modbus/bridge', name: '@snap-rail/driver-modbus/bridge' },
    ],
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
    // The first-party page sorts first and is active; the modbus rows file
    // flat under their own category section.
    const pluginsItem = document.querySelector('[data-settings-page="plugins"]')
    expect(pluginsItem?.getAttribute('aria-current')).toBe('true')
    expect(document.querySelector('[data-active-page="plugins"]')).not.toBeNull()
    expect(document.querySelector('[data-plugins-section="驱动"]')).not.toBeNull()
    const row = document.querySelector('[data-plugin-row="@snap-rail/driver-modbus"]')
    expect(row).not.toBeNull()
    // Rows carry no source badge — the section marker is the only signal.
    expect(row!.textContent).not.toContain('插件池')
    expect(row!.textContent).not.toContain('内置')

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

  it('files every entry flat under its category — no package group cards', async () => {
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

    // The builtin timer pins into the 内置 section; the modbus package and
    // its subpath row each render as their own flat row under 驱动 — no
    // group card, no master toggle, nothing to expand first.
    expect(document.querySelector('[data-plugins-section="内置"] [data-plugin-row="@snap-rail/cordis-plugin-timer"]')).not.toBeNull()
    const main = document.querySelector('[data-plugins-section="驱动"] [data-plugin-row="@snap-rail/driver-modbus"]')
    expect(main).not.toBeNull()
    const bridge = document.querySelector('[data-plugins-section="驱动"] [data-plugin-row="@snap-rail/driver-modbus/bridge"]')
    expect(bridge).not.toBeNull()
    expect(document.querySelector('[data-plugin-group]')).toBeNull()
    // Two-line identity: the author's title leads, the package name rides
    // beneath as the secondary mono line.
    expect(main!.textContent).toContain('ModbusTCP 驱动')
    expect(main!.textContent).toContain('@snap-rail/driver-modbus')

    // Each row owns its switch; one row's flip is exactly one wire call.
    const mainSwitch = main!.querySelector<HTMLButtonElement>('button[role="switch"]')!
    expect(mainSwitch.getAttribute('data-state')).toBe('checked')
    mainSwitch.click()
    await flush()
    expect(calls.map(call => call.name)).toEqual(['@snap-rail/driver-modbus'])

    await runtime.dispose()
    element.remove()
  }, 20_000)

  it('collapses one section from its header and all sections at once', async () => {
    const channel = await makeWorld()
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    const runtime = await createClientRuntime(handle, { plugins: OCCUPANTS })
    await flush()

    document.querySelector<HTMLButtonElement>('button[aria-label="设置"]')!.click()
    await flush()

    // Everything starts expanded.
    expect(document.querySelector('[data-plugins-section="驱动"] [data-plugin-row="@snap-rail/driver-modbus"]')).not.toBeNull()

    // One section's header collapses just that section.
    document.querySelector<HTMLButtonElement>('[data-section-toggle="驱动"]')!.click()
    await flush()
    expect(document.querySelector('[data-plugins-section="驱动"] [data-plugin-row="@snap-rail/driver-modbus"]')).toBeNull()
    expect(document.querySelector('[data-plugins-section="内置"] [data-plugin-row="@snap-rail/cordis-plugin-timer"]')).not.toBeNull()

    // 全部折叠 empties every section; the button flips to 全部展开.
    document.querySelector<HTMLButtonElement>('[data-collapse-all]')!.click()
    await flush()
    expect(document.querySelector('[data-plugins-section="内置"] [data-plugin-row="@snap-rail/cordis-plugin-timer"]')).toBeNull()
    const expand = document.querySelector<HTMLButtonElement>('[data-collapse-all]')!
    expect(expand.textContent).toContain('全部展开')
    expand.click()
    await flush()
    expect(document.querySelector('[data-plugins-section="驱动"] [data-plugin-row="@snap-rail/driver-modbus"]')).not.toBeNull()
    expect(document.querySelector('[data-plugins-section="内置"] [data-plugin-row="@snap-rail/cordis-plugin-timer"]')).not.toBeNull()

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
        presetDirs: [],
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
    // Uncategorized pool package: the 其他 section, and no source badge.
    expect(document.querySelector('[data-plugins-section="其他"] [data-plugin-row="@snap-rail/mini-ui"]')).not.toBeNull()
    expect(row!.textContent).not.toContain('插件池')
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
        presetDirs: [],
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
        presetDirs: [],
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
        presetDirs: [],
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

describe('sectionOf', () => {
  const row = (source: 'builtin' | 'preset' | 'user' | 'pool', category?: string): Parameters<typeof sectionOf>[0] =>
    ({ source, category }) as Parameters<typeof sectionOf>[0]

  it('groups by the author marker whatever the source; the undeclared shipped set pins into 内置', () => {
    // Dev's overlay mounts installable packages as protected builtin rows —
    // they keep their author categories, switches stay disabled elsewhere.
    expect(sectionOf(row('builtin', '驱动'))).toBe('驱动')
    expect(sectionOf(row('user', '套件'))).toBe('套件')
    // The shipped base set declares no category and pins into 内置.
    expect(sectionOf(row('builtin'))).toBe('内置')
    expect(sectionOf(row('user'))).toBe('内置')
    // Installed or preset-carried rows without a marker fall into 其他.
    expect(sectionOf(row('pool'))).toBe('其他')
    expect(sectionOf(row('preset'))).toBe('其他')
  })
})
