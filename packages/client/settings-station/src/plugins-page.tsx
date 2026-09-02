/**
 * The plugin management page: three sections whose layouts are their
 * semantics — 业务套件 as single-choice cards (one scenario at a time,
 * activating one restarts into it), 通讯驱动 as multi-active toggles
 * (host-side hot applies), 核心与其他 as plain rows — plus the zip install
 * flow (pick → inspect → confirm → install) at the top. Every write lands
 * in `plugins.yml` through the plugins domain; the file stays the single
 * interface.
 *
 * @module @snap-rail/settings-station/plugins-page
 */

// Wire rows for the plugins-domain methods this page calls.
import '@snap-rail/app-boot/contract'
import type { Context } from '@snap-rail/cordis'
import { rpcErrorText } from '@snap-rail/connection'
import {
  Badge, Button, Collapsible, CollapsibleChevron, CollapsibleContent, CollapsibleTrigger, Dialog,
  DialogContent, DialogFooter, DialogTitle, Switch,
} from '@snap-rail/client-ui'
import { useEffect, useState, type ReactNode } from 'react'

/** One row of the plugin management surface. */
interface PluginRow {
  name: string
  source: 'builtin' | 'user' | 'pool'
  enabled: boolean
  packageName: string
  kind?: string
}

/** What the pre-install inspection shows. */
interface Inspected {
  name: string
  version: string
  kind?: string | undefined
  permissions: readonly string[]
  hasClient: boolean
}

const KIND_LABELS: Record<string, string> = {
  suite: '业务套件',
  driver: '通讯驱动',
  plugin: '插件',
}

/** One row: origin badge, name, and the enable toggle. */
function PluginRowView(props: { row: PluginRow, onToggle: (name: string, enabled: boolean) => void, needsRestart?: boolean | undefined }): ReactNode {
  const { row } = props
  return (
    <div
      data-plugin-row={row.name}
      className="flex items-center justify-between rounded-md border border-border px-4 py-3.5"
    >
      <div className="flex min-w-0 items-center gap-3">
        <Badge variant="secondary">{row.source === 'builtin' ? '内置' : row.source === 'user' ? '用户层' : '插件池'}</Badge>
        <span className="truncate font-mono text-sm">{row.name}</span>
        {props.needsRestart === true && <Badge variant="destructive">待重启</Badge>}
      </div>
      <Switch
        aria-label={`启用 ${row.name}`}
        checked={row.enabled}
        onCheckedChange={checked => props.onToggle(row.name, checked)}
      />
    </div>
  )
}

/** One package's card: rows of the same package collapse under one master
 * toggle that flips every member together. */
function PluginGroupCard(props: {
  pkg: string
  members: readonly PluginRow[]
  onToggle: (name: string, enabled: boolean) => void
  needsRestart?: ((name: string) => boolean) | undefined
  onUninstall?: ((pkg: string) => void) | undefined
}): ReactNode {
  const allOn = props.members.every(row => row.enabled)
  const setAll = (enabled: boolean): void => {
    for (const row of props.members) {
      if (row.enabled !== enabled) props.onToggle(row.name, enabled)
    }
  }
  return (
    <Collapsible data-plugin-group={props.pkg} className="rounded-md border border-border">
      <div className="flex items-center justify-between px-4 py-3">
        <CollapsibleTrigger className="flex min-w-0 items-center gap-2 py-2 text-left">
          <CollapsibleChevron />
          <span className="truncate font-mono text-sm">{props.pkg}</span>
          <span className="whitespace-nowrap text-sm text-muted-foreground">{props.members.length} 个条目</span>
        </CollapsibleTrigger>
        <div className="flex items-center gap-2">
          {props.onUninstall !== undefined && props.members.some(row => row.source === 'pool') && (
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => props.onUninstall?.(props.pkg)}>
              卸载
            </Button>
          )}
          <Switch aria-label={`启用 ${props.pkg}`} checked={allOn} onCheckedChange={setAll} />
        </div>
      </div>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 border-t border-border p-3">
          {props.members.map(row => (
            <PluginRowView key={row.name} row={row} onToggle={props.onToggle} needsRestart={props.needsRestart?.(row.name)} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** One suite card: radio semantics — 激活 is selecting, not switching. */
function SuiteCard(props: {
  pkg: string
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
        <span className="truncate font-mono text-sm">{props.pkg}</span>
        {props.needsRestart && <Badge variant="destructive">待重启</Badge>}
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

  const link = ctx.client.link

  const reload = (): void => {
    void link.call('plugins.list', {}).then(result => {
      if (result.ok) {
        setRows(result.value.plugins.map(info => ({
          name: info.name, source: info.source, enabled: info.enabled,
          packageName: info.packageName, ...info.kind !== undefined ? { kind: info.kind } : {},
        })))
      } else setFailed(true)
    }).catch(() => setFailed(true))
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

  /** Suite activation flips every member row of the package on (the host's
   * exclusivity turns the other suites off in the same write). */
  const activateSuite = (pkg: string): void => {
    for (const row of rows) {
      if (row.packageName === pkg && !row.enabled) toggle(row.name, true)
    }
    setRestartPrompt(true)
  }

  const uninstall = (pkg: string): void => {
    void link.call('plugins.uninstall', { name: pkg }).then(() => reload())
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

  const runInstall = (zipPath: string, hasClient: boolean): void => {
    setInstall({ phase: 'installing' })
    void link.call('plugins.install', { zipPath }).then(result => {
      if (!result.ok) {
        setInstall({ phase: 'error', message: rpcErrorText(result.error) })
        return
      }
      setInstall({ phase: 'idle' })
      reload()
      // The renderer mounts pool client faces at page boot only, so an
      // install carrying one lands after a restart — same semantics as
      // flipping a renderer row, with the same prompt.
      if (hasClient) {
        setTouched(current => new Set([...current, result.value.installed.name]))
        setRestartPrompt(true)
      }
    }).catch(cause => setInstall({ phase: 'error', message: String(cause) }))
  }

  const relaunch = (): void => {
    void link.call('window.relaunch', {}).catch(() => undefined)
  }

  if (failed) return <div className="text-sm text-muted-foreground">插件列表读取失败。</div>

  const needsRestart = (name: string): boolean => touched.has(name)
  const groups = new Map<string, PluginRow[]>()
  for (const row of rows) {
    const members = groups.get(row.packageName)
    if (members === undefined) groups.set(row.packageName, [row])
    else members.push(row)
  }
  const isPool = (pkg: string): boolean => groups.get(pkg)?.some(row => row.source === 'pool') === true

  const suites = [...groups.entries()].filter(([, members]) => members.some(row => row.kind === 'suite'))
  const drivers = [...groups.entries()].filter(([, members]) => members.some(row => row.kind === 'driver'))
  const rest = [...groups.entries()].filter(([pkg]) => !suites.some(([id]) => id === pkg) && !drivers.some(([id]) => id === pkg))

  const renderGroups = (entries: Array<[string, PluginRow[]]>): ReactNode =>
    entries.map(([pkg, members]) =>
      members.length === 1
        ? <PluginRowView key={members[0]!.name} row={members[0]!} onToggle={toggle} needsRestart={needsRestart(members[0]!.name)} />
        : (
            <PluginGroupCard
              key={pkg}
              pkg={pkg}
              members={members}
              onToggle={toggle}
              needsRestart={needsRestart}
              onUninstall={isPool(pkg) ? uninstall : undefined}
            />
          ))

  return (
    <div data-region="plugins-table" className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          通讯驱动的启停当场生效；业务套件与页面类插件需重启生效。启用状态与配置同源（文件即接口）。
        </p>
        <Button data-install-plugin onClick={pickZip}>安装插件</Button>
      </div>

      <section data-plugins-section="suite" className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">业务套件</h3>
        {suites.length === 0
          ? <div className="rounded-md border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">尚未安装业务套件</div>
          : suites.map(([pkg, members]) => (
              <SuiteCard
                key={pkg}
                pkg={pkg}
                active={members.some(row => row.enabled)}
                needsRestart={members.some(row => needsRestart(row.name))}
                onActivate={() => activateSuite(pkg)}
                onUninstall={isPool(pkg) ? uninstall : undefined}
              />
            ))}
      </section>

      <section data-plugins-section="driver" className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">通讯驱动</h3>
        {drivers.length === 0
          ? <div className="rounded-md border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">尚未安装通讯驱动</div>
          : renderGroups(drivers)}
      </section>

      <section data-plugins-section="core" className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">核心与其他</h3>
        {renderGroups(rest)}
      </section>

      {restartPrompt && (
        <Dialog open onOpenChange={next => { if (!next) setRestartPrompt(false) }}>
          <DialogContent aria-describedby={undefined} className="max-w-sm">
            <DialogTitle className="text-base font-medium">变更待重启生效</DialogTitle>
            <p className="text-sm text-muted-foreground">业务套件与页面类插件的启用变更、以及新安装的页面类插件，将在下次启动时生效。</p>
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
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">包名</span><span className="truncate font-mono">{install.plugin.name}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">版本</span><span className="font-mono">{install.plugin.version}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">类型</span><span>{KIND_LABELS[install.plugin.kind ?? 'plugin'] ?? install.plugin.kind ?? '插件'}</span></div>
              {install.plugin.hasClient && <div className="flex justify-between gap-4"><span className="text-muted-foreground">界面</span><span>含页面</span></div>}
              <div className="flex justify-between gap-4"><span className="text-muted-foreground">权限</span><span>{install.plugin.permissions.length === 0 ? '无' : install.plugin.permissions.join('、')}</span></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setInstall({ phase: 'idle' })}>取消</Button>
              <Button data-confirm-install onClick={() => runInstall(install.zipPath, install.plugin.hasClient)}>安装</Button>
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
    </div>
  )
}
