/** Desktop Host boundary.
 *
 * Electron owns windows and IPC carriers. This module owns the application
 * Host lifecycle and exposes only a settled Cordis context to the shell. The
 * boundary makes a future utility-process Host an implementation change rather
 * than a renderer or plugin API change.
 *
 * @module @snap-rail/desktop/main/host
 */

import { boot, type BootOptions } from '@snap-rail/app-boot'
import type { Context } from '@snap-rail/cordis'

/** A running desktop Host. */
export interface DesktopHost {
  readonly ctx: Context
  dispose(): Promise<void>
}

/** Start the Node Host and its hot composition watcher. */
export async function startDesktopHost(options: BootOptions): Promise<DesktopHost> {
  const ctx = await boot(options)
  ctx.effect(() => ctx.pluginLayers.startWatch())
  return {
    ctx,
    dispose: () => ctx.fiber.dispose(),
  }
}
