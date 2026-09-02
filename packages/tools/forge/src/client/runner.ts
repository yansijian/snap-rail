/**
 * The renderer-half runner (the client mirror of the host runner): mounts
 * generated client halves as child fibers of the forge renderer plugin. A
 * client half is the same plain-JS function body; its `require` is the
 * module loader's global `require` face — the seeded shared instances, and
 * nothing else resolves. Outcomes (success or load diagnostics) ride
 * `forge.client-report` back to the host, where they steer the agent loop.
 *
 * Delivery is pull-plus-push: the boot pull (`forge.gen-faces`) is
 * authoritative (the renderer may start after the host's mounts), the
 * `forge/gen-mounted`/`forge/gen-unmounted` frames are the hot path.
 *
 * @module @snap-rail/forge/client/runner
 */

import type { Context, Fiber, Plugin } from '@snap-rail/cordis'
import type { ClientHandle } from '@snap-rail/client-runtime'
import { subscribeFrame } from '@snap-rail/connection'
import type { ModuleLoaderGlobal } from '@snap-rail/client-modules'
import { genMountedSchema, genUnmountedSchema, type GenFace } from '../contract.ts'

/** One mounted renderer half's bookkeeping. */
interface MountedHalf {
  fiber: Fiber
  versionId: string
}

/** Start the runner inside the forge renderer plugin's apply. */
export function startGenRunner(ctx: Context): void {
  const link: ClientHandle['link'] = ctx.client.link
  const mounted = new Map<string, MountedHalf>()

  const seededRequire = (id: string): unknown => {
    const loader = (globalThis as { __ModuleLoader__?: ModuleLoaderGlobal }).__ModuleLoader__
    if (loader === undefined) throw new Error('渲染进程模块加载器不可用')
    return loader.require(id)
  }

  const report = (id: string, versionId: string, ok: boolean, message?: string): void => {
    void link.call('forge.client-report', {
      id,
      versionId,
      stage: 'load',
      ok,
      ...(message !== undefined ? { message } : {}),
    })
  }

  const unmount = (id: string): void => {
    const half = mounted.get(id)
    if (half === undefined) return
    mounted.delete(id)
    void half.fiber.dispose().catch(() => undefined)
  }

  const mount = (face: GenFace): void => {
    unmount(face.id)
    let plugin: unknown
    try {
      // eslint-disable-next-line no-new-func -- the generated-code container
      const factory = new Function('require', `"use strict";\n${face.src}`) as (require: (id: string) => unknown) => unknown
      plugin = factory(seededRequire)
    } catch (cause) {
      report(face.id, face.versionId, false, cause instanceof Error ? cause.message : String(cause))
      return
    }
    if (typeof plugin !== 'object' || plugin === null || typeof (plugin as { apply?: unknown }).apply !== 'function') {
      report(face.id, face.versionId, false, '函数体没有 return 一个含 apply(ctx) 的插件对象')
      return
    }
    try {
      const fiber = ctx.plugin(plugin as Plugin)
      mounted.set(face.id, { fiber, versionId: face.versionId })
      void Promise.resolve(fiber).then(
        () => report(face.id, face.versionId, true),
        cause => {
          mounted.delete(face.id)
          report(face.id, face.versionId, false, cause instanceof Error ? cause.message : String(cause))
        },
      )
    } catch (cause) {
      report(face.id, face.versionId, false, cause instanceof Error ? cause.message : String(cause))
    }
  }

  // Boot pull: every enabled plugin's active renderer half, in order.
  void link.call('forge.gen-faces', {}).then(result => {
    if (result.ok) for (const face of result.value.faces) mount(face)
  })

  // Hot path: host-pushed mounts and unmounts.
  ctx.effect(() => subscribeFrame(link, 'forge/gen-mounted', genMountedSchema, mount))
  ctx.effect(() => subscribeFrame(link, 'forge/gen-unmounted', genUnmountedSchema, ({ id }) => unmount(id)))

  // This plugin's own unload takes every generated half down with it.
  ctx.effect(() => () => {
    for (const id of [...mounted.keys()]) unmount(id)
  })
}
