/**
 * Auxiliary surface windows: the floating ball and its mini panel. This is the
 * only module that creates them, so the OS-level properties that make them
 * feel like a floating widget live in one place — transparent, frameless,
 * always on top, out of the taskbar, fixed size.
 *
 * Lifetime rules:
 *
 * - Windows are created **lazily** on the first `present` and then kept, so a
 *   hidden panel reappears without a reload (its renderer stays warm and its
 *   subscriptions stay live).
 * - The panel hides on blur and on Escape: a floating panel that survives a
 *   click elsewhere is a window the operator has to chase.
 * - The ball's position is remembered across sessions; a position that no
 *   longer lands inside a display's work area is discarded (a monitor was
 *   unplugged), and the ball returns to the bottom-right corner.
 *
 * @module @snap-rail/desktop/main/shell/surfaces
 */

import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { SURFACE_IDS, type AuxSurfaceId, type SurfaceId } from '@snap-rail/protocol'
import type { SurfaceState } from '@snap-rail/shell'

/** The fixed content size of each auxiliary surface's window. */
export const SURFACE_BOUNDS: Readonly<Record<AuxSurfaceId, { width: number, height: number }>> = {
  ball: { width: 128, height: 128 },
  panel: { width: 360, height: 480 },
}

/** A saved window position. */
export interface SurfacePosition {
  x: number
  y: number
}

/** What the surface host needs from the app. */
export interface SurfaceHostOptions {
  /** The preload script every renderer window mounts. */
  preloadPath: string
  /** The Vite dev server URL; absent in the packaged build. */
  devUrl?: string | undefined
  /** The built client root (`dist/client`), holding `index.html` and `surface.html`. */
  clientRoot: string
  /** The persisted ball position, when one was saved. */
  loadBallPosition(): SurfacePosition | undefined
  /** Persist the ball position. */
  saveBallPosition(position: SurfacePosition): void
  /**
   * A window's visibility changed outside the Shell's own calls (the panel hid
   * on blur, the OS hid it) — the adapter republishes the state so no surface
   * keeps a stale "visible" belief.
   */
  onVisibilityChanged?: ((surface: AuxSurfaceId) => void) | undefined
}

/** The window side of the Shell seam. */
export interface SurfaceHost {
  /** The window of one surface, when it exists. */
  windowOf(surface: SurfaceId): BrowserWindow | undefined
  /** Show and focus a surface (`main` included); false when it cannot. */
  present(surface: SurfaceId): boolean
  /** Hide an auxiliary surface; false when no window exists. */
  hide(surface: AuxSurfaceId): boolean
  /** One surface's live state. */
  stateOf(surface: SurfaceId): SurfaceState
  /** Every surface's state, `main` first. */
  states(): readonly SurfaceState[]
  /** Tear every auxiliary window down (app shutdown). */
  dispose(): void
}

/** Whether a window currently shows on screen. */
function isVisible(win: BrowserWindow | undefined): boolean {
  return win !== undefined && !win.isDestroyed() && win.isVisible()
}

/** Clamp a remembered ball position into a display's work area. */
function clampToDisplay(position: SurfacePosition, size: { width: number, height: number }): SurfacePosition | undefined {
  const display = screen.getDisplayNearestPoint(position)
  const area = display.workArea
  const maxX = area.x + area.width - size.width
  const maxY = area.y + area.height - size.height
  if (position.x < area.x - size.width || position.x > maxX + size.width) return undefined
  if (position.y < area.y - size.height || position.y > maxY + size.height) return undefined
  return {
    x: Math.min(Math.max(position.x, area.x), Math.max(area.x, maxX)),
    y: Math.min(Math.max(position.y, area.y), Math.max(area.y, maxY)),
  }
}

/**
 * Create the auxiliary-surface host.
 *
 * @param mainWindow - the operator window, once it exists (the shell may ask
 *   for it before the app has opened it).
 * @param options - see {@link SurfaceHostOptions}.
 * @returns the surface host the Shell service drives.
 */
export function createSurfaceHost(
  mainWindow: () => BrowserWindow | undefined,
  options: SurfaceHostOptions,
): SurfaceHost {
  const windows = new Map<AuxSurfaceId, BrowserWindow>()
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  /** Persist the ball position shortly after the drag settles. */
  function scheduleBallSave(win: BrowserWindow): void {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      if (win.isDestroyed()) return
      const [x, y] = win.getPosition()
      options.saveBallPosition({ x: x ?? 0, y: y ?? 0 })
    }, 400)
  }

  function create(surface: AuxSurfaceId): BrowserWindow {
    const size = SURFACE_BOUNDS[surface]
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
      // to another app without the panel's focus rules.
      focusable: true,
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    win.setMenuBarVisibility(false)

    if (surface === 'ball') {
      const remembered = options.loadBallPosition()
      const placed = remembered === undefined ? undefined : clampToDisplay(remembered, size)
      if (placed !== undefined) win.setPosition(placed.x, placed.y)
      else {
        const area = screen.getPrimaryDisplay().workArea
        win.setPosition(area.x + area.width - size.width - 24, area.y + area.height - size.height - 24)
      }
      win.on('moved', () => scheduleBallSave(win))
    } else {
      // Panel: hide on blur, and on Escape from any renderer (the fallback
      // page has no key handling of its own).
      win.on('blur', () => {
        if (!win.isDestroyed()) win.hide()
      })
      win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || input.key !== 'Escape') return
        event.preventDefault()
        if (!win.isDestroyed()) win.hide()
      })
    }

    win.on('closed', () => {
      windows.delete(surface)
    })
    // Visibility can change without the Shell asking (the panel's blur rule,
    // a hide from the OS): republish so every surface sees the truth.
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

  function auxWindow(surface: AuxSurfaceId): BrowserWindow {
    const existing = windows.get(surface)
    if (existing !== undefined && !existing.isDestroyed()) return existing
    return create(surface)
  }

  const host: SurfaceHost = {
    windowOf(surface) {
      if (surface === 'main') return mainWindow()
      const win = windows.get(surface)
      return win === undefined || win.isDestroyed() ? undefined : win
    },

    present(surface) {
      if (surface === 'main') {
        const win = mainWindow()
        if (win === undefined || win.isDestroyed()) return false
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        return true
      }
      try {
        const win = auxWindow(surface)
        win.showInactive()
        if (surface === 'panel') win.focus()
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
      return true
    },

    stateOf(surface) {
      const win = surface === 'main' ? mainWindow() : windows.get(surface)
      const alive = win !== undefined && !win.isDestroyed()
      return {
        surface,
        available: surface === 'main' ? alive : windows.has(surface),
        visible: alive && isVisible(win),
      }
    },

    states: () => SURFACE_IDS.map(surface => host.stateOf(surface)),

    dispose() {
      if (saveTimer !== undefined) clearTimeout(saveTimer)
      saveTimer = undefined
      for (const win of windows.values()) {
        if (!win.isDestroyed()) win.destroy()
      }
      windows.clear()
    },
  }
  return host
}