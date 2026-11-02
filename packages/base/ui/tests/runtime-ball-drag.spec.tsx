// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostLink } from '@snap-rail/connection'
import { attachBallDrag, type BallDragOptions } from '../src/runtime.tsx'

/** A link stub recording every call without touching a transport. */
function fakeLink(): { link: HostLink, calls: Array<{ method: string, request: unknown }> } {
  const calls: Array<{ method: string, request: unknown }> = []
  const link = {
    call: vi.fn(async (method: string, request: unknown) => {
      calls.push({ method, request })
      return { ok: true, value: { applied: true } }
    }),
  } as unknown as HostLink
  return { link, calls }
}

/** Dispatch a pointer-named mouse event at the given viewport coordinates. */
function pointer(element: HTMLElement, type: string, x: number, y: number): void {
  element.dispatchEvent(new MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true }))
}

const move = (phase: string): { method: string, request: unknown } => ({
  method: 'shell.ball.move',
  request: { phase },
})

afterEach(() => {
  document.body.innerHTML = ''
})

/**
 * The substrate re-exports the kernel's ball drag so pool faces get it — with
 * types — from a published base seed instead of the app-internal kernel.
 */
describe('@snap-rail/ui/runtime attachBallDrag', () => {
  it('is exported as a function with a self-contained options type', () => {
    expect(typeof attachBallDrag).toBe('function')
    const options: BallDragOptions = { link: fakeLink().link, onClick: () => {}, threshold: 4 }
    expect(options.threshold).toBe(4)
  })

  it('hands the drag to the host as begin/end once travel passes the threshold', () => {
    const { link, calls } = fakeLink()
    const element = document.createElement('div')
    document.body.append(element)
    const dispose = attachBallDrag(element, { link, onClick: () => {} })

    pointer(element, 'pointerdown', 10, 10)
    pointer(element, 'pointermove', 34, 22)
    pointer(element, 'pointerup', 34, 22)

    expect(calls).toEqual([move('begin'), move('end')])
    dispose()
  })

  it('answers a press-release without travel as the click and never touches the wire', () => {
    const { link, calls } = fakeLink()
    const element = document.createElement('div')
    document.body.append(element)
    const click = vi.fn()
    const dispose = attachBallDrag(element, { link, onClick: click })

    pointer(element, 'pointerdown', 5, 5)
    pointer(element, 'pointermove', 6, 6)
    pointer(element, 'pointerup', 6, 6)

    expect(click).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([])
    dispose()
  })

  it('stops reporting after disposal', () => {
    const { link, calls } = fakeLink()
    const element = document.createElement('div')
    document.body.append(element)
    attachBallDrag(element, { link, onClick: () => {} })()

    pointer(element, 'pointerdown', 1, 1)
    pointer(element, 'pointermove', 30, 30)
    pointer(element, 'pointerup', 30, 30)
    expect(calls).toEqual([])
  })
})
