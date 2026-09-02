// @vitest-environment happy-dom
/**
 * The renderer-face install chain, end to end over the real client bundle:
 * the pool-shaped flow main.tsx runs — module loader installed, seeds
 * loaded, the shipped `lib-client/client.js` executed through the loader
 * global, the plugin object required back, mounted in a client runtime
 * alongside a business suite — and the AI 创造 workflow entry shows up in
 * the rail after sign-on. Regression gate for "installed but no entry":
 * pool client faces only mount at page boot, so this is the chain a
 * restart actually runs.
 *
 * @module snap-rail/forge/tests/client-install.spec
 */

import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@snap-rail/cordis'
import auditPlugin from '@snap-rail/audit'
import gatewayPlugin from '@snap-rail/gateway'
import settingsPlugin from '@snap-rail/settings'
import storePlugin from '@snap-rail/store'
import stationRpcPlugin from '@snap-rail/station-rpc'
import forgeHostPlugin from '@snap-rail/forge'
import { bootClient } from '@snap-rail/client-kernel'
import type { HostChannel } from '@snap-rail/connection'
import {
  installModuleLoader,
  type ModuleLoaderGlobal,
  type ModuleSystem,
} from '@snap-rail/client-modules'
import { createClientRuntime } from '@snap-rail/client-runtime'
import layoutPlugin from '../../../suites/terminal-ops/src/layout.tsx'
import titlebarPlugin from '../../../suites/terminal-ops/src/chrome.tsx'
import downtimePlugin from '../../../suites/terminal-ops/src/downtime.tsx'
import faultPlugin from '../../../suites/terminal-ops/src/fault.tsx'
import maintenancePlugin from '../../../suites/terminal-ops/src/maintenance.tsx'
import productionPlugin from '../../../suites/terminal-ops/src/production.tsx'
import samplingPlugin from '../../../suites/terminal-ops/src/sampling.tsx'
import { afterEach, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

const contexts: Context[] = []
const homes: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose().catch(() => {})
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  document.body.innerHTML = ''
  delete (globalThis as { __ModuleLoader__?: ModuleLoaderGlobal }).__ModuleLoader__
})

/** The host world: gateway + settings + audit + store + station bridge + forge. */
async function makeHost(): Promise<HostChannel> {
  const host = new Context()
  contexts.push(host)
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-forge-client-'))
  homes.push(home)
  host.provide('snapRailHome', home)
  await host.plugin(gatewayPlugin, { name: 'forge-client-test', version: '0.1.0', bin: 'test' })
  await host.plugin(settingsPlugin)
  await host.plugin(auditPlugin)
  await host.plugin(storePlugin)
  host.provide('pluginLayers', {
    handles: { userLayerPath: join(home, 'plugins.yml'), rendererPackages: [] },
  } as never)
  await host.plugin(stationRpcPlugin)
  await host.plugin(forgeHostPlugin)
  return {
    invoke: request => host.rpc.handleClientRequest(request),
    openStream: listener => host.rpc.attachDownlink(frame => listener(frame)),
  }
}

/** The ids the shipped client bundle requires — seeded with the real modules,
 * exactly the ids the shell's SEED_TABLE covers for it. */
async function seedTable(): Promise<Array<[string, unknown]>> {
  return [
    ['react', await import('react')],
    ['react/jsx-runtime', await import('react/jsx-runtime')],
    ['@snap-rail/client-ui', await import('@snap-rail/client-ui')],
    ['@snap-rail/client-kernel', await import('@snap-rail/client-kernel')],
    ['@snap-rail/client-slots', await import('@snap-rail/client-slots')],
    ['@snap-rail/client-settings', await import('@snap-rail/client-settings')],
    ['@snap-rail/client-session', await import('@snap-rail/client-session')],
    ['@snap-rail/client-workflows', await import('@snap-rail/client-workflows')],
    ['@snap-rail/client-variables', await import('@snap-rail/client-variables')],
    ['@snap-rail/client-modules', await import('@snap-rail/client-modules')],
    ['@snap-rail/connection', await import('@snap-rail/connection')],
    ['@snap-rail/protocol', await import('@snap-rail/protocol')],
    ['@snap-rail/station-rpc/contract', await import('@snap-rail/station-rpc/contract')],
    ['@snap-rail/util', await import('@snap-rail/util')],
    ['zod', await import('zod')],
  ]
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

/** Sign on through the login card's number pad. */
async function loginAs(id: string): Promise<void> {
  for (const digit of id) {
    document.querySelector<HTMLButtonElement>(`button[data-key="${digit}"]`)?.click()
    await flush(2)
  }
  document.querySelector<HTMLButtonElement>('button[data-key="confirm"]')?.click()
  await flush(20)
}

describe('the forge renderer face over the shipped bundle', () => {
  it('mounts from the client bundle and shows the AI 创造 entry after sign-on', async () => {
    const channel = await makeHost()

    // The renderer boot: loader first, then the shell, then seeds, then the
    // pool bundle's wrapper registration — the sequence main.tsx runs.
    const createSystem = installModuleLoader(globalThis as { __ModuleLoader__?: never })
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel })
    const system: ModuleSystem = createSystem()
    for (const [id, module] of await seedTable()) system.seed(id, module)

    // Execute the shipped bundle exactly as a classic script would: its whole
    // body is the wrapper's `__ModuleLoader__.load({ id, factory })` call.
    const bundleSource = readFileSync(join(here, '..', 'lib-client', 'client.js'), 'utf8')
    new Function(bundleSource)()
    const forgeClient = system.require('@snap-rail/forge') as { default?: unknown }

    const runtime = await createClientRuntime(handle, {
      plugins: [
        layoutPlugin,
        titlebarPlugin,
        maintenancePlugin,
        productionPlugin,
        samplingPlugin,
        faultPlugin,
        downtimePlugin,
        forgeClient.default ?? forgeClient,
      ],
    })
    await flush()
    await loginAs('1001')

    // The studio's workflow entry rides the rail beside the suite's pages.
    const entry = document.querySelector('[data-workflow="forge-studio"]')
    expect(entry).not.toBeNull()
    expect(entry?.textContent).toContain('AI 创造')

    // And the host side answers the runner's boot pull.
    const faces = await handle.link.call('forge.gen-faces', {})
    expect(faces.ok).toBe(true)

    await runtime.dispose()
    element.remove()
  }, 30_000)
})
