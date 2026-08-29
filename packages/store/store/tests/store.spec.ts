import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import storePlugin from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
    const home = ctx.get('snapRailHome') as string | undefined
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
  }
})

async function makeStore(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('snapRailHome', mkdtempSync(join(tmpdir(), 'snap-rail-store-')))
  await ctx.plugin(storePlugin)
  return ctx
}

describe('store seam', () => {
  it('creates prefixed tables and round-trips rows through the SQL handle', async () => {
    const ctx = await makeStore()
    const store = ctx.store.register(ctx, 'driver_modbus', [
      {
        name: 'devices',
        create: 'id TEXT PRIMARY KEY, title TEXT NOT NULL, port INTEGER NOT NULL',
      },
    ])

    expect(store.table('devices')).toBe('driver_modbus__devices')

    store.run(`INSERT INTO ${store.table('devices')} (id, title, port) VALUES (?, ?, ?)`, ['plc1', '1号炉', 502])
    store.run(`INSERT INTO ${store.table('devices')} (id, title, port) VALUES (?, ?, ?)`, ['plc2', '2号炉', 503])

    const row = store.get<{ id: string, title: string, port: number }>(
      `SELECT * FROM ${store.table('devices')} WHERE id = ?`, ['plc1'])
    expect(row).toEqual({ id: 'plc1', title: '1号炉', port: 502 })

    const all = store.all<{ id: string }>(`SELECT id FROM ${store.table('devices')} ORDER BY id`)
    expect(all.map(entry => entry.id)).toEqual(['plc1', 'plc2'])

    // The database file lives under the snap-rail home.
    const home = ctx.get('snapRailHome') as string
    expect(existsSync(join(home, 'snap-rail.db'))).toBe(true)
  })

  it('is idempotent: re-registering the same tables keeps rows', async () => {
    const ctx = await makeStore()
    const defs = [{ name: 'points', create: 'var TEXT PRIMARY KEY, address INTEGER NOT NULL' }]
    const first = ctx.store.register(ctx, 'driver_modbus', defs)
    first.run(`INSERT INTO ${first.table('points')} (var, address) VALUES (?, ?)`, ['温度1', 100])

    const second = ctx.store.register(ctx, 'driver_modbus', defs)
    const rows = second.all(`SELECT var FROM ${second.table('points')}`)
    expect(rows).toHaveLength(1)
  })

  it('applies addColumns once and keeps existing rows readable', async () => {
    const ctx = await makeStore()
    const base = [{ name: 'devices', create: 'id TEXT PRIMARY KEY, host TEXT NOT NULL' }]
    const first = ctx.store.register(ctx, 'acme', base)
    first.run(`INSERT INTO ${first.table('devices')} (id, host) VALUES (?, ?)`, ['d1', '10.0.0.1'])

    ctx.store.register(ctx, 'acme', [{
      name: 'devices',
      create: 'id TEXT PRIMARY KEY, host TEXT NOT NULL, note TEXT',
      addColumns: ['note TEXT'],
    }])

    // Re-register again: the column exists now, the ALTER must not repeat.
    ctx.store.register(ctx, 'acme', [{
      name: 'devices',
      create: 'id TEXT PRIMARY KEY, host TEXT NOT NULL, note TEXT',
      addColumns: ['note TEXT'],
    }])

    const handle = ctx.store.register(ctx, 'acme', base)
    handle.run(`UPDATE ${handle.table('devices')} SET note = ? WHERE id = ?`, ['remember', 'd1'])
    const row = handle.get<{ id: string, host: string, note: string | null }>(
      `SELECT * FROM ${handle.table('devices')} WHERE id = ?`, ['d1'])
    expect(row).toEqual({ id: 'd1', host: '10.0.0.1', note: 'remember' })
  })

  it('rolls back the whole tx when the body throws', async () => {
    const ctx = await makeStore()
    const store = ctx.store.register(ctx, 'acme', [
      { name: 'log', create: 'id INTEGER PRIMARY KEY, line TEXT NOT NULL' },
    ])
    store.run(`INSERT INTO ${store.table('log')} (line) VALUES (?)`, ['before'])

    expect(() => store.tx(() => {
      store.run(`INSERT INTO ${store.table('log')} (line) VALUES (?)`, ['inside'])
      throw new Error('boom')
    })).toThrow('boom')

    const lines = store.all<{ line: string }>(`SELECT line FROM ${store.table('log')}`)
    expect(lines.map(entry => entry.line)).toEqual(['before'])

    // A committed tx persists both rows; nested tx calls join the outer one.
    store.tx(() => {
      store.run(`INSERT INTO ${store.table('log')} (line) VALUES (?)`, ['a'])
      store.tx(() => {
        store.run(`INSERT INTO ${store.table('log')} (line) VALUES (?)`, ['b'])
      })
    })
    expect(store.all<{ line: string }>(`SELECT line FROM ${store.table('log')}`)).toHaveLength(3)
  })

  it('closes the database on fiber dispose so the home directory is removable', async () => {
    const ctx = await makeStore()
    const home = ctx.get('snapRailHome') as string
    ctx.store.register(ctx, 'acme', [{ name: 't', create: 'id INTEGER PRIMARY KEY' }])
    await ctx.fiber.dispose()
    contexts.length = 0
    expect(() => rmSync(home, { recursive: true, force: true })).not.toThrow()
    expect(existsSync(home)).toBe(false)
  })
})
