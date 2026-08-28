import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import auditPlugin from '@snap-rail/audit'
import gatewayPlugin from '@snap-rail/gateway'
import settingsPlugin from '@snap-rail/settings'
import stationRpcPlugin from '../src/index.ts'
import { InProcessApiClient } from '@snap-rail/protocol'
import { afterEach, describe, expect, it } from 'vitest'

const contexts: Context[] = []
const homes: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

interface TestWorld {
  home: string
  client: InProcessApiClient
}

async function makeWorld(rendererPackages: readonly string[] = []): Promise<TestWorld> {
  const home = mkdtempSync(join(tmpdir(), 'snap-rail-station-'))
  homes.push(home)
  const userLayerPath = join(home, 'plugins.yml')

  const host = new Context()
  contexts.push(host)
  host.provide('snapRailHome', home)
  await host.plugin(gatewayPlugin, { name: 'test', version: '0.1.0', bin: 'test' })
  await host.plugin(settingsPlugin)
  await host.plugin(auditPlugin)
  host.provide('pluginLayers', {
    handles: { userLayerPath, rendererPackages },
  } as never)
  await host.plugin(stationRpcPlugin)
  return { home, client: new InProcessApiClient(request => host.gateway.handleClientRequest(request)) }
}

describe('station-rpc', () => {
  it('logs an operator in durably and audits the transition', async () => {
    const { home, client } = await makeWorld()
    const login = await client.call('session.login', { operator: ' 1001 ' })
    expect(login.ok && login.value.applied).toBe(true)

    const current = await client.call('session.current', {})
    expect(current.ok && current.value.operator).toBe('1001')

    const { readFileSync } = await import('node:fs')
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(settings['session.operatorId']).toBe('1001')

    const list = await client.call('audit.list', { actions: ['session.login'] })
    expect(list.ok && list.value.entries.length).toBe(1)
    expect(list.ok && list.value.entries[0]?.actor).toBe('1001')
  })

  it('rejects a blank operator id as a business failure', async () => {
    const { client } = await makeWorld()
    const result = await client.call('session.login', { operator: '   ' })
    expect(result.ok).toBe(false)
  })

  it('attributes audit.record to the signed-on operator and filters list', async () => {
    const { client } = await makeWorld()
    await client.call('session.login', { operator: '1001' })
    const recorded = await client.call('audit.record', { action: 'maintenance.complete', detail: { items: 5 } })
    expect(recorded.ok).toBe(true)

    const mine = await client.call('audit.list', { actions: ['maintenance.complete'], actor: '1001' })
    expect(mine.ok && mine.value.entries.length).toBe(1)
    const other = await client.call('audit.list', { actions: ['maintenance.complete'], actor: '1002' })
    expect(other.ok && other.value.entries.length).toBe(0)
  })

  it('signs out, clears the persisted operator, and audits it', async () => {
    const { home, client } = await makeWorld()
    await client.call('session.login', { operator: '1001' })
    const logout = await client.call('session.logout', {})
    expect(logout.ok && logout.value.applied).toBe(true)
    const current = await client.call('session.current', {})
    expect(current.ok && current.value.operator).toBe(null)

    const { readFileSync } = await import('node:fs')
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(settings['session.operatorId']).toBeNull()
  })

  it('serves renderer-occupant rows carved out of plugins.yml', async () => {
    const home = mkdtempSync(join(tmpdir(), 'snap-rail-station-'))
    homes.push(home)
    writeFileSync(join(home, 'plugins.yml'), [
      'plugins:',
      '  - name: "@snap-rail/process-sampling"',
      '    config:',
      '      schedule: "*/20 * * * *"',
      '  - name: "@snap-rail/process-production"',
      '    enabled: false',
      '  - name: "@snap-rail/gateway"',
      '    enabled: false',
      '',
    ].join('\n'))

    const host = new Context()
    contexts.push(host)
    host.provide('snapRailHome', home)
    await host.plugin(gatewayPlugin, { name: 'test', version: '0.1.0', bin: 'test' })
    await host.plugin(settingsPlugin)
    await host.plugin(auditPlugin)
    host.provide('pluginLayers', {
      handles: {
        userLayerPath: join(home, 'plugins.yml'),
        rendererPackages: ['@snap-rail/process-sampling', '@snap-rail/process-production'],
      },
    } as never)
    await host.plugin(stationRpcPlugin)

    const client = new InProcessApiClient(request => host.gateway.handleClientRequest(request))
    const rows = await client.call('client-config.list', {})
    expect(rows.ok && rows.value.rows).toEqual([
      { name: '@snap-rail/process-sampling', enabled: true, config: { schedule: '*/20 * * * *' } },
      { name: '@snap-rail/process-production', enabled: false },
    ])
  })
})
