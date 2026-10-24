/**
 * Renderer-face authoring API: the host link and frame helpers every client
 * face consumes. The values re-export the base seed `@snap-rail/connection`;
 * `clientBundle` keeps that seed external, so this module compiles to a tiny
 * require shim rather than a private copy of the carrier.
 *
 * @module @snap-rail/plugin-sdk/api/client
 */

export { rpcErrorText, subscribeFrame } from '@snap-rail/connection'
export type { HostLink } from '@snap-rail/connection'