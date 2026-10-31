import { describe, expect, it } from 'vitest'
import { placeBall, type BallPlaceWindow } from '../src-host/main/shell/ball-place.ts'

/**
 * The ball window's guarded position write: Windows grows a `resizable:
 * false` window through the display scale factor on every reposition
 * (electron/electron#41675), so every write the drag poll and the dock
 * slides make goes through the resizable dance plus a trailing size
 * re-assertion.
 */

const SIZE = { width: 96, height: 96 }

interface StubOptions {
  position?: [number, number]
  size?: [number, number]
  /** Model the OS rounding that grows the window on every reposition. */
  growOnMove?: boolean
  destroyed?: boolean
}

type StubWindow = BallPlaceWindow & {
  calls: string[]
  position: [number, number]
  size: [number, number]
  resizable: boolean
}

/** A recorder standing in for the ball BrowserWindow. */
function stubWindow(options: StubOptions = {}): StubWindow {
  const calls: string[] = []
  const win = {
    calls,
    position: options.position ?? ([0, 0] as [number, number]),
    size: options.size ?? ([96, 96] as [number, number]),
    resizable: false,
    isDestroyed: () => options.destroyed ?? false,
    setResizable(value: boolean) {
      win.resizable = value
      calls.push(value ? 'resizable:on' : 'resizable:off')
    },
    getPosition: () => [...win.position],
    setPosition(x: number, y: number) {
      win.position = [x, y]
      if (options.growOnMove === true) win.size = [win.size[0] + 1, win.size[1] + 1]
      calls.push(`setPosition(${x},${y})`)
    },
    getSize: () => [...win.size],
    setSize(width: number, height: number) {
      win.size = [width, height]
      calls.push(`setSize(${width},${height})`)
    },
  }
  return win
}

describe('placeBall', () => {
  it('wraps the position write in the resizable dance and always closes the flag', () => {
    const win = stubWindow({ position: [10, 10] })
    placeBall(win, SIZE, 40, 60)
    expect(win.calls).toEqual(['resizable:on', 'setPosition(40,60)', 'resizable:off'])
    expect(win.position).toEqual([40, 60])
    expect(win.resizable).toBe(false)
  })

  it('re-asserts the square when the write grew the window', () => {
    const win = stubWindow({ position: [10, 10], size: [97, 97] })
    placeBall(win, SIZE, 40, 60)
    expect(win.calls).toEqual([
      'resizable:on',
      'setPosition(40,60)',
      'resizable:off',
      'resizable:on',
      'setSize(96,96)',
      'resizable:off',
    ])
    expect(win.size).toEqual([96, 96])
  })

  it('keeps a window the OS grows on every move at the profile size', () => {
    const win = stubWindow({ growOnMove: true })
    for (let tick = 0; tick < 50; tick += 1) {
      placeBall(win, SIZE, tick + 1, tick + 1)
    }
    expect(win.size).toEqual([96, 96])
    expect(win.resizable).toBe(false)
  })

  it('skips every write when the ball already sits at the spot and size', () => {
    const win = stubWindow({ position: [40, 60] })
    placeBall(win, SIZE, 40, 60)
    expect(win.calls).toEqual([])
  })

  it('still corrects a drifted size when the position is already right', () => {
    const win = stubWindow({ position: [40, 60], size: [160, 96] })
    placeBall(win, SIZE, 40, 60)
    expect(win.calls).toEqual(['resizable:on', 'setSize(96,96)', 'resizable:off'])
    expect(win.size).toEqual([96, 96])
  })

  it('leaves a destroyed window alone', () => {
    const win = stubWindow({ destroyed: true })
    placeBall(win, SIZE, 1, 2)
    expect(win.calls).toEqual([])
  })
})
