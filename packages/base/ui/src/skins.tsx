/**
 * The theme registry and token bridge. A theme is a declared visual
 * implementation of the semantic component contract: one token set plus
 * optional part CSS — pure styling. Component definitions and slots live
 * outside the theme; a theme never shapes behaviour. Exactly one theme is
 * active; the two factory cobalt themes (day/night) are always registered
 * and the dark one is the fallback.
 *
 * @module @snap-rail/ui/skins
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'

/** The colour/typography/spacing vocabulary a theme must populate. */
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

/** One theme's full definition: a single complete look. */
export interface SkinDefinition {
  id: string
  title: string
  /** The theme's single token set; picking another theme switches the set. */
  tokens: SkinTokens
  /** Optional CSS text; the registry injects it scoped by `data-snap-skin`. */
  css?: string
}

/** The factory day theme id (cobalt palette, light surfaces). */
export const DEFAULT_LIGHT_ID = 'default-light'

/** The factory night theme id (cobalt palette, dark surfaces). */
export const DEFAULT_DARK_ID = 'default-dark'

/** The contributor label for the factory themes. */
const FACTORY_CALLER = '@snap-rail/ui'

const COBALT_DARK_TOKENS: SkinTokens = {
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
}

const COBALT_LIGHT_TOKENS: SkinTokens = {
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
}

/** The factory day theme. Always registered; never the first paint though — the night theme is. */
export const DEFAULT_LIGHT: SkinDefinition = {
  id: DEFAULT_LIGHT_ID,
  title: '钴蓝·白天',
  tokens: COBALT_LIGHT_TOKENS,
}

/** The factory night theme and the registry's fallback. */
export const DEFAULT_DARK: SkinDefinition = {
  id: DEFAULT_DARK_ID,
  title: '钴蓝·黑夜',
  tokens: COBALT_DARK_TOKENS,
}

/** One registered theme as the registry reports it. */
export interface SkinRow {
  id: string
  title: string
  /** The registering package; factory themes carry `@snap-rail/ui`. */
  caller: string
}

/** Turn a token key into its CSS custom property (`chart1` → `--snap-chart-1`). */
export function skinTokenVar(key: keyof SkinTokens): string {
  const kebab = key.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`).replace(/(\d+)$/, '-$1')
  return `--snap-${kebab}`
}

/** The service exposed as `ctx.skins`. */
export interface SkinsService {
  /** Register a theme; disposal removes it and falls back to the factory night theme. */
  register(caller: Context, skin: SkinDefinition): () => void
  /** Activate a theme: exact id first, then the id read as a contributor
   * package (a package's first registered theme), then nothing. */
  activate(selection: string): boolean
  /** Every registered theme, factory themes first. */
  list(): readonly SkinRow[]
  /** The active theme. */
  active(): SkinDefinition
  /** The active theme's token object. */
  tokens(): SkinTokens
  /** Subscribe to theme changes. */
  subscribe(listener: () => void): () => void
  /** Monotonic change version. */
  version(): number
}

declare module '@snap-rail/cordis' {
  interface Context {
    skins: SkinsService
  }

  interface Events {
    /** The active theme changed. */
    'skins/changed'(): void
  }
}

/** Apply the active theme to the document root. */
function applySkin(skin: SkinDefinition): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset['snapSkin'] = skin.id
  for (const [key, value] of Object.entries(skin.tokens)) {
    root.style.setProperty(skinTokenVar(key as keyof SkinTokens), value)
  }
}

/** Mount the `ctx.skins` registry. */
const skinsPlugin: Plugin.Object<void> = {
  name: 'snap-rail ui skins',
  apply(ctx: Context): void {
    const skins = new Map<string, SkinDefinition>()
    const callers = new Map<string, string>()
    const listeners = new Set<() => void>()
    const styleTags = new Map<string, HTMLStyleElement>()
    let activeId = DEFAULT_DARK_ID
    let revision = 0

    skins.set(DEFAULT_LIGHT_ID, DEFAULT_LIGHT)
    callers.set(DEFAULT_LIGHT_ID, FACTORY_CALLER)
    skins.set(DEFAULT_DARK_ID, DEFAULT_DARK)
    callers.set(DEFAULT_DARK_ID, FACTORY_CALLER)

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
      const skin = skins.get(activeId) ?? DEFAULT_DARK
      activeId = skin.id
      ensureStyleTag(skin)
      applySkin(skin)
      notify()
    }

    ctx.provide('skins', {
      register(caller: Context, skin: SkinDefinition): () => void {
        skins.set(skin.id, skin)
        callers.set(skin.id, caller.fiber.name)
        // Registration only makes a theme selectable; activation stays with
        // the operator's stored selection (applied by the runtime).
        refresh()
        const remove = (): void => {
          if (!skins.delete(skin.id)) return
          callers.delete(skin.id)
          const tag = styleTags.get(skin.id)
          if (tag !== undefined) {
            tag.remove()
            styleTags.delete(skin.id)
          }
          if (activeId === skin.id) activeId = DEFAULT_DARK_ID
          refresh()
        }
        caller.effect(() => remove)
        return remove
      },
      activate(selection: string): boolean {
        let next = skins.has(selection) ? selection : undefined
        if (next === undefined) {
          for (const [id, owner] of callers) {
            if (id !== selection && owner === selection && skins.has(id)) { next = id; break }
          }
        }
        if (next === undefined) return false
        if (next === activeId) return true
        activeId = next
        refresh()
        return true
      },
      list: (): readonly SkinRow[] => [...skins.values()].map(skin => ({
        id: skin.id,
        title: skin.title,
        caller: callers.get(skin.id) ?? FACTORY_CALLER,
      })),
      active: () => skins.get(activeId) ?? DEFAULT_DARK,
      tokens: () => (skins.get(activeId) ?? DEFAULT_DARK).tokens,
      subscribe(listener: () => void): () => void {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      version: () => revision,
    } satisfies SkinsService)

    // Apply the factory night theme immediately so the first paint already
    // carries the token vocabulary, even before any plugin registers.
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

/** Re-render on theme changes and return the active token set. */
export function useSkinTokens(): SkinTokens {
  const service = useSkins()
  useSyncExternalStore(service.subscribe, service.version, service.version)
  return service.tokens()
}

/** Re-render on theme changes and return the active theme id. */
export function useSkinId(): string {
  const service = useSkins()
  useSyncExternalStore(service.subscribe, service.version, service.version)
  return service.active().id
}

export default skinsPlugin
