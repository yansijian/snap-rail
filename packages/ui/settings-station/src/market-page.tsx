/**
 * The 插件市场 settings page: the configured plugin feed as one browsable
 * catalog — plugins grouped by the author's category marker under one text
 * filter, plus the combination (recipe) section, where base combinations
 * and scenario combinations install with one click: the host lands every
 * missing plugin first and then the recipe's preset file, which is what
 * makes the combination live. The host fetches the feed's `index.json` /
 * `recipes.json` and annotates every entry with the local verdict;
 * installing rides the plugins domain — the same strictly-higher pipeline
 * as a local zip install, so the pool stays the single truth. The feed base
 * URL is a settings key (`plugins.feedUrl`), hot-applied.
 *
 * @module @snap-rail/settings-station/market-page
 */

// Wire rows for the plugins-domain methods this page calls.
import '@snap-rail/app-boot/contract'
import {
  PLUGINS_FEED_URL_KEY,
  type RemoteAction,
  type RemotePluginInfo,
  type RemoteRecipeInfo,
} from '@snap-rail/app-boot/contract'
import type { Context } from '@snap-rail/cordis'
import { rpcErrorText } from '@snap-rail/connection'
import {
  Badge, Button, Dialog, DialogContent, DialogFooter, DialogTitle, Input, Label,
} from '@snap-rail/framework-shadcn/ui'
import { useEffect, useState, type ReactNode } from 'react'
import { KIND_LABELS, PluginIdentity } from './plugins-page.tsx'

/** Action → badge text/variant: what the market says about one plugin row. */
const ACTION_BADGES: Record<RemoteAction, { text: string, variant: 'default' | 'secondary' }> = {
  install: { text: '可安装', variant: 'default' },
  update: { text: '可更新', variant: 'default' },
  current: { text: '已是最新', variant: 'secondary' },
  'local-newer': { text: '本地更新', variant: 'secondary' },
}

/** A plugin building on the base seams (the store service, the equipment
 * seam, or the active framework) is standard-base ecosystem — a display
 * badge only; enablement is still the requirements precheck's business. */
const isBaseEcosystem = (item: RemotePluginInfo): boolean =>
  (item.requires ?? []).some(entry => entry === 'service:store' || entry === '@snap-rail/equipment') ||
  item.framework !== undefined

/** The recipe card's verdict: what one click would do right now. */
function recipeBadge(recipe: RemoteRecipeInfo): { text: string, variant: 'default' | 'secondary' | 'destructive' } {
  if (recipe.applied) return { text: '已安装', variant: 'secondary' }
  if (recipe.unavailable.length > 0) return { text: '插件缺失', variant: 'destructive' }
  if (recipe.pending.length > 0) return { text: '可安装', variant: 'default' }
  return { text: '插件已齐', variant: 'default' }
}

/** One combination card: the effect it promises, the packages it carries,
 * and the one-click install (or remove) affordance. */
function RecipeCard(props: {
  recipe: RemoteRecipeInfo
  busy: boolean
  onInstall: (id: string) => void
  onRemove: (id: string) => void
}): ReactNode {
  const { recipe } = props
  const badge = recipeBadge(recipe)
  const installable = !recipe.applied && recipe.unavailable.length === 0
  return (
    <div
      data-recipe-card={recipe.id}
      className="flex items-center justify-between gap-3 rounded-md border border-border px-4 py-3.5"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{recipe.title}</span>
          <Badge variant={badge.variant} data-recipe-status={badge.text}>{badge.text}</Badge>
          <span className="whitespace-nowrap text-xs text-muted-foreground">v{recipe.version}</span>
        </div>
        {recipe.description !== undefined && recipe.description !== '' && (
          <span className="truncate text-xs text-muted-foreground">{recipe.description}</span>
        )}
        <span className="truncate font-mono text-xs text-muted-foreground">{recipe.plugins.join('、')}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {recipe.applied && (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            data-recipe-remove={recipe.id}
            disabled={props.busy}
            onClick={() => props.onRemove(recipe.id)}
          >
            移除
          </Button>
        )}
        {installable && (
          <Button
            size="sm"
            data-recipe-install={recipe.id}
            disabled={props.busy}
            onClick={() => props.onInstall(recipe.id)}
          >
            {props.busy ? '安装中…' : recipe.pending.length > 0 ? '一键安装' : '启用'}
          </Button>
        )}
      </div>
    </div>
  )
}

/** One group of recipe cards under its kind label. */
function RecipeGroup(props: {
  label: string
  recipes: readonly RemoteRecipeInfo[]
  busyId: string | undefined
  onInstall: (id: string) => void
  onRemove: (id: string) => void
}): ReactNode {
  if (props.recipes.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-muted-foreground">{props.label}</div>
      {props.recipes.map(recipe => (
        <RecipeCard
          key={recipe.id}
          recipe={recipe}
          busy={props.busyId === recipe.id}
          onInstall={props.onInstall}
          onRemove={props.onRemove}
        />
      ))}
    </div>
  )
}

/** The 插件市场 page. */
export function MarketPage({ ctx }: { ctx: Context }): ReactNode {
  const [feedUrl, setFeedUrl] = useState('')
  const [feedError, setFeedError] = useState<string | undefined>(undefined)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error' | 'unconfigured'>('loading')
  const [items, setItems] = useState<readonly RemotePluginInfo[]>([])
  const [recipes, setRecipes] = useState<readonly RemoteRecipeInfo[]>([])
  const [filter, setFilter] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)
  const [busyName, setBusyName] = useState<string | undefined>(undefined)
  const [busyRecipe, setBusyRecipe] = useState<string | undefined>(undefined)
  const [restartPrompt, setRestartPrompt] = useState(false)
  const [rendererNames, setRendererNames] = useState<readonly string[]>([])

  const link = ctx.client.link

  /** Re-read the catalog; only meaningful with a configured feed. The
   * recipe catalog rides along — a feed without one (an older feed, a 404)
   * simply hides the combination section. */
  const refresh = (url: string): void => {
    if (url === '') {
      setPhase('unconfigured')
      return
    }
    setPhase('loading')
    setErrorMessage(undefined)
    void link.call('plugins.remote-list', {}).then(result => {
      if (result.ok) {
        setItems(result.value.plugins)
        setPhase('ready')
      } else {
        setErrorMessage(rpcErrorText(result.error))
        setPhase('error')
      }
    }).catch(cause => {
      setErrorMessage(String(cause))
      setPhase('error')
    })
    void link.call('plugins.remote-recipes', {}).then(result => {
      setRecipes(result.ok ? result.value.recipes : [])
    }).catch(() => setRecipes([]))
  }

  useEffect(() => {
    void link.call('settings.get', { key: PLUGINS_FEED_URL_KEY }).then(result => {
      const value = result.ok && typeof result.value.value === 'string' ? result.value.value : ''
      setFeedUrl(value)
      refresh(value)
    }).catch(() => setPhase('unconfigured'))
    void link.call('client-config.list', {}).then(result => {
      if (result.ok) setRendererNames(result.value.rows.map(row => row.name))
    }).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx])

  const saveFeedUrl = (): void => {
    const value = feedUrl.trim()
    if (value !== '') {
      try {
        const parsed = new URL(value)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol')
      } catch {
        setFeedError('请填写 http(s) 开头的插件源地址')
        return
      }
    }
    setFeedError(undefined)
    void link.call('settings.set', { key: PLUGINS_FEED_URL_KEY, value }).then(() => refresh(value))
  }

  const install = (name: string): void => {
    setBusyName(name)
    setErrorMessage(undefined)
    void link.call('plugins.remote-install', { name }).then(result => {
      setBusyName(undefined)
      if (!result.ok) {
        setErrorMessage(rpcErrorText(result.error))
        return
      }
      refresh(feedUrl.trim())
      // An update swapped the package under a possibly-running renderer
      // face — same restart surface as the plugins page's flows.
      if (result.value.installed.updated && rendererNames.includes(result.value.installed.name)) {
        setRestartPrompt(true)
      }
    }).catch(() => setBusyName(undefined))
  }

  const installRecipe = (id: string): void => {
    setBusyRecipe(id)
    setErrorMessage(undefined)
    void link.call('plugins.remote-install-recipe', { id }).then(result => {
      setBusyRecipe(undefined)
      if (!result.ok) {
        setErrorMessage(rpcErrorText(result.error))
        return
      }
      refresh(feedUrl.trim())
      // An updated package may have swapped under a running renderer face;
      // fresh installs come alive through the recipe's preset file instead.
      if (result.value.installed.some(entry => entry.updated && rendererNames.includes(entry.name))) {
        setRestartPrompt(true)
      }
    }).catch(() => setBusyRecipe(undefined))
  }

  const removeRecipe = (id: string): void => {
    setBusyRecipe(id)
    setErrorMessage(undefined)
    void link.call('plugins.remove-recipe', { id }).then(result => {
      setBusyRecipe(undefined)
      if (!result.ok) {
        setErrorMessage(rpcErrorText(result.error))
        return
      }
      refresh(feedUrl.trim())
    }).catch(() => setBusyRecipe(undefined))
  }

  const relaunch = (): void => {
    void link.call('window.relaunch', {}).catch(() => undefined)
  }

  // The filtered plugin rows: one text box over name, title, and description.
  const query = filter.trim().toLowerCase()
  const visibleItems = query === ''
    ? items
    : items.filter(item =>
        item.name.toLowerCase().includes(query) ||
        (item.title ?? '').toLowerCase().includes(query) ||
        (item.description ?? '').toLowerCase().includes(query))
  // Category sections in the author-marker vocabulary, 其他 pinned last.
  const sections = new Map<string, RemotePluginInfo[]>()
  for (const item of visibleItems) {
    const marker = item.category ?? '其他'
    const bucket = sections.get(marker)
    if (bucket === undefined) sections.set(marker, [item])
    else bucket.push(item)
  }
  const orderedSections = [...sections.entries()].sort(([a], [b]) => {
    if (a === '其他') return 1
    if (b === '其他') return -1
    return a.localeCompare(b, 'zh-Hans-CN')
  })
  const baseRecipes = recipes.filter(recipe => recipe.kind === 'base')
  const scenarioRecipes = recipes.filter(recipe => recipe.kind === 'scenario')

  return (
    <div data-region="market-page" className="flex max-w-2xl flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="market-feed-url">插件源地址</Label>
        <div className="flex items-center gap-2">
          <Input
            id="market-feed-url"
            value={feedUrl}
            placeholder="http://192.168.1.10/snap-rail/plugins/"
            onChange={event => setFeedUrl(event.target.value)}
          />
          <Button variant="outline" data-market-save-feed onClick={saveFeedUrl}>保存</Button>
          <Button variant="outline" data-market-refresh disabled={phase === 'loading' || feedUrl.trim() === ''} onClick={() => refresh(feedUrl.trim())}>
            刷新
          </Button>
        </div>
        {feedError !== undefined && <p className="text-sm text-destructive">{feedError}</p>}
        <p className="text-xs text-muted-foreground">
          指向插件源目录（内含 index.json、recipes.json 与插件包）；保存后立即生效。
        </p>
      </div>

      {phase === 'unconfigured' && (
        <div className="rounded-md border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">
          尚未配置插件源：填写上方地址并保存后，即可浏览与安装远端插件与组合。
        </div>
      )}
      {phase === 'loading' && <div className="text-sm text-muted-foreground">正在读取插件源…</div>}
      {phase === 'error' && (
        <div className="flex flex-col gap-2 rounded-md border border-destructive px-4 py-4">
          <p data-market-error className="text-sm text-destructive">{errorMessage}</p>
          <div>
            <Button variant="outline" size="sm" onClick={() => refresh(feedUrl.trim())}>重试</Button>
          </div>
        </div>
      )}
      {phase === 'ready' && errorMessage !== undefined && (
        <p data-market-action-error className="text-sm text-destructive">{errorMessage}</p>
      )}
      {phase === 'ready' && (
        <div data-recipe-section className="flex flex-col gap-3">
          {recipes.length === 0
            ? (
                <div className="rounded-md border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">
                  该插件源暂未提供组合（基座/场景一键安装）。
                </div>
              )
            : (
                <>
                  <RecipeGroup label="基座组合" recipes={baseRecipes} busyId={busyRecipe} onInstall={installRecipe} onRemove={removeRecipe} />
                  <RecipeGroup label="场景组合" recipes={scenarioRecipes} busyId={busyRecipe} onInstall={installRecipe} onRemove={removeRecipe} />
                </>
              )}
        </div>
      )}
      {phase === 'ready' && (
        <div className="flex flex-col gap-3">
          <Label htmlFor="market-filter">插件</Label>
          <Input
            id="market-filter"
            value={filter}
            placeholder="按名称或描述过滤…"
            data-market-filter
            onChange={event => setFilter(event.target.value)}
          />
        </div>
      )}
      {phase === 'ready' && items.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">插件源为空。</div>
      )}
      {phase === 'ready' && items.length > 0 && visibleItems.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">没有匹配的插件。</div>
      )}
      {phase === 'ready' && orderedSections.map(([marker, sectionItems]) => (
        <div key={marker} data-market-section={marker} className="flex flex-col gap-2">
          <div className="text-xs font-medium text-muted-foreground">{marker}</div>
          {sectionItems.map(item => {
            const badge = ACTION_BADGES[item.action]
            const installable = item.action === 'install' || item.action === 'update'
            return (
              <div
                key={item.name}
                data-market-row={item.name}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-4 py-3.5"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <PluginIdentity
                    title={item.title}
                    name={item.name}
                    version={item.version}
                    badge={(
                      <>
                        <Badge variant="secondary">{KIND_LABELS[item.kind ?? 'plugin'] ?? item.kind ?? '插件'}</Badge>
                        {isBaseEcosystem(item) && <Badge variant="outline" data-market-eco={item.name}>标准基座生态</Badge>}
                        <Badge variant={badge.variant} data-market-action={item.action}>{badge.text}</Badge>
                      </>
                    )}
                  />
                  {item.description !== undefined && item.description !== '' && (
                    <span className="truncate text-xs text-muted-foreground">{item.description}</span>
                  )}
                </div>
                {installable && (
                  <Button
                    size="sm"
                    data-market-install={item.name}
                    disabled={busyName !== undefined}
                    onClick={() => install(item.name)}
                  >
                    {busyName === item.name ? '安装中…' : item.action === 'update' ? '更新' : '安装'}
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      ))}

      {restartPrompt && (
        <Dialog open onOpenChange={next => { if (!next) setRestartPrompt(false) }}>
          <DialogContent aria-describedby={undefined} className="max-w-sm">
            <DialogTitle className="text-base font-medium">变更待重启生效</DialogTitle>
            <p className="text-sm text-muted-foreground">页面类插件的更新将在下次启动时生效，旧界面残留也会随之消失。</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRestartPrompt(false)}>稍后</Button>
              <Button data-restart-now onClick={relaunch}>立即重启</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
