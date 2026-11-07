/**
 * The operator window's profile-source policy, Electron-free and tested like
 * `./machine`. It answers the two questions the adapter asks while wiring OS
 * events:
 *
 * - **Who owns the current profile?** Only `user` — the appearance page's
 *   explicit fix — refuses layout/face requests. Remembered (`persisted`)
 *   geometry is a boot-time restore, not a lock: a remembered size must never
 *   wedge the stage (a login face asking for a portrait panel has to win over
 *   whatever the last session left behind).
 * - **Is a geometry change an operator gesture?** Only events arriving
 *   outside a programmatic apply's settle window are remembered. Applies
 *   cancel queued saves and open a settle window because `maximize`/
 *   full-screen events land asynchronously on Windows — without it, every
 *   face/layout apply would write itself into the remembered state and
 *   masquerade as an operator gesture from then on.
 *
 * @module @snap-rail/desktop/main/shell/window-source
 */

import type { UiProfileSource } from '@snap-rail/shell'

/**
 * How long geometry events after a programmatic apply still belong to that
 * apply (maximize/full-screen transitions emit their events asynchronously).
 */
export const WINDOW_APPLY_SETTLE_MS = 250

/** The source/persistence policy the Shell adapter wires window events into. */
export interface WindowSourceTracker {
  /** The current owner label published with the profile state. */
  state(): UiProfileSource
  /** Whether a configure request must be refused (only an operator fix refuses). */
  locked(): boolean
  /** Boot: an operator-fixed profile owns the window; remembered bounds do not. */
  boot(userFixed: boolean): void
  /** The appearance page applied an operator profile. */
  applyUser(): void
  /** A layout/face request was honoured. */
  applyRequested(): void
  /** An operator gesture was written into the remembered state. */
  noteRemembered(): void
  /** 跟随布局: the operator released the window back to the active layout. */
  reset(): void
  /** Open the settle window at the start of a programmatic apply. */
  beginApply(): void
  /** Whether geometry events still belong to a programmatic apply. */
  settling(): boolean
}

/** The options {@link createWindowSourceTracker} is built with. */
export interface WindowSourceTrackerOptions {
  /** Clock override for the settle window (tests drive it). */
  now?: (() => number) | undefined
}

/**
 * Create the window profile-source policy. Starts at `default`; the adapter
 * calls {@link WindowSourceTracker.boot} once it has read the settings.
 */
export function createWindowSourceTracker(options: WindowSourceTrackerOptions = {}): WindowSourceTracker {
  const now = options.now ?? Date.now
  let source: UiProfileSource = 'default'
  let appliedAt = -Number.MAX_SAFE_INTEGER
  return {
    state: () => source,
    locked: () => source === 'user',
    boot: userFixed => {
      source = userFixed ? 'user' : 'default'
    },
    applyUser: () => {
      source = 'user'
    },
    applyRequested: () => {
      source = 'layout'
    },
    noteRemembered: () => {
      source = 'persisted'
    },
    reset: () => {
      source = 'default'
    },
    beginApply: () => {
      appliedAt = now()
    },
    settling: () => {
      return now() - appliedAt < WINDOW_APPLY_SETTLE_MS
    },
  }
}
