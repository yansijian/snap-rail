import { Context } from '@snap-rail/cordis'
import { InProcessApiClient, RpcBusinessError, type ServerRequest } from '@snap-rail/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
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
  return new InProcessApiClient(request => ctx.rpc.handleClientRequest(request))
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
    const raw = await ctx.rpc.handleClientRequest({
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
    await expect(ctx.rpc.handleClientRequest({ type: 'client-request' })).rejects.toThrow(/envelope/)
  })

  it('converts handler business errors and crashes into results', async () => {
    const ctx = await makeGateway()
    ctx.rpc.claimDomain(ctx, 'demo')
    ctx.rpc.method(ctx, 'demo.boom', { request: z.object({}).strict() }, () => {
      throw new RpcBusinessError({ code: 'unavailable', details: { what: 'demo' } })
    })
    const business = await clientOf(ctx).call('demo.boom', {})
    expect(business).toEqual({ ok: false, error: { code: 'unavailable', details: { what: 'demo' } } })

    ctx.rpc.method(ctx, 'demo.boom', { request: z.object({}).strict() }, () => {
      throw new Error('boom')
    })
    const crash = await clientOf(ctx).call('demo.boom', {})
    expect(crash.ok).toBe(false)
    if (!crash.ok) expect(crash.error.code).toBe('internal')
  })

  it('removes a route on disposer and lets a re-registration win', async () => {
    const ctx = await makeGateway()
    ctx.rpc.claimDomain(ctx, 'demo')
    const dispose = ctx.rpc.method(ctx, 'demo.echo', { request: z.object({}).strict() }, () => 'first')
    let result = await clientOf(ctx).call('demo.echo', {})
    expect(result).toEqual({ ok: true, value: 'first' })

    dispose()
    const afterDispose = await ctx.rpc.handleClientRequest({
      type: 'client-request', rpcId: 'r2' as never, method: 'demo.echo', payload: {},
    })
    expect(afterDispose.result.ok).toBe(false)

    ctx.rpc.method(ctx, 'demo.echo', { request: z.object({}).strict() }, () => 'second')
    result = await clientOf(ctx).call('demo.echo', {})
    expect(result).toEqual({ ok: true, value: 'second' })
  })

  it('broadcasts push frames with fresh rpcIds to every downlink', async () => {
    const ctx = await makeGateway()
    const received: ServerRequest[] = []
    const detach = ctx.rpc.attachDownlink(frame => received.push(frame))
    const silent: ServerRequest[] = []
    const detachSilent = ctx.rpc.attachDownlink(frame => silent.push(frame))

    const sample = { device: 'd', group: 'g', name: 'n', value: null, time: 0 }
    const frameA = ctx.rpc.broadcast('point/updated', sample)
    detachSilent()
    const frameB = ctx.rpc.broadcast('point/updated', sample)

    expect(received).toEqual([frameA, frameB])
    // The detached downlink saw frameA (attached at the time) but not frameB.
    expect(silent).toEqual([frameA])
    expect(frameA.rpcId).not.toBe(frameB.rpcId)
    detach()
  })

  it('rejects a payload that violates the method schema', async () => {
    const ctx = await makeGateway()
    const response = await ctx.rpc.handleClientRequest({
      type: 'client-request', rpcId: 'r3' as never, method: 'host.describe', payload: { stray: 1 },
    })
    expect(response.result.ok).toBe(false)
    if (!response.result.ok) expect(response.result.error.code).toBe('bad-request')
  })
})

describe('gateway domain claims', () => {
  it('claims first-wins, fails loud on conflict, and releases on dispose', async () => {
    const ctx = await makeGateway()
    const release = ctx.rpc.claimDomain(ctx, 'demo')
    expect(() => ctx.rpc.claimDomain(ctx, 'demo')).toThrow(/already claimed/)
    release()
    expect(() => ctx.rpc.claimDomain(ctx, 'demo')).not.toThrow()
  })

  it('rejects malformed domain prefixes', async () => {
    const ctx = await makeGateway()
    expect(() => ctx.rpc.claimDomain(ctx, 'Bad')).toThrow(/invalid domain prefix/)
    expect(() => ctx.rpc.claimDomain(ctx, 'a.b.c')).toThrow(/invalid domain prefix/)
  })

  it('fails loud when another plugin owns the domain', async () => {
    const ctx = await makeGateway()
    const ownerCtx: Context[] = []
    const otherCtx: Context[] = []
    await ctx.plugin({ name: 'demo-owner', inject: ['rpc'], apply: c => { ownerCtx.push(c); c.rpc.claimDomain(c, 'demo') } })
    await ctx.plugin({ name: 'demo-other', apply: c => { otherCtx.push(c) } })
    expect(() => ctx.rpc.method(otherCtx[0]!, 'demo.add', { request: z.object({}).strict() }, () => null))
      .toThrow(/claimed by/)
  })
})

describe('gateway open registration', () => {
  it('registers a claimed method with its schema and dispatches it', async () => {
    const ctx = await makeGateway()
    ctx.rpc.claimDomain(ctx, 'demo')
    ctx.rpc.method(ctx, 'demo.add', { request: z.object({ a: z.number() }).strict() }, ({ a }) => ({ sum: a + 1 }))
    const result = await clientOf(ctx).call('demo.add', { a: 1 })
    expect(result).toEqual({ ok: true, value: { sum: 2 } })

    const bad = await ctx.rpc.handleClientRequest({
      type: 'client-request', rpcId: 'r4' as never, method: 'demo.add', payload: { a: 'nope' },
    })
    expect(bad.result.ok).toBe(false)
    if (!bad.result.ok) expect(bad.result.error.code).toBe('bad-request')
  })

  it('requires a request schema', async () => {
    const ctx = await makeGateway()
    ctx.rpc.claimDomain(ctx, 'demo')
    expect(() => ctx.rpc.method(ctx, 'demo.add', {} as never, () => null)).toThrow(/requires a request schema/)
  })

  it('rejects methods in unclaimed domains and malformed names', async () => {
    const ctx = await makeGateway()
    expect(() => ctx.rpc.method(ctx, 'unclaimed.add', { request: z.object({}).strict() }, () => null)).toThrow(/unclaimed domain/)
    ctx.rpc.claimDomain(ctx, 'demo')
    expect(() => ctx.rpc.method(ctx, 'demo.add-Pascal', { request: z.object({}).strict() }, () => null)).toThrow(/invalid method name/)
  })

  it('prefers the two-segment claim when one exists', async () => {
    const ctx = await makeGateway()
    ctx.rpc.claimDomain(ctx, 'demo')
    ctx.rpc.claimDomain(ctx, 'demo.sub')
    // 'demo.sub.x' matches the 'demo.sub' claim, not the broader 'demo'.
    const other: Context[] = []
    await ctx.plugin({ name: 'sub-other', apply: c => { other.push(c) } })
    expect(() => ctx.rpc.method(other[0]!, 'demo.sub.x', { request: z.object({}).strict() }, () => null)).toThrow(/claimed by/)
    ctx.rpc.method(ctx, 'demo.sub.x', { request: z.object({}).strict() }, () => 'ok')
    ctx.rpc.method(ctx, 'demo.plain', { request: z.object({}).strict() }, () => 'ok')
  })

  it('self-checks responses against the optional response schema', async () => {
    const ctx = await makeGateway()
    ctx.rpc.claimDomain(ctx, 'demo')
    ctx.rpc.method(
      ctx,
      'demo.bad',
      { request: z.object({}).strict(), response: z.object({ v: z.number() }).strict() },
      () => ({ v: 'not a number' }),
    )
    const result = await clientOf(ctx).call('demo.bad', {})
    expect(result).toEqual({ ok: false, error: { code: 'internal', details: { hint: 'response failed its schema' } } })
  })

  it('drops methods and claims with the owning plugin fiber', async () => {
    const ctx = await makeGateway()
    const probe: Context[] = []
    await ctx.plugin({
      name: 'probe',
      inject: ['rpc'],
      apply(c) {
        probe.push(c)
        c.rpc.claimDomain(c, 'probe')
        c.rpc.method(c, 'probe.ping', { request: z.object({}).strict() }, () => 'pong')
      },
    })
    const client = clientOf(ctx)
    const before = await client.call('probe.ping', {})
    expect(before).toEqual({ ok: true, value: 'pong' })

    await probe[0]!.fiber.dispose()
    const after = await client.call('probe.ping', {})
    expect(after.ok).toBe(false)
    // The claim left with the plugin: a fresh plugin may claim the domain.
    expect(() => ctx.rpc.claimDomain(ctx, 'probe')).not.toThrow()
  })
})

describe('gateway frame registration', () => {
  it('registers a frame schema under a claimed domain', async () => {
    const ctx = await makeGateway()
    ctx.rpc.claimDomain(ctx, 'demo')
    ctx.rpc.frame(ctx, 'demo/tick', { payload: z.object({ n: z.number() }).strict() })
    // Broadcast stays unvalidated on the hot path; registration is the
    // discovery record.
    const frame = ctx.rpc.broadcast('demo/tick', { n: 1 })
    expect(frame.method).toBe('demo/tick')
  })

  it('rejects frames with malformed names, unclaimed domains, or no schema', async () => {
    const ctx = await makeGateway()
    expect(() => ctx.rpc.frame(ctx, 'demo.tick', { payload: z.object({}) })).toThrow(/invalid frame name/)
    expect(() => ctx.rpc.frame(ctx, 'unclaimed/tick', { payload: z.object({}) })).toThrow(/unclaimed domain/)
    ctx.rpc.claimDomain(ctx, 'demo')
    expect(() => ctx.rpc.frame(ctx, 'demo/tick', {} as never)).toThrow(/requires a payload schema/)
  })
})

describe('gateway capability discovery', () => {
  it('serves the live registry through rpc.describe', async () => {
    const ctx = await makeGateway()
    ctx.rpc.claimDomain(ctx, 'demo')
    ctx.rpc.method(ctx, 'demo.add', { request: z.object({ a: z.number() }).strict() }, ({ a }) => a)
    ctx.rpc.frame(ctx, 'demo/tick', { payload: z.object({ n: z.number() }).strict() })

    const described = await clientOf(ctx).call('rpc.describe', {})
    expect(described.ok).toBe(true)
    if (described.ok) {
      expect(described.value.domains).toContainEqual({ prefix: 'demo', owner: expect.any(String) })
      expect(described.value.methods.map(method => method.name)).toEqual(
        expect.arrayContaining(['host.describe', 'rpc.describe', 'demo.add']),
      )
      const demo = described.value.methods.find(method => method.name === 'demo.add')
      expect(demo?.requestSchema).toMatchObject({ type: 'object' })
      expect(described.value.frames.map(frame => frame.name)).toContain('demo/tick')
    }
  })
})
