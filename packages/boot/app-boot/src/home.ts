/**
 * Resolution of the snap-rail home directory: the one writable root that owns
 * `plugins.yml`, `settings.json`, `audit.jsonl`, and the plugin pool.
 *
 * @module @snap-rail/app-boot/home
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Resolve the snap-rail home directory.
 *
 * Precedence: explicit argument, then `SNAP_RAIL_HOME`, then `~/.snap-rail`.
 *
 * @param explicit - caller-provided path, when the host owns the location
 * (Electron passes its `userData` directory).
 * @returns the absolute home directory; existence is the caller's concern.
 */
export function resolveHome(explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return resolve(explicit)
  const fromEnv = process.env.SNAP_RAIL_HOME
  if (fromEnv !== undefined && fromEnv !== '') return resolve(fromEnv)
  return join(homedir(), '.snap-rail')
}
