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
import '@snap-rail/client-slots'
import '@snap-rail/client-runtime'

const sourceLabels: Record<PluginInfo['source'], string> = {
  builtin: '内置',
  user: '用户',
  pool: '池',
}

const rowStyle = {
  alignItems: 'center',
  display: 'flex',
  gap: 6,
  justifyContent: 'space-between',
  padding: '4px 0',
} as const

const toggleStyle = {
  background: 'transparent',
  border: '1px solid var(--sr-border)',
  borderRadius: 'var(--sr-radius)',
  color: 'var(--sr-text)',
  cursor: 'pointer',
  fontSize: 11,
  padding: '1px 8px',
} as const

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
    <section data-panel="plugins" style={{ padding: 'var(--sr-space)' }}>
      <h3 style={{ fontSize: 12, margin: '0 0 6px', color: 'var(--sr-text-dim)' }}>插件</h3>
      {error !== undefined && <div style={{ color: 'var(--sr-bad)', fontSize: 12 }}>{error}</div>}
      {plugins.map(plugin => (
        <div key={plugin.name} style={rowStyle}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ color: plugin.enabled ? 'var(--sr-ok)' : 'var(--sr-text-dim)', marginRight: 4 }}>
              {plugin.enabled ? '●' : '○'}
            </span>
            {plugin.name}
            <span style={{ color: 'var(--sr-text-dim)', fontSize: 11, marginLeft: 4 }}>
              [{sourceLabels[plugin.source]}]
            </span>
          </span>
          <button type="button" style={toggleStyle} onClick={() => onToggle(plugin.name, !plugin.enabled)}>
            {plugin.enabled ? '禁用' : '启用'}
          </button>
        </div>
      ))}
    </section>
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
