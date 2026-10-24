/**
 * Host-face authoring API: the base service types an external plugin's host
 * face types against. The module is type-only — importing it emits no runtime
 * code — and the underlying gateway/settings packages are dependencies of this
 * SDK, so a plugin never installs them directly.
 *
 * The empty type imports are deliberate: they put the owning declarations in
 * the program, which is what applies their `Context.rpc` / `Context.settings`
 * augmentation.
 *
 * @module @snap-rail/plugin-sdk/api
 */

import type {} from '@snap-rail/gateway'
import type {} from '@snap-rail/settings'

export type { GatewayService } from '@snap-rail/gateway'
export type { SettingsService } from '@snap-rail/settings'