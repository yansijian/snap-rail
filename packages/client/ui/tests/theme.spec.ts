// @vitest-environment happy-dom
/**
 * Theme application: schema, mode resolution, and the data-mode contract
 * the token blocks in theme.css key off.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { applyTheme, DEFAULT_THEME, resolveThemeMode, THEME_SETTINGS_KEY, themeSettingsSchema } from '../src/theme.ts'

afterEach(() => { delete document.documentElement.dataset.mode })

describe('theme settings', () => {
  it('defaults to dark before any settings arrive', () => {
    expect(DEFAULT_THEME).toEqual({ mode: 'dark' })
  })

  it('accepts the three modes and rejects anything else', () => {
    expect(themeSettingsSchema.safeParse({ mode: 'system' }).success).toBe(true)
    expect(themeSettingsSchema.safeParse({ mode: 'light' }).success).toBe(true)
    expect(themeSettingsSchema.safeParse({ mode: 'dark' }).success).toBe(true)
    expect(themeSettingsSchema.safeParse({ mode: 'amber' }).success).toBe(false)
    expect(themeSettingsSchema.safeParse({}).success).toBe(false)
  })

  it('resolves system through the OS preference', () => {
    expect(resolveThemeMode('system', true)).toBe('light')
    expect(resolveThemeMode('system', false)).toBe('dark')
    expect(resolveThemeMode('light', false)).toBe('light')
    expect(resolveThemeMode('dark', true)).toBe('dark')
  })

  it('applies the resolved mode to the document element', () => {
    applyTheme(document, { mode: 'light' })
    expect(document.documentElement.dataset.mode).toBe('light')
    applyTheme(document, { mode: 'dark' })
    expect(document.documentElement.dataset.mode).toBe('dark')
    // system consults matchMedia; an environment without a preference stays dark
    applyTheme(document, { mode: 'system' })
    expect(['light', 'dark']).toContain(document.documentElement.dataset.mode)
  })

  it('carries the documented settings key', () => {
    expect(THEME_SETTINGS_KEY).toBe('ui.theme')
  })
})
