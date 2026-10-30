/**
 * Pointer-driven dragging for a ball face. The ball window is transparent and
 * frameless, where CSS `-webkit-app-region` hit-testing is unreliable on
 * Windows — and streaming renderer coordinates back to a window that is being
 * moved under the pointer is a feedback loop that stalls and jitters. So the
 * face only signals intent: past the travel threshold it says `begin`, and
 * the host takes over — it anchors the grab from the live OS cursor and pins
 * the window to it at display rate until `end`, then runs the dock settle
 * (edge snap, tuck, persistence) from the released position.
 *
 * A press-release that stays within the threshold is answered as a click, so
 * one surface keeps both interactions, and a plain click never disturbs a
 * parked ball.
 *
 * @module @snap-rail/client-kernel/ball-drag
 */

import type { HostLink } from '@snap-rail/connection'

/** Options for {@link attachBallDrag}. */
export interface BallDragOptions {
  /** The surface's host link; the drag rides `shell.ball.move`. */
  link: HostLink
  /** Answered when a press-release never turned into a drag. */
  onClick: () => void
  /** Pointer travel in px beyond which a press becomes a drag (default 4). */
  threshold?: number
}

/**
 * Wire an element as the ball's drag/click surface.
 *
 * @param element - the ball's root element (pointer events are captured so a
 *   drag keeps tracking outside the small window).
 * @param options - see {@link BallDragOptions}.
 * @returns the disposer removing every listener.
 */
export function attachBallDrag(element: HTMLElement, options: BallDragOptions): () => void {
  const threshold = options.threshold ?? 4
  let pressing = false
  let dragging = false
  let originX = 0
  let originY = 0
  element.style.touchAction = 'none'

  const move = (phase: 'begin' | 'end'): void => {
    void options.link.call('shell.ball.move', { phase }).catch(() => {})
  }

  const onPointerDown = (event: Event): void => {
    const pointer = event as PointerEvent
    if (pointer.button !== 0) return
    pressing = true
    dragging = false
    originX = pointer.clientX
    originY = pointer.clientY
    if (typeof element.setPointerCapture === 'function') {
      try {
        element.setPointerCapture(pointer.pointerId)
      } catch {
        // A stale pointer id must not break the press.
      }
    }
  }

  const onPointerMove = (event: Event): void => {
    if (!pressing || dragging) return
    const pointer = event as PointerEvent
    const travelled = Math.hypot(pointer.clientX - originX, pointer.clientY - originY)
    if (travelled <= threshold) return
    dragging = true
    element.style.cursor = 'grabbing'
    move('begin')
  }

  const finish = (event: Event): void => {
    if (!pressing) return
    pressing = false
    element.style.cursor = ''
    if (typeof element.releasePointerCapture === 'function') {
      try {
        element.releasePointerCapture((event as PointerEvent).pointerId)
      } catch {
        // The capture may already be gone; the drag state is what matters.
      }
    }
    if (dragging) {
      dragging = false
      move('end')
      return
    }
    options.onClick()
  }

  element.addEventListener('pointerdown', onPointerDown)
  element.addEventListener('pointermove', onPointerMove)
  element.addEventListener('pointerup', finish)
  element.addEventListener('pointercancel', finish)
  return () => {
    element.removeEventListener('pointerdown', onPointerDown)
    element.removeEventListener('pointermove', onPointerMove)
    element.removeEventListener('pointerup', finish)
    element.removeEventListener('pointercancel', finish)
  }
}
