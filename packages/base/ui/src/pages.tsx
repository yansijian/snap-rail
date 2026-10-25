/**
 * The main-page registry: business views contribute a page, a layout renders
 * the active one. This is deliberately separate from settings pages and from
 * the chrome slots; gating/workflows can wrap it later without changing the
 * page authoring surface.
 *
 * @module @snap-rail/ui/pages
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import { useSyncExternalStore, type ReactNode } from 'react'

/** One main page contributed by a plugin. */
export interface PageDefinition {
  id: string
  title: string
  order: number
  render(): ReactNode
}

/** The page registry exposed as `ctx.pages`. */
export interface PagesService {
  registerPage(caller: Context, page: PageDefinition): () => void
  list(): readonly PageDefinition[]
  active(): PageDefinition | undefined
  setActive(id: string): void
  subscribe(listener: () => void): () => void
  version(): number
}

declare module '@snap-rail/cordis' {
  interface Context {
    pages: PagesService
  }

  interface Events {
    'pages/changed'(): void
  }
}

interface StoredPage {
  page: PageDefinition
  seq: number
}

/** Mount the page registry. */
const pagesPlugin: Plugin.Object<void> = {
  name: 'snap-rail ui pages',
  apply(ctx: Context): void {
    const pages = new Map<string, StoredPage>()
    const listeners = new Set<() => void>()
    let revision = 0
    let seq = 0
    let activeId: string | undefined

    const ordered = (): PageDefinition[] => [...pages.values()]
      .sort((a, b) => a.page.order - b.page.order || a.seq - b.seq)
      .map(entry => entry.page)

    const notify = (): void => {
      revision += 1
      for (const listener of listeners) listener()
      ctx.emit('pages/changed')
    }

    const service: PagesService = {
      registerPage(caller: Context, page: PageDefinition): () => void {
        pages.set(page.id, { page, seq: seq++ })
        activeId ??= page.id
        notify()
        const remove = (): void => {
          if (!pages.delete(page.id)) return
          if (activeId === page.id) activeId = ordered()[0]?.id
          notify()
        }
        caller.effect(() => remove)
        return remove
      },
      list: ordered,
      active(): PageDefinition | undefined {
        if (activeId === undefined) return undefined
        return pages.get(activeId)?.page ?? ordered()[0]
      },
      setActive(id: string): void {
        if (!pages.has(id) || activeId === id) return
        activeId = id
        notify()
      },
      subscribe(listener: () => void): () => void {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      version: () => revision,
    }
    ctx.provide('pages', service)
  },
}

/** Re-render a layout when the page registry or active page changes. */
export function usePagesVersion(ctx: Context): number {
  return useSyncExternalStore(ctx.pages.subscribe, ctx.pages.version, ctx.pages.version)
}

export default pagesPlugin