/**
 * The auxiliary surface window (the floating ball) and the operator window's
 * handover. This is the only module that positions those windows, so the
 * OS-level properties that make the ball feel like a floating widget live in
 * one place — transparent, frameless, always on top, out of the taskbar,
 * fixed size — and the dock behavior (park at an edge, tuck to a sliver,
 * slide out on hover) is wired to the pure decisions in `./dock`.
 *
 * Lifetime rules:
 *
 * - The ball window is created **lazily** on the first `present` and then
 *   kept, so a hidden ball reappears without a reload (its renderer stays
 *   warm and its subscriptions stay live).
 * - The ball's park is remembered across sessions as `{ edge, offset }`, so a
 *   parked ball re-parks correctly after a restart; a free position that no
 *   longer lands inside a display's work area is discarded (a monitor was
 *   unplugged) and the ball returns to the bottom-right corner.
 * - The operator window is **created by the app entry** (boot ordering and
 *   graceful degradation stay there) and handed over as a promise: this host
 *   attaches its visibility publishing the moment it exists, and the Shell
 *   adapter (`./index`) attaches the close policy through
 *   {@link SurfaceHostOptions.onMainWindowAttached}.
 *
 * @module @snap-rail/desktop/main/shell/surfaces
 */

import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { SURFACE_IDS, type AuxSurfaceId, type SurfaceId } from '@snap-rail/protocol'
import {
  BALL_SURFACE,
  resolveBallProfile,
  type BallDockEdge,
  type BallDockState,
  type BallProfile,
  type ResolvedBallProfile,
  type SurfaceState,
} from '@snap-rail/shell'
import {
  clampDock,
  clampPosition,
  dockedPosition,
  initialTuckState,
  settleDock,
  tickTuck,
  visiblePxOf,
  visibleRect,
  type BallDock,
  type Point,
  type Rect,
  type Size,
  type TuckState,
} from './dock.ts'
import { placeBall } from './ball-place.ts'

/** The factory ball bounds, kept as a stable export for tests/tools. */
export const SURFACE_BOUNDS: Readonly<Record<AuxSurfaceId, { width: number, height: number }>> = {
  ball: { width: BALL_SURFACE.size, height: BALL_SURFACE.size },
}

/** Pixels of the factory ball window that stay on screen while parked. */
export const BALL_VISIBLE_PX = visiblePxOf(SURFACE_BOUNDS.ball)

/** A saved ball position: free coordinates, or a parked edge with its cross-axis offset. */
export type SavedBallPosition =
  | { kind: 'free', x: number, y: number }
  | { kind: 'docked', edge: BallDockEdge, offset: number }

/** What the surface host needs from the app. */
export interface SurfaceHostOptions {
  /** The preload script every renderer window mounts. */
  preloadPath: string
  /** The Vite dev server URL; absent in the packaged build. */
  devUrl?: string | undefined
  /** The built client root (`dist/client`), holding `index.html` and `surface.html`. */
  clientRoot: string
  /** The operator window, resolved by the app entry once it has created it. */
  operatorWindow: Promise<BrowserWindow>
  /** The persisted ball position, when one was saved. */
  loadBallPosition(): SavedBallPosition | undefined
  /** Persist the ball position. */
  saveBallPosition(position: SavedBallPosition): void
  /**
   * A window's visibility changed outside the Shell's own calls (the OS hid
   * or showed it) — the adapter republishes the state so no surface keeps a
   * stale "visible" belief.
   */
  onVisibilityChanged?: ((surface: SurfaceId) => void) | undefined
  /** The ball's dock state changed (parked, tucked, slid out). */
  onDockChanged?: ((state: BallDockState) => void) | undefined
  /**
   * The operator window arrived. The Shell adapter attaches its close policy
   * here; the visibility publishing is already wired.
   */
  onMainWindowAttached?: ((window: BrowserWindow) => void) | undefined
}

/** The window side of the Shell seam. */
export interface SurfaceHost {
  /** The window of one surface, when it exists. */
  windowOf(surface: SurfaceId): BrowserWindow | undefined
  /** The effective floating-ball stage. */
  ballProfile(): ResolvedBallProfile
  /** Apply a ball stage (size/docking/availability) and resize the window if live. */
  setBallProfile(profile: BallProfile): ResolvedBallProfile
  /** Show and focus a surface (`main` included); false when it cannot. */
  present(surface: SurfaceId): boolean
  /** Hide an auxiliary surface; false when no window exists. */
  hide(surface: AuxSurfaceId): boolean
  /**
   * Drag-drive the ball window: `begin` anchors the grab from the live OS
   * cursor and starts the follow poll, `end` stops it and hands the window
   * to the dock settle; false when no live window.
   */
  moveBall(event: { phase: 'begin' | 'end' }): boolean
  /** One surface's live state. */
  stateOf(surface: SurfaceId): SurfaceState
  /** Every surface's state, `main` first. */
  states(): readonly SurfaceState[]
  /** The ball window's dock state (parked edge, tucked flag). */
  dockState(): BallDockState
  /** Tear every auxiliary window down (app shutdown). */
  dispose(): void
}

/** Whether a window currently shows on screen. */
function isVisible(win: BrowserWindow | undefined): boolean {
  return win !== undefined && !win.isDestroyed() && win.isVisible()
}

/** Clamp a remembered free position into a display's work area. */
function clampToDisplay(position: Point, size: Size): Point | undefined {
  const work = workAreaNear(position, size)
  const clamped = clampPosition(position, size, work)
  const drift = Math.abs(clamped.x - position.x) + Math.abs(clamped.y - position.y)
  // A position that had to move more than a window's width/height belonged to
  // a display that is gone — discard it and take the default corner instead.
  if (drift > Math.max(size.width, size.height)) return undefined
  return clamped
}

/** The work area of the display the ball (or a point of it) sits on. */
function workAreaNear(point: Point, size: Size): Rect {
  const center = { x: point.x + size.width / 2, y: point.y + size.height / 2 }
  return screen.getDisplayNearestPoint(center).workArea
}

/**
 * Create the auxiliary-surface host.
 *
 * @param options - see {@link SurfaceHostOptions}.
 * @returns the surface host the Shell service drives.
 */
export function createSurfaceHost(options: SurfaceHostOptions): SurfaceHost {
  const windows = new Map<AuxSurfaceId, BrowserWindow>()
  let ball = resolveBallProfile()
  const ballSize = (): Size => ({ width: ball.size, height: ball.size })
  const ballVisiblePx = (): number => visiblePxOf(ballSize(), ball.dockVisibleRatio)
  let main: BrowserWindow | undefined
  /** The ball's pending drag-settle timer. */
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  /** The ball's dock-slide animation timer. */
  let animTimer: ReturnType<typeof setInterval> | undefined
  /** The cursor poll that drives reveal/tuck while the ball is parked. */
  let pollTimer: ReturnType<typeof setInterval> | undefined
  /** Guards against our own dock animations re-entering the drag settle. */
  let programmatic = 0
  let programmaticTimer: ReturnType<typeof setTimeout> | undefined
  /** The parked position (edge + offset + the work area it was computed against), when parked. */
  let parked: { dock: BallDock, work: Rect } | undefined
  /** The live ball drag: the grab anchor (cursor offset from the window origin). */
  let drag: { anchorX: number, anchorY: number } | undefined
  /** The 60 fps follow poll that pins the dragged ball under the OS cursor. */
  let dragTimer: ReturnType<typeof setInterval> | undefined
  let dockState: BallDockState = { edge: null, collapsed: false, visiblePx: ballVisiblePx() }
  let tuck: TuckState = initialTuckState(false)

  // The operator window arrives whenever the app entry finishes creating it;
  // wire its visibility publishing and hand it to the adapter.
  void options.operatorWindow
    .then(win => {
      if (win.isDestroyed()) return
      main = win
      win.on('show', () => options.onVisibilityChanged?.('main'))
      win.on('hide', () => options.onVisibilityChanged?.('main'))
      options.onMainWindowAttached?.(win)
      options.onVisibilityChanged?.('main')
    })
    .catch(() => {
      // The promise only rejects if the app entry is torn down before creating
      // the window — boot has already failed louder elsewhere.
    })

  // A display change can invalidate a parked edge or push a free position
  // off-screen; recompute both against the new layout.
  const onDisplaysChanged = (): void => {
    const win = windows.get('ball')
    if (win === undefined || win.isDestroyed()) return
    if (parked !== undefined) {
      const [rawX, rawY] = win.getPosition()
      const work = workAreaNear({ x: rawX ?? 0, y: rawY ?? 0 }, ballSize())
      parked = { dock: clampDock(parked.dock, ballSize(), work), work }
      applyDock(win, tuck.collapsed)
    } else if (isVisible(win)) {
      const [x, y] = win.getPosition()
      const clamped = clampToDisplay({ x: x ?? 0, y: y ?? 0 }, ballSize())
      if (clamped !== undefined) positionProgrammatically(win, clamped)
    }
  }
  screen.on('display-metrics-changed', onDisplaysChanged)
  screen.on('display-removed', onDisplaysChanged)

  function publishDock(next: BallDockState): void {
    if (
      next.edge === dockState.edge
      && next.collapsed === dockState.collapsed
      && next.visiblePx === dockState.visiblePx
    ) return
    dockState = next
    options.onDockChanged?.(next)
  }

  /** Mark our own positioning so the drag settle does not fight the animation. */
  function positionProgrammatically(win: BrowserWindow, at: Point): void {
    programmatic += 1
    if (programmaticTimer !== undefined) clearTimeout(programmaticTimer)
    placeBall(win, ballSize(), at.x, at.y)
    // Outlive the settle debounce so `moved` events from the animation's tail
    // are all ignored, then hand control back to the operator.
    programmaticTimer = setTimeout(() => {
      programmatic = 0
    }, 600)
  }

  /** Tween the ball window to a dock position (a few frames; the ball is 128px). */
  function animateTo(win: BrowserWindow, target: Point): void {
    if (animTimer !== undefined) clearInterval(animTimer)
    const [fromX, fromY] = win.getPosition()
    const from = { x: fromX ?? 0, y: fromY ?? 0 }
    if (from.x === target.x && from.y === target.y) return
    const steps = 10
    let step = 0
    animTimer = setInterval(() => {
      step += 1
      if (win.isDestroyed() || step >= steps) {
        if (animTimer !== undefined) clearInterval(animTimer)
        animTimer = undefined
        if (!win.isDestroyed()) positionProgrammatically(win, target)
        return
      }
      positionProgrammatically(win, {
        x: Math.round(from.x + (target.x - from.x) * (step / steps)),
        y: Math.round(from.y + (target.y - from.y) * (step / steps)),
      })
    }, 12)
  }

  /** Place the parked ball at its tucked or slid-out position. */
  function applyDock(win: BrowserWindow, collapsed: boolean): void {
    if (parked === undefined) return
    const at = dockedPosition(parked.dock, ballSize(), parked.work, collapsed, ballVisiblePx())
    animateTo(win, at)
  }

  function tuckBall(win: BrowserWindow): void {
    if (parked === undefined) return
    tuck = initialTuckState(true)
    applyDock(win, true)
    publishDock({ edge: parked.dock.edge, collapsed: true, visiblePx: ballVisiblePx() })
  }

  function revealBall(win: BrowserWindow): void {
    if (parked === undefined) return
    tuck = { collapsed: false, inside: false, outsideSince: undefined }
    applyDock(win, false)
    publishDock({ edge: parked.dock.edge, collapsed: false, visiblePx: ballVisiblePx() })
  }

  function stopPolling(): void {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
  }

  /** Stop the drag follow poll (the drag itself is over or lost its window). */
  function stopDragPoll(): void {
    if (dragTimer !== undefined) {
      clearInterval(dragTimer)
      dragTimer = undefined
    }
  }

  /** Drive reveal/tuck from the cursor while the ball is parked and visible. */
  function startPolling(win: BrowserWindow): void {
    if (pollTimer !== undefined) return
    pollTimer = setInterval(() => {
      if (win.isDestroyed() || !win.isVisible() || parked === undefined) {
        stopPolling()
        return
      }
      if (animTimer !== undefined) return // a slide is in flight; wait for it
      let pointer: Point | undefined
      try {
        const at = screen.getCursorScreenPoint()
        pointer = { x: at.x, y: at.y }
      } catch {
        return // no cursor position this tick; try again on the next one
      }
      const [rawX, rawY] = win.getPosition()
      const windowRect: Rect = { x: rawX ?? 0, y: rawY ?? 0, width: ballSize().width, height: ballSize().height }
      const strip = visibleRect(parked.dock, ballSize(), parked.work, ballVisiblePx())
      const verdict = tickTuck(tuck, pointer, windowRect, strip, Date.now(), ball.hoverDelayMs)
      tuck = verdict.state
      if (verdict.action === 'reveal') revealBall(win)
      else if (verdict.action === 'tuck') tuckBall(win)
    }, 120)
  }

  /** Persist and apply the outcome of a settled drag. */
  function settleBall(win: BrowserWindow): void {
    const [rawX, rawY] = win.getPosition()
    const position = { x: rawX ?? 0, y: rawY ?? 0 }
    const work = workAreaNear(position, ballSize())
    const landed = ball.dockable ? settleDock(position, ballSize(), work) : undefined
    if (landed === undefined || !ball.dockEdges.includes(landed.edge)) {
      parked = undefined
      stopPolling()
      const clamped = clampPosition(position, ballSize(), work)
      positionProgrammatically(win, clamped)
      options.saveBallPosition({ kind: 'free', x: clamped.x, y: clamped.y })
      publishDock({ edge: null, collapsed: false, visiblePx: ballVisiblePx() })
      return
    }
    parked = { dock: landed, work }
    options.saveBallPosition({ kind: 'docked', edge: landed.edge, offset: landed.offset })
    // A park lands flush: the cursor is on the ball right after the drop, so
    // it stays fully out and tucks only once the pointer moves on.
    tuck = initialTuckState(false)
    applyDock(win, false)
    publishDock({ edge: landed.edge, collapsed: false, visiblePx: ballVisiblePx() })
    if (ball.collapse) startPolling(win)
  }

  /** Settle only after the drag has truly gone quiet (a paused hand is still a drag). */
  function settleWhenQuiet(win: BrowserWindow): void {
    let before: Point | undefined
    try {
      const at = screen.getCursorScreenPoint()
      before = { x: at.x, y: at.y }
    } catch {
      before = undefined
    }
    setTimeout(() => {
      if (win.isDestroyed()) return
      let after: Point | undefined
      try {
        const at = screen.getCursorScreenPoint()
        after = { x: at.x, y: at.y }
      } catch {
        after = undefined
      }
      const moved = before !== undefined && after !== undefined
        && Math.abs(after.x - before.x) + Math.abs(after.y - before.y) > 4
      if (moved) {
        settleTimer = setTimeout(() => settleWhenQuiet(win), 250)
        return
      }
      settleTimer = undefined
      settleBall(win)
    }, 120)
  }

  function scheduleBallSettle(win: BrowserWindow): void {
    if (programmatic > 0) return
    if (settleTimer !== undefined) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => settleWhenQuiet(win), 350)
  }

  function create(surface: AuxSurfaceId): BrowserWindow {
    const size = ballSize()
    const win = new BrowserWindow({
      ...size,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: surface === 'ball',
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      // The ball is a desktop widget: it must survive the operator switching
      // to another app.
      focusable: true,
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    win.setMenuBarVisibility(false)

    if (surface === 'ball') {
      const saved = options.loadBallPosition()
      if (saved?.kind === 'docked' && ball.dockable && ball.dockEdges.includes(saved.edge)) {
        // A parked ball re-parks on the primary display's work area (the park
        // is stored as an edge plus an offset, so it survives resolution
        // changes better than raw coordinates would). It comes back tucked
        // only when collapsing is on — with the pointer elsewhere, a parked
        // ball belongs to its edge.
        const work = screen.getPrimaryDisplay().workArea
        const dock = clampDock({ edge: saved.edge, offset: saved.offset }, size, work)
        parked = { dock, work }
        const at = dockedPosition(dock, size, work, ball.collapse, ballVisiblePx())
        placeBall(win, size, at.x, at.y)
        tuck = initialTuckState(ball.collapse)
        dockState = { edge: dock.edge, collapsed: ball.collapse, visiblePx: ballVisiblePx() }
      } else if (saved !== undefined && saved.kind === 'free') {
        const placed = clampToDisplay({ x: saved.x, y: saved.y }, size)
        if (placed !== undefined) placeBall(win, size, placed.x, placed.y)
        else defaultCorner(win, size)
      } else {
        defaultCorner(win, size)
      }
      win.on('moved', () => {
        // A live drag moves the window itself; its settle waits for the end.
        if (drag === undefined) scheduleBallSettle(win)
      })
    }

    win.on('closed', () => {
      windows.delete(surface)
      if (surface === 'ball') stopPolling()
    })
    // Visibility can change without the Shell asking (an OS-side hide or
    // show): republish so every surface sees the truth.
    win.on('show', () => options.onVisibilityChanged?.(surface))
    win.on('hide', () => options.onVisibilityChanged?.(surface))

    const query = `?surface=${surface}`
    const devUrl = options.devUrl === undefined
      ? undefined
      : options.devUrl.endsWith('/') ? options.devUrl : `${options.devUrl}/`
    if (devUrl !== undefined) void win.loadURL(`${devUrl}surface.html${query}`)
    else void win.loadFile(join(options.clientRoot, 'surface.html'), { query: { surface } })
    windows.set(surface, win)
    return win
  }

  /** The ball's default parking spot: the work area's bottom-right corner. */
  function defaultCorner(win: BrowserWindow, size: Size): void {
    const area = screen.getPrimaryDisplay().workArea
    placeBall(win, size, area.x + area.width - size.width - 24, area.y + area.height - size.height - 24)
  }

  function auxWindow(surface: AuxSurfaceId): BrowserWindow {
    const existing = windows.get(surface)
    if (existing !== undefined && !existing.isDestroyed()) return existing
    return create(surface)
  }

  const host: SurfaceHost = {
    windowOf(surface) {
      if (surface === 'main') return main
      const win = windows.get(surface)
      return win === undefined || win.isDestroyed() ? undefined : win
    },

    ballProfile: () => ball,

    setBallProfile(profile: BallProfile): ResolvedBallProfile {
      ball = resolveBallProfile(profile)
      const win = windows.get('ball')
      if (win !== undefined && !win.isDestroyed()) {
        // Windows refuses to shrink a window created with `resizable: false`;
        // flip it around the resize like the operator window's profile dance.
        win.setResizable(true)
        win.setSize(ball.size, ball.size)
        win.setResizable(false)
        if (!ball.enabled) {
          win.hide()
          stopPolling()
        } else if (parked !== undefined) {
          const [rawX, rawY] = win.getPosition()
          const work = workAreaNear({ x: rawX ?? 0, y: rawY ?? 0 }, ballSize())
          parked = { dock: clampDock(parked.dock, ballSize(), work), work }
          if (ball.collapse) {
            applyDock(win, tuck.collapsed)
            startPolling(win)
          } else {
            // Collapse switched off while parked: the ball comes fully out
            // and the tuck machine stops running.
            tuck = initialTuckState(false)
            applyDock(win, false)
            stopPolling()
          }
        } else if (isVisible(win)) {
          const [x, y] = win.getPosition()
          const clamped = clampToDisplay({ x: x ?? 0, y: y ?? 0 }, ballSize())
          if (clamped !== undefined) positionProgrammatically(win, clamped)
        }
        publishDock({ edge: parked?.dock.edge ?? null, collapsed: parked !== undefined && tuck.collapsed, visiblePx: ballVisiblePx() })
      }
      return ball
    },

    present(surface) {
      if (surface === 'main') {
        if (main === undefined || main.isDestroyed()) return false
        if (main.isMinimized()) main.restore()
        main.show()
        main.focus()
        return true
      }
      try {
        const win = auxWindow(surface)
        win.showInactive()
        // An explicit summon slides a parked ball out; it keeps its edge and
        // tucks back once the pointer moves on.
        if (surface === 'ball' && ball.collapse && parked !== undefined) {
          tuck = { collapsed: false, inside: false, outsideSince: undefined }
          applyDock(win, false)
          publishDock({ edge: parked.dock.edge, collapsed: false, visiblePx: ballVisiblePx() })
          startPolling(win)
        }
        return true
      } catch {
        // A transparent always-on-top window can fail on hosts without a
        // compositor; the caller turns this into `unavailable`.
        return false
      }
    },

    hide(surface) {
      const win = windows.get(surface)
      if (win === undefined || win.isDestroyed()) return false
      win.hide()
      if (surface === 'ball') stopPolling()
      return true
    },

    moveBall({ phase }) {
      const win = windows.get('ball')
      if (win === undefined || win.isDestroyed()) return false
      if (phase === 'begin') {
        if (!win.isVisible()) return false
        let at: { x: number, y: number }
        try {
          const cursor = screen.getCursorScreenPoint()
          at = { x: cursor.x, y: cursor.y }
        } catch {
          return false
        }
        const [rawX, rawY] = win.getPosition()
        drag = { anchorX: at.x - (rawX ?? 0), anchorY: at.y - (rawY ?? 0) }
        // Leaving the park: the tuck poll would fight the drag, and any dock
        // slide still in flight would too. The ball is free until the settle
        // re-parks it from the released position.
        parked = undefined
        tuck = initialTuckState(false)
        stopPolling()
        if (animTimer !== undefined) {
          clearInterval(animTimer)
          animTimer = undefined
        }
        publishDock({ edge: null, collapsed: false, visiblePx: ballVisiblePx() })
        // The cursor is the only truth: pin the window to it at display rate.
        // Absolute positioning cannot accumulate error, so the ball stays
        // glued to the pointer no matter how fast the drag is. The writes go
        // through placeBall: this poll is the heaviest position hammer we
        // own, and the OS's resizable:false rounding grows the window a
        // pixel per unguarded write (electron/electron#41675).
        stopDragPoll()
        dragTimer = setInterval(() => {
          if (win.isDestroyed() || !win.isVisible() || drag === undefined) {
            stopDragPoll()
            return
          }
          try {
            const cursor = screen.getCursorScreenPoint()
            // The chase is clamped to the work area under the cursor: the
            // dragged ball can press flush against an edge but never leave
            // the screen.
            const target = { x: Math.round(cursor.x - drag.anchorX), y: Math.round(cursor.y - drag.anchorY) }
            const work = workAreaNear(target, ballSize())
            const at = clampPosition(target, ballSize(), work)
            placeBall(win, ballSize(), at.x, at.y)
          } catch {
            stopDragPoll()
          }
        }, 16)
        return true
      }
      const wasDragging = drag !== undefined
      drag = undefined
      stopDragPoll()
      if (wasDragging) scheduleBallSettle(win)
      return true
    },

    stateOf(surface) {
      const win = surface === 'main' ? main : windows.get(surface)
      const alive = win !== undefined && !win.isDestroyed()
      return {
        surface,
        available: surface === 'main' ? alive : windows.has(surface),
        visible: alive && isVisible(win),
      }
    },

    states: () => SURFACE_IDS.map(surface => host.stateOf(surface)),

    dockState: () => dockState,

    dispose() {
      if (settleTimer !== undefined) clearTimeout(settleTimer)
      if (animTimer !== undefined) clearInterval(animTimer)
      if (programmaticTimer !== undefined) clearTimeout(programmaticTimer)
      stopPolling()
      stopDragPoll()
      screen.removeListener('display-metrics-changed', onDisplaysChanged)
      screen.removeListener('display-removed', onDisplaysChanged)
      for (const win of windows.values()) {
        if (!win.isDestroyed()) win.destroy()
      }
      windows.clear()
    },
  }
  return host
}
