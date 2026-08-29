/**
 * The settings seam: `ctx.settingsPages` is a registry of settings-dialog
 * pages plus the dialog's open state. It knows the mechanism — registration,
 * ordering, which page is shown, whether the dialog is open — and nothing
 * about any concrete page. The dialog shell (settings-station) renders the
 * registry; the chrome's gear button only calls `open()`.
 *
 * The service mirrors `ctx.workflows` structurally: register + list plus
 * change events, with state in construction-time closures.
 *
 * @module @snap-rail/client-settings
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import type { ReactNode } from 'react'

/** What one plugin contributes to the settings dialog. */
export interface SettingsPageDef {
  /** Stable page id (the menu and content key). */
  id: string
  /** Menu label. */
  title: string
  /** Menu ordering; ties break by registration time. */
  order: number
  render(): ReactNode
}

/** A settings page as the dialog sees it, with derived state. */
export interface SettingsPage extends SettingsPageDef {
  /** Whether this page is the one currently shown. */
  active: boolean
}

/** Settings registry and dialog state exposed as `ctx.settingsPages`. */
export interface SettingsPagesService {
  /** Registered pages in menu order with the active flag. */
  list(): readonly SettingsPage[]
  /** Register one page; disposal (caller unload) removes it.
   * @param caller - owning context; unload drops the page.
   * @param def - the contribution; same-id re-registration replaces.
   */
  register(caller: Context, def: SettingsPageDef): () => void
  /** Open the dialog; `id` additionally makes that page active. */
  open(id?: string): void
  /** Close the dialog (the active-page choice is kept). */
  close(): void
  /** Open when closed, close when open. */
  toggle(): void
  /** Whether the dialog is currently open. */
  isOpen(): boolean
  /** The active page id while open — the requested one when registered, else the first menu page; `undefined` while closed. */
  active(): string | undefined
}

declare module '@snap-rail/cordis' {
  interface Context {
    settingsPages: SettingsPagesService
  }

  interface Events {
    /** The page registry changed (any add, replace, or removal). */
    'settings/pages-changed'(): void
    /** The dialog opened, closed, or switched pages. */
    'settings/open-changed'(): void
  }
}

interface RegistryEntry {
  def: SettingsPageDef
  seq: number
}

/**
 * Mounts the `ctx.settingsPages` registry. All state lives in
 * construction-time closures: traceable context proxies rebind `this` on
 * every method access, so `this`-reached state cannot back a service here
 * (the uiSlots lesson).
 */
const settingsPlugin: Plugin.Object<void> = {
  name: 'client-settings',
  apply(ctx: Context): void {
    const pages = new Map<string, RegistryEntry>()
    let nextSeq = 0
    let open = false
    let requestedId: string | undefined

    const firstId = (): string | undefined =>
      [...pages.values()]
        .sort((a, b) => a.def.order - b.def.order || a.seq - b.seq)[0]?.def.id

    const activeId = (): string | undefined => {
      if (!open) return undefined
      if (requestedId !== undefined && pages.has(requestedId)) return requestedId
      return firstId()
    }

    const openDialog = (id?: string): void => {
      if (id !== undefined) requestedId = id
      if (open && id === undefined) return
      open = true
      ctx.emit('settings/open-changed')
    }

    const closeDialog = (): void => {
      if (!open) return
      open = false
      ctx.emit('settings/open-changed')
    }

    ctx.provide('settingsPages', {
      list(): readonly SettingsPage[] {
        const current = activeId()
        return [...pages.values()]
          .sort((a, b) => a.def.order - b.def.order || a.seq - b.seq)
          .map(({ def }) => ({ ...def, active: def.id === current }))
      },
      register(caller: Context, def: SettingsPageDef): () => void {
        const replaced = pages.has(def.id)
        pages.set(def.id, { def, seq: nextSeq++ })
        ctx.emit(replaced ? 'settings/open-changed' : 'settings/pages-changed')
        const remove = (): void => {
          if (pages.delete(def.id)) ctx.emit('settings/pages-changed')
        }
        // Effects take a body producing the disposer; passing `remove`
        // itself would run it as setup.
        caller.effect(() => remove)
        return remove
      },
      open: openDialog,
      close: closeDialog,
      toggle(): void {
        if (open) closeDialog()
        else openDialog()
      },
      isOpen(): boolean {
        return open
      },
      active: activeId,
    })
  },
}

export default settingsPlugin
