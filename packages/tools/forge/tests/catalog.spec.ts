/**
 * Catalog gates: every template's halves pass the same pre-flight the agent
 * faces (a drifted template fails here, never a session at run time), the
 * seed list matches its single source, and every primitive the catalog
 * teaches actually exists in the shared UI seam.
 *
 * @module snap-rail/forge/tests/catalog.spec
 */

import { Context } from '@snap-rail/cordis'
import gatewayPlugin from '@snap-rail/gateway'
import { SEED_MODULES } from '@snap-rail/plugin-kit/seeds'
import * as clientUi from '@snap-rail/client-ui'
import { afterEach, describe, expect, it } from 'vitest'
import { CATALOG_CAPABILITIES, CATALOG_TEMPLATES } from '../src/catalog.ts'
import { SYSTEM_PROMPT } from '../src/prompt.ts'
import { createRunner } from '../src/runner.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose().catch(() => {})
})

/** A context with the gateway live (the minimal template injects `rpc`). */
async function gatewayContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(gatewayPlugin, { name: 'catalog-test', version: '0.1.0', bin: 'test' })
  contexts.push(ctx)
  return ctx
}

describe('the template catalog', () => {
  it('every template half passes pre-flight', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const { createRegistry } = await import('../src/registry.ts')
    const runner = createRunner(ctx, createRegistry({} as never))
    for (const [name, template] of Object.entries(CATALOG_TEMPLATES)) {
      if (template.hostSrc !== null) {
        expect(runner.preflight('host', template.hostSrc), `${name} host`).toBeNull()
      }
      if (template.clientSrc !== null) {
        expect(runner.preflight('client', template.clientSrc), `${name} client`).toBeNull()
      }
      expect(template.hostSrc !== null || template.clientSrc !== null, `${name} has a half`).toBe(true)
    }
  })

  it('the minimal template mounts live end to end', async () => {
    const ctx = await gatewayContext()
    const { createRegistry } = await import('../src/registry.ts')
    const registry = createRegistry({} as never)
    const runner = createRunner(ctx, registry)
    const template = CATALOG_TEMPLATES['minimal-both']
    if (template.hostSrc === null) throw new Error('minimal template lost its host half')
    const result = await runner.mountHost('tpl-minimal', 'v1', template.hostSrc)
    expect(result.ok).toBe(true)
    expect(ctx.rpc.describe().domains.map(domain => domain.prefix)).toContain('hello')
  })
})

describe('the capabilities catalog', () => {
  it('client seeds match the single source', () => {
    expect(CATALOG_CAPABILITIES.clientSeeds).toBe(SEED_MODULES)
  })

  it('every UI primitive the catalog teaches exists in the seam', () => {
    const names = new Set(Object.keys(clientUi))
    const tokens = CATALOG_CAPABILITIES.uiPrimitives
      .split(/[\s,，、（）()：:/·]+/)
      .map(token => token.trim())
      .filter(token => /^[A-Z][A-Za-z0-9]+$/.test(token))
    expect(tokens.length).toBeGreaterThan(20)
    const missing = [...new Set(tokens)].filter(name => !names.has(name))
    expect(missing).toEqual([])
  })

  it('the system prompt names the workflow and the tool set', () => {
    for (const tool of ['rail_inspect', 'rail_define', 'rail_run', 'rail_read']) {
      expect(SYSTEM_PROMPT).toContain(tool)
    }
    expect(SYSTEM_PROMPT).toContain('React.createElement')
  })
})
