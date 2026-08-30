// @vitest-environment happy-dom
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import auditPlugin from '@snap-rail/audit'
import gatewayPlugin from '@snap-rail/gateway'
import fieldPlugin from '@snap-rail/field'
import fieldRpcPlugin from '@snap-rail/field/rpc'
import type { ConnectionRegistration } from '@snap-rail/field'
import type { HostChannel } from '@snap-rail/connection'
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import variablesPlugin, { usePoint } from '../src/index.ts'

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  document.body.innerHTML = ''
})

async function makeVariables(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(variablesPlugin)
  return ctx
}

describe('variables registry', () => {
  it('registers, lists, and drops on fiber unload', async () => {
    const ctx = await makeVariables()
    const fiber = await ctx.plugin(Object.assign(
      function demand(sub): void {
        sub.variables.register(sub, [
          { device: 'plc1', group: '温度', name: '温度1', type: 'float', title: '炉温' },
          { device: 'plc1', group: '计数', name: '计数1', type: 'int' },
        ])
      },
      { inject: ['variables'] },
    ))

    expect(ctx.variables.list().map(entry => entry.name)).toEqual(['温度1', '计数1'])
    expect(ctx.variables.list()[0]).toMatchObject({ device: 'plc1', group: '温度', type: 'float', title: '炉温', source: 'plugin' })

    await fiber.dispose()
    expect(ctx.variables.list()).toEqual([])
  })

  it('replaces same-address registrations by identity and emits changes', async () => {
    const ctx = await makeVariables()
    let changes = 0
    ctx.on('variables/changed', () => { changes += 1 })

    const first = ctx.variables.register(ctx, [{ device: 'plc1', group: '温度', name: '温度1', type: 'float' }])
    // The same name in another group is a different variable.
    ctx.variables.register(ctx, [{ device: 'plc1', group: '备用', name: '温度1', type: 'float' }])
    expect(ctx.variables.list()).toHaveLength(2)
    // The same address replaces.
    const second = ctx.variables.register(ctx, [{ device: 'plc1', group: '温度', name: '温度1', type: 'int' }])
    expect(ctx.variables.list()).toHaveLength(2)
    expect(ctx.variables.list().find(entry => entry.group === '温度')?.type).toBe('int')

    // The first disposer no longer owns the address: nothing changes.
    first()
    expect(ctx.variables.list()).toHaveLength(2)
    // The second disposer does.
    second()
    expect(ctx.variables.list().map(entry => entry.group)).toEqual(['备用'])
    expect(changes).toBe(4)
  })

  it('rejects duplicate addresses within one call', async () => {
    const ctx = await makeVariables()
    expect(() => ctx.variables.register(ctx, [
      { device: 'plc1', group: 'g', name: 'x', type: 'bool' },
      { device: 'plc1', group: 'g', name: 'x', type: 'int' },
    ])).toThrow(/duplicate addresses/)
  })
})

describe('usePoint', () => {
  /** A minimal field world: one connection with the group-scoped point. */
  async function makeWorld(): Promise<{ channel: HostChannel, sample: (value: number) => void }> {
    const home = mkdtempSync(join(tmpdir(), 'snap-rail-usepoint-'))
    tempDirs.push(home)
    const host = new Context()
    contexts.push(host)
    host.provide('snapRailHome', home)
    await host.plugin(gatewayPlugin, { name: 'test', version: '0.0.0', bin: 'test' })
    await host.plugin(auditPlugin)
    await host.plugin(fieldPlugin)
    await host.plugin(fieldRpcPlugin)
    let registration: ConnectionRegistration | undefined
    await host.plugin(Object.assign(
      function driver(sub): void {
        registration = sub.connections.register(sub, { id: 'c1', driver: 'test', title: 'Test' })
        registration.setPoints([{ device: 'plc1', group: '温度', name: '温度1', connection: 'c1', type: 'float' }])
      },
      { inject: ['connections'] },
    ))
    return {
      channel: {
        invoke: request => host.rpc.handleClientRequest(request),
        openStream: listener => host.rpc.attachDownlink(frame => listener(frame)),
      },
      sample: value => registration?.sample({ device: 'plc1', group: '温度', name: '温度1' }, value),
    }
  }

  it('seeds from field.points.read and follows field/point-updated increments', async () => {
    const { channel, sample } = await makeWorld()
    const calls: string[] = []
    const client = new Context()
    contexts.push(client)
    await client.plugin(variablesPlugin)
    client.provide('client', {
      link: {
        call: async (method: string, payload: unknown) => {
          calls.push(method)
          // HostLink.call unwraps the response envelope to its RpcResult.
          const response = await channel.invoke({ type: 'client-request', rpcId: `t-${calls.length}`, method, payload } as never)
          return response.result
        },
        subscribe: (method: string, listener: (payload: unknown) => void) => channel.openStream(frame => {
          if (frame.method === method) listener(frame.payload)
        }),
      },
    })

    // Every render records the hook's current sample.
    const observed: Array<{ value: unknown, time: number } | undefined> = []
    function Hook(): ReactNode {
      observed.push(usePoint(client, { device: 'plc1', group: '温度', name: '温度1' }))
      return null
    }
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    // act() pumps React's scheduler: outside a discrete event, state updates
    // from promise continuations only commit inside an act scope.
    await act(async () => {
      root.render(createElement(Hook))
      await flush()
    })

    // Seeded: the point is registered but unobserved, so the seed read
    // answers the abnormal `null` sample and the hook reflects it.
    expect(observed.length).toBeGreaterThan(1)
    expect(observed.at(-1)).toEqual({ value: null, time: 0 })

    // A host-side sample flows the broadcast; the hook re-renders with it.
    await act(async () => {
      sample(42.5)
      await flush()
    })
    expect(observed.at(-1)?.value).toBe(42.5)
    const rendersAfterFirst = observed.length

    // An unchanged push still delivers (dedup is the driver's job, not the hook's).
    await act(async () => {
      sample(43.5)
      await flush()
    })
    expect(observed.at(-1)?.value).toBe(43.5)
    expect(observed.length).toBeGreaterThan(rendersAfterFirst)

    // Unmount unsubscribes on the wire.
    await act(async () => {
      root.unmount()
      element.remove()
      await flush()
    })
    expect(calls).toContain('field.points.subscribe')
    expect(calls).toContain('field.points.read')
    expect(calls).toContain('field.points.unsubscribe')
  }, 20_000)
})

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}
