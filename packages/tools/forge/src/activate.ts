/**
 * The one activation semantics: move the version pointer, enable the plugin,
 * and mount both halves (host synchronously awaited, renderer pushed). The
 * agent's `rail_run`, the workbench's admin RPCs, and boot remounting all
 * path through here — one meaning of "activate" for every caller.
 *
 * @module @snap-rail/forge/activate
 */

import type { ClientDispatch } from './dispatch.ts'
import type { ForgeRegistry } from './registry.ts'
import type { HostRunner } from './runner.ts'

/** One activation attempt's outcome; diagnostics carry the repair text. */
export type ActivateResult = { ok: boolean, diagnostics?: string }

/** The activator over the registry, runner, and dispatcher. */
export type Activator = (id: string, versionId: string) => Promise<ActivateResult>

/** Construct the activator (and its inverse) over the host-side pieces. */
export function createActivator(registry: ForgeRegistry, runner: HostRunner, dispatch: ClientDispatch): {
  activate: Activator
  /** Unmount both halves and disable (stop, or removal's first leg). */
  deactivate(id: string): Promise<void>
} {
  const activate: Activator = async (id, versionId) => {
    const version = registry.readVersion(id, versionId)
    if (version === undefined) return { ok: false, diagnostics: `版本 ${versionId} 不存在` }
    if (version.hostSrc === null && version.clientSrc === null) {
      return { ok: false, diagnostics: '该版本两个半边都为空' }
    }
    registry.setCurrent(id, versionId)
    registry.setEnabled(id, true)
    if (version.hostSrc !== null) {
      const result = await runner.mountHost(id, versionId, version.hostSrc)
      if (!result.ok) return { ok: false, diagnostics: result.diagnostics }
    } else {
      registry.setStatus(id, 'running', null)
    }
    if (version.clientSrc !== null) dispatch.mountClient(id, versionId, version.clientSrc)
    dispatch.notifyPluginsChanged()
    return { ok: true }
  }

  const deactivate = async (id: string): Promise<void> => {
    await runner.unmountHost(id)
    dispatch.unmountClient(id)
    registry.setEnabled(id, false)
    registry.setStatus(id, 'stopped', null)
    dispatch.notifyPluginsChanged()
  }

  return { activate, deactivate }
}
