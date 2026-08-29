/**
 * Workflow page: 生产任务 — pick a model, start, and watch the counters.
 * The theoretical total derives from the audit event stream (rate × net
 * running time, pauses unioned from fault + downtime events); the actual
 * total follows the counting variable this plugin declares (默认 产量计数)
 * and accumulates its positive deltas — map the variable onto a device
 * address in the communication settings and the counter runs. Starting
 * production records `production.start`, which unlocks the sampling
 * workflow.
 *
 * @module @snap-rail/process-production
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import { z } from 'zod'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, cn } from '@snap-rail/client-ui'
import { MAINTENANCE_COMPLETE } from '@snap-rail/process-maintenance'
import { usePoint } from '@snap-rail/client-variables'
import {
  deriveState,
  theoryPerHour,
  theoryTotal,
  type ModelInfo,
  type ProductionEvent,
  type ProductionState,
} from './theory.ts'
import '@snap-rail/client-slots'
import '@snap-rail/client-runtime'
import '@snap-rail/client-session'
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

/** Config schema: the model table (and the counting variable name) from plugins.yml. */
export const productionConfigSchema = z.object({
  models: z.array(modelSchema).min(1).default([
    { id: 'SR-100', name: 'SR-100', ratePerHour: 1200 },
    { id: 'SR-200', name: 'SR-200', ratePerHour: 900 },
    { id: 'SR-300', name: 'SR-300', ratePerHour: 600 },
  ]),
  /** Name of the counting variable this plugin declares and follows; map it
   * onto a device address in the communication settings to run the counter. */
  countVar: z.string().min(1).default('产量计数'),
})

export type ProductionConfig = z.infer<typeof productionConfigSchema>

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

function Chart(props: { theory: number[], actual: number[], labels: string[] }): ReactNode {
  const { theory, actual, labels } = props
  const max = Math.max(1, ...theory, ...actual)
  return (
    <div>
      <div className="flex h-40 items-end gap-[3px]" data-chart="hourly">
        {labels.map((label, index) => (
          <div key={label} className="flex h-full flex-1 items-end justify-center gap-[2px]" title={`${label} 实际 ${Math.floor(actual[index] ?? 0)} / 理论 ${Math.floor(theory[index] ?? 0)}`}>
            <div
              className="w-full max-w-3 rounded-t bg-primary/80"
              style={{ height: `${((actual[index] ?? 0) / max) * 100}%` }}
              aria-label={`${label} 实际产量`}
            />
            <div
              className="w-full max-w-3 rounded-t border border-dashed border-muted-foreground/70"
              style={{ height: `${((theory[index] ?? 0) / max) * 100}%` }}
              aria-label={`${label} 理论产量`}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[3px] text-[10px] text-muted-foreground">
        {labels.map((label, index) => (
          <div key={label} className="flex-1 text-center">{index % 4 === 0 ? label : ''}</div>
        ))}
      </div>
      <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-t bg-primary/80" />实际产量</span>
        <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-t border border-dashed border-muted-foreground/70" />理论产量</span>
      </div>
    </div>
  )
}

function ProductionPage(props: { ctx: Context, config: ProductionConfig }): ReactNode {
  const { ctx, config } = props
  const [now, setNow] = useState(() => Date.now())
  const [events, setEvents] = useState<readonly ProductionEvent[]>([])
  const [selected, setSelected] = useState<ModelInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Hour-bucketed actual counts (session-scoped; theory derives from audit). */
  const actualRef = useRef<{ lastSample: number | bigint | null, total: number, buckets: Map<number, number> }>({
    lastSample: null, total: 0, buckets: new Map(),
  })
  const [, forceCount] = useState(0)
  const countSample = usePoint(ctx, config.countVar)

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

  // Actual counting: follow the counting variable's live samples and
  // accumulate positive deltas into the total and the current hour bucket.
  // A counter reset (negative delta) is ignored; an abnormal (null) sample
  // re-seeds the baseline; unmapped variables never produce samples.
  useEffect(() => {
    const counter = actualRef.current
    const value = countSample?.value
    if (value === undefined || value === null) {
      counter.lastSample = null
      return
    }
    if (typeof value !== 'number' && typeof value !== 'bigint') return
    if (counter.lastSample !== null) {
      const delta = Number(value) - Number(counter.lastSample)
      if (delta > 0) {
        counter.total += delta
        const hourStart = new Date().setMinutes(0, 0, 0)
        counter.buckets.set(hourStart, (counter.buckets.get(hourStart) ?? 0) + delta)
        forceCount(current => current + 1)
      }
    }
    counter.lastSample = value
  }, [countSample])

  const state: ProductionState = deriveState(events, config.models)
  const running = state.session !== null
  const theory = theoryTotal(events, state, now)
  const theoryBuckets = theoryPerHour(events, state, now)
  const actualBuckets = Array.from({ length: 24 }, (_, index) => {
    const hourStart = new Date(now).setMinutes(0, 0, 0) - (23 - index) * 3_600_000
    return actualRef.current.buckets.get(hourStart) ?? 0
  })

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
    <div className="h-full overflow-y-auto p-4" data-page="production">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="xl:col-span-1">
          <CardHeader><CardTitle>生产任务</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {running && state.session !== null
              ? (
                  <>
                    <div className="flex items-center gap-2 text-sm">
                      <Badge variant="success">运行中</Badge>
                      <span>{state.session.model.name}</span>
                    </div>
                    {state.faultActive && <div className="text-xs text-destructive">故障处理中：理论计数暂停。</div>}
                    {state.downtimeActive && <div className="text-xs text-[#d29922]">停机休息中：理论计数暂停。</div>}
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground">实际当前总产量</div>
                      <div className="font-mono text-3xl tabular-nums" data-value="actual">{Math.floor(actualRef.current.total)}</div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground">理论当前总产量</div>
                      <div className="font-mono text-3xl tabular-nums text-primary" data-value="theory">{Math.floor(theory)}</div>
                    </div>
                    <Button variant="destructive" className="w-full" disabled={busy} onClick={() => act(PRODUCTION_STOP)}>
                      {busy ? '处理中…' : '停止生产'}
                    </Button>
                  </>
                )
              : (
                  <>
                    <div className="text-xs text-muted-foreground">选择要生产的产品型号</div>
                    <div className="space-y-2">
                      {config.models.map(model => (
                        <button
                          key={model.id}
                          type="button"
                          className={cn(
                            'flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-left text-sm transition-colors',
                            selected?.id === model.id ? 'border-primary bg-primary/10' : 'hover:bg-accent',
                          )}
                          onClick={() => { setSelected(model) }}
                        >
                          <span>{model.name}</span>
                          <span className="text-xs text-muted-foreground">{model.ratePerHour} 件/时</span>
                        </button>
                      ))}
                    </div>
                    <Button
                      className="w-full"
                      disabled={selected === null || busy}
                      onClick={() => { if (selected !== null) act(PRODUCTION_START, { model: selected.id }) }}
                    >
                      {busy ? '处理中…' : '开始生产'}
                    </Button>
                  </>
                )}
            {error !== null && <div className="text-xs text-destructive" role="alert">{error}</div>}
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader><CardTitle>每小时产量（近 24 小时）</CardTitle></CardHeader>
          <CardContent>
            <Chart theory={theoryBuckets} actual={actualBuckets} labels={hourLabels(now)} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

/** The production workflow occupant; config arrives from its plugins.yml row. */
const productionPlugin: Plugin.Object<ProductionConfig> = {
  name: 'process-production',
  inject: ['uiSlots', 'client', 'session', 'workflows', 'variables'],
  Config: productionConfigSchema,
  apply(ctx: Context, config: ProductionConfig): void {
    const resolved = config
    // The counting variable: declared here, mapped onto a device address in
    // the communication settings; positive deltas become actual output.
    ctx.variables.register(ctx, [{ name: resolved.countVar, type: 'int', title: '实际产量计数' }])
    ctx.workflows.register(ctx, {
      id: 'production',
      title: '生产任务',
      order: 20,
      requires: [{ action: MAINTENANCE_COMPLETE, scope: 'operator-day' }],
      render(): ReactNode {
        return <ProductionPage ctx={ctx} config={resolved} />
      },
    })
  },
}

export default productionPlugin
