/**
 * The forge renderer face, window-mode branched: the main terminal window
 * mounts only the generated-plugin runner (generated pages live in the main
 * chrome) plus the titlebar studio button; the studio window
 * (`?window=forge`, opened via `window.open-forge`) mounts the full chat
 * workbench as its layout occupant — titlebar included — and adopts the
 * shared theme (that window ships no settings-station). One plugin, two
 * projections; both consume the same forge RPC domain and frames.
 *
 * @module @snap-rail/forge/client
 */

// Wire rows for the forge-domain methods this face calls.
import '../contract.ts'
import { Context, type Plugin } from '@snap-rail/cordis'
import { Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import '@snap-rail/station-rpc/contract'
import '@snap-rail/client-slots'
import {
  applyTheme,
  Button,
  DEFAULT_THEME,
  THEME_SETTINGS_KEY,
  themeSettingsSchema,
} from '@snap-rail/client-ui'
import { subscribeFrame } from '@snap-rail/connection'
import { settingsChangedSchema } from '@snap-rail/station-rpc/contract'
import { ForgeStudio } from './studio.tsx'
import { startGenRunner } from './runner.ts'

/** Whether this page is the singleton studio window. */
function isStudioWindow(): boolean {
  return new URLSearchParams(window.location.search).get('window') === 'forge'
}

/**
 * Adopt the shared `ui.theme` settings row in this window's document: apply
 * the stored value now, hot-sync through the settings/changed frame, and
 * follow the OS preference while in system mode (the main window's
 * settings-station owns the writing side).
 */
function adoptStudioTheme(ctx: Context): void {
  let theme = DEFAULT_THEME
  const adopt = (value: unknown): void => {
    const parsed = themeSettingsSchema.safeParse(value)
    if (!parsed.success) return
    theme = parsed.data
    applyTheme(document, theme)
  }
  applyTheme(document, theme)
  void ctx.client.link.call('settings.get', { key: THEME_SETTINGS_KEY })
    .then(result => { if (result.ok) adopt(result.value.value) })
    .catch(() => {})
  ctx.effect(() => subscribeFrame(ctx.client.link, 'settings/changed', settingsChangedSchema, change => {
    if (change.key === THEME_SETTINGS_KEY) adopt(change.value)
  }))
  const osPreference = window.matchMedia('(prefers-color-scheme: light)')
  ctx.effect(() => {
    const sync = (): void => { if (theme.mode === 'system') applyTheme(document, theme) }
    osPreference.addEventListener('change', sync)
    return () => { osPreference.removeEventListener('change', sync) }
  })
}

/** The forge client plugin; mount in the client runtime tree. */
const forgeClientPlugin: Plugin.Object<void> = {
  name: 'forge-client',
  inject: ['client', 'uiSlots'],
  apply(ctx: Context): void {
    if (!isStudioWindow()) {
      // Main window: run the generated halves here (their pages target this
      // chrome) and contribute the studio's titlebar entry.
      startGenRunner(ctx)
      ctx.uiSlots.register(ctx, 'titlebar-actions', {
        id: 'forge-open',
        order: 10,
        render(): ReactNode {
          return (
            <Button
              variant="ghost"
              aria-label="AI 创造"
              className="h-full w-14 rounded-none px-0"
              onClick={() => { void ctx.client.link.call('window.open-forge', {}).catch(() => {}) }}
            >
              <Sparkles className="h-5 w-5" />
            </Button>
          )
        },
      })
      return
    }
    // Studio window: the workbench is the whole layout.
    adoptStudioTheme(ctx)
    ctx.uiSlots.register(ctx, 'layout', {
      id: 'forge-studio',
      order: 10,
      render(): ReactNode {
        return <ForgeStudio ctx={ctx} />
      },
    })
  },
}

export default forgeClientPlugin
