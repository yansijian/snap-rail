/**
 * The auxiliary surface's renderer entry: the transparent, always-on-top
 * window the Shell creates for the floating ball or its mini panel.
 *
 * The Shell appends `?surface=ball|panel` when it loads this page, so one entry
 * serves both windows; the surface id decides which plugin faces load here (see
 * `renderer-boot.tsx`) and is passed to the framework runtime so the UI stack
 * can render the right shell.
 *
 * There is deliberately no plugin-row auto-reload here: an auxiliary window is
 * created on demand and kept warm, and reloading it under the operator's cursor
 * would be worse than picking up a row change on the next present.
 *
 * @module @snap-rail/desktop/client-surface
 */

import { isAuxSurfaceId, type AuxSurfaceId } from '@snap-rail/protocol'
import { bootRenderer } from './renderer-boot.tsx'

const element = document.getElementById('root')
if (element === null) throw new Error('client: #root is missing from surface.html')

/** The surface this window was created for. */
function requestedSurface(): AuxSurfaceId | undefined {
  const raw = new URLSearchParams(window.location.search).get('surface')
  return isAuxSurfaceId(raw) ? raw : undefined
}

const surface = requestedSurface()
if (surface === undefined) {
  throw new Error('client: surface.html was loaded without ?surface=ball|panel')
}

await bootRenderer({ element, surface })