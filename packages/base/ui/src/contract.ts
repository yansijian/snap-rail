/**
 * The semantic UI contract: component names, region-slot ids, scoped slot
 * contexts, and the author-facing UI profile vocabulary. This module is pure
 * (types, constants, guards) so host and renderer faces can both import it
 * without dragging React or the renderer runtime into the host graph.
 *
 * @module @snap-rail/ui/contract
 */

import type { ReactNode } from 'react'
import type { SurfaceId } from '@snap-rail/protocol'
import type { BallProfile, WindowProfile } from '@snap-rail/shell/contract'

/** The author-declared relationship between a plugin and the skin contract. */
export const UI_PROFILES = ['native', 'integrated', 'custom'] as const

/** One UI profile. */
export type UiProfile = (typeof UI_PROFILES)[number]

/** The stable region slots every layout may provide. */
export const UI_SLOT_IDS = {
  /** The one active layout of the operator window. */
  layout: 'shell.layout',
  /** The operator titlebar. */
  titlebar: 'shell.titlebar',
  /** Contributed titlebar actions. */
  titlebarActions: 'shell.titlebar.actions',
  /** Sidebar extension area. */
  sidebar: 'shell.sidebar',
  /** Statusbar extension area. */
  statusbar: 'shell.statusbar',
  /** The global overlay stack (dialogs, confirms). */
  overlay: 'shell.overlay',
  /** The floating ball surface face. */
  ball: 'shell.ball',
  /** The settings trigger. */
  settingsEntry: 'settings.entry',
  /** The settings surface itself. */
  settingsSurface: 'settings.surface',
} as const

/** A named custom slot is owned by a publisher package. */
export const CUSTOM_SLOT_PATTERN = /^custom:[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/

/** Any region-slot id: a built-in id or a publisher-owned custom seat. */
export type SlotId = (typeof UI_SLOT_IDS)[keyof typeof UI_SLOT_IDS] | `custom:${string}`

/** Check a region-slot id at runtime. */
export function isValidSlotId(value: string): value is SlotId {
  return (Object.values(UI_SLOT_IDS) as readonly string[]).includes(value)
    || CUSTOM_SLOT_PATTERN.test(value)
}

/** How a slot renders its occupants. */
export type SlotMode = 'one' | 'many'

/** The occupancy mode of every built-in slot. */
export const UI_SLOT_MODES = {
  [UI_SLOT_IDS.layout]: 'one',
  [UI_SLOT_IDS.titlebar]: 'one',
  [UI_SLOT_IDS.titlebarActions]: 'many',
  [UI_SLOT_IDS.sidebar]: 'many',
  [UI_SLOT_IDS.statusbar]: 'many',
  [UI_SLOT_IDS.overlay]: 'many',
  [UI_SLOT_IDS.ball]: 'one',
  [UI_SLOT_IDS.settingsEntry]: 'one',
  [UI_SLOT_IDS.settingsSurface]: 'one',
} as const satisfies Record<string, SlotMode>

/** The operator-window controls a layout exposes to chrome contributions. */
export type WindowControl = 'minimize' | 'toggle-maximize' | 'close'

/** The context a settings trigger receives from the layout that hosts it. */
export interface SettingsEntryContext {
  /** `icon` for a glyph-only chrome button, `label` for a labelled action. */
  presentation: 'icon' | 'label'
  /** Open the settings surface (the last page stays active). */
  open(): void
  /** Whether the settings surface is currently open. */
  isOpen: boolean
}

/** A settings page as the settings surface sees it. */
export interface SettingsPageInfo {
  id: string
  title: string
  group?: string | undefined
  order: number
}

/** The context a settings surface receives. */
export interface SettingsSurfaceContext {
  pages: readonly SettingsPageInfo[]
  activeId?: string | undefined
  close(): void
}

/**
 * Scoped context carried by each built-in region slot. The `Slot` component
 * infers its context type from this map; custom slots declare their own
 * generic context through `ctx.ui.defineSlot`.
 */
export interface SlotContextMap {
  'shell.layout': { surface: SurfaceId }
  'shell.titlebar': { surface: SurfaceId; controls: WindowControl }
  'shell.titlebar.actions': { surface: SurfaceId; controls: WindowControl }
  'shell.sidebar': { surface: SurfaceId }
  'shell.statusbar': { surface: SurfaceId }
  'shell.overlay': { surface: SurfaceId }
  'shell.ball': { surface: 'ball' }
  'settings.entry': SettingsEntryContext
  'settings.surface': SettingsSurfaceContext
}

/** The scoped context type of one built-in slot. */
export type SlotContextOf<S extends keyof SlotContextMap> = SlotContextMap[S]

/** A region-slot declaration. */
export interface SlotDefinition<C = unknown> {
  /** The stable slot id (built-in or `custom:<publisher>.<name>`). */
  id: string
  /** Occupancy mode; defaults to `many`. */
  mode?: SlotMode
  /** The surface this slot belongs to; defaults to `all`. */
  surface?: SurfaceId | 'all'
  /** The default content when no occupant is registered. */
  fallback?: (context: C) => ReactNode
}

/** A contribution to a region slot. */
export interface SlotContribution<C = unknown> {
  /** Stable contribution id; a later same-id registration replaces it. */
  id: string
  /** Render order within the slot; ties break by registration time. */
  order: number
  /** Winner election for `one` slots; ignored in `many` slots. */
  precedence?: number
  /** Render the contribution against the slot's scoped context. */
  render(context: C): ReactNode
}

/** A layout contribution: provides region slots and owns the stage profiles. */
export interface LayoutContribution {
  id: string
  order: number
  /** Winner election among layout occupants; the highest wins. */
  precedence?: number
  /** Region-slot ids this layout renders. */
  provides: readonly SlotId[]
  /** The operator-window stage preferred by this layout/suite. */
  window?: WindowProfile
  /** The floating-ball stage preferred by this layout/suite. */
  ball?: BallProfile
  render(): ReactNode
}

/** Diagnostic kinds surfaced by the UI registry. */
export const UI_DIAGNOSTIC_KINDS = [
  'unknown-slot',
  'missing-provider',
  'invalid-context',
  'duplicate-id',
  'render-failed',
  'declared-not-rendered',
] as const

/** One diagnostic kind. */
export type UiDiagnosticKind = (typeof UI_DIAGNOSTIC_KINDS)[number]

/** A non-fatal UI contract violation. */
export interface UiDiagnostic {
  kind: UiDiagnosticKind
  message: string
  slot?: string | undefined
  id?: string | undefined
  time: number
}

/** One semantic component's public anatomy. */
export interface UiComponentSpec {
  /** Stable `data-snap-part` names the skin may target. */
  parts: readonly string[]
  /** Component slots (children/header/footer/actions/...). */
  slots?: readonly string[]
  /** Semantic prop names (intent/emphasis/size/...); documentation only. */
  props?: readonly string[]
}

/**
 * The component catalog. It is the shared vocabulary for the gallery, skin
 * coverage checks, and author documentation; adding a component here is a
 * contract change, not an implementation detail.
 */
export const UI_COMPONENTS = {
  button: {
    parts: ['button.root', 'button.label', 'button.icon', 'button.spinner'],
    slots: ['label', 'icon'],
    props: ['intent', 'emphasis', 'size', 'loading', 'disabled'],
  },
  'icon-button': {
    parts: ['icon-button.root', 'icon-button.icon'],
    slots: ['icon'],
    props: ['intent', 'emphasis', 'size', 'active', 'disabled'],
  },
  input: {
    parts: ['input.root', 'input.field', 'input.prefix', 'input.suffix', 'input.clear'],
    slots: ['prefix', 'suffix'],
    props: ['size', 'invalid', 'disabled'],
  },
  textarea: {
    parts: ['textarea.root', 'textarea.field'],
    props: ['size', 'invalid', 'disabled'],
  },
  'number-input': {
    parts: ['number-input.root', 'number-input.field', 'number-input.step-up', 'number-input.step-down'],
    props: ['size', 'invalid', 'disabled'],
  },
  select: {
    parts: ['select.root', 'select.trigger', 'select.value', 'select.chevron', 'select.content', 'select.item', 'select.item-indicator', 'select.empty'],
    slots: ['empty'],
    props: ['size', 'invalid', 'disabled', 'presentation'],
  },
  'touch-select': {
    parts: ['touch-select.root', 'touch-select.trigger', 'touch-select.sheet', 'touch-select.option'],
    props: ['invalid', 'disabled'],
  },
  checkbox: {
    parts: ['checkbox.root', 'checkbox.box', 'checkbox.indicator', 'checkbox.label'],
    slots: ['label'],
    props: ['checked', 'invalid', 'disabled'],
  },
  switch: {
    parts: ['switch.root', 'switch.thumb', 'switch.label'],
    slots: ['label'],
    props: ['checked', 'disabled'],
  },
  'radio-group': {
    parts: ['radio-group.root', 'radio-group.item', 'radio-group.indicator', 'radio-group.label'],
    props: ['value', 'disabled'],
  },
  tabs: {
    parts: ['tabs.root', 'tabs.list', 'tabs.trigger', 'tabs.content'],
    slots: ['list', 'content'],
    props: ['value', 'presentation'],
  },
  table: {
    parts: ['table.root', 'table.header', 'table.body', 'table.row', 'table.head', 'table.cell', 'table.empty'],
    slots: ['empty'],
  },
  card: {
    parts: ['card.root', 'card.header', 'card.title', 'card.description', 'card.body', 'card.footer'],
    slots: ['header', 'title', 'description', 'body', 'footer'],
  },
  panel: {
    parts: ['panel.root', 'panel.header', 'panel.title', 'panel.body', 'panel.footer'],
    slots: ['header', 'title', 'body', 'footer'],
  },
  dialog: {
    parts: ['dialog.root', 'dialog.overlay', 'dialog.panel', 'dialog.header', 'dialog.title', 'dialog.description', 'dialog.body', 'dialog.footer', 'dialog.close'],
    slots: ['header', 'title', 'description', 'body', 'footer'],
    props: ['open', 'presentation', 'size'],
  },
  sheet: {
    parts: ['sheet.root', 'sheet.overlay', 'sheet.panel', 'sheet.header', 'sheet.body', 'sheet.footer'],
    slots: ['header', 'body', 'footer'],
    props: ['open', 'presentation'],
  },
  popover: {
    parts: ['popover.root', 'popover.trigger', 'popover.content'],
    slots: ['trigger', 'content'],
  },
  tooltip: {
    parts: ['tooltip.root', 'tooltip.trigger', 'tooltip.content'],
    slots: ['trigger', 'content'],
  },
  menu: {
    parts: ['menu.root', 'menu.trigger', 'menu.content', 'menu.item', 'menu.separator'],
    slots: ['trigger', 'content'],
  },
  toast: {
    parts: ['toast.root', 'toast.title', 'toast.description', 'toast.action', 'toast.close'],
    slots: ['action'],
  },
  progress: {
    parts: ['progress.root', 'progress.track', 'progress.indicator'],
  },
  badge: {
    parts: ['badge.root'],
  },
  led: {
    parts: ['led.root', 'led.halo'],
    props: ['tone'],
  },
  spinner: {
    parts: ['spinner.root'],
  },
  'empty-state': {
    parts: ['empty-state.root', 'empty-state.icon', 'empty-state.title', 'empty-state.description', 'empty-state.action'],
    slots: ['icon', 'title', 'description', 'action'],
  },
  form: {
    parts: ['form.root', 'form.fields', 'form.actions'],
    slots: ['fields', 'actions'],
  },
  field: {
    parts: ['field.root', 'field.label', 'field.control', 'field.help', 'field.error'],
    slots: ['label', 'control', 'help', 'error'],
    props: ['invalid', 'required', 'disabled'],
  },
  'schema-form': {
    parts: ['schema-form.root', 'schema-form.field'],
    slots: ['fields'],
  },
  'app-shell': {
    parts: ['app-shell.root', 'app-shell.header', 'app-shell.sidebar', 'app-shell.main', 'app-shell.footer'],
    slots: ['header', 'sidebar', 'main', 'footer'],
  },
  page: {
    parts: ['page.root', 'page.header', 'page.title', 'page.description', 'page.actions', 'page.body'],
    slots: ['header', 'title', 'description', 'actions', 'body'],
  },
  section: {
    parts: ['section.root', 'section.header', 'section.title', 'section.actions', 'section.body'],
    slots: ['header', 'title', 'actions', 'body'],
  },
  toolbar: {
    parts: ['toolbar.root', 'toolbar.start', 'toolbar.end'],
    slots: ['start', 'end'],
  },
  stack: { parts: ['stack.root'], props: ['gap', 'padding', 'align'] },
  row: { parts: ['row.root'], props: ['gap', 'padding', 'align', 'justify'] },
  grid: { parts: ['grid.root'], props: ['gap', 'columns', 'padding'] },
  split: { parts: ['split.root', 'split.start', 'split.end'], slots: ['start', 'end'] },
  'scroll-area': { parts: ['scroll-area.root', 'scroll-area.viewport', 'scroll-area.scrollbar'] },
  'drag-scroll': { parts: ['drag-scroll.root', 'drag-scroll.viewport'] },
  visualization: {
    parts: ['visualization.root', 'visualization.header', 'visualization.title', 'visualization.actions', 'visualization.body', 'visualization.empty', 'visualization.error', 'visualization.loading'],
    slots: ['header', 'title', 'actions', 'body', 'empty', 'error', 'loading'],
    props: ['state'],
  },
  'chart-frame': {
    parts: ['chart-frame.root', 'chart-frame.header', 'chart-frame.title', 'chart-frame.actions', 'chart-frame.body'],
    slots: ['header', 'title', 'actions', 'body'],
  },
  settings: {
    parts: [
      'settings.root',
      'settings.header',
      'settings.title',
      'settings.body',
      'settings.nav',
      'settings.nav-item',
      'settings.nav-icon',
      'settings.group',
      'settings.group-title',
      'settings.content',
    ],
  },
} as const satisfies Record<string, UiComponentSpec>

/** One semantic component name. */
export type UiComponentName = keyof typeof UI_COMPONENTS

/** The presentation targets a skin may tune. */
export const PRESENTATION_TARGETS = ['dialog', 'select', 'tabs', 'toast'] as const

/** One presentation target. */
export type PresentationTarget = (typeof PRESENTATION_TARGETS)[number]

/** The presentation variants the core implements. */
export const PRESENTATION_VARIANTS = ['modal', 'sheet', 'fullscreen', 'popover', 'segmented', 'inline'] as const

/** One presentation variant. */
export type PresentationVariant = (typeof PRESENTATION_VARIANTS)[number]