import { Context } from '@snap-rail/cordis'
import { RpcTransportError, type ClientRequest, type ServerRequest, type ServerResponse } from '@snap-rail/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import gatewayPlugin from '@snap-rail/gateway'
import { HostLink, rpcErrorText, subscribeTopic, type HostChannel } from '../src/index.ts'

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
  const channel = makeChannel(request => ctx.rpc.handleClientRequest(request))
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

describe('rpcErrorText', () => {
  it('prefers issues, then what, and never leaves internal bare', () => {
    expect(rpcErrorText({ code: 'bad-request', details: { issues: ['地址无效', '功能码无效'] } })).toBe('地址无效；功能码无效')
    expect(rpcErrorText({ code: 'conflict', details: { what: '点位已存在' } })).toBe('点位已存在')
    // The masked-internal regression: the hint always names the failing step.
    expect(rpcErrorText({ code: 'internal', details: { hint: 'field point upsert failed' } })).toBe('内部错误（field point upsert failed）')
    expect(rpcErrorText({ code: 'internal' })).toBe('内部错误')
    expect(rpcErrorText({ code: 'unavailable' })).toBe('unavailable')
  })
})

describe('subscribeTopic', () => {
  it('opens a gate, delivers schema-parsed payloads, and closes gate and stream on dispose', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(gatewayPlugin, { name: 'snap-rail', version: '0.1.0', bin: 'test' })
    ctx.topic.declare(ctx, 'demo/tick', {
      payload: z.object({ n: z.number() }).strict(),
      filter: z.object({ n: z.number().optional() }).strict(),
      match: (filter, payload) => filter.n === undefined || filter.n === payload.n,
    })

    // Mirror the carrier: frames reach the link's streams through a downlink,
    // and the invoke side records the gate traffic.
    const sent: ClientRequest[] = []
    let announceGateSettled: () => void = () => undefined
    const gateSettled = new Promise<void>(resolve => { announceGateSettled = resolve })
    const channel = makeChannel(async request => {
      sent.push(request)
      const response = await ctx.rpc.handleClientRequest(request)
      if (request.method === 'topic.subscribe') announceGateSettled()
      return response
    })
    const detachDownlink = ctx.rpc.attachDownlink(frame => channel.push(frame))
    const link = new HostLink(channel)

    const received: number[] = []
    const detach = subscribeTopic(
      link,
      'demo/tick',
      { n: 1 },
      z.object({ n: z.number() }).strict(),
      payload => received.push(payload.n),
    )
    await gateSettled

    // The matching publication rides the gate to the stream; the other never
    // climbs to the wire at all.
    ctx.topic.publish('demo/tick', { n: 1 })
    ctx.topic.publish('demo/tick', { n: 2 })
    expect(received).toEqual([1])

    // A raw malformed payload is dropped, not fed half-parsed to the listener.
    channel.push({ type: 'server-request', rpcId: 'fx', method: 'demo/tick', payload: { n: 'bad' } })
    expect(received).toEqual([1])

    detach()
    await vi.waitFor(() => {
      expect(sent.some(request => request.method === 'topic.unsubscribe')).toBe(true)
    })
    ctx.topic.publish('demo/tick', { n: 1 })
    expect(received).toEqual([1])
    detachDownlink()
  })

  it('closes a gate that settles after disposal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(gatewayPlugin, { name: 'snap-rail', version: '0.1.0', bin: 'test' })
    ctx.topic.declare(ctx, 'demo/tick', { payload: z.object({ n: z.number() }).strict() })

    let releaseGate: ((response: ServerResponse) => void) | undefined
    const sent: ClientRequest[] = []
    const channel = makeChannel(request => {
      sent.push(request)
      if (request.method === 'topic.subscribe') {
        // Hold the gate response hostage until after the disposer ran.
        return new Promise<ServerResponse>(resolve => { releaseGate = resolve })
      }
      return ctx.rpc.handleClientRequest(request)
    })
    const link = new HostLink(channel)

    const detach = subscribeTopic(link, 'demo/tick', undefined, z.object({ n: z.number() }).strict(), () => undefined)
    detach()
    await vi.waitFor(() => expect(releaseGate).toBeDefined())
    releaseGate!({
      type: 'server-response',
      rpcId: sent[0]!.rpcId,
      result: { ok: true, value: { subscriptionId: 'late-gate' } },
    })
    await vi.waitFor(() => {
      expect(sent.some(request => request.method === 'topic.unsubscribe')).toBe(true)
    })
  })
})
