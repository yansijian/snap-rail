// @vitest-environment happy-dom
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import auditPlugin from '@snap-rail/audit'
import gatewayPlugin from '@snap-rail/gateway'
import fieldPlugin from '@snap-rail/field'
import fieldRpcPlugin from '@snap-rail/field/rpc'
import type { ConnectionRegistration, MappingDocument, MappingPoint, PointType } from '@snap-rail/field'
import { afterEach, describe, expect, it } from 'vitest'
import variablesPlugin, {
  resolveBinding,
  watchBinding,
  type BindingView,
} from '../src/index.ts'

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  document.body.innerHTML = ''
})

function point(overrides: Partial<MappingPoint> & { name: string }): MappingPoint {
  return { deviceId: 'plc1', group: '故障报警', ...overrides }
}

/** The generic mapping document a test driver projects (dialect-free). */
const DOC: MappingDocument = {
  devices: [{ id: 'plc1', driver: 'rig' }],
  groups: [
    { deviceId: 'plc1', name: '故障报警', type: 'bool' },
    { deviceId: 'plc1', name: '其他', type: 'bool' },
    { deviceId: 'plc1', name: '产量', type: 'int' },
  ],
  points: [
    point({ name: '液压低压' }),
    point({ name: '主轴过载' }),
    // Same name, another group: a different point.
    point({ name: '主轴过载', group: '其他' }),
    point({ name: '冷却异常', group: '其他' }),
    point({ name: '产量计数', group: '产量' }),
  ],
}

describe('resolveBinding', () => {
  it('resolves the two addressing forms; the point form is group-scoped', () => {
    expect(resolveBinding(DOC, { device: 'plc1', group: '产量', name: '产量计数' }))
      .toEqual({ kind: 'point', ref: { device: 'plc1', group: '产量', name: '产量计数' }, name: '产量计数' })
    // The same name in two groups resolves to two distinct addresses.
    expect(resolveBinding(DOC, { device: 'plc1', group: '故障报警', name: '主轴过载' })?.ref)
      .toEqual({ device: 'plc1', group: '故障报警', name: '主轴过载' })
    expect(resolveBinding(DOC, { device: 'plc1', group: '其他', name: '主轴过载' })?.ref)
      .toEqual({ device: 'plc1', group: '其他', name: '主轴过载' })
    // A name belonging to another group does not resolve cross-group.
    expect(resolveBinding(DOC, { device: 'plc1', group: '产量', name: '主轴过载' })).toBeUndefined()
    // Group members keep the document's order (the projection defines it).
    expect(resolveBinding(DOC, { device: 'plc1', group: '故障报警' })).toEqual({
      kind: 'group', device: 'plc1', group: '故障报警',
      members: [
        { ref: { device: 'plc1', group: '故障报警', name: '液压低压' }, name: '液压低压' },
        { ref: { device: 'plc1', group: '故障报警', name: '主轴过载' }, name: '主轴过载' },
      ],
    })
    // Unknown device, unknown group, and a group nobody belongs to.
    expect(resolveBinding(DOC, { device: 'ghost', group: '故障报警' })).toBeUndefined()
    expect(resolveBinding(DOC, { device: 'plc1', group: '不存在' })).toBeUndefined()
  })
})

describe('watchBinding', () => {
  /**
   * A world whose mapping document comes from a test driver registered with
   * the field seam (`ctx.field.registerDriver` + projection — the spine
   * never imports a real driver) and whose field rig provides the mapped
   * points. `field.mappings.list` and `field/mappings-changed` are the real
   * bridge outputs.
   */
  async function makeWorld(): Promise<{
    setDoc: (doc: MappingDocument) => void
    notifyMappingsChanged: () => void
    sample: (group: string, name: string, value: boolean | bigint | null) => void
    attach: (binding: Parameters<typeof watchBinding>[1]) => { views: BindingView[], stop: () => void }
  }> {
    const home = mkdtempSync(join(tmpdir(), 'snap-rail-binding-'))
    tempDirs.push(home)
    const host = new Context()
    contexts.push(host)
    host.provide('snapRailHome', home)
    await host.plugin(gatewayPlugin, { name: 'test', version: '0.0.0', bin: 'test' })
    await host.plugin(auditPlugin)
    await host.plugin(fieldPlugin)
    await host.plugin(fieldRpcPlugin)

    let doc = DOC
    let registration: ConnectionRegistration | undefined
    await host.plugin(Object.assign(
      function driver(sub: Context): void {
        sub.field.registerDriver(sub, { id: 'rig', title: 'Rig', mappings: () => doc })
        registration = sub.connections.register(sub, { id: 'rig', driver: 'rig', title: 'Rig' })
        registration.setPoints(DOC.points.map(entry => ({
          device: entry.deviceId, group: entry.group, name: entry.name,
          connection: 'rig', type: typeOf(entry),
        })))
      },
      { inject: ['connections', 'field'] },
    ))

    // A client context: the variables plugin plus a client link over the
    // host channel (call unwraps the envelope like HostLink does).
    const client = new Context()
    contexts.push(client)
    await client.plugin(variablesPlugin)
    let rpcSeq = 0
    client.provide('client', {
      link: {
        call: async (method: string, payload: unknown) => {
          rpcSeq += 1
          const response = await host.rpc.handleClientRequest(
            { type: 'client-request', rpcId: `t-${rpcSeq}`, method, payload } as never)
          return response.result
        },
        subscribe: (method: string, listener: (payload: unknown) => void) =>
          host.rpc.attachDownlink(frame => { if (frame.method === method) listener(frame.payload) }),
      },
    })

    /** The rig derives a point's type from its group (the generic doc has none). */
    function typeOf(entry: MappingPoint): PointType {
      return doc.groups.find(group => group.deviceId === entry.deviceId && group.name === entry.group)?.type ?? 'bool'
    }

    return {
      setDoc: next => {
        doc = next
        // The rig follows the document: a re-grouped point changes its
        // address, so the registered points follow too.
        registration?.setPoints(next.points.map(entry => ({
          device: entry.deviceId, group: entry.group, name: entry.name, connection: 'rig', type: typeOf(entry),
        })))
      },
      notifyMappingsChanged: () => { host.emit('field/mappings-changed') },
      sample: (group, name, value) => {
        registration?.sample({ device: 'plc1', group, name }, value)
      },
      attach: binding => {
        const views: BindingView[] = []
        const stop = watchBinding(client, binding, view => { views.push(view) })
        return { views, stop }
      },
    }
  }

  async function flush(times = 12): Promise<void> {
    for (let i = 0; i < times; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
  }

  it('aggregates the group: active with member names, reset, abnormal, pending', async () => {
    const world = await makeWorld()
    const { views, stop } = world.attach({ device: 'plc1', group: '故障报警' })
    await flush()

    // Both members read back "never observed" (null, time 0) → pending.
    expect(views.at(-1)).toEqual({
      kind: 'group', device: 'plc1', group: '故障报警', status: 'normal',
      active: [], abnormal: [], pending: ['液压低压', '主轴过载'],
    })

    // One member trips: active with the point name.
    world.sample('故障报警', '主轴过载', true)
    await flush()
    let latest = views.at(-1)
    expect(latest).toMatchObject({ status: 'active' })
    expect(latest?.kind === 'group' && latest.active.map(member => member.name)).toEqual(['主轴过载'])

    // The same name in another group never reaches this view.
    world.sample('其他', '主轴过载', true)
    await flush()
    latest = views.at(-1)
    expect(latest?.kind === 'group' && latest.active.map(member => member.name)).toEqual(['主轴过载'])

    // Reset one, kill the other's link: active drains into abnormal.
    world.sample('故障报警', '液压低压', false)
    world.sample('故障报警', '主轴过载', null)
    await flush()
    expect(views.at(-1)).toMatchObject({ status: 'normal', abnormal: ['主轴过载'], active: [] })

    stop()
    await flush()
  }, 20_000)

  it('re-resolves on field/mappings-changed without restarting the watcher', async () => {
    const world = await makeWorld()
    const { views, stop } = world.attach({ device: 'plc1', group: '故障报警' })
    await flush()

    // Re-group (same type, another group): 冷却异常 joins the fault group,
    // one old member leaves it.
    world.setDoc({
      ...DOC,
      points: [
        DOC.points[0]!,
        { ...DOC.points[1]!, group: '其他' },
        DOC.points[2]!,
        { ...DOC.points[3]!, group: '故障报警' },
        DOC.points[4]!,
      ],
    })
    world.notifyMappingsChanged()
    await flush()

    const regrouped = views.at(-1)
    expect(regrouped?.kind === 'group' && regrouped.pending).toEqual(['液压低压', '冷却异常'])
    // The leaving member no longer drives the view.
    world.sample('其他', '主轴过载', true)
    world.sample('故障报警', '冷却异常', true)
    await flush()
    const after = views.at(-1)
    expect(after?.kind === 'group' && after.active.map(member => member.name)).toEqual(['冷却异常'])

    stop()
    await flush()
  }, 20_000)

  it('serves one group-scoped point with usePoint semantics', async () => {
    const world = await makeWorld()
    const { views, stop } = world.attach({ device: 'plc1', group: '产量', name: '产量计数' })
    await flush()

    // Seeded never-observed sample, then a live update.
    expect(views.at(-1)).toEqual({
      kind: 'point', ref: { device: 'plc1', group: '产量', name: '产量计数' }, name: '产量计数',
      sample: { value: null, time: 0 },
    })
    world.sample('产量', '产量计数', 12n)
    await flush()
    expect(views.at(-1)).toEqual({
      kind: 'point', ref: { device: 'plc1', group: '产量', name: '产量计数' }, name: '产量计数',
      sample: { value: 12n, time: expect.any(Number) },
    })

    stop()
    await flush()
  }, 20_000)

  it('stays unresolved for a binding the document cannot satisfy', async () => {
    const world = await makeWorld()
    const wrongGroup = world.attach({ device: 'plc1', group: '产量', name: '主轴过载' })
    await flush()
    expect(wrongGroup.views).toEqual([{ kind: 'unresolved' }])
    wrongGroup.stop()

    const unknown = world.attach({ device: 'plc1', group: '不存在' })
    await flush()
    expect(unknown.views).toEqual([{ kind: 'unresolved' }])
    unknown.stop()
    await flush()
  }, 20_000)
})
