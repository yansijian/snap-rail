import { describe, expect, it } from 'vitest'
import { SHELL_LIMITS } from '@snap-rail/shell'
import { createShellMachine } from '../src-host/main/shell/machine.ts'

/**
 * The Shell adapter's rules, driven without a window: the tray contribution
 * caps and ownership model, the notification ledger (throttle, coalescing,
 * eviction), the ball state merge, and the exit policy fold with its hold
 * ledger. The Electron glue is deliberately out of scope — everything
 * decidable is decided here.
 */

/** A machine with a controllable clock. */
function machineAt(start = 1_000): { machine: ReturnType<typeof createShellMachine>, advance: (ms: number) => void } {
  let clock = start
  const machine = createShellMachine({ now: () => clock })
  return { machine, advance: (ms: number) => { clock += ms } }
}

describe('tray contributions', () => {
  it('namespaces keys per plugin so two plugins may share an id', () => {
    const { machine } = machineAt()
    expect(machine.addTrayItem('suite-a', { id: 'pause', label: '暂停采集' })).toEqual({ applied: true })
    expect(machine.addTrayItem('suite-b', { id: 'pause', label: '暂停记录' })).toEqual({ applied: true })
    expect(machine.trayEntries().map(entry => entry.key)).toEqual(['suite-a:pause', 'suite-b:pause'])
  })

  it('refuses a duplicate id within one plugin, and only that plugin', () => {
    const { machine } = machineAt()
    machine.addTrayItem('suite-a', { id: 'pause', label: '暂停采集' })
    const duplicate = machine.addTrayItem('suite-a', { id: 'pause', label: '暂停采集' })
    expect(duplicate).toMatchObject({ applied: false, reason: 'duplicate' })
    // Ownership: suite-b cannot update or remove suite-a's row.
    expect(machine.updateTrayItem('suite-b', 'pause', { label: 'x' })).toMatchObject({ applied: false, reason: 'not-found' })
    expect(machine.removeTrayItem('suite-b', 'pause')).toMatchObject({ applied: false, reason: 'not-found' })
    expect(machine.trayEntries()).toHaveLength(1)
  })

  it('enforces the label cap and the per-plugin and total caps', () => {
    const { machine } = machineAt()
    expect(machine.addTrayItem('a', { id: 'x', label: '标题'.repeat(SHELL_LIMITS.trayLabel) }))
      .toMatchObject({ applied: false, reason: 'limit-reached' })
    expect(machine.addTrayItem('a', { id: '', label: 'ok' })).toMatchObject({ applied: false, reason: 'limit-reached' })

    for (let index = 0; index < SHELL_LIMITS.trayItemsPerPlugin; index++) {
      expect(machine.addTrayItem('a', { id: `i${index}`, label: `项 ${index}` })).toEqual({ applied: true })
    }
    expect(machine.addTrayItem('a', { id: 'overflow', label: '溢出' })).toMatchObject({ applied: false, reason: 'limit-reached' })
    // Another plugin still has room until the global cap.
    expect(machine.addTrayItem('b', { id: 'one', label: '一' })).toEqual({ applied: true })

    for (let index = 0; machine.trayEntries().length < SHELL_LIMITS.trayItems; index++) {
      machine.addTrayItem(`filler-${index}`, { id: 'x', label: '填充' })
    }
    expect(machine.addTrayItem('c', { id: 'one', label: '一' })).toMatchObject({ applied: false, reason: 'limit-reached' })
  })

  it('updates label, enabled, and the checked toggle in place', () => {
    const { machine } = machineAt()
    machine.addTrayItem('a', { id: 'mute', label: '静音', checked: false })
    expect(machine.updateTrayItem('a', 'mute', { label: '已静音', checked: true })).toEqual({ applied: true })
    expect(machine.trayEntries()[0]).toMatchObject({ label: '已静音', checked: true })
    // `null` demotes the toggle back to a plain item; `undefined` leaves it.
    expect(machine.updateTrayItem('a', 'mute', { checked: null })).toEqual({ applied: true })
    expect(machine.trayEntries()[0]).not.toHaveProperty('checked')
    expect(machine.updateTrayItem('a', 'mute', { enabled: false })).toEqual({ applied: true })
    expect(machine.trayEntries()[0]).toMatchObject({ enabled: false })
  })

  it('drops every row a plugin owned when its fiber goes away', () => {
    const { machine } = machineAt()
    machine.addTrayItem('a', { id: 'one', label: '一' })
    machine.addTrayItem('a', { id: 'two', label: '二' })
    machine.addTrayItem('b', { id: 'one', label: '一' })
    expect(machine.removeTrayOwner('a')).toBe(2)
    expect(machine.trayEntries().map(entry => entry.key)).toEqual(['b:one'])
  })
})

describe('notification ledger', () => {
  it('allocates an id and keeps the record for click routing', () => {
    const { machine } = machineAt()
    const plan = machine.planNotification({ title: '采集失败', body: '点位超时', actions: [{ id: 'retry', label: '重试' }] })
    expect(plan.applied).toBe(true)
    if (!plan.applied) return
    expect(plan.record.actions).toEqual(['retry'])
    expect(machine.notification(plan.id)?.time).toBe(1_000)
  })

  it('refuses over-cap titles, bodies, actions and tags', () => {
    const { machine } = machineAt()
    expect(machine.planNotification({ title: 'x'.repeat(SHELL_LIMITS.title + 1) })).toMatchObject({ applied: false, reason: 'limit-reached' })
    expect(machine.planNotification({ title: '' })).toMatchObject({ applied: false, reason: 'limit-reached' })
    expect(machine.planNotification({ title: 't', body: 'x'.repeat(SHELL_LIMITS.body + 1) })).toMatchObject({ applied: false })
    expect(machine.planNotification({
      title: 't',
      actions: Array.from({ length: SHELL_LIMITS.notificationActions + 1 }, (_, index) => ({ id: `a${index}`, label: `${index}` })),
    })).toMatchObject({ applied: false, reason: 'limit-reached' })
    expect(machine.planNotification({ title: 't', actions: [{ id: 'a', label: 'x'.repeat(SHELL_LIMITS.actionLabel + 1) }] }))
      .toMatchObject({ applied: false, reason: 'limit-reached' })
    expect(machine.planNotification({ title: 't', tag: 'x'.repeat(SHELL_LIMITS.tag + 1) })).toMatchObject({ applied: false })
    // Refusals never consume the throttle budget.
    expect(machine.planNotification({ title: 'ok' })).toMatchObject({ applied: true })
  })

  it('throttles to the per-window cap and releases it as the window slides', () => {
    const { machine, advance } = machineAt()
    for (let index = 0; index < SHELL_LIMITS.notificationsPerWindow; index++) {
      expect(machine.planNotification({ title: `通知 ${index}` })).toMatchObject({ applied: true })
      advance(100)
    }
    expect(machine.planNotification({ title: '超额' })).toMatchObject({ applied: false, reason: 'limit-reached' })
    advance(SHELL_LIMITS.notificationWindowMs)
    expect(machine.planNotification({ title: '窗口滑过' })).toMatchObject({ applied: true })
  })

  it('coalesces a tagged toast onto one id — and never throttles it away', () => {
    const { machine, advance } = machineAt()
    const first = machine.planNotification({ title: '计数 1', tag: 'count' })
    expect(first.applied).toBe(true)
    if (!first.applied) return
    // Fill the throttle window with untagged toasts.
    for (let index = 0; index < SHELL_LIMITS.notificationsPerWindow; index++) {
      machine.planNotification({ title: `填充 ${index}` })
      advance(10)
    }
    const replacement = machine.planNotification({ title: '计数 2', tag: 'count' })
    expect(replacement.applied).toBe(true)
    if (!replacement.applied) return
    // Same identity: the OS replaces the live toast instead of stacking one.
    expect(replacement.id).toBe(first.id)
    expect(machine.notification(first.id)?.time).toBeGreaterThan(1_000)
  })

  it('evicts the oldest record once the ledger is full', () => {
    const { machine, advance } = machineAt()
    const ids: string[] = []
    for (let index = 0; index < SHELL_LIMITS.notificationRecords + 1; index++) {
      const plan = machine.planNotification({ title: `通知 ${index}` })
      if (plan.applied) ids.push(plan.id)
      advance(SHELL_LIMITS.notificationWindowMs)
    }
    expect(ids).toHaveLength(SHELL_LIMITS.notificationRecords + 1)
    expect(machine.notification(ids[0]!)).toBeUndefined()
    expect(machine.notification(ids.at(-1)!)).toBeDefined()
  })
})

describe('ball state', () => {
  it('starts empty and merges patches', () => {
    const { machine } = machineAt()
    expect(machine.ballState()).toEqual({ progress: null, label: null, tone: 'neutral' })
    expect(machine.setBallState({ progress: 0.5, label: '运行', tone: 'accent' }))
      .toEqual({ progress: 0.5, label: '运行', tone: 'accent' })
    // Partial patch: the untouched fields keep their value.
    expect(machine.setBallState({ progress: 0.8 })).toEqual({ progress: 0.8, label: '运行', tone: 'accent' })
    expect(machine.setBallState({ progress: null, label: null })).toEqual({ progress: null, label: null, tone: 'accent' })
  })

  it('clamps the ring and truncates the caption instead of refusing', () => {
    const { machine } = machineAt()
    expect(machine.setBallState({ progress: 4 }).progress).toBe(1)
    expect(machine.setBallState({ progress: -2 }).progress).toBe(0)
    expect(machine.setBallState({ progress: Number.NaN }).progress).toBe(0)
    expect(machine.setBallState({ label: '运行中生产在线统计' }).label).toHaveLength(SHELL_LIMITS.ballLabel)
    // An unknown tone keeps the previous one (the host face is trusted, but a
    // typo must not paint a transparent ring).
    expect(machine.setBallState({ tone: 'loud' as never }).tone).toBe('neutral')
  })
})

describe('exit policy', () => {
  it('defaults to quit for both sources — the pre-policy behavior', () => {
    const { machine } = machineAt()
    expect(machine.exitPolicy()).toEqual({ close: 'quit', quit: 'quit' })
    expect(machine.exitDecision('window')).toBe('quit')
    expect(machine.exitDecision('tray')).toBe('quit')
  })

  it('accepts a partial declaration and folds the rest from the defaults', () => {
    const { machine } = machineAt()
    expect(machine.setExitPolicy('suite', { close: 'ball' })).toEqual({ applied: true })
    expect(machine.exitPolicy()).toEqual({ close: 'ball', quit: 'quit' })
  })

  it('lets the newest declaration win, per field, across plugins', () => {
    const { machine } = machineAt()
    machine.setExitPolicy('suite-a', { close: 'ball', quit: 'hold' })
    machine.setExitPolicy('suite-b', { close: 'tray' })
    expect(machine.exitPolicy()).toEqual({ close: 'tray', quit: 'hold' })
    // A re-declaration replaces its author's whole patch and moves to the
    // back of the line: the suite always declares the pair it means.
    machine.setExitPolicy('suite-a', { close: 'quit' })
    expect(machine.exitPolicy()).toEqual({ close: 'quit', quit: 'quit' })
  })

  it('reverts the fields of a plugin whose fiber goes away', () => {
    const { machine } = machineAt()
    machine.setExitPolicy('suite', { close: 'ball', quit: 'hold' })
    machine.removeExitPolicyOwner('suite')
    expect(machine.exitPolicy()).toEqual({ close: 'quit', quit: 'quit' })
  })

  it('refuses unknown decisions and an empty declaration', () => {
    const { machine } = machineAt()
    expect(machine.setExitPolicy('suite', { close: 'explode' as never })).toMatchObject({ applied: false, reason: 'limit-reached' })
    expect(machine.setExitPolicy('suite', {})).toMatchObject({ applied: false, reason: 'limit-reached' })
    expect(machine.exitPolicy()).toEqual({ close: 'quit', quit: 'quit' })
  })
})

describe('exit hold', () => {
  it('holds one request and answers it', () => {
    const { machine } = machineAt()
    expect(machine.holdExit('tray')).toEqual({ applied: true })
    expect(machine.pendingExit()).toBe('tray')
    expect(machine.resolveExit('cancel')).toEqual({ source: 'tray', action: 'cancel' })
    expect(machine.pendingExit()).toBeUndefined()
  })

  it('refuses a second request while one is on the table', () => {
    const { machine } = machineAt()
    machine.holdExit('window')
    expect(machine.holdExit('tray')).toMatchObject({ applied: false, reason: 'duplicate' })
    expect(machine.pendingExit()).toBe('window')
  })

  it('expires only the request that is actually held', () => {
    const { machine } = machineAt()
    machine.holdExit('window')
    expect(machine.expireExit('tray')).toBe(false)
    expect(machine.pendingExit()).toBe('window')
    expect(machine.expireExit('window')).toBe(true)
    expect(machine.pendingExit()).toBeUndefined()
    // Answered holds do not resurrect.
    machine.holdExit('window')
    machine.resolveExit('quit')
    expect(machine.expireExit('window')).toBe(false)
  })

  it('answers nothing when no request is held', () => {
    const { machine } = machineAt()
    expect(machine.resolveExit('quit')).toBeUndefined()
  })
})