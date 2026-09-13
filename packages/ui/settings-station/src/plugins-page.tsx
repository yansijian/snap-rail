/**
 * The plugin management page: one collapsible section per classification
 * marker — the raw `snapRail.category` string from each installed package,
 * authored by the plugin developer — with every entry a flat row (no
 * package-level grouping: a package and its subpath rows each own a toggle)
 * identified by the author's `snapRail.title` over the package name, plus
 * the zip install flow (pick → inspect → confirm → install) and a
 * collapse-all control at the top. 套件-kind rows render as single-choice
 * cards (one scenario at a time). Shipped rows carry no toggle: they are
 * the app itself, the disabled switch being the only cue. Every write
 * lands in `plugins.yml` through the plugins domain; the file stays the
 * single interface.
 *
 * @module @snap-rail/settings-station/plugins-page
 */

// Wire rows for the plugins-domain methods this page calls.
import '@snap-rail/app-boot/contract'
import type { Context } from '@snap-rail/cordis'
import { rpcErrorText } from '@snap-rail/connection'
import {
  Badge, Button, Collapsible, CollapsibleChevron, CollapsibleContent, CollapsibleTrigger, Dialog,
  DialogContent, DialogFooter, DialogTitle, IconChevronsDownUp, IconChevronsUpDown, IconPlus, Switch, Tooltip,
} from '@snap-rail/framework-shadcn/ui'
import { useEffect, useState, type ReactNode } from 'react'

/** One row of the plugin management surface. */
interface PluginRow {
  name: string
  source: 'builtin' | 'preset' | 'user' | 'pool'
  enabled: boolean
  packageName: string
  kind?: string
  title?: string
  category?: string
  framework?: string
  clientOnly?: boolean
}

/** What the pre-install inspection shows. */
interface Inspected {
  name: string
  version: string
  kind?: string | undefined
  title?: string | undefined
  category?: string | undefined
  permissions: readonly string[]
  hasClient: boolean
  requires: readonly string[]
  missing: readonly string[]
}

/** Shipped rows accept no management operation — the app itself is
 * read-only. A preset row stays manageable: toggling it writes a user row,
 * which overrides the preset per field (the preset itself is untouched). */
const isProtectedRow = (row: PluginRow): boolean => row.source !== 'pool' && row.source !== 'preset'

/** The section a package groups under: a declared category wins whatever the
 * source (dev's overlay mounts installable packages as protected builtin
 * rows, and they keep their author markers); without one, installed and
 * preset-carried rows fall into 其他 and the protected shipped set — which
 * declares no category — pins into the single 内置 section. */
export const sectionOf = (row: PluginRow): string =>
  row.category ?? (row.source === 'pool' || row.source === 'preset' ? '其他' : '内置')

/** The identity block every listing surface shares: the author's title on
 * top, the package (or entry) name beneath in small muted mono — an
 * undeclared title shows the name alone. */
function PluginIdentity(props: { title?: string | undefined, name: string, badge?: ReactNode }): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-3">
        <span className="truncate text-sm font-medium">{props.title ?? props.name}</span>
        {props.badge}
      </span>
      {props.title !== undefined && (
        <span className="truncate font-mono text-xs text-muted-foreground">{props.name}</span>
      )}
    </div>
  )
}

/** One row: identity and the enable toggle (pool-installed single-entry
 * packages also carry the uninstall affordance). Shipped rows are the app
 * itself — the toggle is disabled and hovering explains why. */
function PluginRowView(props: {
  row: PluginRow
  onToggle: (name: string, enabled: boolean) => void
  onUninstall?: ((pkg: string) => void) | undefined
  needsRestart?: boolean | undefined
}): ReactNode {
  const { row } = props
  const isBase = isProtectedRow(row)
  const label = row.title ?? row.name
  return (
    <div
      data-plugin-row={row.name}
      className="flex items-center justify-between rounded-md border border-border px-4 py-3.5"
    >
      <PluginIdentity
        title={row.title}
        name={row.name}
        badge={props.needsRestart === true ? <Badge variant="destructive">待重启</Badge> : undefined}
      />
      <div className="flex items-center gap-2">
        {props.onUninstall !== undefined && (
          <Button
            data-uninstall-plugin={row.packageName}
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => props.onUninstall?.(row.packageName)}
          >
            卸载
          </Button>
        )}
        {isBase ? (
          <Tooltip content="内置插件禁止删除/修改">
            <span className="inline-flex">
              <Switch aria-label={`内置 ${label}`} checked disabled />
            </span>
          </Tooltip>
        ) : (
          <Switch
            aria-label={`启用 ${label}`}
            checked={row.enabled}
            onCheckedChange={checked => props.onToggle(row.name, checked)}
          />
        )}
      </div>
    </div>
  )
}

/** One suite card: radio semantics — 激活 is selecting, not switching. */
function SuiteCard(props: {
  pkg: string
  title?: string | undefined
  active: boolean
  needsRestart: boolean
  onActivate: () => void
  onUninstall?: ((pkg: string) => void) | undefined
}): ReactNode {
  return (
    <div
      data-suite-card={props.pkg}
      aria-pressed={props.active}
      className={`flex items-center justify-between rounded-md border px-4 py-3.5 ${props.active ? 'border-primary channel-keyline' : 'border-border'}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className={`inline-block h-4 w-4 shrink-0 rounded-full border-2 border-primary ${props.active ? 'bg-primary' : 'bg-transparent'}`}
        />
        <PluginIdentity
          title={props.title}
          name={props.pkg}
          badge={props.needsRestart ? <Badge variant="destructive">待重启</Badge> : undefined}
        />
      </div>
      <div className="flex items-center gap-2">
        {props.onUninstall !== undefined && (
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => props.onUninstall?.(props.pkg)}>
            卸载
          </Button>
        )}
        <Button variant={props.active ? 'secondary' : 'default'} size="sm" disabled={props.active} onClick={props.onActivate}>
          {props.active ? '使用中' : '激活'}
        </Button>
      </div>
    </div>
  )
}

/** The plugins page. */
export function PluginsPage({ ctx }: { ctx: Context }): ReactNode {
  const [rows, setRows] = useState<readonly PluginRow[]>([])
  const [failed, setFailed] = useState(false)
  const [rendererNames, setRendererNames] = useState<readonly string[]>([])
  /** Classification markers the user collapsed; everything else is open. */
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  /** Rows toggled since page open — the restart-required surface. */
  const [touched, setTouched] = useState<Set<string>>(new Set())
  const [restartPrompt, setRestartPrompt] = useState(false)
  const [install, setInstall] = useState<
    | { phase: 'idle' }
    | { phase: 'picked', zipPath: string }
    | { phase: 'confirm', zipPath: string, plugin: Inspected }
    | { phase: 'installing' }
    | { phase: 'error', message: string }
  >({ phase: 'idle' })
  const [uninstall, setUninstall] = useState<
    | { phase: 'idle' }
    | { phase: 'confirm', pkg: string }
    | { phase: 'error', message: string }
  >({ phase: 'idle' })

  const link = ctx.client.link

  const reload = (): void => {
    void link.call('plugins.list', {}).then(result => {
      if (result.ok) {
        setRows(result.value.plugins.map(info => ({
          name: info.name, source: info.source, enabled: info.enabled,
          packageName: info.packageName,
          ...info.kind !== undefined ? { kind: info.kind } : {},
          ...info.title !== undefined ? { title: info.title } : {},
          ...info.category !== undefined ? { category: info.category } : {},
          ...info.framework !== undefined ? { framework: info.framework } : {},
          ...info.clientOnly ? { clientOnly: true } : {},
        })))
      } else setFailed(true)
    }).catch(() => setFailed(true))
    // Rides every reload: installs and uninstalls change which pool faces
    // exist, and the restart prompt keys off this list.
    void link.call('client-config.list', {}).then(result => {
      if (result.ok) setRendererNames(result.value.rows.map(row => row.name))
    }).catch(() => undefined)
  }
  useEffect(() => {
    reload()
    void link.call('client-config.list', {}).then(result => {
      if (result.ok) setRendererNames(result.value.rows.map(row => row.name))
    }).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx])

  const toggle = (name: string, enabled: boolean): void => {
    setRows(current => current.map(row => row.name === name ? { ...row, enabled } : row))
    if (rendererNames.includes(name)) {
      setTouched(current => new Set([...current, name]))
      setRestartPrompt(true)
    }
    void link.call('plugins.set-enabled', { name, enabled })
      .then(result => {
        if (!result.ok) {
          setRows(current => current.map(row => row.name === name ? { ...row, enabled: !enabled } : row))
          setTouched(current => { const next = new Set(current); next.delete(name); return next })
        }
      })
      .catch(() => {
        setRows(current => current.map(row => row.name === name ? { ...row, enabled: !enabled } : row))
        setTouched(current => { const next = new Set(current); next.delete(name); return next })
      })
  }

  /** The uninstall affordance opens a confirm first — the package and its
   * data are deleted for real. */
  const requestUninstall = (pkg: string): void => {
    setUninstall({ phase: 'confirm', pkg })
  }

  const runUninstall = (pkg: string): void => {
    void link.call('plugins.uninstall', { name: pkg }).then(result => {
      if (!result.ok) {
        setUninstall({ phase: 'error', message: rpcErrorText(result.error) })
        return
      }
      setUninstall({ phase: 'idle' })
      reload()
      // The renderer may still carry the uninstalled face until it reboots.
      if (rendererNames.includes(pkg)) {
        setTouched(current => new Set([...current, pkg]))
        setRestartPrompt(true)
      }
    }).catch(cause => setUninstall({ phase: 'error', message: String(cause) }))
  }

  const pickZip = (): void => {
    setInstall({ phase: 'idle' })
    void link.call('window.pick-zip', { title: '选择插件包' }).then(result => {
      if (!result.ok || result.value === null) return
      const zipPath: string = result.value
      setInstall({ phase: 'picked', zipPath })
      void link.call('plugins.inspect', { zipPath }).then(inspect => {
        if (!inspect.ok) {
          setInstall({ phase: 'error', message: rpcErrorText(inspect.error) })
          return
        }
        setInstall({ phase: 'confirm', zipPath, plugin: inspect.value.plugin })
      }).catch(cause => setInstall({ phase: 'error', message: String(cause) }))
    }).catch(() => undefined)
  }

  const runInstall = (zipPath: string): void => {
    setInstall({ phase: 'installing' })
    void link.call('plugins.install', { zipPath }).then(result => {
      if (!result.ok) {
        setInstall({ phase: 'error', message: rpcErrorText(result.error) })
        return
      }
      // Installing lands the package in the pool disabled; enabling it is a
      // separate explicit act, so no restart prompt belongs to the install.
      setInstall({ phase: 'idle' })
      reload()
    }).catch(cause => setInstall({ phase: 'error', message: String(cause) }))
  }

  const relaunch = (): void => {
    void link.call('window.relaunch', {}).catch(() => undefined)
  }

  if (failed) return <div className="text-sm text-muted-foreground">插件列表读取失败。</div>

  const needsRestart = (name: string): boolean => touched.has(name)

  // Rows file straight under their classification marker — no package-level
  // grouping; every entry (a package or one of its subpath rows) is its own
  // flat row with its own toggle. Sections collapse on demand; 内置 pins last.
  const sections = new Map<string, PluginRow[]>()
  for (const row of rows) {
    const marker = sectionOf(row)
    const bucket = sections.get(marker)
    if (bucket === undefined) sections.set(marker, [row])
    else bucket.push(row)
  }
  const orderedSections = [...sections.entries()].sort(([a], [b]) => {
    if (a === '内置') return 1
    if (b === '内置') return -1
    return a.localeCompare(b, 'zh-Hans-CN')
  })
  const allCollapsed = orderedSections.every(([marker]) => collapsedSections.has(marker))
  const collapseAll = (): void => {
    setCollapsedSections(allCollapsed ? new Set() : new Set(orderedSections.map(([marker]) => marker)))
  }
  const toggleSection = (marker: string, open: boolean): void => {
    setCollapsedSections(current => {
      const next = new Set(current)
      if (open) next.delete(marker)
      else next.add(marker)
      return next
    })
  }

  return (
    <div data-region="plugins-table" className="flex flex-col gap-4">
      <div className="flex items-center justify-end gap-2">
        <Button data-install-plugin onClick={pickZip}><IconPlus />安装插件</Button>
        <Button data-collapse-all variant="outline" onClick={collapseAll}>
          {allCollapsed ? <IconChevronsUpDown /> : <IconChevronsDownUp />}
          {allCollapsed ? '全部展开' : '全部折叠'}
        </Button>
      </div>

      {orderedSections.map(([marker, sectionRows]) => (
        <Collapsible
          key={marker}
          data-plugins-section={marker}
          open={!collapsedSections.has(marker)}
          onOpenChange={open => toggleSection(marker, open)}
          className="flex flex-col gap-2 rounded-none border-0 bg-transparent"
        >
          <CollapsibleTrigger
            data-section-toggle={marker}
            aria-label={`折叠分类 ${marker}`}
            className="w-fit justify-start py-1 text-sm font-medium text-muted-foreground"
          >
            <CollapsibleChevron />
            <span>{marker}</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-2">
            {sectionRows.map(row =>
              row.kind === 'suite'
                ? (
                    <SuiteCard
                      key={row.name}
                      pkg={row.packageName}
                      title={row.title}
                      active={row.enabled}
                      needsRestart={needsRestart(row.name)}
                      onActivate={() => toggle(row.name, true)}
                      onUninstall={row.source === 'pool' ? requestUninstall : undefined}
                    />
                  )
                : (
                    <PluginRowView
                      key={row.name}
                      row={row}
                      onToggle={toggle}
                      onUninstall={row.source === 'pool' ? requestUninstall : undefined}
                      needsRestart={needsRestart(row.name)}
                    />
                  ))}
          </CollapsibleContent>
        </Collapsible>
      ))}

      {restartPrompt && (
        <Dialog open onOpenChange={next => { if (!next) setRestartPrompt(false) }}>
          <DialogContent aria-describedby={undefined} className="max-w-sm">
            <DialogTitle className="text-base font-medium">变更待重启生效</DialogTitle>
            <p className="text-sm text-muted-foreground">业务套件与页面类插件的启用变更将在下次启动时生效；插件卸载后的界面残留也会随之消失。</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRestartPrompt(false)}>稍后</Button>
              <Button data-restart-now onClick={() => relaunch()}>立即重启</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {install.phase === 'confirm' && (
        <Dialog open onOpenChange={next => { if (!next) setInstall({ phase: 'idle' }) }}>
          <DialogContent aria-describedby={undefined} className="max-w-sm">
            <DialogTitle className="text-base font-medium">安装插件</DialogTitle>
            <div className="grid gap-2 text-sm">
              {install.plugin.title !== undefined && (
                <div className="flex justify-between gap-4"><span className="text-muted-foreground">名称</span><span className="truncate">{install.plugin.title}</span></div>
              )}
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">包名</span><span className="truncate font-mono">{install.plugin.name}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">版本</span><span className="font-mono">{install.plugin.version}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">分类</span><span>{install.plugin.category ?? '其他'}</span></div>
              {install.plugin.hasClient && <div className="flex justify-between gap-4"><span className="text-muted-foreground">界面</span><span>含页面</span></div>}
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">权限</span><span>{install.plugin.permissions.length === 0 ? '无' : install.plugin.permissions.join('、')}</span></div>
              {install.plugin.missing.length > 0 && (
                <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  尚未安装的依赖：{install.plugin.missing.join('、')}——可先安装本包，启用前需装齐。
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setInstall({ phase: 'idle' })}>取消</Button>
              <Button data-confirm-install onClick={() => runInstall(install.zipPath)}>安装</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {install.phase === 'error' && (
        <Dialog open onOpenChange={next => { if (!next) setInstall({ phase: 'idle' }) }}>
          <DialogContent aria-describedby={undefined} className="max-w-sm">
            <DialogTitle className="text-base font-medium">安装失败</DialogTitle>
            <p data-install-error className="text-sm text-destructive">{install.message}</p>
            <DialogFooter>
              <Button onClick={() => setInstall({ phase: 'idle' })}>知道了</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {uninstall.phase === 'confirm' && (
        <Dialog open onOpenChange={next => { if (!next) setUninstall({ phase: 'idle' }) }}>
          <DialogContent aria-describedby={undefined} className="max-w-sm">
            <DialogTitle className="text-base font-medium">卸载插件</DialogTitle>
            <p className="text-sm text-muted-foreground">
              将从插件池移除 <span className="font-mono text-foreground">{uninstall.pkg}</span>，其数据一并删除，不可恢复。
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setUninstall({ phase: 'idle' })}>取消</Button>
              <Button variant="destructive" data-confirm-uninstall onClick={() => runUninstall(uninstall.pkg)}>卸载</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {uninstall.phase === 'error' && (
        <Dialog open onOpenChange={next => { if (!next) setUninstall({ phase: 'idle' }) }}>
          <DialogContent aria-describedby={undefined} className="max-w-sm">
            <DialogTitle className="text-base font-medium">卸载失败</DialogTitle>
            <p data-uninstall-error className="text-sm text-destructive">{uninstall.message}</p>
            <DialogFooter>
              <Button onClick={() => setUninstall({ phase: 'idle' })}>知道了</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
