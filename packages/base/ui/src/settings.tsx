/**
 * The built-in settings feature: a page registry plus the open/close state,
 * the default trigger contribution, and the default settings surface. The
 * shell is a semantic composition; a skin styles it, and any plugin may
 * replace the entry or surface through the region slots.
 *
 * @module @snap-rail/ui/settings
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import { Component, useSyncExternalStore, type ReactNode } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  EmptyState,
  IconButton,
} from './components/index.ts'
import { UI_SLOT_IDS, type SettingsPageInfo } from './contract.ts'
import { AppearancePage } from './settings-pages/appearance.tsx'
import { PluginsPage } from './settings-pages/plugins.tsx'
import { cn, part } from './utils.ts'

/** What one plugin contributes to the settings surface. */
export interface SettingsPageDefinition {
  id: string
  title: string
  group?: string | undefined
  icon?: ReactNode
  order: number
  keywords?: readonly string[] | undefined
  render(): ReactNode
}

/** The settings registry and surface state exposed as `ctx.settings`. */
export interface SettingsService {
  registerPage(caller: Context, page: SettingsPageDefinition): () => void
  listPages(): readonly SettingsPageDefinition[]
  open(pageId?: string): void
  close(): void
  toggle(): void
  isOpen(): boolean
  activePage(): string | undefined
  subscribe(listener: () => void): () => void
  version(): number
}

declare module '@snap-rail/cordis' {
  interface Context {
    settings: SettingsService
  }

  interface Events {
    'settings/pages-changed'(): void
    'settings/open-changed'(): void
  }
}

interface PageEntry {
  page: SettingsPageDefinition
  seq: number
}

/** Sort pages by order, then registration time. */
function orderedPages(pages: Iterable<PageEntry>): SettingsPageDefinition[] {
  return [...pages]
    .sort((a, b) => a.page.order - b.page.order || a.seq - b.seq)
    .map(entry => entry.page)
}

/** A page-level boundary: one broken settings page must not take down the shell. */
class SettingsPageBoundary extends Component<{ children: ReactNode; page: string }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    console.error(`[snap-rail ui] settings page ${this.props.page} failed`, error)
  }

  override render(): ReactNode {
    return this.state.failed
      ? <EmptyState title="设置页加载失败" description="该页面抛出了异常，其他设置页仍可使用。" />
      : this.props.children
  }
}

/** The gear glyph used by the default trigger. */
function GearIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" />
    </svg>
  )
}

/** The default settings trigger; the layout decides placement/presentation. */
export function SettingsEntry(props: {
  presentation: 'icon' | 'label'
  open(): void
  isOpen: boolean
}): ReactNode {
  if (props.presentation === 'label') {
    return <Button intent="neutral" emphasis="ghost" icon={<GearIcon />} onClick={props.open}>设置</Button>
  }
  return <IconButton icon={<GearIcon />} label="设置" active={props.isOpen} onClick={props.open} />
}

/** The default settings surface. */
export function SettingsSurface(props: { service: SettingsService }): ReactNode {
  const { service } = props
  useSyncExternalStore(service.subscribe, service.version, service.version)
  const open = service.isOpen()
  const pages = service.listPages()
  const activeId = service.activePage()
  const active = pages.find(page => page.id === activeId)

  const groups = new Map<string, SettingsPageDefinition[]>()
  for (const page of pages) {
    const group = page.group ?? '其他'
    const bucket = groups.get(group)
    if (bucket === undefined) groups.set(group, [page])
    else bucket.push(page)
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) service.close() }}>
      <DialogContent presentation="fullscreen" showClose={false}>
        <div {...part('settings', 'root')} className="snap-settings">
          <header {...part('settings', 'header')} className="snap-settings-header">
            <DialogTitle>设置</DialogTitle>
            <Button intent="neutral" emphasis="ghost" onClick={() => service.close()}>关闭</Button>
          </header>
          <div {...part('settings', 'body')} className="snap-settings-body">
            <nav {...part('settings', 'nav')} className="snap-settings-nav" aria-label="设置页">
              {[...groups.entries()].map(([group, entries]) => (
                <div key={group} {...part('settings', 'group')} className="snap-settings-group">
                  <div {...part('settings', 'group-title')} className="snap-settings-group-title">{group}</div>
                  {entries.map(page => (
                    <button
                      key={page.id}
                      type="button"
                      {...part('settings', 'nav-item')}
                      className={cn('snap-settings-nav-item', page.id === activeId && 'is-active')}
                      data-active={page.id === activeId || undefined}
                      aria-current={page.id === activeId ? 'page' : undefined}
                      onClick={() => service.open(page.id)}
                    >
                      {page.icon !== undefined && <span {...part('settings', 'nav-icon')}>{page.icon}</span>}
                      <span>{page.title}</span>
                    </button>
                  ))}
                </div>
              ))}
            </nav>
            <main {...part('settings', 'content')} className="snap-settings-content" data-active-page={activeId}>
              {active === undefined
                ? <EmptyState title="暂无设置页" description="安装或启用一个带设置页的插件后，它会出现在这里。" />
                : <SettingsPageBoundary page={active.id}>{active.render()}</SettingsPageBoundary>}
            </main>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Mount the settings registry and its default slot contributions. */
const settingsPlugin: Plugin.Object<void> = {
  name: 'snap-rail settings',
  inject: ['ui'],
  apply(ctx: Context): void {
    const pages = new Map<string, PageEntry>()
    const listeners = new Set<() => void>()
    let open = false
    let requestedId: string | undefined
    let revision = 0
    let seq = 0

    const notify = (kind: 'pages' | 'open'): void => {
      revision += 1
      for (const listener of listeners) listener()
      ctx.emit(kind === 'pages' ? 'settings/pages-changed' : 'settings/open-changed')
    }

    const firstId = (): string | undefined => orderedPages(pages.values())[0]?.id
    const activeId = (): string | undefined => {
      if (!open) return undefined
      if (requestedId !== undefined && pages.has(requestedId)) return requestedId
      return firstId()
    }

    const service: SettingsService = {
      registerPage(caller: Context, page: SettingsPageDefinition): () => void {
        pages.set(page.id, { page, seq: seq++ })
        notify('pages')
        const remove = (): void => {
          if (pages.delete(page.id)) notify('pages')
        }
        caller.effect(() => remove)
        return remove
      },
      listPages: () => orderedPages(pages.values()),
      open(pageId?: string): void {
        if (pageId !== undefined) requestedId = pageId
        if (open && pageId === undefined) return
        open = true
        notify('open')
      },
      close(): void {
        if (!open) return
        open = false
        notify('open')
      },
      toggle(): void {
        if (open) service.close()
        else service.open()
      },
      isOpen: () => open,
      activePage: activeId,
      subscribe(listener: () => void): () => void {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      version: () => revision,
    }

    ctx.provide('settings', service)

    // First-party pages ship with the substrate so a fresh install can manage
    // its own plugins without any external settings-page package.
    ctx.settings.registerPage(ctx, {
      id: 'plugins',
      title: '插件管理',
      group: '系统',
      order: 0,
      keywords: ['安装', '启用', '卸载', '驱动', '皮肤'],
      render: () => <PluginsPage ctx={ctx} />,
    })
    ctx.settings.registerPage(ctx, {
      id: 'appearance',
      title: '外观与显示',
      group: '系统',
      order: 1,
      keywords: ['主题', '皮肤', '窗口', '悬浮球', '尺寸'],
      render: () => <AppearancePage />,
    })

    // The default trigger and surface are ordinary contributions: a plugin may
    // replace either with a higher precedence, including a fully custom UI.
    ctx.ui.contribute(ctx, UI_SLOT_IDS.settingsEntry, {
      id: 'settings.default-entry',
      order: 0,
      render: (context: { presentation: 'icon' | 'label'; open(): void; isOpen: boolean }) => (
        <SettingsEntry presentation={context.presentation} open={context.open} isOpen={context.isOpen} />
      ),
    })
    ctx.ui.contribute(ctx, UI_SLOT_IDS.settingsSurface, {
      id: 'settings.default-surface',
      order: 0,
      render: () => <SettingsSurface service={service} />,
    })
  },
}

/** The settings page info the slot context exposes. */
export function settingsPageInfo(page: SettingsPageDefinition): SettingsPageInfo {
  return {
    id: page.id,
    title: page.title,
    ...page.group !== undefined ? { group: page.group } : {},
    order: page.order,
  }
}

export default settingsPlugin