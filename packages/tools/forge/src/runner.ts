/**
 * The generated host-half runner: compiles, pre-flights, mounts, and unloads
 * the plain-JS function bodies the agent defines. A host half is a function
 * body over one parameter — `require` — returning a cordis plugin object
 * (`{ name, inject?, apply(ctx) }`); the require it sees is the forge-bundled
 * whitelist table below (the same shared instances the host tree runs on —
 * a second cordis or zod would split schemas and fibers).
 *
 * Pre-flight compiles **and executes** the body (the returned value is only
 * a record until mount), so syntax errors, stray requires, and malformed
 * plugin shapes all surface at `rail_define` time with precise text — the
 * repair loop's first gate. Mount re-executes the body and lets
 * `fiber.await()` rethrow startup errors as diagnostics.
 *
 * The function-body container is an honesty container, not a security
 * boundary (the same trust model as deepseek-harness's dynamic runner):
 * the require whitelist and the absence of node globals are the practical
 * constraint, not isolation.
 *
 * @module @snap-rail/forge/runner
 */

import { Context, type Fiber, type Plugin } from '@snap-rail/cordis'
import * as cordisNamespace from '@snap-rail/cordis'
import * as protocolNamespace from '@snap-rail/protocol'
import * as fieldContractNamespace from '@snap-rail/field/contract'
import * as utilNamespace from '@snap-rail/util'
import * as zodNamespace from 'zod'
import * as drizzleNamespace from 'drizzle-orm'
import * as drizzleSqliteNamespace from 'drizzle-orm/sqlite-core'
import { SEED_MODULES } from '@snap-rail/plugin-kit/seeds'
import type { GeneratedPluginStatus } from './contract.ts'
import type { ForgeRegistry } from './registry.ts'

/** The module ids a generated host half may `require` (the whitelist face). */
export const HOST_REQUIRE_IDS: readonly string[] = [
  '@snap-rail/cordis',
  '@snap-rail/protocol',
  '@snap-rail/field/contract',
  '@snap-rail/util',
  'zod',
  'drizzle-orm',
  'drizzle-orm/sqlite-core',
]

/** The whitelist table itself: the host tree's own shared instances. */
const HOST_REQUIRE_TABLE: Readonly<Record<string, unknown>> = {
  '@snap-rail/cordis': cordisNamespace,
  '@snap-rail/protocol': protocolNamespace,
  '@snap-rail/field/contract': fieldContractNamespace,
  '@snap-rail/util': utilNamespace,
  'zod': zodNamespace,
  'drizzle-orm': drizzleNamespace,
  'drizzle-orm/sqlite-core': drizzleSqliteNamespace,
}

/** Extract every `require('…')` string literal in the body. */
export function scanRequires(src: string): string[] {
  const found: string[] = []
  const pattern = /\brequire\s*\(\s*(['"])((?:[^\\'"]|\\.)*)\1\s*\)/g
  for (const match of src.matchAll(pattern)) {
    const id = match[2]
    if (id !== undefined) found.push(id)
  }
  return found
}

/** Compile and run one function body under a custom require; throws with
 * the forge-side context on any failure. */
export function evaluateBody(kind: 'host' | 'client', src: string, requireFace: (id: string) => unknown): unknown {
  const label = kind === 'host' ? '宿主' : '渲染'
  let factory: (require: (id: string) => unknown) => unknown
  try {
    factory = new Function('require', `"use strict";\n${src}`) as typeof factory
  } catch (cause) {
    throw new Error(`${label}半边语法错误：${errorText(cause)}`)
  }
  try {
    return factory(requireFace)
  } catch (cause) {
    throw new Error(`${label}半边执行失败：${errorText(cause)}`)
  }
}

/** Assert the evaluated body returned a plausible cordis plugin object. */
export function assertPluginShape(value: unknown, kind: 'host' | 'client'): void {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${kind} 半边必须 return 一个插件对象（{ name, inject?, apply(ctx) }），实际返回 ${describe(value)}`)
  }
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || record.name === '') {
    throw new Error(`${kind} 半边返回的插件对象缺少字符串字段 name`)
  }
  if (typeof record.apply !== 'function') {
    throw new Error(`${kind} 半边返回的插件对象缺少函数字段 apply(ctx)`)
  }
}

/** The runner over one owning context and the registry's mount board. */
export interface HostRunner {
  /** Full pre-flight for a host half: compile, scan requires, execute, check
   * the shape. For a client half: compile and scan against SEED_MODULES only
   * — the renderer modules do not exist in this process, so execution and
   * the shape check ride the renderer runner's `forge.client-report` back.
   * Returns `null` when acceptable, else the failure text. */
  preflight(kind: 'host' | 'client', src: string): string | null
  /** Mount (or replace) the plugin's host half; resolves with the outcome. */
  mountHost(id: string, versionId: string, src: string): Promise<HostMountResult>
  /** Unmount the plugin's host half if mounted (idempotent). */
  unmountHost(id: string): Promise<void>
  /** The currently mounted host fibers' plugin ids (for unload-all). */
  mountedIds(): readonly string[]
}

/** One mount attempt's outcome; diagnostics carry the repair-loop text. */
export type HostMountResult = { ok: true } | { ok: false, diagnostics: string }

/** Construct the runner. The owning context parents every generated fiber. */
export function createRunner(ctx: Context, registry: ForgeRegistry): HostRunner {
  const mounted = new Map<string, { fiber: Fiber, versionId: string }>()

  const hostRequire = (id: string): unknown => {
    const module = HOST_REQUIRE_TABLE[id]
    if (module === undefined) {
      throw new Error(`require("${id}") 不在宿主半边白名单内。可用模块：${HOST_REQUIRE_IDS.join('、')}`)
    }
    return module
  }

  return {
    preflight(kind: 'host' | 'client', src: string): string | null {
      try {
        // Compile gate — both halves are plain function bodies.
        try {
          // eslint-disable-next-line no-new-func -- the generated-code container
          new Function('require', `"use strict";\n${src}`)
        } catch (cause) {
          throw new Error(`${kind} 半边语法错误：${errorText(cause)}`)
        }
        // Require gate — literals are scanned statically; anything dynamic
        // still fails at run time against the same whitelist.
        const allowed = kind === 'host' ? HOST_REQUIRE_IDS : SEED_MODULES
        for (const id of scanRequires(src)) {
          if (!allowed.includes(id)) {
            throw new Error(`require("${id}") 不在${kind === 'host' ? '宿主' : '渲染'}半边白名单内。可用模块：${allowed.join('、')}`)
          }
        }
        // Shape gate — host halves run here (the modules exist in-process);
        // client halves execute in the renderer and report back.
        if (kind === 'host') {
          const value = evaluateBody('host', src, hostRequire)
          assertPluginShape(value, 'host')
        }
        return null
      } catch (cause) {
        return errorText(cause)
      }
    },

    async mountHost(id: string, versionId: string, src: string): Promise<HostMountResult> {
      // Replace semantics: the old fiber goes first, one plugin one host half.
      await this.unmountHost(id)
      let plugin: Plugin
      try {
        const value = evaluateBody('host', src, hostRequire)
        assertPluginShape(value, 'host')
        plugin = value as Plugin
      } catch (cause) {
        const diagnostics = errorText(cause)
        registry.setStatus(id, 'error', diagnostics)
        return { ok: false, diagnostics }
      }
      try {
        const fiber = ctx.plugin(plugin)
        mounted.set(id, { fiber, versionId })
        await fiber
        registry.setStatus(id, 'running', null)
        return { ok: true }
      } catch (cause) {
        mounted.delete(id)
        const diagnostics = `宿主半边挂载失败：${errorText(cause)}`
        registry.setStatus(id, 'error', diagnostics)
        return { ok: false, diagnostics }
      }
    },

    async unmountHost(id: string): Promise<void> {
      const entry = mounted.get(id)
      if (entry === undefined) return
      mounted.delete(id)
      try {
        await entry.fiber.dispose()
      } catch (cause) {
        ctx.logger('forge').warn?.(`卸载 ${id} 宿主半边时出错：${errorText(cause)}`)
      }
      const remaining: GeneratedPluginStatus = 'stopped'
      registry.setStatus(id, remaining, null)
    },

    mountedIds(): readonly string[] {
      return [...mounted.keys()]
    },
  }
}

/** Compact error text with the cause's message and first stack frame. */
function errorText(cause: unknown): string {
  if (cause instanceof Error) {
    const frame = cause.stack?.split('\n').find(line => line.trim().startsWith('at '))
    return frame === undefined ? cause.message : `${cause.message}（${frame.trim()}）`
  }
  return String(cause)
}

/** A short type description for shape diagnostics. */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
