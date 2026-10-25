/**
 * The skin registry and token bridge. A skin is a declared visual
 * implementation of the semantic component contract: token values plus part
 * CSS. Exactly one skin is active; the built-in default is always available
 * as the fallback.
 *
 * @module @snap-rail/ui/skins
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import {
  PRESENTATION_TARGETS,
  type PresentationTarget,
  type PresentationVariant,
} from './contract.ts'

/** The colour/typography/spacing vocabulary a skin must populate. */
export interface SkinTokens {
  colorBg: string
  colorSurface: string
  colorSurfaceRaised: string
  colorText: string
  colorMuted: string
  colorPrimary: string
  colorOnPrimary: string
  colorDanger: string
  colorSuccess: string
  colorWarning: string
  colorBorder: string
  colorFocus: string
  chart1: string
  chart2: string
  chart3: string
  chart4: string
  chart5: string
  chart6: string
  fontSans: string
  fontMono: string
  textXs: string
  textSm: string
  textMd: string
  textLg: string
  textXl: string
  weightNormal: string
  weightMedium: string
  weightStrong: string
  leadingTight: string
  leadingNormal: string
  spaceXs: string
  spaceSm: string
  spaceMd: string
  spaceLg: string
  spaceXl: string
  radiusSm: string
  radiusMd: string
  radiusLg: string
  radiusFull: string
  borderWidth: string
  shadowSm: string
  shadowMd: string
  shadowLg: string
  durationFast: string
  durationNormal: string
  durationSlow: string
  easeStandard: string
  zOverlay: string
  zModal: string
  zToast: string
  controlHeightSm: string
  controlHeightMd: string
  controlHeightLg: string
  density: string
}

/** One skin's full definition. */
export interface SkinDefinition {
  id: string
  title: string
  /** Token values for both modes; the active mode picks one set. */
  tokens: { light: SkinTokens; dark: SkinTokens }
  /** Presentation defaults the skin chooses for core variants. */
  presentations?: Partial<Record<PresentationTarget, PresentationVariant>>
  /** Parts the skin claims to style (coverage diagnostics, optional). */
  parts?: readonly string[]
  /** Optional CSS text; the registry injects it scoped by `data-snap-skin`. */
  css?: string
}

/** The two colour modes. */
export const SKIN_MODES = ['light', 'dark'] as const

/** One skin mode. */
export type SkinMode = (typeof SKIN_MODES)[number]

/** The built-in default skin id. */
export const DEFAULT_SKIN_ID = 'default'

/** The factory cobalt/steel skin. Extra skins override it through the registry. */
export const DEFAULT_SKIN: SkinDefinition = {
  id: DEFAULT_SKIN_ID,
  title: '工业钴蓝',
  presentations: {
    dialog: 'modal',
    select: 'popover',
    tabs: 'inline',
    toast: 'inline',
  },
  tokens: {
    dark: {
      colorBg: '#0b0f14',
      colorSurface: '#11161d',
      colorSurfaceRaised: '#161b22',
      colorText: '#ced8e3',
      colorMuted: '#8b949e',
      colorPrimary: '#4a6cff',
      colorOnPrimary: '#ffffff',
      colorDanger: '#f85149',
      colorSuccess: '#3fb950',
      colorWarning: '#d29922',
      colorBorder: '#1f2933',
      colorFocus: '#4a6cff',
      chart1: '#4a6cff',
      chart2: '#3147a1',
      chart3: '#667fcd',
      chart4: '#7d8fa5',
      chart5: '#55677c',
      chart6: '#33414f',
      fontSans: 'system-ui, "Segoe UI", "Microsoft YaHei", sans-serif',
      fontMono: '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace',
      textXs: '13px',
      textSm: '15px',
      textMd: '17px',
      textLg: '20px',
      textXl: '24px',
      weightNormal: '400',
      weightMedium: '500',
      weightStrong: '600',
      leadingTight: '1.2',
      leadingNormal: '1.55',
      spaceXs: '4px',
      spaceSm: '8px',
      spaceMd: '12px',
      spaceLg: '20px',
      spaceXl: '32px',
      radiusSm: '6px',
      radiusMd: '8px',
      radiusLg: '12px',
      radiusFull: '999px',
      borderWidth: '1px',
      shadowSm: '0 1px 2px rgb(0 0 0 / 0.25)',
      shadowMd: '0 8px 24px rgb(0 0 0 / 0.28)',
      shadowLg: '0 24px 64px rgb(0 0 0 / 0.36)',
      durationFast: '120ms',
      durationNormal: '180ms',
      durationSlow: '280ms',
      easeStandard: 'cubic-bezier(0.2, 0, 0, 1)',
      zOverlay: '50',
      zModal: '60',
      zToast: '70',
      controlHeightSm: '40px',
      controlHeightMd: '48px',
      controlHeightLg: '56px',
      density: 'comfortable',
    },
    light: {
      colorBg: '#e4e9ef',
      colorSurface: '#f3f6f9',
      colorSurfaceRaised: '#ffffff',
      colorText: '#26323e',
      colorMuted: '#5d6d7e',
      colorPrimary: '#3857e8',
      colorOnPrimary: '#ffffff',
      colorDanger: '#dc2626',
      colorSuccess: '#15803d',
      colorWarning: '#b45309',
      colorBorder: '#c7d0da',
      colorFocus: '#3857e8',
      chart1: '#3857e8',
      chart2: '#7088ee',
      chart3: '#667dd0',
      chart4: '#94a3b8',
      chart5: '#b3c0cd',
      chart6: '#ccd6e0',
      fontSans: 'system-ui, "Segoe UI", "Microsoft YaHei", sans-serif',
      fontMono: '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace',
      textXs: '13px',
      textSm: '15px',
      textMd: '17px',
      textLg: '20px',
      textXl: '24px',
      weightNormal: '400',
      weightMedium: '500',
      weightStrong: '600',
      leadingTight: '1.2',
      leadingNormal: '1.55',
      spaceXs: '4px',
      spaceSm: '8px',
      spaceMd: '12px',
      spaceLg: '20px',
      spaceXl: '32px',
      radiusSm: '6px',
      radiusMd: '8px',
      radiusLg: '12px',
      radiusFull: '999px',
      borderWidth: '1px',
      shadowSm: '0 1px 2px rgb(0 0 0 / 0.08)',
      shadowMd: '0 8px 24px rgb(0 0 0 / 0.12)',
      shadowLg: '0 24px 64px rgb(0 0 0 / 0.18)',
      durationFast: '120ms',
      durationNormal: '180ms',
      durationSlow: '280ms',
      easeStandard: 'cubic-bezier(0.2, 0, 0, 1)',
      zOverlay: '50',
      zModal: '60',
      zToast: '70',
      controlHeightSm: '40px',
      controlHeightMd: '48px',
      controlHeightLg: '56px',
      density: 'comfortable',
    },
  },
}

/** Turn a token key into its CSS custom property (`chart1` → `--snap-chart-1`). */
export function skinTokenVar(key: keyof SkinTokens): string {
  const kebab = key.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`).replace(/(\d+)$/, '-$1')
  return `--snap-${kebab}`
}

/** The service exposed as `ctx.skins`. */
export interface SkinsService {
  /** Register a skin; disposal removes it and falls back to the default. */
  register(caller: Context, skin: SkinDefinition): () => void
  /** Activate a registered skin by id. */
  activate(skinId: string): boolean
  /** Every registered skin, default first. */
  list(): readonly SkinDefinition[]
  /** The active skin. */
  active(): SkinDefinition
  /** Set the colour mode and re-apply the active tokens. */
  setMode(mode: SkinMode): void
  /** The current colour mode. */
  mode(): SkinMode
  /** The active skin's presentation default for a target, when one is set. */
  presentation(target: PresentationTarget): PresentationVariant | undefined
  /** The active skin's token object for the current mode. */
  tokens(): SkinTokens
  /** Subscribe to skin/mode changes. */
  subscribe(listener: () => void): () => void
  /** Monotonic change version. */
  version(): number
}

declare module '@snap-rail/cordis' {
  interface Context {
    skins: SkinsService
  }

  interface Events {
    /** The active skin or colour mode changed. */
    'skins/changed'(): void
  }
}

/** Apply the active skin to the document root. */
function applySkin(skin: SkinDefinition, mode: SkinMode): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset['snapSkin'] = skin.id
  root.dataset['snapMode'] = mode
  const tokens = skin.tokens[mode]
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(skinTokenVar(key as keyof SkinTokens), value)
  }
}

/** Mount the `ctx.skins` registry. */
const skinsPlugin: Plugin.Object<void> = {
  name: 'snap-rail ui skins',
  apply(ctx: Context): void {
    const skins = new Map<string, SkinDefinition>()
    const listeners = new Set<() => void>()
    const styleTags = new Map<string, HTMLStyleElement>()
    let activeId = DEFAULT_SKIN_ID
    let mode: SkinMode = 'dark'
    let revision = 0

    skins.set(DEFAULT_SKIN_ID, DEFAULT_SKIN)

    const notify = (): void => {
      revision += 1
      for (const listener of listeners) listener()
      ctx.emit('skins/changed')
    }

    const ensureStyleTag = (skin: SkinDefinition): void => {
      if (typeof document === 'undefined' || skin.css === undefined) return
      if (styleTags.has(skin.id)) return
      const tag = document.createElement('style')
      tag.dataset['snapSkinStyle'] = skin.id
      tag.textContent = skin.css
      document.head.append(tag)
      styleTags.set(skin.id, tag)
    }

    const refresh = (): void => {
      const skin = skins.get(activeId) ?? DEFAULT_SKIN
      activeId = skin.id
      ensureStyleTag(skin)
      applySkin(skin, mode)
      notify()
    }

    ctx.provide('skins', {
      register(caller: Context, skin: SkinDefinition): () => void {
        skins.set(skin.id, skin)
        // A pool skin (non-default) becomes active immediately; the default
        // stays underneath as the fallback when the pool skin is removed.
        if (skin.id !== DEFAULT_SKIN_ID) activeId = skin.id
        refresh()
        const remove = (): void => {
          if (!skins.delete(skin.id)) return
          const tag = styleTags.get(skin.id)
          if (tag !== undefined) {
            tag.remove()
            styleTags.delete(skin.id)
          }
          if (activeId === skin.id) activeId = DEFAULT_SKIN_ID
          refresh()
        }
        caller.effect(() => remove)
        return remove
      },
      activate(skinId: string): boolean {
        if (!skins.has(skinId)) return false
        activeId = skinId
        refresh()
        return true
      },
      list: () => [skins.get(DEFAULT_SKIN_ID) ?? DEFAULT_SKIN, ...[...skins.values()].filter(skin => skin.id !== DEFAULT_SKIN_ID)],
      active: () => skins.get(activeId) ?? DEFAULT_SKIN,
      setMode(next: SkinMode): void {
        if (mode === next) return
        mode = next
        refresh()
      },
      mode: () => mode,
      presentation(target: PresentationTarget): PresentationVariant | undefined {
        const skin = skins.get(activeId) ?? DEFAULT_SKIN
        return skin.presentations?.[target]
      },
      tokens: () => (skins.get(activeId) ?? DEFAULT_SKIN).tokens[mode],
      subscribe(listener: () => void): () => void {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      version: () => revision,
    } satisfies SkinsService)

    // Apply the factory skin immediately so the first paint already carries
    // the token vocabulary, even before any plugin registers.
    refresh()
  },
}

/** The React context carrying the skin service. */
const SkinsContext = createContext<SkinsService | null>(null)

/** Provide the skin service to a renderer tree. */
export function SkinsProvider(props: { service: SkinsService; children: ReactNode }): ReactNode {
  return <SkinsContext.Provider value={props.service}>{props.children}</SkinsContext.Provider>
}

/** Read the skin service. */
export function useSkins(): SkinsService {
  const service = useContext(SkinsContext)
  if (service === null) throw new Error('useSkins: no SkinsProvider in the tree')
  return service
}

/** Re-render on skin/mode changes and return the active token set. */
export function useSkinTokens(): SkinTokens {
  const service = useSkins()
  useSyncExternalStore(service.subscribe, service.version, service.version)
  return service.tokens()
}

/** Re-render on skin/mode changes and return the active presentation default. */
export function usePresentation(target: PresentationTarget): PresentationVariant | undefined {
  const service = useSkins()
  useSyncExternalStore(service.subscribe, service.version, service.version)
  return service.presentation(target)
}

/** Re-export the presentation vocabulary for skin authors. */
export { PRESENTATION_TARGETS }

export default skinsPlugin