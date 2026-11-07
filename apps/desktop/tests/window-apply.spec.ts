import { describe, expect, it } from 'vitest'
import { resolveWindowProfile } from '@snap-rail/shell'
import { applyResolvedWindowProfile, type GeometryWindow, type WorkArea } from '../src-host/main/shell/window-apply.ts'

/**
 * The operator window's geometry dance. Windows corrects a frameless window
 * against constraints written before its bounds, swallowing the bounds — a
 * 1280×800 business stage after a 432×768 login landed as 960×768. The write
 * order is the fix: lift every constraint, write the geometry, re-assert.
 */

const WORK: WorkArea = { x: 0, y: 0, width: 1920, height: 1032 }

/** A window that records every geometry call in order. */
function recordingWindow(state: { maximized?: boolean, fullscreen?: boolean } = {}) {
  const calls: string[] = []
  const win = {
    setResizable: (value: boolean) => calls.push(`resizable:${value}`),
    setMinimumSize: (width: number, height: number) => calls.push(`min:${width}x${height}`),
    setFullScreen: (value: boolean) => calls.push(`fullscreen:${value}`),
    isFullScreen: () => state.fullscreen === true,
    maximize: () => calls.push('maximize'),
    isMaximized: () => state.maximized === true,
    unmaximize: () => calls.push('unmaximize'),
    setBounds: (bounds: { x?: number, y?: number, width?: number, height?: number }) =>
      calls.push(`bounds:${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`),
  }
  return { calls, win: win as unknown as GeometryWindow }
}

describe('window geometry dance', () => {
  it('writes the bounds with every constraint lifted, then re-asserts them', () => {
    const { calls, win } = recordingWindow()
    const home = resolveWindowProfile({ width: 1280, height: 800, minWidth: 960, minHeight: 600, remember: true }, WORK)
    applyResolvedWindowProfile(win, home, () => WORK)
    expect(calls).toEqual([
      'resizable:true',
      'min:1x1',
      'bounds:320,116 1280x800',
      'min:960x600',
      'resizable:true',
    ])
  })

  it('re-locks a fixed-size stage only after its bounds landed', () => {
    const { calls, win } = recordingWindow()
    const login = resolveWindowProfile({ width: 432, height: 768, resizable: false, remember: false }, WORK)
    applyResolvedWindowProfile(win, login, () => WORK)
    expect(calls.indexOf('bounds:744,132 432x768')).toBeGreaterThan(calls.indexOf('min:1x1'))
    expect(calls.at(-1)).toBe('resizable:false')
  })

  it('restores a remembered origin clamped into the work area', () => {
    const { calls, win } = recordingWindow()
    const stage = resolveWindowProfile({ width: 1280, height: 800 }, WORK)
    applyResolvedWindowProfile(win, stage, () => WORK, { x: 5000, y: -40 })
    expect(calls).toContain(`bounds:${WORK.width - 64},0 1280x800`)
  })

  it('leaves maximized and full-screen states before a windowed write', () => {
    const { calls, win } = recordingWindow({ maximized: true, fullscreen: true })
    applyResolvedWindowProfile(win, resolveWindowProfile({ width: 1280, height: 800 }, WORK), () => WORK)
    expect(calls.slice(0, 4)).toEqual(['resizable:true', 'min:1x1', 'fullscreen:false', 'unmaximize'])
  })

  it('maximizes inside the same lifted window', () => {
    const { calls, win } = recordingWindow()
    applyResolvedWindowProfile(win, resolveWindowProfile({ mode: 'maximized', minWidth: 960, minHeight: 600 }, WORK), () => WORK)
    expect(calls).toEqual(['resizable:true', 'min:1x1', 'maximize', 'min:960x600', 'resizable:true'])
  })
})
