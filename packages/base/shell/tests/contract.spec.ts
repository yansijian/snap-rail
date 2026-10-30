import { describe, expect, it } from 'vitest'
import { AUX_SURFACE_IDS, SURFACE_IDS, isAuxSurfaceId, isSurfaceId } from '@snap-rail/protocol'
import { EXIT_DECISIONS } from '../src/index.ts'
import {
  BALL_DOCK_EDGES,
  BALL_LIMITS,
  BALL_SURFACE,
  BALL_TONES,
  EXIT_ACTIONS,
  SHELL_LIMITS,
  WINDOW_LIMITS,
  ballDockStateSchema,
  ballProfileSchema,
  ballStateSchema,
  resolveBallProfile,
  resolveWindowProfile,
  shellContract,
  surfaceStateSchema,
  windowProfileSchema,
} from '../src/contract.ts'

/** The request schema of one method row, narrowed for inspection. */
function requestOf(name: keyof typeof shellContract.methods) {
  const row = shellContract.methods[name]
  if (row === undefined) throw new Error(`missing method row: ${name}`)
  return row.request
}

describe('surface vocabulary', () => {
  it('whitelists exactly main and ball — main first', () => {
    expect(SURFACE_IDS).toEqual(['main', 'ball'])
    expect(AUX_SURFACE_IDS).toEqual(['ball'])
  })

  it('recognises surface ids and rejects everything else', () => {
    for (const id of SURFACE_IDS) expect(isSurfaceId(id)).toBe(true)
    expect(isSurfaceId('tray')).toBe(false)
    expect(isSurfaceId('panel')).toBe(false)
    expect(isSurfaceId(undefined)).toBe(false)
    // `main` is a surface but never an auxiliary one — the Shell owns it.
    expect(isAuxSurfaceId('main')).toBe(false)
  })
})

describe('ball geometry', () => {
  it('keeps the orb and its shadow rim inside the window', () => {
    // The single source the host's window bounds and every face's layout
    // derive from: the orb plus two insets must exactly fill the window, so a
    // face painting a contained shadow can never spill past the edge.
    expect(BALL_SURFACE.orb + 2 * BALL_SURFACE.inset).toBe(BALL_SURFACE.size)
    expect(BALL_SURFACE.dockVisibleRatio).toBeGreaterThan(0)
    expect(BALL_SURFACE.dockVisibleRatio).toBeLessThan(1)
  })

  it('documents the hold timeout as a positive cap', () => {
    expect(SHELL_LIMITS.exitHoldMs).toBeGreaterThan(0)
  })
})

describe('window profile', () => {
  it('uses factory defaults when nothing is requested', () => {
    const profile = resolveWindowProfile()
    expect(profile.mode).toBe('windowed')
    expect(profile.width).toBe(WINDOW_LIMITS.defaultWidth)
    expect(profile.height).toBe(WINDOW_LIMITS.defaultHeight)
    expect(profile.minWidth).toBe(WINDOW_LIMITS.minWidth)
    expect(profile.minHeight).toBe(WINDOW_LIMITS.minHeight)
    expect(profile.resizable).toBe(true)
    expect(profile.center).toBe(true)
    expect(profile.remember).toBe(true)
  })

  it('clamps an oversized request to the display work area and a tiny one to the guard', () => {
    const profile = resolveWindowProfile(
      { width: 5000, height: 4000, minWidth: 100, minHeight: 100 },
      { width: 1600, height: 900 },
    )
    expect(profile.width).toBe(1600)
    expect(profile.height).toBe(900)
    expect(profile.minWidth).toBe(WINDOW_LIMITS.minWidth)
    expect(profile.minHeight).toBe(WINDOW_LIMITS.minHeight)
  })

  it('rejects malformed wire profiles', () => {
    expect(windowProfileSchema.safeParse({ width: 0 }).success).toBe(false)
    expect(windowProfileSchema.safeParse({ width: 1280, extra: true }).success).toBe(false)
    expect(windowProfileSchema.safeParse({ mode: 'kiosk' }).success).toBe(false)
    expect(windowProfileSchema.safeParse({ mode: 'fullscreen', width: 1920, height: 1080 }).success).toBe(true)
  })
})

describe('ball profile', () => {
  it('keeps the paint rim fixed while the window size changes', () => {
    const small = resolveBallProfile({ size: 96 })
    const large = resolveBallProfile({ size: 192 })
    expect(small.inset).toBe(BALL_LIMITS.inset)
    expect(large.inset).toBe(BALL_LIMITS.inset)
    expect(small.orb + 2 * small.inset).toBe(small.size)
    expect(large.orb + 2 * large.inset).toBe(large.size)
  })

  it('clamps size, docking ratio, and hover timing into the documented range', () => {
    const tiny = resolveBallProfile({ size: 1, collapseRatio: 0.01, hoverDelayMs: 1 })
    expect(tiny.size).toBe(BALL_LIMITS.minSize)
    expect(tiny.dockVisibleRatio).toBe(BALL_LIMITS.minCollapseRatio)
    expect(tiny.hoverDelayMs).toBe(BALL_LIMITS.minHoverDelayMs)

    const huge = resolveBallProfile({ size: 999, collapseRatio: 0.99, hoverDelayMs: 99_999 })
    expect(huge.size).toBe(BALL_LIMITS.maxSize)
    expect(huge.dockVisibleRatio).toBe(BALL_LIMITS.maxCollapseRatio)
    expect(huge.hoverDelayMs).toBe(BALL_LIMITS.maxHoverDelayMs)
  })

  it('deduplicates dock edges and falls back to all edges when the request is empty', () => {
    expect(resolveBallProfile({ dockEdges: ['left', 'left'] }).dockEdges).toEqual(['left'])
    expect(resolveBallProfile({ dockEdges: [] }).dockEdges).toEqual([...BALL_DOCK_EDGES])
  })

  it('rejects malformed wire profiles', () => {
    expect(ballProfileSchema.safeParse({ size: 0 }).success).toBe(false)
    expect(ballProfileSchema.safeParse({ dockEdges: [] }).success).toBe(false)
    expect(ballProfileSchema.safeParse({ dockEdges: ['diagonal'] }).success).toBe(false)
    expect(ballProfileSchema.safeParse({ size: 160, dockEdges: ['left', 'right'] }).success).toBe(true)
  })
})

describe('shell contract', () => {
  it('declares the client-facing rows and frames', () => {
    expect(Object.keys(shellContract.methods).sort()).toEqual([
      'shell.ball.configure',
      'shell.ball.dock',
      'shell.ball.move',
      'shell.ball.profile',
      'shell.ball.state',
      'shell.exit.resolve',
      'shell.surface.hide',
      'shell.surface.present',
      'shell.surface.state',
      'shell.toast',
      'shell.window.configure',
      'shell.window.profile',
    ])
    expect(Object.keys(shellContract.frames).sort()).toEqual([
      'shell/ball-changed',
      'shell/ball-dock-changed',
      'shell/ball-profile-changed',
      'shell/exit-requested',
      'shell/settings-open-requested',
      'shell/surface-changed',
      'shell/window-profile-changed',
    ])
    expect(shellContract.domain).toBe('shell')
  })

  it('refuses a toast without a title, and one over the title cap', () => {
    const toast = requestOf('shell.toast')
    expect(toast.safeParse({ title: '' }).success).toBe(false)
    expect(toast.safeParse({ title: 'x'.repeat(SHELL_LIMITS.title + 1) }).success).toBe(false)
    expect(toast.safeParse({ title: '采集失败', body: '点位 PLC-1 超时' }).success).toBe(true)
  })

  it('refuses unknown toast fields — clients may not smuggle action buttons', () => {
    const toast = requestOf('shell.toast')
    // The actionable half is host-face only: a client cannot declare buttons
    // whose clicks would arrive after its own face is gone.
    expect(toast.safeParse({ title: 'x', actions: [{ id: 'a', label: 'A' }] }).success).toBe(false)
    expect(toast.safeParse({ title: 'x', onClick: 'shell/notification-clicked' }).success).toBe(false)
  })

  it('accepts any surface for present, only auxiliary ones for hide', () => {
    const present = requestOf('shell.surface.present')
    for (const surface of SURFACE_IDS) expect(present.safeParse({ surface }).success).toBe(true)
    expect(present.safeParse({ surface: 'other' }).success).toBe(false)
    // Hiding the operator window is not a renderer's call.
    const hide = requestOf('shell.surface.hide')
    for (const surface of AUX_SURFACE_IDS) expect(hide.safeParse({ surface }).success).toBe(true)
    expect(hide.safeParse({ surface: 'main' }).success).toBe(false)
  })

  it('validates ball state against the tone vocabulary and the progress range', () => {
    for (const tone of BALL_TONES) {
      expect(ballStateSchema.safeParse({ progress: 0.5, label: '运行', tone }).success).toBe(true)
    }
    expect(ballStateSchema.safeParse({ progress: null, label: null, tone: 'neutral' }).success).toBe(true)
    expect(ballStateSchema.safeParse({ progress: 1.5, label: null, tone: 'neutral' }).success).toBe(false)
    expect(ballStateSchema.safeParse({ progress: 0, label: null, tone: 'loud' }).success).toBe(false)
    expect(ballStateSchema.safeParse({ progress: 0, label: 'x'.repeat(SHELL_LIMITS.ballLabel + 1), tone: 'accent' }).success).toBe(false)
  })

  it('validates surface state for any surface, main included', () => {
    expect(surfaceStateSchema.safeParse({ surface: 'main', available: true, visible: true }).success).toBe(true)
    expect(surfaceStateSchema.safeParse({ surface: 'ball', available: false, visible: false }).success).toBe(true)
    expect(surfaceStateSchema.safeParse({ surface: 'tray', available: true, visible: true }).success).toBe(false)
    expect(surfaceStateSchema.safeParse({ surface: 'ball', visible: true }).success).toBe(false)
  })

  it('validates dock state: a parked edge, the tucked flag, and a sane visible strip', () => {
    expect(ballDockStateSchema.safeParse({ edge: null, collapsed: false, visiblePx: 43 }).success).toBe(true)
    expect(ballDockStateSchema.safeParse({ edge: 'left', collapsed: true, visiblePx: 43 }).success).toBe(true)
    expect(ballDockStateSchema.safeParse({ edge: 'top', collapsed: false, visiblePx: 43 }).success).toBe(true)
    expect(ballDockStateSchema.safeParse({ edge: 'diagonal', collapsed: false, visiblePx: 43 }).success).toBe(false)
    expect(ballDockStateSchema.safeParse({ edge: 'left', collapsed: true, visiblePx: BALL_SURFACE.size + 1 }).success).toBe(false)
    expect(ballDockStateSchema.safeParse({ edge: 'left', collapsed: true, visiblePx: 0 }).success).toBe(false)
  })

  it('accepts exit resolutions and request sources from the closed vocabularies', () => {
    const resolve = requestOf('shell.exit.resolve')
    for (const action of EXIT_ACTIONS) expect(resolve.safeParse({ action }).success).toBe(true)
    expect(resolve.safeParse({ action: 'hold' }).success).toBe(false)
    expect(resolve.safeParse({}).success).toBe(false)
    // `hold` is a policy decision, never a resolution: a renderer answers,
    // it does not defer again.
    expect(EXIT_ACTIONS).not.toContain('hold')
    expect(EXIT_DECISIONS).toContain('hold')
  })

  it('keeps the tray caps consistent with the notification caps', () => {
    // A tray caption must fit the menu, and a notification's action label must
    // fit the toast button — the Shell refuses beyond these, so the numbers
    // themselves are the contract with the OS.
    expect(SHELL_LIMITS.trayLabel).toBeLessThanOrEqual(60)
    expect(SHELL_LIMITS.actionLabel).toBeLessThanOrEqual(40)
    expect(SHELL_LIMITS.trayItemsPerPlugin).toBeLessThanOrEqual(SHELL_LIMITS.trayItems)
    expect(SHELL_LIMITS.notificationsPerWindow).toBeGreaterThan(0)
  })
})