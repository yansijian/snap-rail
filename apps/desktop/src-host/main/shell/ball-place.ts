/**
 * The one safe way to write the ball window's position.
 *
 * Windows re-derives a `resizable: false` window's frame through the display
 * scale factor on every reposition, and the rounding can only grow the
 * window — a ball dragged at display rate gains a pixel per `setPosition`
 * call and balloons past its profile size within seconds
 * (electron/electron#41675). Flipping the resizable flag around the write is
 * the dance the profile swap already uses for the same family of rounding;
 * the trailing size check re-asserts the exact square whatever the round
 * trip still mangled.
 *
 * @module @snap-rail/desktop/main/shell/ball-place
 */

import type { Size } from './dock.ts'

/** The window surface {@link placeBall} drives — a structural slice of BrowserWindow. */
export interface BallPlaceWindow {
  isDestroyed(): boolean
  setResizable(resizable: boolean): void
  getPosition(): number[]
  setPosition(x: number, y: number): void
  getSize(): number[]
  setSize(width: number, height: number): void
}

/**
 * Write the ball window's position without letting the OS grow it.
 *
 * A no-op for the position write when the window already sits at `x, y` (the
 * drag follow poll keeps ticking while the pointer rests); the size check
 * runs either way, so one stray write cannot outlive its tick.
 */
export function placeBall(win: BallPlaceWindow, size: Size, x: number, y: number): void {
  if (win.isDestroyed()) return
  const [atX, atY] = win.getPosition()
  if (atX === undefined || atY === undefined || atX !== x || atY !== y) {
    win.setResizable(true)
    win.setPosition(x, y)
    win.setResizable(false)
  }
  const [width, height] = win.getSize()
  if (width !== size.width || height !== size.height) {
    win.setResizable(true)
    win.setSize(size.width, size.height)
    win.setResizable(false)
  }
}
