// @vitest-environment happy-dom
/**
 * DragScroll: a held mouse drag pans both axes, the click after a pan is
 * swallowed, and a sub-threshold press stays an ordinary tap.
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DragScroll } from '../src/drag-scroll.tsx'

afterEach(cleanup)

/** Pointer capture is a browser capability the DOM shim lacks. */
function stubCapture(el: HTMLElement): void {
  el.setPointerCapture = vi.fn()
  el.releasePointerCapture = vi.fn()
  el.hasPointerCapture = vi.fn(() => true)
}

describe('DragScroll', () => {
  it('pans the container under a held mouse drag', () => {
    const { container } = render(
      <DragScroll><button type="button">行</button></DragScroll>,
    )
    const el = container.firstElementChild as HTMLElement
    stubCapture(el)

    fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 300, clientY: 200 })
    fireEvent.pointerMove(el, { pointerId: 1, pointerType: 'mouse', clientX: 280, clientY: 160 })
    expect(el.scrollLeft).toBe(20)
    expect(el.scrollTop).toBe(40)
    fireEvent.pointerUp(el, { pointerId: 1, pointerType: 'mouse', clientX: 280, clientY: 160 })

    // the click that follows a pan never fires on the rows
    const click = vi.fn()
    el.addEventListener('click', click)
    el.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    expect(click).not.toHaveBeenCalled()
    // one swallow only: a later click passes again
    el.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('keeps sub-threshold presses interactive', () => {
    const onClick = vi.fn()
    const { container } = render(
      <DragScroll><button type="button" onClick={onClick}>行</button></DragScroll>,
    )
    const el = container.firstElementChild as HTMLElement
    stubCapture(el)

    fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(el, { pointerId: 1, pointerType: 'mouse', clientX: 99, clientY: 100 })
    fireEvent.pointerUp(el, { pointerId: 1, pointerType: 'mouse', clientX: 99, clientY: 100 })
    expect(el.scrollLeft).toBe(0)

    fireEvent.click(el.firstElementChild as HTMLElement)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('ignores touch pointers — Chromium pans those natively', () => {
    const { container } = render(
      <DragScroll><button type="button">行</button></DragScroll>,
    )
    const el = container.firstElementChild as HTMLElement
    fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'touch', button: 0, clientX: 300, clientY: 200 })
    fireEvent.pointerMove(el, { pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 100 })
    expect(el.scrollLeft).toBe(0)
    expect(el.scrollTop).toBe(0)
  })
})
