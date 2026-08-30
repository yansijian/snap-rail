/**
 * Theme settings: the `ui.theme` settings.json row (a mode choice — the
 * cobalt accent is fixed per mode) and its DOM application. The renderer
 * resident that owns the 主题 settings page reads and writes the row; the
 * `settings/changed` frame hot-applies it on every surface without a
 * restart.
 *
 * @module @snap-rail/client-ui/theme
 */

import { z } from 'zod'

/** settings.json key carrying the theme row. */
export const THEME_SETTINGS_KEY = 'ui.theme'

/** The theme row; invalid stored rows fall back to {@link DEFAULT_THEME}. */
export const themeSettingsSchema = z.object({
  mode: z.enum(['system', 'light', 'dark']),
})

/** Parsed theme row. */
export type ThemeSettings = z.infer<typeof themeSettingsSchema>

/** Applied before any settings arrive; keeps the terminal dark as before. */
export const DEFAULT_THEME: ThemeSettings = { mode: 'dark' }

/** The mode a setting resolves to (`system` consults the OS preference). */
export function resolveThemeMode(mode: ThemeSettings['mode'], prefersLight: boolean): 'light' | 'dark' {
  if (mode === 'system') return prefersLight ? 'light' : 'dark'
  return mode
}

/** Apply a theme row: sets `data-mode` on the document element (the token
 * blocks in theme.css key off it). A missing matchMedia — as in tests —
 * resolves `system` to dark. */
export function applyTheme(document: Document, theme: ThemeSettings): void {
  const view = document.defaultView
  const prefersLight = view !== null && typeof view.matchMedia === 'function'
    && view.matchMedia('(prefers-color-scheme: light)').matches
  document.documentElement.dataset.mode = resolveThemeMode(theme.mode, prefersLight)
}
