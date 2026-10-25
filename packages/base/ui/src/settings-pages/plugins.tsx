/**
 * The built-in 插件管理 settings page: a category-grouped, flat list of
 * installable pool plugins. Rows are one package each; enabling/disabling
 * writes the same `plugins.yml` the file interface uses and asks for a restart
 * because renderer rows only re-mount at boot.
 *
 * @module @snap-rail/ui/settings-pages/plugins
 */

import type { Context } from '@snap-rail/cordis'
import type { PluginInfo } from '@snap-rail/app-boot/contract'
import '@snap-rail/app-boot/contract'
import { rpcErrorText } from '@snap-rail/connection'
import { useEffect, useState, type ReactNode } from 'react'
import { Badge, Button, EmptyState, Page, Section, Stack, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/index.ts'

/** Human labels for the package kinds. */
const KIND_LABELS: Record<string, string> = {
  skin: '界面风格',
  driver: '通讯驱动',
  suite: '业务套件',
  plugin: '插件',
}

const PROFILE_LABELS: Record<string, string> = {
  native: '皮肤原生',
  integrated: '图表桥接',
  custom: '自定义界面',
}

/** One page row: a package, not an individual subpath entry. */
interface PackageRow {
  packageName: string
  title: string
  category: string
  kind: string
  version?: string
  enabled: boolean
  source: PluginInfo['source']
  builtinDefault: boolean
  clientOnly: boolean
  uiProfile?: string
}

/** Collapse entry rows into package rows (one master switch per package). */
function packageRows(plugins: readonly PluginInfo[]): PackageRow[] {
  const byPackage = new Map<string, PackageRow>()
  for (const plugin of plugins) {
    if (plugin.source === 'builtin') continue
    const existing = byPackage.get(plugin.packageName)
    if (existing !== undefined) {
      existing.enabled = existing.enabled || plugin.enabled
      continue
    }
    byPackage.set(plugin.packageName, {
      packageName: plugin.packageName,
      title: plugin.title ?? plugin.packageName,
      category: plugin.category ?? '其他',
      kind: plugin.kind ?? 'plugin',
      ...plugin.version !== undefined ? { version: plugin.version } : {},
      enabled: plugin.enabled,
      source: plugin.source,
      builtinDefault: plugin.source === 'builtin-default',
      clientOnly: plugin.clientOnly === true,
      ...(plugin.uiProfile !== undefined ? { uiProfile: plugin.uiProfile } : {}),
    })
  }
  return [...byPackage.values()].sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title))
}

/** The plugin management page. */
export function PluginsPage({ ctx }: { ctx: Context }): ReactNode {
  const [rows, setRows] = useState<readonly PackageRow[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())

  const load = (): void => {
    setError(undefined)
    void ctx.client.link.call('plugins.list', {}).then(result => {
      if (!result.ok) {
        setError(rpcErrorText(result.error))
        return
      }
      setRows(packageRows(result.value.plugins))
    }).catch(cause => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  useEffect(load, [])

  const toggle = (row: PackageRow, enabled: boolean): void => {
    setBusy(row.packageName)
    void ctx.client.link.call('plugins.set-enabled', { name: row.packageName, enabled })
      .then(result => {
        if (!result.ok) {
          setError(rpcErrorText(result.error))
          return
        }
        setRows(current => current.map(item => item.packageName === row.packageName ? { ...item, enabled } : item))
        setTouched(current => new Set(current).add(row.packageName))
      })
      .catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { setBusy(undefined) })
  }

  const uninstall = (row: PackageRow): void => {
    if (!window.confirm(`卸载 ${row.title}？该包的数据也会一起删除。`)) return
    setBusy(row.packageName)
    void ctx.client.link.call('plugins.uninstall', { name: row.packageName })
      .then(result => {
        if (!result.ok) {
          setError(rpcErrorText(result.error))
          return
        }
        setTouched(current => new Set(current).add(row.packageName))
        load()
      })
      .catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { setBusy(undefined) })
  }

  const groups = new Map<string, PackageRow[]>()
  for (const row of rows) {
    const bucket = groups.get(row.category)
    if (bucket === undefined) groups.set(row.category, [row])
    else bucket.push(row)
  }

  return (
    <Page
      title="插件管理"
      description="安装驱动、业务页面和界面风格。启用/停用写入 plugins.yml，渲染端在下一次重启后生效。"
      actions={<Button intent="neutral" emphasis="outline" onClick={load}>刷新</Button>}
    >
      <Stack gap="lg">
        {error !== undefined && <div role="alert" style={{ color: 'var(--snap-color-danger)' }}>{error}</div>}
        {rows.length === 0
          ? <EmptyState title="还没有安装插件" description="把插件 zip 拖入插件安装入口，或从插件源搜索安装。" />
          : [...groups.entries()].map(([category, entries]) => (
              <Section key={category} title={category}>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>名称</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead>版本</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map(row => (
                      <TableRow key={row.packageName}>
                        <TableCell>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--snap-space-sm)' }}>
                              {row.title}
                              {row.builtinDefault && <Badge intent="neutral">内置默认</Badge>}
                            </span>
                            <span style={{ color: 'var(--snap-color-muted)', fontSize: 'var(--snap-text-xs)' }}>{row.packageName}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {KIND_LABELS[row.kind] ?? row.kind}
                          {row.uiProfile !== undefined && (
                            <Badge intent="neutral">{PROFILE_LABELS[row.uiProfile] ?? row.uiProfile}</Badge>
                          )}
                        </TableCell>
                        <TableCell>{row.version ?? '—'}</TableCell>
                        <TableCell>
                          {row.builtinDefault
                            ? <Badge intent="success">始终随底座</Badge>
                            : (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--snap-space-sm)' }}>
                                <Switch
                                  checked={row.enabled}
                                  disabled={busy === row.packageName}
                                  onCheckedChange={next => toggle(row, next)}
                                  aria-label={`启用 ${row.title}`}
                                />
                                {touched.has(row.packageName) && <Badge intent="warning">待重启</Badge>}
                              </div>
                            )}
                        </TableCell>
                        <TableCell>
                          {row.builtinDefault
                            ? <span style={{ color: 'var(--snap-color-muted)' }}>内置默认不可卸载</span>
                            : (
                              <Button
                                intent="danger"
                                emphasis="ghost"
                                size="sm"
                                disabled={busy === row.packageName}
                                onClick={() => uninstall(row)}
                              >
                                卸载
                              </Button>
                            )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Section>
            ))}
      </Stack>
    </Page>
  )
}