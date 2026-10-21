import { describe, expect, it } from 'vitest'
import { AUX_SURFACE_IDS, SURFACE_IDS, isAuxSurfaceId, isSurfaceId } from '@snap-rail/protocol'
import {
  BALL_TONES,
  SHELL_LIMITS,
  ballStateSchema,
  shellContract,
  surfaceStateSchema,
} from '../src/contract.ts'

/** The request schema of one method row, narrowed for inspection. */
function requestOf(name: keyof typeof shellContract.methods) {
  const row = shellContract.methods[name]
  if (row === undefined) throw new Error(`missing method row: ${name}`)
  return row.request
}

describe('surface vocabulary', () => {
  it('whitelists exactly main, ball and panel — main first', () => {
    expect(SURFACE_IDS).toEqual(['main', 'ball', 'panel'])
    expect(AUX_SURFACE_IDS).toEqual(['ball', 'panel'])
  })

  it('recognises surface ids and rejects everything else', () => {
    for (const id of SURFACE_IDS) expect(isSurfaceId(id)).toBe(true)
    expect(isSurfaceId('tray')).toBe(false)
    expect(isSurfaceId(undefined)).toBe(false)
    // `main` is a surface but never an auxiliary one — the Shell owns it.
    expect(isAuxSurfaceId('main')).toBe(false)
    expect(isAuxSurfaceId('panel')).toBe(true)
  })
})

describe('shell contract', () => {
  it('declares the client-facing rows and frames', () => {
    expect(Object.keys(shellContract.methods).sort()).toEqual([
      'shell.ball.state',
      'shell.surface.hide',
      'shell.surface.present',
      'shell.toast',
    ])
    expect(Object.keys(shellContract.frames).sort()).toEqual([
      'shell/ball-changed',
      'shell/surface-changed',
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