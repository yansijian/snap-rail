// @vitest-environment happy-dom
import { Context } from '@snap-rail/cordis'
import gatewayPlugin from '@snap-rail/gateway'
import { afterEach, describe, expect, it } from 'vitest'
import { bootClient } from '../src/index.tsx'
import type { HostChannel } from '../src/index.tsx'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function inProcessChannel(ctx: Context): HostChannel {
  return {
    invoke: request => ctx.rpc.handleClientRequest(request),
    openStream: () => () => {},
  }
}

async function makeReady(): Promise<{ channel: HostChannel }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(gatewayPlugin, { name: 'demo-shell', version: '9.9.9', bin: 'desktop' })
  return { channel: inProcessChannel(ctx) }
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

describe('bootClient', () => {
  it('renders the ready identity once the host answers describe', async () => {
    const { channel } = await makeReady()
    const element = document.createElement('div')
    document.body.append(element)

    const handle = await bootClient({ element, channel })
    await flush()

    expect(document.body.textContent).toContain('demo-shell')
    expect(document.body.textContent).toContain('9.9.9')
    // The handed-over link is a working typed client, not just UI wiring.
    const echo = await handle.link.call('host.describe', {})
    expect(echo.ok && echo.value.bin).toBe('desktop')
    handle.root.unmount()
    element.remove()
  })

  it('shows the failure reason when the carrier is dead', async () => {
    const broken: HostChannel = {
      invoke: () => Promise.reject(new Error('carrier down')),
      openStream: () => () => {},
    }
    const element = document.createElement('div')
    document.body.append(element)

    const handle = await bootClient({ element, channel: broken })
    await flush()

    expect(document.body.textContent).toContain('连接失败')
    expect(document.body.textContent).toContain('carrier down')
    handle.root.unmount()
    element.remove()
  })
})
