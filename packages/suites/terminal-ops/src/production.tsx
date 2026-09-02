/**
 * Workflow page: 生产任务 — pick a model, start, and watch the counters.
 * The theoretical total derives from the audit event stream (rate × net
 * running time, pauses unioned from fault + downtime events). The actual
 * shift production is a pure projection of this package's host-side counter
 * (`./stats`): it counts the bound output point into three 8-hour shift
 * buckets (snap-rail.db, anchored at login time — only a re-login re-picks
 * the shift) and broadcasts the `production/stats-changed` frame this page
 * renders, so page switches never lose a count.
 *
 * The counting variable's (device, group, name) address is the counting
 * binding: persisted in settings.json (`production.countBinding`) and picked
 * on this plugin's 产量采集 settings page — every write hot-applies
 * (redeclares the variable and re-aims the host counter) through the
 * `settings/changed` frame, no restart. Starting production records
 * `production.start`, which unlocks the sampling workflow.
 *
 * @module @snap-rail/suite-terminal-ops/production
 */

// Wire rows for the station-domain methods this resident calls.
import '@snap-rail/station-rpc/contract'
import { Context, type Plugin } from '@snap-rail/cordis'
import { z } from 'zod'
import { useEffect, useState, type ReactNode } from 'react'
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle, DragScroll, Label, TouchSelect, cn,
} from '@snap-rail/client-ui'
import { rpcErrorText, subscribeFrame } from '@snap-rail/connection'
import { pointKey, type PointDescriptor } from '@snap-rail/field'
import { settingsChangedSchema } from '@snap-rail/station-rpc/contract'
import {
  COUNT_BINDING_KEY,
  DEFAULT_COUNT_BINDING,
  SHIFT_WINDOWS,
  countBindingSchema,
  localDateString,
  productionStatsSnapshotSchema,
  type CountBinding,
  type ProductionStatsSnapshot,
  type ShiftName,
} from './production-contract.ts'
import { MAINTENANCE_COMPLETE } from './maintenance.tsx'
import {
  deriveState,
  theoryPerHour,
  theoryTotal,
  type ModelInfo,
  type ProductionEvent,
  type ProductionState,
} from './production-theory.ts'
import '@snap-rail/client-slots'
import '@snap-rail/client-runtime'
import '@snap-rail/client-session'
import '@snap-rail/client-settings'
import '@snap-rail/client-variables'
import '@snap-rail/client-workflows'

/** Audit action: production started with a model (unlocks sampling for today). */
export const PRODUCTION_START = 'production.start'

/** Audit action: production stopped. */
export const PRODUCTION_STOP = 'production.stop'

/** Every action this page derives its state from. */
const STATE_ACTIONS: readonly string[] = [
  PRODUCTION_START,
  PRODUCTION_STOP,
  'fault.report',
  'fault.repair-complete',
  'downtime.begin',
  'downtime.resume',
]

const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ratePerHour: z.number().positive(),
})

/** Config schema: the model table from plugins.yml; the counting binding
 * lives in settings.json (see {@link COUNT_BINDING_KEY}) and hot-applies. */
export const productionConfigSchema = z.object({
  models: z.array(modelSchema).min(1).default([
    { id: 'SR-100', name: 'SR-100', ratePerHour: 1200 },
    { id: 'SR-200', name: 'SR-200', ratePerHour: 900 },
    { id: 'SR-300', name: 'SR-300', ratePerHour: 600 },
  ]),
})

export type ProductionConfig = z.infer<typeof productionConfigSchema>

// The counting binding contract is shared with this package's host-side
// counter (`./stats`) and re-exported here for consumers of the page's
// public surface.
export { COUNT_BINDING_KEY, DEFAULT_COUNT_BINDING, countBindingSchema } from './production-contract.ts'
export type { CountBinding } from './production-contract.ts'

declare module '@snap-rail/cordis' {
  interface Events {
    /** The counting binding changed (a settings.json write); the host
     * counter re-seeds from the newly bound point's next sample.
     * @param binding - the now-current counting point address. */
    'production/binding-changed'(binding: CountBinding): void
    /** A fresh production-stats snapshot arrived (the host plugin's
     * `production/stats-changed` frame, zod-validated on receipt).
     * @param snapshot - the validated frame payload. */
    'production/stats-changed'(snapshot: ProductionStatsSnapshot): void
  }
}

/** The declared counting variable for one binding address. */
function countVariableOf(binding: CountBinding): { device: string, group: string, name: string, type: 'int', title: string } {
  return {
    device: binding.device,
    group: binding.group,
    name: binding.name,
    type: 'int',
    title: '实际产量计数',
  }
}

function eventOf(entry: { action: string, actor: string, time: number, detail?: unknown }): ProductionEvent {
  return { action: entry.action, actor: entry.actor, time: entry.time, ...entry.detail !== undefined ? { detail: entry.detail } : {} }
}

/** Hour-aligned buckets, oldest first, ending at `now`'s hour. */
function hourLabels(now: number): string[] {
  const hour = 3_600_000
  const currentHourStart = new Date(now).setMinutes(0, 0, 0)
  return Array.from({ length: 24 }, (_, index) => {
    const start = currentHourStart - (23 - index) * hour
    return `${String(new Date(start).getHours()).padStart(2, '0')}:00`
  })
}

/** Human shift label. */
const SHIFT_LABEL: Record<ShiftName, string> = { morning: '早班', middle: '中班', night: '晚班' }

/** The shift's display window, e.g. `08:00–16:00`. */
function windowText(shift: ShiftName): string {
  const { startHour, endHour } = SHIFT_WINDOWS[shift]
  return `${String(startHour).padStart(2, '0')}:00–${String(endHour).padStart(2, '0')}`
}

/** `HH:mm` of an epoch-ms timestamp. */
function clockText(epochMs: number): string {
  const date = new Date(epochMs)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function Chart(props: { theory: number[], actual: number[], labels: string[] }): ReactNode {
  const { theory, actual, labels } = props
  const max = Math.max(1, ...theory, ...actual)
  return (
    <div>
      <div className="flex h-56 items-end gap-1" data-chart="hourly">
        {labels.map((label, index) => (
          <div key={label} className="flex h-full flex-1 items-end justify-center gap-0.5" title={`${label} 实际 ${Math.floor(actual[index] ?? 0)} / 理论 ${Math.floor(theory[index] ?? 0)}`}>
            <div
              className="glow-bar w-full max-w-4 rounded-t bg-chart-1"
              style={{ height: `${((actual[index] ?? 0) / max) * 100}%` }}
              aria-label={`${label} 实际产量`}
            />
            <div
              className="w-full max-w-4 rounded-t border border-dashed border-chart-2 border-b-0"
              style={{ height: `${((theory[index] ?? 0) / max) * 100}%` }}
              aria-label={`${label} 理论产量`}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1 text-xs text-muted-foreground">
        {labels.map((label, index) => (
          <div key={label} className="flex-1 text-center">{index % 4 === 0 ? label : ''}</div>
        ))}
      </div>
      <div className="mt-3 flex gap-4 text-sm text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-t bg-chart-1" />实际产量</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-t border border-dashed border-chart-2 border-b-0" />理论产量</span>
      </div>
    </div>
  )
}

function ProductionPage(props: { ctx: Context, config: ProductionConfig, stats: ProductionStatsSnapshot | null }): ReactNode {
  const { ctx, config } = props
  const [now, setNow] = useState(() => Date.now())
  const [events, setEvents] = useState<readonly ProductionEvent[]>([])
  const [selected, setSelected] = useState<ModelInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The live stats projection; seeded from the plugin closure (frames kept
   * arriving while this page was unmounted) and refreshed by every
   * `production/stats-changed` frame. */
  const [stats, setStats] = useState<ProductionStatsSnapshot | null>(props.stats)

  useEffect(() => {
    const detach = ctx.on('production/stats-changed', next => { setStats(next) })
    return () => { detach() }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ctx is stable
  }, [])

  const refresh = (): void => {
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    void ctx.client.link.call('audit.list', { actions: STATE_ACTIONS, since: midnight.getTime() }).then(result => {
      if (result.ok) setEvents(result.value.entries.map(eventOf))
    })
  }

  // Derive from the audit stream on mount; poll so fault/downtime pauses
  // recorded by other pages reach the theoretical counter quickly.
  useEffect(() => {
    refresh()
    const slow = window.setInterval(refresh, 5000)
    return () => { window.clearInterval(slow) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ctx and setters are stable
  }, [])

  // Wall clock for the live theoretical counter.
  useEffect(() => {
    const tick = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(tick) }
  }, [])

  const state: ProductionState = deriveState(events, config.models)
  const running = state.session !== null
  const theory = theoryTotal(events, state, now)
  const theoryBuckets = theoryPerHour(events, state, now)
  const anchor = stats?.anchor ?? null
  const actualBuckets = Array.from({ length: 24 }, (_, index) => {
    const hourStart = new Date(now).setMinutes(0, 0, 0) - (23 - index) * 3_600_000
    return stats?.hours.find(bucket => bucket.hourStart === hourStart)?.count ?? 0
  })
  const todayShiftCount = (shift: ShiftName): number => {
    const today = localDateString(now)
    const row = stats?.shifts.find(entry => entry.date === today && entry.shift === shift)
    return row === undefined ? 0 : Math.floor(row.count)
  }

  const act = (action: 'production.start' | 'production.stop', detail?: unknown): void => {
    setBusy(true)
    setError(null)
    void ctx.client.link.call('audit.record', { action, detail })
      .then(result => {
        if (!result.ok) throw new Error(`操作失败（${result.error.code}）`)
        if (action === PRODUCTION_START) ctx.workflows.announce(PRODUCTION_START)
        refresh()
      })
      .catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { setBusy(false) })
  }

  return (
    <DragScroll className="h-full p-6" data-page="production">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-1">
          <CardHeader><CardTitle>生产任务</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {anchor !== null
              ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm" data-region="shift">
                    <Badge variant="secondary" data-shift={anchor.shift}>
                      {SHIFT_LABEL[anchor.shift]} {windowText(anchor.shift)}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      {anchor.operator} {clockText(anchor.loginAt)} 登录，重新登录后更新班次
                    </span>
                  </div>
                )
              : <div className="text-sm text-muted-foreground" data-region="shift">班次在登录后确定。</div>}
            <div className="space-y-1">
              <div className="text-sm text-muted-foreground">本班实际产量</div>
              <div className="flex items-baseline gap-2.5">
                <span className="glow-number font-mono text-5xl font-semibold tabular-nums" data-value="actual">
                  {anchor === null ? '—' : Math.floor(anchor.count)}
                </span>
                <span className="text-sm text-muted-foreground">件</span>
              </div>
            </div>
            {running && state.session !== null
              ? (
                  <>
                    <div className="flex items-center gap-2 text-base">
                      <Badge variant="success">运行中</Badge>
                      <span>{state.session.model.name}</span>
                    </div>
                    {state.faultActive && <div className="text-sm text-destructive">故障处理中：理论计数暂停。</div>}
                    {state.downtimeActive && <div className="text-sm text-warning">停机休息中：理论计数暂停。</div>}
                    <div className="space-y-1">
                      <div className="text-sm text-muted-foreground">理论当前总产量</div>
                      <div className="glow-number font-mono text-4xl font-semibold tabular-nums" data-value="theory">{Math.floor(theory)}</div>
                    </div>
                    <Button variant="destructive" size="lg" className="w-full" disabled={busy} onClick={() => act(PRODUCTION_STOP)}>
                      {busy ? '处理中…' : '停止生产'}
                    </Button>
                  </>
                )
              : (
                  <>
                    <div className="text-sm text-muted-foreground">选择要生产的产品型号</div>
                    <div className="space-y-2">
                      {config.models.map(model => (
                        <button
                          key={model.id}
                          type="button"
                          className={cn(
                            'flex h-14 w-full items-center justify-between rounded-md border border-border px-4 text-left text-base transition-colors',
                            selected?.id === model.id ? 'channel-keyline border-primary bg-primary/10 font-medium' : 'hover:bg-accent',
                          )}
                          onClick={() => { setSelected(model) }}
                        >
                          <span>{model.name}</span>
                          <span className="text-sm text-muted-foreground">{model.ratePerHour} 件/时</span>
                        </button>
                      ))}
                    </div>
                    <Button
                      size="lg"
                      className="w-full"
                      disabled={selected === null || busy}
                      onClick={() => { if (selected !== null) act(PRODUCTION_START, { model: selected.id }) }}
                    >
                      {busy ? '处理中…' : '开始生产'}
                    </Button>
                  </>
                )}
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3 text-sm text-muted-foreground" data-region="shifts-today">
              <span>今日班产</span>
              {(['morning', 'middle', 'night'] as const).map(shift => (
                <span key={shift} data-shift-count={shift}>
                  {SHIFT_LABEL[shift]} <span className="font-mono tabular-nums">{todayShiftCount(shift)}</span>
                </span>
              ))}
            </div>
            {error !== null && <div className="text-sm text-destructive" role="alert">{error}</div>}
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader><CardTitle>每小时产量（近 24 小时）</CardTitle></CardHeader>
          <CardContent>
            <Chart theory={theoryBuckets} actual={actualBuckets} labels={hourLabels(now)} />
          </CardContent>
        </Card>
      </div>
    </DragScroll>
  )
}

/** Human label for a point's semantic type. */
const POINT_TYPE_LABEL: Record<string, string> = { bool: '开关', int: '整数', float: '小数', string: '文本' }

/** The 产量采集 settings page: pick the counting point from the live point
 * table (设备 → 组 → 点位 cascades over `points.list`); 保存 writes
 * settings.json and the `settings/changed` frame hot-applies the rebind —
 * no restart, no remount. */
function CountingPage(props: { ctx: Context, binding: CountBinding }): ReactNode {
  const { ctx } = props
  const [points, setPoints] = useState<readonly PointDescriptor[] | null>(null)
  const [binding, setBinding] = useState<CountBinding>(props.binding)
  const [device, setDevice] = useState(props.binding.device)
  const [group, setGroup] = useState(props.binding.group)
  const [name, setName] = useState(props.binding.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const detach = ctx.on('production/binding-changed', next => { setBinding(next) })
    return () => { detach() }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ctx is stable
  }, [])

  // The picker's option space is the live point table; the structural
  // frames keep it fresh, so mappings added in the ModbusTCP page appear
  // without reopening this dialog.
  useEffect(() => {
    const reload = (): void => {
      void ctx.client.link.call('field.points.list', {})
        .then(result => { if (result.ok) setPoints(result.value.points) })
        .catch(() => {})
    }
    reload()
    const detachAdded = ctx.client.link.subscribe('field/point-added', reload)
    const detachRemoved = ctx.client.link.subscribe('field/point-removed', reload)
    return () => { detachAdded(); detachRemoved() }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ctx is stable
  }, [])

  const rows = points ?? []
  // Cascading options; the current selection rides along even when the
  // point table lacks it, so an unmapped binding stays visible instead of
  // silently snapping to the first option.
  const devices = [...new Set(rows.map(point => point.device))].sort()
  if (!devices.includes(device)) devices.push(device)
  const groups = [...new Set(rows.filter(point => point.device === device).map(point => point.group))].sort()
  if (!groups.includes(group)) groups.push(group)
  const candidates: { name: string, type: string | undefined }[] =
    rows.filter(point => point.device === device && point.group === group).map(point => ({ name: point.name, type: point.type }))
  if (!candidates.some(candidate => candidate.name === name)) candidates.push({ name, type: undefined })

  const mapped = points !== null && rows.some(point =>
    point.device === binding.device && point.group === binding.group && point.name === binding.name)
  const selectedType = candidates.find(candidate => candidate.name === name)?.type

  const pickDevice = (next: string): void => {
    setDevice(next)
    setSaved(false)
    const nextGroups = [...new Set(rows.filter(point => point.device === next).map(point => point.group))].sort()
    const nextGroup = nextGroups[0] ?? ''
    setGroup(nextGroup)
    setName(rows.find(point => point.device === next && point.group === nextGroup)?.name ?? '')
  }
  const pickGroup = (next: string): void => {
    setGroup(next)
    setSaved(false)
    setName(rows.find(point => point.device === device && point.group === next)?.name ?? '')
  }

  const save = (): void => {
    setBusy(true)
    setError(null)
    void ctx.client.link.call('settings.set', {
      key: COUNT_BINDING_KEY,
      value: { device, group, name },
    })
      .then(result => {
        if (!result.ok) throw new Error(rpcErrorText(result.error))
        setSaved(true)
      })
      .catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { setBusy(false) })
  }

  if (points === null) {
    return <div className="text-sm text-muted-foreground" data-region="production-count-page">点位表读取中…</div>
  }

  return (
    <div className="flex flex-col gap-4" data-region="production-count-page">
      <Card>
        <CardHeader><CardTitle>产量自动采集</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">实际产量跟随所选点位的正增量累计；保存后立即生效，无需重启。</p>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5" data-region="count-devices">
              <Label>设备</Label>
              <TouchSelect
                label="绑定设备"
                value={device}
                options={devices.map(option => ({ value: option, label: option }))}
                onValueChange={pickDevice}
              />
            </div>
            <div className="space-y-1.5" data-region="count-groups">
              <Label>组</Label>
              <TouchSelect
                label="绑定分组"
                value={group}
                options={groups.map(option => ({ value: option, label: option }))}
                onValueChange={pickGroup}
              />
            </div>
            <div className="space-y-1.5" data-region="count-points">
              <Label>点位</Label>
              <TouchSelect
                label="绑定点位"
                value={name}
                options={candidates.map(option => ({
                  value: option.name,
                  label: option.name,
                  triggerLabel: option.name,
                  ...(option.type !== undefined && {
                    hint: <Badge variant={option.type === 'int' ? 'default' : option.type === 'float' ? 'warning' : 'success'}>
                      {POINT_TYPE_LABEL[option.type] ?? option.type}
                    </Badge>,
                  }),
                }))}
                onValueChange={next => { setName(next); setSaved(false) }}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-cell="current-binding">
            <span>当前绑定：{binding.device} / {binding.group} / {binding.name}</span>
            {mapped ? <Badge variant="success">已映射</Badge> : <Badge variant="warning">未映射</Badge>}
            {!mapped && <span>未映射到任何驱动点位时，实际产量恒为 0。</span>}
            {selectedType !== undefined && selectedType !== 'int' && (
              <span className="text-warning">所选点位是{POINT_TYPE_LABEL[selectedType] ?? selectedType}；计数只累计数值增量。</span>
            )}
          </div>
          {error !== null && <div className="text-sm text-destructive" role="alert">{error}</div>}
          {saved && <div className="text-sm text-muted-foreground" data-cell="saved">已保存，已生效。</div>}
          <div className="flex justify-end">
            <Button size="lg" disabled={busy || device === '' || group === '' || name === ''} onClick={save}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/** The production workflow occupant; the model table arrives from its
 * plugins.yml row, the counting binding from settings.json (hot-applied). */
const productionPlugin: Plugin.Object<ProductionConfig> = {
  name: 'process-production',
  inject: ['uiSlots', 'client', 'session', 'workflows', 'variables', 'settingsPages'],
  Config: productionConfigSchema,
  apply(ctx: Context, config: ProductionConfig): void {
    const resolved = config
    // The counting binding: the default until settings.json says otherwise,
    // then hot-swapped on every settings/changed frame for this key. The
    // state lives in this apply-scope closure; rebinding redeclares the
    // counting variable at the new address, and the counter re-seeds from
    // the new point's first sample.
    let binding: CountBinding = DEFAULT_COUNT_BINDING
    let unregister = ctx.variables.register(ctx, [countVariableOf(binding)])
    const rebind = (next: CountBinding): void => {
      if (pointKey(next) === pointKey(binding)) return
      unregister()
      binding = next
      unregister = ctx.variables.register(ctx, [countVariableOf(next)])
      ctx.emit('production/binding-changed', next)
    }
    const adopt = (value: unknown): void => {
      const parsed = countBindingSchema.safeParse(value)
      if (parsed.success) rebind(parsed.data)
    }
    void ctx.client.link.call('settings.get', { key: COUNT_BINDING_KEY })
      .then(result => { if (result.ok) adopt(result.value.value) })
      .catch(() => {})
    ctx.effect(() => subscribeFrame(ctx.client.link, 'settings/changed', settingsChangedSchema, change => {
      if (change.key === COUNT_BINDING_KEY) adopt(change.value)
    }))
    // The stats projection: the latest snapshot rides this closure (pages
    // unmount freely — the count itself lives host-side) and re-emits as a
    // local event for whatever surface is mounted. The frame is push-only,
    // so the host broadcasts the full snapshot every flush tick; a payload
    // that fails the contract is dropped rather than half-applied.
    let stats: ProductionStatsSnapshot | null = null
    ctx.effect(() => subscribeFrame(ctx.client.link, 'production/stats-changed', productionStatsSnapshotSchema, snapshot => {
      stats = snapshot
      ctx.emit('production/stats-changed', snapshot)
    }))
    ctx.workflows.register(ctx, {
      id: 'production',
      title: '生产任务',
      order: 20,
      requires: [{ action: MAINTENANCE_COMPLETE, scope: 'operator-day' }],
      render(): ReactNode {
        return <ProductionPage ctx={ctx} config={resolved} stats={stats} />
      },
    })
    ctx.settingsPages.register(ctx, {
      id: 'production',
      title: '产量采集',
      order: 20,
      render(): ReactNode {
        return <CountingPage ctx={ctx} binding={binding} />
      },
    })
  },
}

export default productionPlugin
