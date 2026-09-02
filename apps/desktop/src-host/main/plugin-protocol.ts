/**
 * The `snap-plugin://` privileged scheme: the renderer's transport for pool
 * plugin assets. Classic `<script src>`/fetch against this scheme maps
 * `snap-plugin://pool/<pkg…>/<path>` onto `<poolDir>/<pkg…>/<path>` — the
 * same one path dev and production load from, so plugin authors never meet
 * a works-in-dev-breaks-in-prod split. The scheme is registered privileged
 * (standard, supportFetchAPI, stream) before app ready and handled with
 * Electron's `protocol.handle` afterwards; future seats (signing, permission
 * checks, caching) hang off this single layer.
 *
 * @module @snap-rail/desktop/main/plugin-protocol
 */

import { net, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The wire name of the scheme (also allow-listed in the page CSP). */
export const PLUGIN_SCHEME = 'snap-plugin'

/** Register the scheme as privileged — must run before `app.whenReady()`. */
export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ])
}

/**
 * Serve pool plugin assets: `snap-plugin://pool/<pkg…>/<path>` reads
 * `<poolDir>/<pkg…>/<path>`. Path traversal out of the pool is refused —
 * the resolved file URL must stay under the pool root.
 *
 * @param poolDir - the plugin pool directory (`<home>/plugins`).
 */
export function handlePluginScheme(poolDir: string): void {
  const poolRoot = `${pathToFileURL(join(poolDir, '.')).href}`
  protocol.handle(PLUGIN_SCHEME, request => {
    const url = new URL(request.url)
    if (url.hostname !== 'pool') {
      return new Response('not found', { status: 404 })
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const target = join(poolDir, relative)
    if (!pathToFileURL(target).href.startsWith(poolRoot)) {
      return new Response('forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(target).href, { bypassCustomProtocolHandlers: true })
  })
}
