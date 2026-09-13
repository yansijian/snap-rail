/**
 * Pre-flight gates for generated function bodies: require-literal scanning,
 * syntax rejection, whitelist enforcement per half, and plugin-shape checks
 * — the repair loop's first barrier, exercised with both clean and broken
 * bodies (the catalog's own templates double as the clean corpus in
 * catalog.spec).
 *
 * @module snap-rail/forge/tests/runner.spec
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@snap-rail/cordis'
import { evaluateBody, scanRequires, HOST_REQUIRE_IDS } from '../src/runner.ts'

describe('scanRequires', () => {
  it('collects require string literals only', () => {
    const src = [
      "const z = require('zod')",
      'const dyn = require(name)',
      'const q = require("drizzle-orm")',
    ].join('\n')
    expect(scanRequires(src)).toEqual(['zod', 'drizzle-orm'])
  })
})

describe('evaluateBody', () => {
  it('runs a body to its returned plugin object', () => {
    const value = evaluateBody('host', "return { name: 'x', apply() {} }", () => undefined)
    expect(value).toMatchObject({ name: 'x' })
  })

  it('wraps syntax and runtime failures with the half in the message', () => {
    expect(() => evaluateBody('host', 'return {', () => undefined)).toThrow('宿主半边语法错误')
    expect(() => evaluateBody('client', 'throw new Error("boom")', () => undefined)).toThrow('渲染半边执行失败')
  })
})

describe('the pre-flight over a live context', () => {
  it('accepts a whitelist-clean host half and rejects the rest', async () => {
    const { createRunner } = await import('../src/runner.ts')
    const { createRegistry } = await import('../src/registry.ts')
    const ctx = new Context()
    const registry = createRegistry({} as never)
    const runner = createRunner(ctx, registry)
    const good = "const { z } = require('zod')\nreturn { name: 'ok', inject: ['settings'], apply() {} }"
    expect(runner.preflight('host', good)).toBeNull()
    expect(runner.preflight('host', 'return {')).toMatchObject(expect.stringContaining('语法错误'))
    expect(runner.preflight('host', "return require('node:fs')")).toMatchObject(expect.stringContaining('白名单'))
    expect(runner.preflight('host', 'return 42')).toMatchObject(expect.stringContaining('插件对象'))
    await ctx.fiber.dispose()
  })

  it('checks client halves against the seed table without executing them', async () => {
    const { createRunner } = await import('../src/runner.ts')
    const { createRegistry } = await import('../src/registry.ts')
    const ctx = new Context()
    const runner = createRunner(ctx, createRegistry({} as never))
    // react is a seed id; node:fs is not — and the body is never executed
    // here, so a would-be runtime failure stays invisible to pre-flight.
    expect(runner.preflight('client', "const R = require('react')\nreturn { name: 'ui', apply() { R.hooks } }")).toBeNull()
    expect(runner.preflight('client', "return require('node:fs')")).toMatchObject(expect.stringContaining('白名单'))
    await ctx.fiber.dispose()
  })

  it('lists the host whitelist face', () => {
    expect(HOST_REQUIRE_IDS).toContain('zod')
    expect(HOST_REQUIRE_IDS).toContain('@snap-rail/cordis')
  })
})
