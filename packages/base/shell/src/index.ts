/**
 * The OS integration seam — the specification half. Everything a plugin may
 * ask of the operating system arrives here, so that no plugin ever imports
 * Electron: notifications, tray menu contributions, and the lifecycle of the
 * auxiliary surfaces (the floating ball and its mini panel).
 *
 * Ownership follows the click lifetime, not the call site:
 *
 * - **Host face** (`ctx.shell`, this module): actionable notifications
 *   (buttons whose click arrives minutes later), tray menu items, and the
 *   windows themselves. These outlive any renderer, so only a host-face
 *   plugin — a fiber that lives as long as the app — may contribute them. The
 *   events below are the return path.
 * - **Client face** (`@snap-rail/shell/contract`): a one-way toast and
 *   control over the surface the caller renders in. A renderer that vanishes
 *   must not leave a dead menu row or an unanswerable action behind, and a
 *   client cannot be trusted with an OS handle anyway.
 *
 * The service is implemented by the first-party desktop Shell adapter
 * (`apps/desktop/src-host/main/shell`) — the only code in the repository that
 * imports Electron for OS integration. That adapter is a provider like any
 * other: swapping it for a headless or a remote-shell implementation is a
 * provider swap, not a consumer change.
 *
 * @module @snap-rail/shell
 */

import type { Context } from '@snap-rail/cordis'
import type { AuxSurfaceId, SurfaceId } from '@snap-rail/protocol'
import type { BallPatch, BallState, SurfaceState } from './contract.ts'

export * from './contract.ts'

declare module '@snap-rail/cordis' {
  interface Context {
    shell: ShellService
  }

  interface Events {
    /** An OS notification was clicked (its body, not an action button).
     * @param id - the notification id `notify` returned.
     */
    'shell/notification-clicked'(id: string): void
    /** An OS notification's action button was clicked.
     * @param id - the notification id `notify` returned.
     * @param actionId - the action's `id` from the contribution.
     */
    'shell/notification-action'(id: string, actionId: string): void
    /** A contributed tray menu item was picked.
     * @param key - the entry's namespaced key (`<plugin>:<id>`).
     */
    'shell/tray-clicked'(key: string): void
    /** An auxiliary surface appeared, disappeared, or was created.
     * @param state - the surface's state after the change.
     */
    'shell/surface-changed'(state: SurfaceState): void
    /** The host-aggregated ball state changed.
     * @param state - the ball state after the change.
     */
    'shell/ball-changed'(state: BallState): void
  }
}

/** One action button on an OS notification. */
export interface ShellNotificationAction {
  /** Opaque id echoed back through `shell/notification-action` (at most
   * {@link SHELL_LIMITS.actionId} characters). */
  id: string
  /** Button caption (at most {@link SHELL_LIMITS.actionLabel} characters). */
  label: string
}

/**
 * A notification request from a host-face plugin. A toast is fire-and-forget:
 * the plugin is told whether it was raised, and a later click arrives as an
 * event on the context — the registry entry that produced it is the plugin's
 * own responsibility to keep current.
 */
export interface ShellNotificationInput {
  /** Toast title (at most {@link SHELL_LIMITS.title} characters). */
  title: string
  /** Toast body (at most {@link SHELL_LIMITS.body} characters). */
  body?: string | undefined
  /** Action buttons; at most {@link SHELL_LIMITS.notificationActions} render. */
  actions?: readonly ShellNotificationAction[] | undefined
  /** Coalescing tag: a later toast with the same tag replaces the earlier one. */
  tag?: string | undefined
  /** Suppress the notification sound. */
  silent?: boolean | undefined
}

/** Why the Shell refused a capability call. */
export type ShellRefusalReason =
  /** No OS integration at all: a headless or test boot mounted no adapter. */
  | 'no-shell'
  /** A tray item was contributed but no tray icon could be created. */
  | 'no-tray'
  /** A {@link SHELL_LIMITS} cap refused the contribution. */
  | 'limit-reached'
  /** The contribution would reuse a tray id the caller already owns. */
  | 'duplicate'
  /** No such contribution exists (an update/remove of an unknown id). */
  | 'not-found'
  /** The surface is not plugin-controllable (`main`; the Shell owns it). */
  | 'not-controllable'
  /** The surface's window could not be created or shown. */
  | 'unavailable'

/** The uniform answer of a host-face Shell capability call. */
export type ShellResult =
  | { readonly applied: true }
  | { readonly applied: false, readonly reason: ShellRefusalReason, readonly message: string }

/** The answer of {@link ShellService.notify}: a raised toast carries its id. */
export type ShellNotificationResult =
  | { readonly applied: true, readonly id: string }
  | { readonly applied: false, readonly reason: ShellRefusalReason, readonly message: string }

/** One contributed tray menu item. */
export interface ShellTrayItem {
  /** Item id, unique within the contributing plugin (at most
   * {@link SHELL_LIMITS.trayItemId} characters); the click event carries the
   * namespaced key instead. */
  id: string
  /** Menu caption (at most {@link SHELL_LIMITS.trayLabel} characters). */
  label: string
  /** Whether the item is enabled (default `true`). */
  enabled?: boolean | undefined
  /** Checked state for a toggle item; `undefined` means a plain item. */
  checked?: boolean | undefined
}

/** A patch for one contributed tray item: omitted fields keep their value. */
export interface ShellTrayItemPatch {
  label?: string | undefined
  enabled?: boolean | undefined
  checked?: boolean | null | undefined
}

/** A live tray entry: the contribution plus the host-side namespace. */
export interface ShellTrayEntry extends ShellTrayItem {
  /** The contributing plugin's fiber name. */
  plugin: string
  /** The id `shell/tray-clicked` carries — `<plugin>:<id>`. */
  key: string
}

/**
 * Notification and tray contribution. Both are host-face only: their return
 * path (`shell/notification-*`, `shell/tray-clicked`) arrives on a context
 * that must still be alive then.
 */
export interface ShellTrayCapability {
  /** Whether a tray icon exists; `false` makes `addItem` answer `no-tray`. */
  readonly available: boolean
  /** Contribute one menu item; the answer names the refusal when it cannot. */
  addItem(caller: Context, item: ShellTrayItem): ShellResult
  /** Update a contributed item in place. */
  updateItem(caller: Context, id: string, patch: ShellTrayItemPatch): ShellResult
  /** Withdraw a contributed item (idempotent; `applied` is `false` when it was never there). */
  removeItem(caller: Context, id: string): ShellResult
  /** The live contributed entries, in contribution order (diagnostics and tests). */
  entries(): readonly ShellTrayEntry[]
}

/** The window lifecycle of the auxiliary surfaces. */
export interface ShellSurfaceCapability {
  /** Every surface's live state, `main` first. */
  state(): readonly SurfaceState[]
  /** Create the surface's window if needed and show it. `main` means "bring
   * the operator window up and focus it". */
  present(caller: Context, surface: SurfaceId): ShellResult
  /** Hide an auxiliary surface's window (the window is kept for the next present). */
  hide(caller: Context, surface: AuxSurfaceId): ShellResult
}

/**
 * The host-aggregated ball state. A host-face plugin (a production counter, a
 * connection health rollup) writes it without the ball window existing; the
 * ball surface repaints from the `shell/ball-changed` frame.
 */
export interface ShellBallCapability {
  /** The current state. */
  state(): BallState
  /** Merge a patch and broadcast `shell/ball-changed`; returns the new state. */
  setState(caller: Context, patch: BallPatch): BallState
}

/** The OS integration service exposed on `ctx.shell`. */
export interface ShellService {
  /** Whether an OS integration is mounted at all (headless boots answer `false`). */
  readonly available: boolean
  /** Raise an actionable notification; the click arrives as a context event. */
  notify(caller: Context, input: ShellNotificationInput): ShellNotificationResult
  /** Tray menu contributions and their click return path. */
  readonly tray: ShellTrayCapability
  /** Auxiliary surface lifecycle. */
  readonly surface: ShellSurfaceCapability
  /** The host-aggregated ball state. */
  readonly ball: ShellBallCapability
}