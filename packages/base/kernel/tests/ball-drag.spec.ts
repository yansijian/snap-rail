// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostLink } from '@snap-rail/connection'
import { attachBallDrag } from '../src/ballDrag.ts'

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
function pointer(element: HTMLElement, type: string, x: number, y: number, button = 0): void {
  element.dispatchEvent(new MouseEvent(type, { button, clientX: x, clientY: y, bubbles: true }))
}

const move = (phase: string): { method: string, request: unknown } => ({
  method: 'shell.ball.move',
  request: { phase },
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('attachBallDrag', () => {
  it('hands the drag to the host once travel passes the threshold', () => {
    const { link, calls } = fakeLink()
    const element = document.createElement('div')
    document.body.append(element)
    const dispose = attachBallDrag(element, { link, onClick: () => {} })

    pointer(element, 'pointerdown', 10, 10)
    pointer(element, 'pointermove', 34, 22)
    pointer(element, 'pointermove', 58, 30)
    pointer(element, 'pointerup', 58, 30)

    expect(calls).toEqual([move('begin'), move('end')])
    dispose()
  })

  it('answers a press-release without travel as the click, never as a drag', () => {
    const { link, calls } = fakeLink()
    const element = document.createElement('div')
    document.body.append(element)
    const click = vi.fn()
    const dispose = attachBallDrag(element, { link, onClick: click })

    pointer(element, 'pointerdown', 5, 5)
    pointer(element, 'pointermove', 6, 6)
    pointer(element, 'pointerup', 6, 6)

    expect(click).toHaveBeenCalledTimes(1)
    // A plain click never reaches the wire: a parked ball stays parked.
    expect(calls).toEqual([])
    dispose()
  })

  it('ignores travel below the threshold and non-primary buttons', () => {
    const { link, calls } = fakeLink()
    const element = document.createElement('div')
    document.body.append(element)
    const click = vi.fn()
    const dispose = attachBallDrag(element, { link, onClick: click, threshold: 10 })

    pointer(element, 'pointerdown', 0, 0, 2)
    pointer(element, 'pointermove', 40, 0)
    pointer(element, 'pointerup', 40, 0)
    expect(calls).toEqual([])
    expect(click).not.toHaveBeenCalled()

    pointer(element, 'pointerdown', 0, 0)
    pointer(element, 'pointermove', 6, 0)
    pointer(element, 'pointerup', 6, 0)
    expect(calls).toEqual([])
    expect(click).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('stops reporting after disposal', () => {
    const { link, calls } = fakeLink()
    const element = document.createElement('div')
    document.body.append(element)
    const dispose = attachBallDrag(element, { link, onClick: () => {} })
    dispose()

    pointer(element, 'pointerdown', 1, 1)
    pointer(element, 'pointermove', 30, 30)
    pointer(element, 'pointerup', 30, 30)
    expect(calls).toEqual([])
  })
})
