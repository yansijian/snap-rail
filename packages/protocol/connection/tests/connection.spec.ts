import { Context } from '@snap-rail/cordis'
import { RpcTransportError, type ClientRequest, type ServerRequest, type ServerResponse } from '@snap-rail/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import gatewayPlugin from '@snap-rail/gateway'
import { HostLink, type HostChannel } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

interface FakeChannel extends HostChannel {
  /** Push a raw frame to every open stream listener. */
  push(frame: unknown): void
}

function makeChannel(invoke: (request: ClientRequest) => Promise<ServerResponse>): FakeChannel {
  const listeners = new Set<(frame: ServerRequest) => void>()
  return {
    invoke,
    openStream(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    push(frame) {
      for (const listener of [...listeners]) listener(frame as ServerRequest)
    },
  }
}

async function makeLink(): Promise<{ link: HostLink; channel: FakeChannel }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(gatewayPlugin, { name: 'snap-rail', version: '0.1.0', bin: 'test' })
  const channel = makeChannel(request => ctx.gateway.handleClientRequest(request))
  return { link: new HostLink(channel), channel }
}

describe('HostLink', () => {
  it('runs the full unary round trip over a generic channel', async () => {
    const { link } = await makeLink()
    const described = await link.describeHost()
    expect(described).toEqual({ name: 'snap-rail', version: '0.1.0', bin: 'test' })
  })

  it('throws on an rpcId echo mismatch instead of mispairing results', async () => {
    // A well-formed response carrying someone else's id is unpaired result
    // data; only the echo check can catch it.
    const corrupt = makeChannel(async request => ({
      type: 'server-response',
      rpcId: `${request.rpcId}-swapped`,
      result: { ok: true, value: {} },
    }))
    const badLink = new HostLink(corrupt)
    await expect(badLink.call('host.describe', {})).rejects.toThrow(RpcTransportError)
  })

  it('delivers frames filtered by method and honors unsubscribe', async () => {
    const { link, channel } = await makeLink()
    const updates: unknown[] = []
    const statuses: unknown[] = []
    const detachUpdates = link.subscribe('point/updated', payload => updates.push(payload))
    link.subscribe('connection/status', payload => statuses.push(payload))

    channel.push({ type: 'server-request', rpcId: 'f1', method: 'point/updated', payload: { id: 'p1' } })
    channel.push({ type: 'server-request', rpcId: 'f2', method: 'connection/status', payload: { id: 'c1', status: 'online', time: 1 } })
    detachUpdates()
    channel.push({ type: 'server-request', rpcId: 'f3', method: 'point/updated', payload: { id: 'p2' } })

    expect(updates).toEqual([{ id: 'p1' }])
    expect(statuses).toEqual([{ id: 'c1', status: 'online', time: 1 }])
  })

  it('fails loud on a frame that violates the envelope schema', async () => {
    const { link, channel } = await makeLink()
    const received: unknown[] = []
    link.subscribe('point/updated', payload => received.push(payload))

    expect(() => channel.push({ method: 'point/updated', payload: {} })).toThrow(/invalid|required/i)
  })
})
