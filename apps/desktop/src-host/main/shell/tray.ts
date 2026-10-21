/**
 * The tray icon: one singleton for the whole app, created on demand. The app
 * never starts with a tray icon — a terminal that always parks a glyph in the
 * notification area would be presumptuous — but the moment a plugin
 * contributes a menu item or an auxiliary surface appears, the icon arrives
 * and stays for the session.
 *
 * The menu is rebuilt from the machine's entry list on every change, so the
 * rendering here stays a pure projection: fixed operator rows (show / hide /
 * quit) around the contributed rows. Contributed rows never get a stored
 * closure — the click only reports the entry's namespaced key, and the owning
 * plugin decides what it means.
 *
 * @module @snap-rail/desktop/main/shell/tray
 */

import { existsSync } from 'node:fs'
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import type { ShellTrayEntry } from '@snap-rail/shell'

/** What the fixed operator rows and contributed rows do. */
export interface TrayActions {
  /** Show and focus the operator window. */
  showMain(): void
  /** Hide the operator window into the tray. */
  hideMain(): void
  /** Quit the whole app. */
  quit(): void
  /** A contributed row was picked (`key` is `<plugin>:<id>`). */
  pick(key: string): void
  /** The icon itself was clicked (toggles the operator window). */
  toggleMain(): void
}

/** The tray icon's lifecycle, as the Shell service drives it. */
export interface TrayHost {
  /** Create the icon if it does not exist yet; false when the tray is unusable. */
  ensure(): boolean
  /** Whether an icon currently exists. */
  readonly available: boolean
  /** Rebuild the menu from the contributed entries. */
  update(entries: readonly ShellTrayEntry[]): void
  /** Destroy the icon (app shutdown). */
  dispose(): void
}

/**
 * Create the tray host.
 *
 * @param iconPath - the tray glyph inside the app (`resources/tray.png`);
 *   a missing file disables the tray instead of throwing, because a failed
 *   tray must never take the app down with it.
 * @param actions - see {@link TrayActions}.
 */
export function createTrayHost(iconPath: string, actions: TrayActions): TrayHost {
  let tray: Tray | undefined
  let entries: readonly ShellTrayEntry[] = []
  let disposed = false

  function menu(): Menu {
    const items: MenuItemConstructorOptions[] = [
      { label: '显示主窗口', click: () => actions.showMain() },
      { label: '隐藏到托盘', click: () => actions.hideMain() },
    ]
    if (entries.length > 0) {
      items.push({ type: 'separator' })
      for (const entry of entries) {
        items.push({
          label: entry.label,
          enabled: entry.enabled !== false,
          // A `checked` entry is a toggle: the owning plugin flips it through
          // `updateItem`, so the menu never holds its own copy of the state.
          ...entry.checked !== undefined ? { type: 'checkbox' as const, checked: entry.checked } : {},
          click: () => actions.pick(entry.key),
        })
      }
    }
    items.push({ type: 'separator' }, { label: '退出', click: () => actions.quit() })
    return Menu.buildFromTemplate(items)
  }

  function rebuild(): void {
    if (tray === undefined || tray.isDestroyed()) return
    tray.setContextMenu(menu())
  }

  return {
    get available() {
      return tray !== undefined && !tray.isDestroyed()
    },

    ensure() {
      if (disposed) return false
      if (tray !== undefined && !tray.isDestroyed()) return true
      if (!existsSync(iconPath)) return false
      const image = nativeImage.createFromPath(iconPath)
      if (image.isEmpty()) return false
      try {
        tray = new Tray(image)
      } catch {
        // No notification area (some kiosk shells, a locked-down session) —
        // the app keeps running without a tray.
        return false
      }
      tray.setToolTip('SnapRail')
      tray.on('click', () => actions.toggleMain())
      rebuild()
      return true
    },

    update(next) {
      entries = next
      rebuild()
    },

    dispose() {
      disposed = true
      entries = []
      if (tray !== undefined && !tray.isDestroyed()) tray.destroy()
      tray = undefined
    },
  }
}