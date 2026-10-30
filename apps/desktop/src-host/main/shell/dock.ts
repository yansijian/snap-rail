/**
 * The floating ball's docking math — pure, Electron-free, tested. The ball can
 * be dragged anywhere on screen (the host clamps the drag to the work area it
 * is over, so the ball never leaves the screen); when a drag settles near a
 * work-area edge the ball **parks** there, flush with the edge. Once the
 * pointer leaves a parked ball it tucks itself into the edge until only
 * {@link BALL_SURFACE.dockVisibleRatio} of the window remains on screen (the
 * familiar floating-ball sliver) — on every edge alike; hovering the visible
 * strip slides it back out.
 *
 * Reveal and tuck are decided by a tiny cursor-driven machine
 * ({@link tickTuck}): hovering the visible strip slides the ball out; the
 * pointer leaving it tucks it back after a delay — but only after the pointer
 * was seen away from the strip at least once, so a ball tucked under a
 * resting pointer does not pop straight back out.
 *
 * @module @snap-rail/desktop/main/shell/dock
 */

import { BALL_SURFACE, type BallDockEdge } from '@snap-rail/shell'

/** A point in screen coordinates. */
export interface Point {
  x: number
  y: number
}

/** A window's content size. */
export interface Size {
  width: number
  height: number
}

/** A rectangle in screen coordinates (a display's work area or a window). */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A parked ball: the edge it sits on and where along it (cross-axis offset from the work area's origin). */
export interface BallDock {
  edge: BallDockEdge
  offset: number
}

/** How close a drag must settle to an edge for the ball to park there. */
export const DOCK_SNAP_PX = 16

/** How long the pointer must stay away from a revealed, parked ball before it tucks back in. */
export const DOCK_TUCK_DELAY_MS = 600

/** Pixels of the ball window that stay inside the work area while parked. */
export function visiblePxOf(size: Size, ratio: number = BALL_SURFACE.dockVisibleRatio): number {
  return Math.max(1, Math.round(Math.min(size.width, size.height) * ratio))
}

/**
 * Whether the edge is one of the screen's vertical sides (left/right): the
 * parked ball's cross axis then is the work area's height, and the tucked
 * position slides along X instead of Y.
 *
 * @param edge - the parked edge.
 */
export function isVerticalEdge(edge: BallDockEdge): boolean {
  return edge === 'left' || edge === 'right'
}

/** Clamp a window position so its rect stays inside a work area. */
export function clampPosition(position: Point, size: Size, work: Rect): Point {
  const maxX = Math.max(work.x, work.x + work.width - size.width)
  const maxY = Math.max(work.y, work.y + work.height - size.height)
  return {
    x: Math.min(Math.max(position.x, work.x), maxX),
    y: Math.min(Math.max(position.y, work.y), maxY),
  }
}

/** Keep a dock's cross-axis offset inside the work area. */
export function clampDock(dock: BallDock, size: Size, work: Rect): BallDock {
  const vertical = isVerticalEdge(dock.edge)
  const span = vertical ? work.height : work.width
  const windowSpan = vertical ? size.height : size.width
  const max = Math.max(0, span - windowSpan)
  return { edge: dock.edge, offset: Math.min(Math.max(dock.offset, 0), max) }
}

/**
 * Decide the park a settled drag lands in.
 *
 * @param position - the window's top-left when the drag settled.
 * @param size - the window's size.
 * @param work - the work area of the display the ball sits on.
 * @returns the park (already offset-clamped), or `undefined` for free-floating
 * (the caller should clamp the position into the work area instead).
 */
export function settleDock(position: Point, size: Size, work: Rect): BallDock | undefined {
  const at = clampPosition(position, size, work)
  const nearLeft = at.x - work.x <= DOCK_SNAP_PX
  const nearRight = work.x + work.width - (at.x + size.width) <= DOCK_SNAP_PX
  const nearTop = at.y - work.y <= DOCK_SNAP_PX
  const nearBottom = work.y + work.height - (at.y + size.height) <= DOCK_SNAP_PX
  // Vertical edges win over horizontal ones at a corner: the ball is a
  // left/right-edge citizen first.
  if (nearLeft) return clampDock({ edge: 'left', offset: at.y - work.y }, size, work)
  if (nearRight) return clampDock({ edge: 'right', offset: at.y - work.y }, size, work)
  if (nearTop) return clampDock({ edge: 'top', offset: at.x - work.x }, size, work)
  if (nearBottom) return clampDock({ edge: 'bottom', offset: at.x - work.x }, size, work)
  return undefined
}

/**
 * The window position for a parked ball: slid out (`collapsed: false`) or
 * tucked into the edge (`collapsed: true`), where only `visiblePx` of the
 * window remains inside the work area.
 */
export function dockedPosition(dock: BallDock, size: Size, work: Rect, collapsed: boolean, visiblePx: number): Point {
  const d = clampDock(dock, size, work)
  const vertical = isVerticalEdge(d.edge)
  const slack = (vertical ? size.width : size.height) - visiblePx
  const flushX = work.x + work.width - size.width
  const flushY = work.y + work.height - size.height
  switch (d.edge) {
    case 'left': return { x: collapsed ? work.x - slack : work.x, y: work.y + d.offset }
    case 'right': return { x: collapsed ? flushX + slack : flushX, y: work.y + d.offset }
    case 'top': return { x: work.x + d.offset, y: collapsed ? work.y - slack : work.y }
    case 'bottom': return { x: work.x + d.offset, y: collapsed ? flushY + slack : flushY }
  }
}

/** The on-screen strip of a tucked ball — what the operator can still point at. */
export function visibleRect(dock: BallDock, size: Size, work: Rect, visiblePx: number): Rect {
  const at = dockedPosition(dock, size, work, true, visiblePx)
  if (isVerticalEdge(dock.edge)) {
    // Tucked left, only the window's right slice is on screen; tucked right,
    // its left slice.
    return {
      x: dock.edge === 'left' ? at.x + (size.width - visiblePx) : at.x,
      y: at.y,
      width: visiblePx,
      height: size.height,
    }
  }
  // Tucked top, only the window's bottom slice is on screen; tucked bottom,
  // its top slice.
  return {
    x: at.x,
    y: dock.edge === 'top' ? at.y + (size.height - visiblePx) : at.y,
    width: size.width,
    height: visiblePx,
  }
}

/** The parked ball's reveal/tuck machine state. */
export interface TuckState {
  /** Whether the ball is currently tucked into its edge. */
  collapsed: boolean
  /** The pointer has been over the ball since the last reveal. */
  inside: boolean
  /** When the pointer was last observed away from the ball (epoch ms); `undefined` = not observed yet. */
  outsideSince: number | undefined
}

/** The state a freshly tucked (or free) ball starts from. */
export function initialTuckState(collapsed: boolean): TuckState {
  return { collapsed, inside: false, outsideSince: undefined }
}

/** What one cursor tick decided. */
export interface TickVerdict {
  /** The machine state after the tick. */
  state: TuckState
  /** The window act to perform, when the state change demands one. */
  action?: 'reveal' | 'tuck'
}

function insideRect(point: Point, rect: Rect): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height
}

/**
 * Advance the parked ball's reveal/tuck machine by one cursor tick.
 *
 * - Tucked: the pointer entering the visible strip reveals the ball — but
 *   only after the pointer was seen away from the strip once, so a ball
 *   tucked under a resting pointer does not pop straight back out.
 * - Slid out: the pointer leaving the whole window tucks the ball back after
 *   `tuckDelayMs` — hovered or not: a parked ball belongs to its edge, and
 *   the pointer moving on is exactly the focus leaving.
 *
 * @param state - the machine state.
 * @param pointer - the cursor position; `undefined` ticks nothing (no observation).
 * @param windowRect - the ball window's full rect.
 * @param strip - the on-screen strip while tucked.
 * @param now - the current time (epoch ms).
 * @param tuckDelayMs - how long the pointer must stay away before the tuck.
 */
export function tickTuck(
  state: TuckState,
  pointer: Point | undefined,
  windowRect: Rect,
  strip: Rect,
  now: number,
  tuckDelayMs: number,
): TickVerdict {
  if (pointer === undefined) return { state }
  if (state.collapsed) {
    if (insideRect(pointer, strip)) {
      if (!state.inside && state.outsideSince === undefined) return { state }
      return { state: { collapsed: false, inside: true, outsideSince: undefined }, action: 'reveal' }
    }
    return state.outsideSince === undefined ? { state: { ...state, outsideSince: now } } : { state }
  }
  if (insideRect(pointer, windowRect)) {
    return { state: { ...state, inside: true, outsideSince: undefined } }
  }
  const since = state.outsideSince ?? now
  if (now - since >= tuckDelayMs) {
    return { state: initialTuckState(true), action: 'tuck' }
  }
  return { state: { ...state, outsideSince: since } }
}
