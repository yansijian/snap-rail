/**
 * Resident plugin management panel: occupies the `sidebar` slot with the
 * merged layer view (mounted entries plus pool extras) and an enable/disable
 * toggle per row. Every toggle is a `plugins.setEnabled` wire call that
 * lands in `plugins.yml` and hot-applies — the file stays the interface.
 *
 * @module @snap-rail/manage-plugins
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import type { HostLink } from '@snap-rail/connection'
import type { PluginInfo } from '@snap-rail/protocol'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@snap-rail/client-ui'
import '@snap-rail/client-slots'
import '@snap-rail/client-runtime'

const sourceLabels: Record<PluginInfo['source'], string> = {
  builtin: '内置',
  user: '用户',
  pool: '池',
}

function PluginsPanel(props: { link: HostLink }): ReactNode {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick(value => value + 1), [])
  useEffect(() => {
    let alive = true
    void props.link.call('plugins.list', {}).then(result => {
      if (!alive) return
      if (result.ok) setPlugins([...result.value.plugins])
      else setError(`加载失败（${result.error.code}）`)
    })
    return () => { alive = false }
  }, [props.link, tick])

  const onToggle = (name: string, next: boolean): void => {
    void props.link.call('plugins.setEnabled', { name, enabled: next }).then(result => {
      if (!result.ok) setError(`操作失败（${result.error.code}）`)
      else refresh()
    })
  }

  return (
    <Card className="m-3 gap-0" data-panel="plugins">
      <CardHeader><CardTitle>插件</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-1">
        {error !== undefined && <div className="text-xs text-destructive">{error}</div>}
        {plugins.map(plugin => (
          <div key={plugin.name} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-xs">
              <Badge variant={plugin.enabled ? 'success' : 'secondary'}>
                {plugin.enabled ? '启用' : '停用'}
              </Badge>
              <span className="truncate font-mono">{plugin.name}</span>
              <span className="shrink-0 text-muted-foreground">[{sourceLabels[plugin.source]}]</span>
            </span>
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => onToggle(plugin.name, !plugin.enabled)}>
              {plugin.enabled ? '禁用' : '启用'}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

/** The plugin management occupant. */
const managePluginsPlugin: Plugin.Object<void> = {
  name: 'manage-plugins',
  inject: ['uiSlots', 'client'],
  apply(ctx: Context): void {
    ctx.uiSlots.register(ctx, 'sidebar', {
      id: 'manage-plugins',
      order: 10,
      render(): ReactNode {
        return <PluginsPanel link={ctx.client.link} />
      },
    })
  },
}

export default managePluginsPlugin
