import { Context } from '@snap-rail/cordis'
import { InProcessApiClient, RpcBusinessError, type ServerRequest } from '@snap-rail/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import gatewayPlugin from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function makeGateway(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(gatewayPlugin, { name: 'snap-rail', version: '0.1.0', bin: 'test' })
  return ctx
}

function clientOf(ctx: Context): InProcessApiClient {
  return new InProcessApiClient(request => ctx.gateway.handleClientRequest(request))
}

describe('gateway', () => {
  it('answers host.describe through the full InProcess round trip', async () => {
    const ctx = await makeGateway()
    const client = clientOf(ctx)
    const result = await client.call('host.describe', {})
    expect(result).toEqual({ ok: true, value: { name: 'snap-rail', version: '0.1.0', bin: 'test' } })
  })

  it('rejects an unknown method as bad-request (fail loud, no fallback)', async () => {
    const ctx = await makeGateway()
    const result = await clientOf(ctx).call('host.describe', {})
    expect(result.ok).toBe(true)
    const raw = await ctx.gateway.handleClientRequest({
      type: 'client-request',
      rpcId: 'r1' as never,
      method: 'no.such.method',
      payload: {},
    })
    expect(raw.result).toEqual({
      ok: false,
      error: { code: 'bad-request', details: { issues: ['unknown method: no.such.method'] } },
    })
  })

  it('rejects a malformed envelope before dispatch', async () => {
    const ctx = await makeGateway()
    await expect(ctx.gateway.handleClientRequest({ type: 'client-request' })).rejects.toThrow(/envelope/)
  })

  it('converts handler business errors and crashes into results', async () => {
    const ctx = await makeGateway()
    ctx.gateway.registerMethod('host.describe', () => {
      throw new RpcBusinessError({ code: 'unavailable', details: { what: 'describe' } })
    })
    const business = await clientOf(ctx).call('host.describe', {})
    expect(business).toEqual({ ok: false, error: { code: 'unavailable', details: { what: 'describe' } } })

    ctx.gateway.registerMethod('host.describe', () => {
      throw new Error('boom')
    })
    const crash = await clientOf(ctx).call('host.describe', {})
    expect(crash.ok).toBe(false)
    if (!crash.ok) expect(crash.error.code).toBe('internal')
  })

  it('removes a route on disposer and lets a re-registration win', async () => {
    const ctx = await makeGateway()
    const dispose = ctx.gateway.registerMethod('host.describe', () => ({ name: 'a', version: '0', bin: 'b' }))
    let first = await clientOf(ctx).call('host.describe', {})
    expect(first.ok && first.value.name).toBe('a')

    dispose()
    const afterDispose = await ctx.gateway.handleClientRequest({
      type: 'client-request', rpcId: 'r2' as never, method: 'host.describe', payload: {},
    })
    expect(afterDispose.result.ok).toBe(false)

    ctx.gateway.registerMethod('host.describe', () => ({ name: 'c', version: '0', bin: 'b' }))
    first = await clientOf(ctx).call('host.describe', {})
    expect(first.ok && first.value.name).toBe('c')
  })

  it('broadcasts push frames with fresh rpcIds to every downlink', async () => {
    const ctx = await makeGateway()
    const received: ServerRequest[] = []
    const detach = ctx.gateway.attachDownlink(frame => received.push(frame))
    const silent: ServerRequest[] = []
    const detachSilent = ctx.gateway.attachDownlink(frame => silent.push(frame))

    const frameA = ctx.gateway.broadcast('point/updated', { updates: [] })
    detachSilent()
    const frameB = ctx.gateway.broadcast('point/updated', { updates: [] })

    expect(received).toEqual([frameA, frameB])
    // The detached downlink saw frameA (attached at the time) but not frameB.
    expect(silent).toEqual([frameA])
    expect(frameA.rpcId).not.toBe(frameB.rpcId)
    detach()
  })

  it('rejects a payload that violates the method schema', async () => {
    const ctx = await makeGateway()
    const response = await ctx.gateway.handleClientRequest({
      type: 'client-request', rpcId: 'r3' as never, method: 'host.describe', payload: { stray: 1 },
    })
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) expect(response.result.error.code).toBe('bad-request')
  })
})
