// @vitest-environment happy-dom
/**
 * The studio window, end to end over the real client bundle: with
 * `?window=forge` in the address (what `window.open-forge` loads), the same
 * bundle mounts as the whole layout — its own titlebar driving
 * `window.control` with `target: 'forge'`, the session sidebar, the chat
 * pane (Enter sends), and the settings dialog over the shared `forge.llm`
 * key. The main-window projection (runner + titlebar button) is covered by
 * client-install.spec.
 *
 * @module snap-rail/forge/tests/forge-window.spec
 */

import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
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
import { afterEach, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))

const contexts: Context[] = []
const homes: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose().catch(() => {})
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  document.body.innerHTML = ''
  window.history.replaceState(null, '', location.pathname)
  delete (globalThis as { __ModuleLoader__?: ModuleLoaderGlobal }).__ModuleLoader__
})

/** The host world: gateway + settings + audit + store + station bridge + forge. */
async function makeHost(): Promise<HostChannel> {
  const host = new Context()
  contexts.push(host)
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-forge-window-'))
  homes.push(home)
  host.provide('snapRailHome', home)
  await host.plugin(gatewayPlugin, { name: 'forge-window-test', version: '0.1.0', bin: 'test' })
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

/** The seeds the shipped bundle requires (same table the shell covers). */
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

/** Set a React-controlled textarea's value the way a real keyboard would. */
function typeInto(textarea: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(textarea, text)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('the studio window projection over the shipped bundle', () => {
  it('renders the studio layout, drives its own window, sends on Enter, and manages sessions', async () => {
    // What window.open-forge loads: the same entry with the studio branch.
    window.history.replaceState(null, '', '?window=forge')

    const channel = await makeHost()
    const controls: Array<Record<string, unknown>> = []
    const sends: Array<Record<string, unknown>> = []
    const spying: HostChannel = {
      invoke: async request => {
        if (request.method === 'window.control') controls.push(request.payload as Record<string, unknown>)
        if (request.method === 'forge.session.send') sends.push(request.payload as Record<string, unknown>)
        return channel.invoke(request)
      },
      openStream: channel.openStream,
    }

    const createSystem = installModuleLoader(globalThis as { __ModuleLoader__?: never })
    const element = document.createElement('div')
    document.body.append(element)
    const handle = await bootClient({ element, channel: spying })
    const system: ModuleSystem = createSystem()
    for (const [id, module] of await seedTable()) system.seed(id, module)

    const bundleSource = readFileSync(join(here, '..', 'lib-client', 'client.js'), 'utf8')
    new Function(bundleSource)()
    const forgeClient = system.require('@snap-rail/forge') as { default?: unknown }

    // The studio window's seat list: only the forge face (main.tsx's branch).
    const runtime = await createClientRuntime(handle, {
      plugins: [forgeClient.default ?? forgeClient],
    })
    await flush()

    // The whole window: titlebar + session sidebar + chat pane.
    expect(document.querySelector('[data-forge="studio"]')).not.toBeNull()
    expect(document.querySelector('[data-region="forge-sessions"]')).not.toBeNull()
    expect(document.querySelector('button[aria-label="模型接口设置"]')).not.toBeNull()
    expect(document.documentElement.dataset.mode).not.toBe(undefined)

    // Window controls address this window, not the main terminal.
    document.querySelector<HTMLButtonElement>('button[aria-label="最小化"]')!.click()
    await flush()
    expect(controls).toEqual([{ action: 'minimize', target: 'forge' }])

    // The settings dialog opens over the shared forge.llm key.
    document.querySelector<HTMLButtonElement>('button[aria-label="模型接口设置"]')!.click()
    await flush()
    expect(document.querySelector('[data-forge="config"] input[placeholder="https://api.deepseek.com/v1"]')).not.toBeNull()

    // Enter sends (Shift+Enter would not); the new session lands in the sidebar.
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!
    typeInto(textarea, '帮我造一个班产周报页')
    await flush()
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flush(20)
    expect(sends).toHaveLength(1)
    expect(sends[0]!['text']).toBe('帮我造一个班产周报页')
    const items = document.querySelectorAll('[data-session-item]')
    expect(items.length).toBe(1)
    expect(items[0]!.textContent).toContain('帮我造一个班产周报页')

    // Deleting the session clears the sidebar back to the empty state.
    items[0]!.querySelector<HTMLButtonElement>('button[aria-label^="删除会话"]')!.click()
    await flush()
    const confirm = [...document.querySelectorAll('button')].find(button => button.textContent === '删除')!
    confirm.click()
    await flush(20)
    expect(document.querySelectorAll('[data-session-item]').length).toBe(0)

    await runtime.dispose()
    element.remove()
  }, 30_000)
})
