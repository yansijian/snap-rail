// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachDragPan } from '../src/components/layout.tsx'

/** Dispatch a pointer-named mouse event at the given viewport coordinates. */
function pointer(element: HTMLElement, type: string, x: number, y: number): void {
  element.dispatchEvent(new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true }))
}

afterEach(() => {
  document.body.innerHTML = ''
})

/** The DragScroll pan engine: tool-pointer drags scroll the viewport while
 * child clicks survive a press-release. */
describe('attachDragPan', () => {
  it('pans the viewport once travel passes the threshold', () => {
    const element = document.createElement('div')
    document.body.append(element)
    element.scrollTop = 100
    const dispose = attachDragPan(element, { direction: 'vertical' })

    pointer(element, 'pointerdown', 10, 10)
    pointer(element, 'pointermove', 13, 11)
    expect(element.scrollTop).toBe(100)
    pointer(element, 'pointermove', 10, 40)
    expect(element.scrollTop).toBe(70)
    expect(element.getAttribute('data-dragging')).toBe('true')
    pointer(element, 'pointerup', 10, 40)
    expect(element.getAttribute('data-dragging')).toBe(null)
    dispose()
  })

  it('moves only the enabled axes', () => {
    const element = document.createElement('div')
    document.body.append(element)
    element.scrollLeft = 50
    const dispose = attachDragPan(element, { direction: 'horizontal' })

    pointer(element, 'pointerdown', 0, 0)
    pointer(element, 'pointermove', 20, 30)
    expect(element.scrollLeft).toBe(30)
    expect(element.scrollTop).toBe(0)
    dispose()
  })

  it('swallows the click after a pan but not after a press-release', () => {
    const element = document.createElement('div')
    document.body.append(element)
    const child = document.createElement('button')
    element.append(child)
    const onClick = vi.fn()
    child.addEventListener('click', onClick)
    const dispose = attachDragPan(element)

    pointer(element, 'pointerdown', 10, 10)
    pointer(element, 'pointermove', 40, 10)
    pointer(element, 'pointerup', 40, 10)
    child.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClick).not.toHaveBeenCalled()

    pointer(element, 'pointerdown', 10, 10)
    pointer(element, 'pointerup', 10, 10)
    child.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onClick).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('ignores non-primary buttons and detached after dispose', () => {
    const element = document.createElement('div')
    document.body.append(element)
    element.scrollTop = 8
    const dispose = attachDragPan(element)

    element.dispatchEvent(new MouseEvent('pointerdown', { button: 2, clientX: 0, clientY: 0, bubbles: true }))
    element.dispatchEvent(new MouseEvent('pointermove', { button: 2, clientX: 0, clientY: 60, bubbles: true }))
    expect(element.scrollTop).toBe(8)
    dispose()

    pointer(element, 'pointerdown', 0, 0)
    pointer(element, 'pointermove', 0, 60)
    expect(element.scrollTop).toBe(8)
  })
})
