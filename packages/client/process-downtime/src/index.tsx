/**
 * Workflow page: 停机休息 — pick one of the fixed downtime reasons and the
 * page collapses to a single 恢复生产 button; resuming records the end and
 * duration. While a downtime is open the sidebar entry breathes yellow at a
 * constant rate. State and alert live at plugin scope so a restart (or
 * another active page) keeps the effect and the history honest.
 *
 * @module @snap-rail/process-downtime
 */

import { Context, type Plugin } from '@snap-rail/cordis'
// Side-effect: pulls in the timer augmentation (`ctx.interval`).
import '@snap-rail/cordis-plugin-timer'
import { useEffect, useState, type ReactNode } from 'react'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@snap-rail/client-ui'
import '@snap-rail/client-slots'
import '@snap-rail/client-runtime'
import '@snap-rail/client-session'
import '@snap-rail/client-workflows'

/** Audit action: a downtime began (detail: reason; opens a production pause). */
export const DOWNTIME_BEGIN = 'downtime.begin'
/** Audit action: production resumed (closes the pause). */
export const DOWNTIME_RESUME = 'downtime.resume'

const WORKFLOW_ID = 'downtime'
const DOWNTIME_ACTIONS: readonly string[] = [DOWNTIME_BEGIN, DOWNTIME_RESUME]

/** The fixed reason vocabulary (the page buttons, in display order). */
export const DOWNTIME_REASONS: readonly string[] = [
  '转产调机', '清洁', '就餐', '质量异常', '物料异常', '安全风险', '其他',
]

/** One history row: a begin/resume pair (resume null while open). */
export interface DowntimeRecord {
  reason: string
  beganAt: number
  resumedAt: number | null
}

/** Pair the event stream into records (newest first) and flag the open one. */
export function deriveDowntimes(events: readonly { action: string, time: number, reason?: string }[]): { records: DowntimeRecord[], openIndex: number } {
  const sorted = [...events].sort((a, b) => a.time - b.time)
  const records: DowntimeRecord[] = []
  for (const event of sorted) {
    if (event.action === DOWNTIME_BEGIN) {
      records.push({ reason: event.reason ?? '未注明', beganAt: event.time, resumedAt: null })
      continue
    }
    const last = records[records.length - 1]
    if (last !== undefined && last.resumedAt === null && event.action === DOWNTIME_RESUME) {
      last.resumedAt = event.time
    }
  }
  const openIndex = records.findIndex(record => record.resumedAt === null)
  return { records: records.reverse(), openIndex: openIndex === -1 ? -1 : records.length - 1 - openIndex }
}

/** Plugin-scope state shared with the page. */
interface DowntimeController {
  state: { records: DowntimeRecord[], openIndex: number }
  refresh(): Promise<void>
}

function formatClock(time: number): string {
  return new Date(time).toLocaleTimeString('zh-CN', { hour12: false })
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}时${minutes}分`
  if (minutes > 0) return `${minutes}分${seconds}秒`
  return `${seconds}秒`
}

function DowntimePage(props: { ctx: Context, controller: DowntimeController }): ReactNode {
  const { ctx, controller } = props
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const clock = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(clock) }
  }, [])

  const { records, openIndex } = controller.state
  const open = openIndex === -1 ? null : records[openIndex] ?? null

  const act = (action: 'downtime.begin' | 'downtime.resume', reason?: string): void => {
    setBusy(true)
    setError(null)
    void ctx.client.link.call('audit.record', {
      action,
      ...reason !== undefined ? { detail: { reason } } : {},
    })
      .then(result => {
        if (!result.ok) throw new Error(`操作失败（${result.error.code}）`)
        return controller.refresh()
      })
      .catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { setBusy(false) })
  }

  return (
    <div className="grid h-full grid-cols-[1fr_360px] gap-3 p-4" data-page="downtime">
      <Card className="flex flex-col">
        <CardContent className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
          {open === null
            ? (
                <>
                  <div className="text-sm text-muted-foreground">选择停机原因开始停机</div>
                  <div className="grid grid-cols-3 gap-3">
                    {DOWNTIME_REASONS.map(reason => (
                      <Button
                        key={reason}
                        variant="secondary"
                        className="h-16 w-28 text-sm"
                        disabled={busy}
                        onClick={() => act(DOWNTIME_BEGIN, reason)}
                      >
                        {reason}
                      </Button>
                    ))}
                  </div>
                </>
              )
            : (
                <>
                  <div className="flex items-center gap-2 text-sm">
                    <Badge variant="destructive">停机中</Badge>
                    <span>{open.reason}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    自 {formatClock(open.beganAt)} 起，已停机 {formatDuration(now - open.beganAt)}
                  </div>
                  <Button className="h-10 px-8" disabled={busy} onClick={() => act(DOWNTIME_RESUME)}>恢复生产</Button>
                </>
              )}
          {error !== null && <div className="text-xs text-destructive" role="alert">{error}</div>}
        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-col">
        <CardHeader><CardTitle>停机记录</CardTitle></CardHeader>
        <CardContent className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {records.length === 0 && <div className="text-xs text-muted-foreground">暂无停机记录。</div>}
          {records.map((record, index) => (
            <div key={`${record.beganAt}-${index}`} className="rounded-md border border-border p-2 text-xs" data-downtime-row={index}>
              <div className="mb-1 flex items-center gap-2">
                {record.resumedAt === null
                  ? <Badge variant="destructive">进行中</Badge>
                  : <Badge variant="success">已恢复</Badge>}
                <span>{record.reason}</span>
              </div>
              <div className="grid grid-cols-[64px_1fr] gap-y-1">
                <span className="text-muted-foreground">发生时间</span><span className="font-mono">{formatClock(record.beganAt)}</span>
                <span className="text-muted-foreground">恢复时间</span>
                <span className="font-mono">{record.resumedAt === null ? '—' : formatClock(record.resumedAt)}</span>
                <span className="text-muted-foreground">持续时长</span>
                <span className="font-mono">{record.resumedAt === null ? formatDuration(now - record.beganAt) : formatDuration(record.resumedAt - record.beganAt)}</span>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

/** The downtime workflow occupant; state and alert run at plugin scope. */
const downtimePlugin: Plugin.Object<void> = {
  name: 'process-downtime',
  inject: ['uiSlots', 'client', 'session', 'workflows', 'timer'],
  apply(ctx: Context): void {
    const controller: DowntimeController = {
      state: { records: [], openIndex: -1 },
      async refresh(): Promise<void> {
        const result = await ctx.client.link.call('audit.list', { actions: DOWNTIME_ACTIONS, limit: 500 })
        if (!result.ok) return
        const events = result.value.entries.map(entry => {
          const reason = (entry.detail as { reason?: unknown } | undefined)?.reason
          return {
            action: entry.action,
            time: entry.time,
            ...typeof reason === 'string' ? { reason } : {},
          }
        })
        const derived = deriveDowntimes(events)
        controller.state.records = derived.records
        controller.state.openIndex = derived.openIndex
        ctx.workflows.setAlert(WORKFLOW_ID, derived.openIndex === -1 ? null : { kind: 'steady', color: 'yellow' })
      },
    }
    void controller.refresh()
    ctx.interval(() => { void controller.refresh() }, 2000)

    ctx.workflows.register(ctx, {
      id: WORKFLOW_ID,
      title: '停机休息',
      order: 50,
      requires: [],
      render(): ReactNode {
        return <DowntimePage ctx={ctx} controller={controller} />
      },
    })
  },
}

export default downtimePlugin
