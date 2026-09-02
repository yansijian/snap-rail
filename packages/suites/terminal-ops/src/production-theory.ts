/**
 * Production arithmetic as pure functions over the audit event stream: the
 * running session (start/stop), pause windows (fault and downtime, unioned —
 * the machine is either producing or not), and the derived theoretical
 * counters. Everything is restorable from events alone, so a restart
 * recomputes the same numbers.
 *
 * @module @snap-rail/suite-terminal-ops/production-theory
 */

/** One audit-shaped business event (see `audit.list`). */
export interface ProductionEvent {
  action: string
  actor: string
  time: number
  detail?: unknown
}

/** One producible model with its theoretical rate. */
export interface ModelInfo {
  id: string
  name: string
  ratePerHour: number
}

/** Actions that open a production pause, and the ones that close it. */
const PAUSE_OPENS: ReadonlySet<string> = new Set(['fault.report', 'downtime.begin'])
const PAUSE_CLOSES: ReadonlySet<string> = new Set(['fault.repair-complete', 'downtime.resume'])

/** The derived production state. */
export interface ProductionState {
  /** The running session (latest start without a stop), or `null` when idle. */
  session: { model: ModelInfo, startedAt: number } | null
  /** A fault is open (reported, not yet repaired). */
  faultActive: boolean
  /** A downtime is open (begun, not yet resumed). */
  downtimeActive: boolean
}

function modelOf(detail: unknown, models: readonly ModelInfo[]): ModelInfo | undefined {
  const id = (detail as { model?: unknown } | undefined)?.model
  return typeof id === 'string' ? models.find(model => model.id === id) : undefined
}

/**
 * Walk the event stream (sorted or unsorted; this sorts first) and derive the
 * production state. An unknown model id in `production.start` is ignored
 * (the start event falls through, state stays as if it never happened).
 */
export function deriveState(events: readonly ProductionEvent[], models: readonly ModelInfo[]): ProductionState {
  const sorted = [...events].sort((a, b) => a.time - b.time)
  let session: ProductionState['session'] = null
  let faultActive = false
  let downtimeActive = false
  for (const event of sorted) {
    switch (event.action) {
      case 'production.start': {
        const model = modelOf(event.detail, models)
        if (model !== undefined) session = { model, startedAt: event.time }
        break
      }
      case 'production.stop':
        session = null
        break
      case 'fault.report':
        faultActive = true
        break
      case 'fault.repair-complete':
        faultActive = false
        break
      case 'downtime.begin':
        downtimeActive = true
        break
      case 'downtime.resume':
        downtimeActive = false
        break
      default:
        break
    }
  }
  return { session, faultActive, downtimeActive }
}

/**
 * Union of pause windows clipped to `[from, to]`. Concurrent pauses (a fault
 * during a downtime) count once; a still-open pause closes at `to`.
 */
export function pauseIntervals(
  events: readonly ProductionEvent[],
  from: number,
  to: number,
): Array<[number, number]> {
  const sorted = [...events].sort((a, b) => a.time - b.time)
  const windows: Array<[number, number]> = []
  let openCount = 0
  let openStart = 0
  for (const event of sorted) {
    const isPauseEdge = PAUSE_OPENS.has(event.action) || PAUSE_CLOSES.has(event.action)
    if (!isPauseEdge) continue
    const wasPaused = openCount > 0
    if (PAUSE_OPENS.has(event.action)) openCount += 1
    else openCount = Math.max(0, openCount - 1)
    const nowPaused = openCount > 0
    if (!wasPaused && nowPaused) openStart = event.time
    if (wasPaused && !nowPaused) windows.push([openStart, event.time])
  }
  if (openCount > 0) windows.push([openStart, to])

  const clipped: Array<[number, number]> = []
  let current: [number, number] | null = null
  for (const [start, end] of windows.sort((a, b) => a[0] - b[0])) {
    const begin = Math.max(start, from)
    const finish = Math.min(end, to)
    if (begin >= finish) continue
    if (current !== null && begin <= current[1]) current = [current[0], Math.max(current[1], finish)]
    else {
      if (current !== null) clipped.push(current)
      current = [begin, finish]
    }
  }
  if (current !== null) clipped.push(current)
  return clipped
}

/** Producing milliseconds inside `[from, to]` (wall window minus pauses). */
export function netMillis(events: readonly ProductionEvent[], from: number, to: number): number {
  if (to <= from) return 0
  const paused = pauseIntervals(events, from, to).reduce((sum, [start, end]) => sum + (end - start), 0)
  return to - from - paused
}

/** Theoretical total output since the session started, at the model rate. */
export function theoryTotal(events: readonly ProductionEvent[], state: ProductionState, now: number): number {
  if (state.session === null) return 0
  const { model, startedAt } = state.session
  const net = netMillis(events, startedAt, Math.max(now, startedAt))
  return model.ratePerHour * net / 3_600_000
}

/**
 * Theoretical output per hour bucket for the 24 hour-aligned buckets ending
 * at `now`'s hour (oldest first). Only the current session counts; buckets
 * before its start are zero.
 */
export function theoryPerHour(
  events: readonly ProductionEvent[],
  state: ProductionState,
  now: number,
): number[] {
  const buckets = new Array<number>(24).fill(0)
  if (state.session === null) return buckets
  const hour = 3_600_000
  const currentHourStart = new Date(now).setMinutes(0, 0, 0)
  for (let index = 0; index < 24; index += 1) {
    const bucketIndex = 23 - index
    const bucketStart = currentHourStart - index * hour
    const bucketEnd = bucketStart + hour
    const from = Math.max(bucketStart, state.session.startedAt)
    const to = Math.min(bucketEnd, Math.max(now, state.session.startedAt))
    if (to <= from) continue
    buckets[bucketIndex] = state.session.model.ratePerHour * netMillis(events, from, to) / hour
  }
  return buckets
}
