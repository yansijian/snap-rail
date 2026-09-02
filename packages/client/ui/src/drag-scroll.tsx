/**
 * DragScroll: an overflow-auto container that also pans when held and
 * dragged with the mouse (both axes). Touch and pen keep Chromium's native
 * pan, so only mouse pointers are intercepted. A 6px threshold separates a
 * pan from a press; the click that follows a pan is swallowed so dragged
 * rows never fire. DragScrolls nest (a table inside a scrolled page); only
 * the innermost container under the pressed target takes the gesture.
 *
 * @module @snap-rail/client-ui/drag-scroll
 */

import { useRef, type ComponentProps, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { cn } from './utils.ts'

/** Movement (px) before a held press turns into a pan. */
const PAN_THRESHOLD = 6

/** An auto-scrolling div that pans under a held mouse drag. */
export function DragScroll({ className, children, ...props }: ComponentProps<'div'>): ReactNode {
  const container = useRef<HTMLDivElement | null>(null)
  const pan = useRef<{ id: number, x: number, y: number, moved: boolean } | null>(null)
  const swallowClick = useRef(false)

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return
    // DragScrolls nest (a table inside a scrolled page). If both armed on
    // one press, the ancestor's setPointerCapture would steal the pointer
    // from the innermost container mid-gesture: its pan freezes and its
    // state leaks past the release into a hover-follow. Only the innermost
    // container under the pressed target arms.
    if (container.current === null) return
    const innermost = event.target instanceof Element ? event.target.closest('[data-drag-scroll]') : null
    if (innermost !== null && innermost !== container.current) return
    pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = pan.current
    if (state === null || state.id !== event.pointerId) return
    // A buttonless move means the press ended without our pointerup — the
    // capture was stolen. Drop the stale pan instead of following hover.
    if (event.buttons === 0) {
      pan.current = null
      return
    }
    const el = container.current
    if (el === null) return
    const dx = state.x - event.clientX
    const dy = state.y - event.clientY
    if (!state.moved) {
      if (Math.hypot(dx, dy) < PAN_THRESHOLD) return
      state.moved = true
      el.setPointerCapture(event.pointerId)
      el.dataset.panning = 'true'
    }
    el.scrollLeft += dx
    el.scrollTop += dy
    state.x = event.clientX
    state.y = event.clientY
  }

  const endPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const state = pan.current
    if (state === null || state.id !== event.pointerId) return
    pan.current = null
    const el = container.current
    if (el === null) return
    if (state.moved) {
      if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId)
      delete el.dataset.panning
      swallowClick.current = true
    }
  }

  return (
    <div
      ref={container}
      data-drag-scroll=""
      className={cn('overflow-auto', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onClickCapture={event => {
        if (!swallowClick.current) return
        swallowClick.current = false
        event.preventDefault()
        event.stopPropagation()
      }}
      {...props}
    >
      {children}
    </div>
  )
}
