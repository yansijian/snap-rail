import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@snap-rail/cordis'
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { eq } from 'drizzle-orm'
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

const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  port: integer('port').notNull(),
})

/** One database file per namespace, ignoring WAL sidecar files. */
function dataFiles(home: string): string[] {
  return readdirSync(join(home, 'data')).filter(name => name.endsWith('.db'))
}

describe('store seam (drizzle namespaces)', () => {
  it('round-trips typed rows and writes one database file per namespace', async () => {
    const ctx = await makeStore()
    const db = ctx.store.register(ctx, 'acme', { devices })

    db.insert(devices).values({ id: 'plc1', title: '1号炉', port: 502 }).run()
    db.insert(devices).values({ id: 'plc2', title: '2号炉', port: 503 }).run()

    const row = db.select().from(devices).where(eq(devices.id, 'plc1')).get()
    expect(row).toEqual({ id: 'plc1', title: '1号炉', port: 502 })

    const all = db.select({ id: devices.id }).from(devices).orderBy(devices.id).all()
    expect(all.map(entry => entry.id)).toEqual(['plc1', 'plc2'])

    const home = ctx.get('snapRailHome') as string
    expect(existsSync(join(home, 'data', 'acme.db'))).toBe(true)
    expect(dataFiles(home)).toEqual(['acme.db'])
  })

  it('is idempotent: re-registering the same schema keeps rows', async () => {
    const ctx = await makeStore()
    ctx.store.register(ctx, 'acme', { devices })
      .insert(devices).values({ id: 'd1', title: 't', port: 1 }).run()

    const second = ctx.store.register(ctx, 'acme', { devices })
    expect(second.select().from(devices).all()).toHaveLength(1)
  })

  it('appends columns added to the schema and keeps existing rows readable', async () => {
    const ctx = await makeStore()
    const base = sqliteTable('devices', {
      id: text('id').primaryKey(),
      host: text('host').notNull(),
    })
    ctx.store.register(ctx, 'acme', { devices: base })
      .insert(base).values({ id: 'd1', host: '10.0.0.1' }).run()

    const evolved = sqliteTable('devices', {
      id: text('id').primaryKey(),
      host: text('host').notNull(),
      note: text('note'),
    })
    const db = ctx.store.register(ctx, 'acme', { devices: evolved })
    // Registering again must not repeat the ALTER.
    ctx.store.register(ctx, 'acme', { devices: evolved })

    db.update(evolved).set({ note: 'remember' }).where(eq(evolved.id, 'd1')).run()
    const row = db.select().from(evolved).where(eq(evolved.id, 'd1')).get()
    expect(row).toEqual({ id: 'd1', host: '10.0.0.1', note: 'remember' })
  })

  it('builds composite primary keys from the table-level builder', async () => {
    const ctx = await makeStore()
    const points = sqliteTable('points', {
      deviceId: text('device_id').notNull(),
      group: text('group').notNull(),
      name: text('name').notNull(),
    }, table => [
      primaryKey({ columns: [table.deviceId, table.group, table.name] }),
    ])
    const db = ctx.store.register(ctx, 'field', { points })
    db.insert(points).values({ deviceId: 'd1', group: 'g1', name: '温度' }).run()

    // The composite key rejects a duplicate identity.
    expect(() => db.insert(points).values({ deviceId: 'd1', group: 'g1', name: '温度' }).run())
      .toThrow()
    const rows = db.select().from(points).all()
    expect(rows).toEqual([{ deviceId: 'd1', group: 'g1', name: '温度' }])
  })

  it('isolates namespaces into separate database files', async () => {
    const ctx = await makeStore()
    const alpha = ctx.store.register(ctx, 'alpha', { devices })
    const beta = ctx.store.register(ctx, 'beta', { devices })
    alpha.insert(devices).values({ id: 'a1', title: 'A', port: 1 }).run()
    beta.insert(devices).values({ id: 'b1', title: 'B', port: 2 }).run()

    expect(alpha.select().from(devices).all().map(row => row.id)).toEqual(['a1'])
    expect(beta.select().from(devices).all().map(row => row.id)).toEqual(['b1'])

    const home = ctx.get('snapRailHome') as string
    expect(new Set(dataFiles(home))).toEqual(new Set(['alpha.db', 'beta.db']))
  })

  it('rolls back the transaction body and commits clean ones', async () => {
    const ctx = await makeStore()
    const db = ctx.store.register(ctx, 'acme', { devices })
    db.insert(devices).values({ id: 'keep', title: 't', port: 0 }).run()

    expect(() => db.transaction(tx => {
      tx.insert(devices).values({ id: 'lost', title: 't', port: 1 }).run()
      throw new Error('boom')
    })).toThrow('boom')
    expect(db.select().from(devices).all().map(row => row.id)).toEqual(['keep'])

    db.transaction(tx => {
      tx.insert(devices).values({ id: 'a', title: 't', port: 1 }).run()
      tx.insert(devices).values({ id: 'b', title: 't', port: 2 }).run()
    })
    expect(db.select().from(devices).all()).toHaveLength(3)
  })

  it('closes every database on fiber dispose so the home directory is removable', async () => {
    const ctx = await makeStore()
    const home = ctx.get('snapRailHome') as string
    ctx.store.register(ctx, 'acme', { devices })
    ctx.store.register(ctx, 'beta', { devices })
    await ctx.fiber.dispose()
    contexts.length = 0
    expect(() => rmSync(home, { recursive: true, force: true })).not.toThrow()
    expect(existsSync(home)).toBe(false)
  })
})
