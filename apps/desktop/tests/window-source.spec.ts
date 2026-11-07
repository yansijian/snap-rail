import { describe, expect, it } from 'vitest'
import { WINDOW_APPLY_SETTLE_MS, createWindowSourceTracker } from '../src-host/main/shell/window-source.ts'

/**
 * The operator window's profile-source policy: remembered (`persisted`)
 * geometry is a boot-time restore, never a lock — only the appearance page's
 * operator fix refuses layout/face requests. And a programmatic apply is
 * never remembered as a gesture: applies cancel queued saves and swallow
 * their own geometry events inside a settle window, so a face-requested
 * stage can't wedge itself into the remembered state.
 */

describe('window profile source policy', () => {
  it('boots unlocked unless the operator fixed the profile', () => {
    const free = createWindowSourceTracker()
    free.boot(false)
    expect(free.state()).toBe('default')
    expect(free.locked()).toBe(false)

    const fixed = createWindowSourceTracker()
    fixed.boot(true)
    expect(fixed.state()).toBe('user')
    expect(fixed.locked()).toBe(true)
  })

  it('remembered bounds never lock configure requests', () => {
    const tracker = createWindowSourceTracker()
    tracker.boot(false)
    tracker.noteRemembered()
    expect(tracker.state()).toBe('persisted')
    expect(tracker.locked()).toBe(false)
  })

  it('an operator fix refuses until 跟随布局 releases it', () => {
    const tracker = createWindowSourceTracker()
    tracker.applyUser()
    expect(tracker.locked()).toBe(true)
    tracker.reset()
    expect(tracker.state()).toBe('default')
    expect(tracker.locked()).toBe(false)
  })

  it('an honoured layout/face request keeps later requests open', () => {
    const tracker = createWindowSourceTracker()
    tracker.applyRequested()
    expect(tracker.state()).toBe('layout')
    expect(tracker.locked()).toBe(false)
    tracker.noteRemembered()
    expect(tracker.locked()).toBe(false)
  })

  it('geometry events inside an apply settle window belong to the apply', () => {
    let clock = 1_000
    const tracker = createWindowSourceTracker({ now: () => clock })
    expect(tracker.settling()).toBe(false)

    tracker.beginApply()
    expect(tracker.settling()).toBe(true)
    clock += WINDOW_APPLY_SETTLE_MS - 1
    expect(tracker.settling()).toBe(true)
    clock += 1
    expect(tracker.settling()).toBe(false)
  })
})
