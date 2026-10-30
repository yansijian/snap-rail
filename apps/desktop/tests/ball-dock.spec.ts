import { describe, expect, it } from 'vitest'
import { BALL_SURFACE } from '@snap-rail/shell'
import {
  DOCK_SNAP_PX,
  DOCK_TUCK_DELAY_MS,
  clampDock,
  clampPosition,
  dockedPosition,
  initialTuckState,
  isVerticalEdge,
  settleDock,
  tickTuck,
  visiblePxOf,
  visibleRect,
  type Point,
  type Rect,
} from '../src-host/main/shell/dock.ts'

/**
 * The floating ball's docking math: a settled drag near an edge parks the
 * ball flush; every edge tucks it to a third once the pointer leaves (the
 * focus leaving), and hovering the visible strip slides it back out — but
 * only after the pointer was seen away from the strip once.
 */

const SIZE = { width: BALL_SURFACE.size, height: BALL_SURFACE.size }
/** A work area that does not start at the origin (a taskbar on the left, say). */
const WORK: Rect = { x: 100, y: 50, width: 1000, height: 700 }

function at(x: number, y: number): Point {
  return { x, y }
}

describe('visible strip', () => {
  it('keeps a third of the window on screen', () => {
    expect(visiblePxOf(SIZE)).toBe(43)
  })

  it('tells the vertical edges from the horizontal ones', () => {
    expect(isVerticalEdge('left')).toBe(true)
    expect(isVerticalEdge('right')).toBe(true)
    expect(isVerticalEdge('top')).toBe(false)
    expect(isVerticalEdge('bottom')).toBe(false)
  })
})

describe('settleDock', () => {
  it('leaves a mid-work-area drag free-floating', () => {
    expect(settleDock(at(600, 400), SIZE, WORK)).toBeUndefined()
  })

  it('parks on each edge within the snap threshold', () => {
    expect(settleDock(at(WORK.x + 5, 300), SIZE, WORK)).toEqual({ edge: 'left', offset: 250 })
    expect(settleDock(at(WORK.x + WORK.width - SIZE.width - 2, 300), SIZE, WORK))
      .toEqual({ edge: 'right', offset: 250 })
    expect(settleDock(at(600, WORK.y + DOCK_SNAP_PX), SIZE, WORK)).toEqual({ edge: 'top', offset: 500 })
    expect(settleDock(at(600, WORK.y + WORK.height - SIZE.height - DOCK_SNAP_PX), SIZE, WORK))
      .toEqual({ edge: 'bottom', offset: 500 })
  })

  it('recovers a drag that went past the edge', () => {
    // Half off the left edge: clamped flush, then parked.
    expect(settleDock(at(WORK.x - 60, 300), SIZE, WORK)).toEqual({ edge: 'left', offset: 250 })
  })

  it('wins the vertical edge at a corner', () => {
    const parked = settleDock(at(WORK.x + 4, WORK.y + 4), SIZE, WORK)
    expect(parked?.edge).toBe('left')
  })

  it('clamps the cross-axis offset into the work area', () => {
    const parked = settleDock(at(WORK.x + 4, WORK.y + WORK.height + 200), SIZE, WORK)
    expect(parked).toBeDefined()
    expect(parked?.offset).toBe(WORK.height - SIZE.height)
  })
})

describe('clampDock and clampPosition', () => {
  it('keeps the offset inside the work area', () => {
    expect(clampDock({ edge: 'left', offset: -10 }, SIZE, WORK)).toEqual({ edge: 'left', offset: 0 })
    expect(clampDock({ edge: 'right', offset: 9_999 }, SIZE, WORK)).toEqual({ edge: 'right', offset: WORK.height - SIZE.height })
    expect(clampDock({ edge: 'top', offset: 5 }, SIZE, WORK)).toEqual({ edge: 'top', offset: 5 })
  })

  it('clamps a free position into the work area', () => {
    expect(clampPosition(at(0, 0), SIZE, WORK)).toEqual({ x: WORK.x, y: WORK.y })
    expect(clampPosition(at(9_999, 9_999), SIZE, WORK)).toEqual({
      x: WORK.x + WORK.width - SIZE.width,
      y: WORK.y + WORK.height - SIZE.height,
    })
  })
})

describe('dockedPosition', () => {
  it('slides a left-parked ball out and tucks it to a third', () => {
    const dock = { edge: 'left' as const, offset: 100 }
    expect(dockedPosition(dock, SIZE, WORK, false, 43)).toEqual({ x: WORK.x, y: WORK.y + 100 })
    expect(dockedPosition(dock, SIZE, WORK, true, 43)).toEqual({ x: WORK.x - (SIZE.width - 43), y: WORK.y + 100 })
  })

  it('slides a right-parked ball out and tucks it to a third', () => {
    const dock = { edge: 'right' as const, offset: 100 }
    const flushX = WORK.x + WORK.width - SIZE.width
    expect(dockedPosition(dock, SIZE, WORK, false, 43)).toEqual({ x: flushX, y: WORK.y + 100 })
    expect(dockedPosition(dock, SIZE, WORK, true, 43)).toEqual({ x: flushX + (SIZE.width - 43), y: WORK.y + 100 })
  })

  it('tucks top and bottom into the edge like every other side', () => {
    const top = { edge: 'top' as const, offset: 100 }
    expect(dockedPosition(top, SIZE, WORK, false, 43)).toEqual({ x: WORK.x + 100, y: WORK.y })
    expect(dockedPosition(top, SIZE, WORK, true, 43)).toEqual({ x: WORK.x + 100, y: WORK.y - (SIZE.height - 43) })
    const bottom = { edge: 'bottom' as const, offset: 100 }
    const flushY = WORK.y + WORK.height - SIZE.height
    expect(dockedPosition(bottom, SIZE, WORK, false, 43)).toEqual({ x: WORK.x + 100, y: flushY })
    expect(dockedPosition(bottom, SIZE, WORK, true, 43)).toEqual({ x: WORK.x + 100, y: flushY + (SIZE.height - 43) })
  })

  it('names the on-screen strip of a tucked ball', () => {
    // Tucked left, the window's right slice shows (flush with the work area's
    // left edge); tucked right, its left slice; tucked top/bottom, the
    // window's bottom/top slice.
    expect(visibleRect({ edge: 'left', offset: 0 }, SIZE, WORK, 43)).toEqual({
      x: WORK.x, y: WORK.y, width: 43, height: SIZE.height,
    })
    expect(visibleRect({ edge: 'right', offset: 0 }, SIZE, WORK, 43)).toEqual({
      x: WORK.x + WORK.width - 43, y: WORK.y, width: 43, height: SIZE.height,
    })
    expect(visibleRect({ edge: 'top', offset: 0 }, SIZE, WORK, 43)).toEqual({
      x: WORK.x, y: WORK.y, width: SIZE.width, height: 43,
    })
    expect(visibleRect({ edge: 'bottom', offset: 0 }, SIZE, WORK, 43)).toEqual({
      x: WORK.x, y: WORK.y + WORK.height - 43, width: SIZE.width, height: 43,
    })
  })
})

describe('tickTuck', () => {
  const dock = { edge: 'left' as const, offset: 100 }
  const strip = visibleRect(dock, SIZE, WORK, 43)
  const revealedAt = dockedPosition(dock, SIZE, WORK, false, 43)
  const windowRect: Rect = { x: revealedAt.x, y: revealedAt.y, width: SIZE.width, height: SIZE.height }
  const onStrip: Point = { x: strip.x + 10, y: strip.y + 40 }
  const away: Point = { x: WORK.x + 500, y: WORK.y + 300 }

  it('does not pop straight back out under the hand that dropped it', () => {
    const verdict = tickTuck(initialTuckState(true), onStrip, windowRect, strip, 1_000, DOCK_TUCK_DELAY_MS)
    expect(verdict.action).toBeUndefined()
    expect(verdict.state.collapsed).toBe(true)
  })

  it('records the pointer leaving before it arms the reveal', () => {
    const seen = tickTuck(initialTuckState(true), away, windowRect, strip, 1_000, DOCK_TUCK_DELAY_MS)
    expect(seen.state.outsideSince).toBe(1_000)
    const back = tickTuck(seen.state, onStrip, windowRect, strip, 1_200, DOCK_TUCK_DELAY_MS)
    expect(back.action).toBe('reveal')
    expect(back.state).toEqual({ collapsed: false, inside: true, outsideSince: undefined })
  })

  it('keeps a tucked ball tucked while the pointer stays away', () => {
    const seen = tickTuck(initialTuckState(true), away, windowRect, strip, 1_000, DOCK_TUCK_DELAY_MS)
    const again = tickTuck(seen.state, away, windowRect, strip, 2_000, DOCK_TUCK_DELAY_MS)
    expect(again.action).toBeUndefined()
    expect(again.state.outsideSince).toBe(1_000)
  })

  it('ignores an absent pointer observation', () => {
    const verdict = tickTuck(initialTuckState(true), undefined, windowRect, strip, 1_000, DOCK_TUCK_DELAY_MS)
    expect(verdict.action).toBeUndefined()
    expect(verdict.state).toEqual(initialTuckState(true))
  })

  it('marks a revealed ball hovered while the pointer stays on it', () => {
    const verdict = tickTuck({ collapsed: false, inside: false, outsideSince: undefined }, onStrip, windowRect, strip, 1_000, DOCK_TUCK_DELAY_MS)
    expect(verdict.state.inside).toBe(true)
  })

  it('tucks a hovered ball after the pointer has been away long enough', () => {
    const hovered = { collapsed: false, inside: true, outsideSince: undefined as number | undefined }
    const left = tickTuck(hovered, away, windowRect, strip, 1_000, DOCK_TUCK_DELAY_MS)
    expect(left.action).toBeUndefined()
    const waited = tickTuck(left.state, away, windowRect, strip, 1_000 + DOCK_TUCK_DELAY_MS, DOCK_TUCK_DELAY_MS)
    expect(waited.action).toBe('tuck')
    expect(waited.state).toEqual(initialTuckState(true))
  })

  it('tucks an unhovered parked ball once the pointer has been away long enough', () => {
    // A parked ball belongs to its edge: the pointer moving on is the focus
    // leaving, hovered or not.
    const summoned = { collapsed: false, inside: false, outsideSince: undefined as number | undefined }
    const first = tickTuck(summoned, away, windowRect, strip, 1_000, DOCK_TUCK_DELAY_MS)
    expect(first.action).toBeUndefined()
    const waited = tickTuck(first.state, away, windowRect, strip, 1_000 + DOCK_TUCK_DELAY_MS, DOCK_TUCK_DELAY_MS)
    expect(waited.action).toBe('tuck')
    expect(waited.state).toEqual(initialTuckState(true))
  })
})
