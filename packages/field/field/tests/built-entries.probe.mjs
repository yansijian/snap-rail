/**
 * The built-faces probe, run by plain node from built-entries.spec.ts:
 * bundling the field entries as separate single-entry passes once
 * duplicated the FieldError class, so every mapped seam failure surfaced
 * as bare `internal` — invisible to source-graph tests (one module, one
 * class) and to vitest's mixed src/lib graph. Only the production
 * resolution (everything through node_modules, the way the desktop host
 * loads plugins) can see the packaging; vitest would alias some imports
 * back to src and hide it again. Build before testing (repo convention).
 */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const nodeRequire = createRequire(import.meta.url)
const { Context } = nodeRequire('@snap-rail/cordis')
const gatewayPlugin = nodeRequire('@snap-rail/gateway').default
const auditPlugin = nodeRequire('@snap-rail/audit').default
const storePlugin = nodeRequire('@snap-rail/store').default
const { z } = nodeRequire('zod')
const fieldPlugin = (await import('../lib/index.js')).default
const fieldRpcPlugin = (await import('../lib/rpc.js')).default
const { FieldError } = await import('../lib/index.js')

const home = mkdtempSync(join(tmpdir(), 'snap-rail-field-lib-'))
const ctx = new Context()
ctx.provide('snapRailHome', home)
await ctx.plugin(gatewayPlugin, { name: 'lib-probe', version: '0.1.0', bin: 'test' })
await ctx.plugin(auditPlugin)
await ctx.plugin(storePlugin)
await ctx.plugin(fieldPlugin)
await ctx.plugin(fieldRpcPlugin)
await ctx.plugin(Object.assign(
  function rigDriver(sub) {
    sub.field.registerDriver(sub, {
      id: 'rig',
      title: 'Rig',
      schemas: {
        device: z.object({}).strict(),
        point: z.object({ type: z.enum(['bool', 'int', 'float', 'string']), factor: z.number() }).strict(),
      },
      createConnection: () => ({ update: () => undefined, dispose: () => undefined }),
    })
  },
  { inject: ['field'] },
))
ctx.field.upsertDevice({ name: 'd1', driver: 'rig', config: {} })
ctx.field.upsertGroup('d1', { name: 'g', type: 'int' })

// The core's failure is the one class the rpc bridge checks against.
assert.doesNotThrow(() => ctx.field.upsertPoint('d1', 'g', { name: 'ok', config: { factor: 2 } }))
try {
  ctx.field.upsertPoint('d1', 'g', { name: 'bad', config: {} })
  assert.fail('invalid config accepted')
} catch (cause) {
  assert.ok(cause instanceof FieldError, 'core throws the shared FieldError class')
}

let rpcSeq = 0
const call = async (method, payload) => {
  rpcSeq += 1
  const response = await ctx.rpc.handleClientRequest(
    { type: 'client-request', rpcId: `p-${rpcSeq}`, method, payload })
  return response.result
}

// The regression rows: a mapped seam failure is a readable bad-request,
// and a zero-valued dialect field round-trips (the address-0 trap class).
const invalid = await call('field.points.upsert', { device: 'd1', group: 'g', point: { name: 'p1', config: {} } })
assert.equal(invalid.ok, false)
assert.equal(invalid.error.code, 'bad-request')
assert.ok(invalid.error.details.issues.join('; ').includes('rejected by driver'), 'issue text rides the wire')

const zero = await call('field.points.upsert', { device: 'd1', group: 'g', point: { name: 'zero', config: { factor: 0 } } })
assert.equal(zero.ok, true)
assert.deepEqual(ctx.field.config().devices[0].groups[0].points.find(point => point.name === 'zero'), { name: 'zero', config: { factor: 0 } })

await ctx.fiber.dispose()
rmSync(home, { recursive: true, force: true })
console.log('BUILT-ENTRIES-OK')
