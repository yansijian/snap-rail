/**
 * The operator window's geometry write, Electron-free like `./window-source`
 * (the window is injected), so the ordering rule is tested without a display.
 *
 * Windows does not apply a frameless window's constraints and bounds
 * atomically: writing `setMinimumSize`/`setResizable` first lets the OS
 * "correct" the window against the fresh constraints mid-flight and swallow
 * the bounds that follow. Field evidence: a 1280×800 business stage after a
 * 432×768 login landed as a 960×768 half-geometry — the width snapped to the
 * new minimum, the height kept the login's. The ball window hits the same
 * family (electron/electron#41675, see `./ball-place`), and the cure is the
 * same dance: lift every constraint, write the geometry, re-assert the
 * constraints.
 *
 * @module @snap-rail/desktop/main/shell/window-apply
 */

import type { BrowserWindow } from 'electron'
import { WINDOW_LIMITS, type ResolvedWindowProfile } from '@snap-rail/shell'

/** The window surface the geometry write drives. */
export type GeometryWindow = Pick<
  BrowserWindow,
  'setResizable' | 'setMinimumSize' | 'setFullScreen' | 'isFullScreen' | 'maximize' | 'isMaximized' | 'unmaximize' | 'setBounds'
>

/** A display work area (screen coordinates). */
export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

/** A remembered window origin to restore (clamped back into the work area). */
export interface WindowOrigin {
  x: number
  y: number
}

/**
 * Write a resolved profile onto a live window. A windowed profile centres on
 * the work area unless a remembered origin is given; the work area is read
 * lazily, after leaving maximized/full-screen, so it matches the display the
 * window actually lands on.
 */
export function applyResolvedWindowProfile(
  win: GeometryWindow,
  profile: ResolvedWindowProfile,
  workArea: () => WorkArea,
  origin?: WindowOrigin,
): void {
  // Lift: the geometry lands without the OS correcting it mid-flight.
  win.setResizable(true)
  win.setMinimumSize(1, 1)
  if (profile.mode === 'fullscreen') {
    win.setFullScreen(true)
  } else if (profile.mode === 'maximized') {
    if (win.isFullScreen()) win.setFullScreen(false)
    win.maximize()
  } else {
    if (win.isFullScreen()) win.setFullScreen(false)
    if (win.isMaximized()) win.unmaximize()
    const work = workArea()
    const x = origin !== undefined
      ? Math.min(Math.max(origin.x, work.x), work.x + Math.max(0, work.width - WINDOW_LIMITS.minVisiblePx))
      : work.x + Math.round((work.width - profile.width) / 2)
    const y = origin !== undefined
      ? Math.min(Math.max(origin.y, work.y), work.y + Math.max(0, work.height - WINDOW_LIMITS.minVisiblePx))
      : work.y + Math.round((work.height - profile.height) / 2)
    win.setBounds({ x, y, width: profile.width, height: profile.height })
  }
  // Re-assert: the profile's own floor is the only one (a layout declaring
  // nothing resolves to 1×1 — unconstrained).
  win.setMinimumSize(profile.minWidth, profile.minHeight)
  win.setResizable(profile.resizable)
}
