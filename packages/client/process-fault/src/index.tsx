/**
 * Workflow page: 故障提报 — the operator reports, a technician takes over.
 * One fault is active at a time; the flow is strictly linear (提报 → 等待
 * 技术员接单 → 技术员维修中 → 完成) and each screen shows exactly one action
 * button, each transition confirming the technician's id. While a fault is
 * open the sidebar entry breathes red at a constant rate; the right rail
 * lists every fault with occurrence, repair, and duration.
 *
 * The fault state and the alert live at plugin scope (not in the page), so
 * an open fault stays red after a restart even before the page is opened.
 *
 * @module @snap-rail/process-fault
 */

import { Context, type Plugin } from '@snap-rail/cordis'
// Side-effect: pulls in the timer augmentation (`ctx.interval`).
import '@snap-rail/cordis-plugin-timer'
import { useEffect, useState, type ReactNode } from 'react'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label } from '@snap-rail/client-ui'
import '@snap-rail/client-slots'
import '@snap-rail/client-runtime'
import '@snap-rail/client-session'
import '@snap-rail/client-workflows'

/** Audit action: a fault was reported (opens a pause on production). */
export const FAULT_REPORT = 'fault.report'
/** Audit action: the technician started the repair (detail: technician id). */
export const FAULT_REPAIR_START = 'fault.repair-start'
/** Audit action: the repair completed (detail: technician id; closes the pause). */
export const FAULT_REPAIR_COMPLETE = 'fault.repair-complete'

const WORKFLOW_ID = 'fault'
const FAULT_ACTIONS: readonly string[] = [FAULT_REPORT, FAULT_REPAIR_START, FAULT_REPAIR_COMPLETE]

interface FaultEvent {
  action: string
  time: number
  technician?: string
}

/** One history row: a report paired with its completion (when repaired). */
export interface FaultRecord {
  reportedAt: number
  repairStartedAt: number | null
  technician: string | null
  completedAt: number | null
}

/** Pair the event stream into records (newest first) and flag the open one. */
export function deriveFaults(events: readonly FaultEvent[]): { records: FaultRecord[], openIndex: number } {
  const sorted = [...events].sort((a, b) => a.time - b.time)
  const records: FaultRecord[] = []
  for (const event of sorted) {
    if (event.action === FAULT_REPORT) {
      records.push({ reportedAt: event.time, repairStartedAt: null, technician: null, completedAt: null })
      continue
    }
    const last = records[records.length - 1]
    if (last === undefined || last.completedAt !== null) continue
    if (event.action === FAULT_REPAIR_START) {
      last.repairStartedAt = event.time
      last.technician = event.technician ?? null
    } else if (event.action === FAULT_REPAIR_COMPLETE) {
      last.completedAt = event.time
      if (event.technician !== undefined) last.technician = event.technician
    }
  }
  const openIndex = records.findIndex(record => record.completedAt === null)
  return { records: records.reverse(), openIndex: openIndex === -1 ? -1 : records.length - 1 - openIndex }
}

/** Plugin-scope state shared with the page: the page renders, the plugin owns. */
interface FaultController {
  state: { records: FaultRecord[], openIndex: number }
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

function Step(props: { index: number, label: string, state: 'done' | 'active' | 'todo' }): ReactNode {
  return (
    <div className="flex items-center gap-2" data-step={props.label} data-state={props.state}>
      <span className={
        props.state === 'done'
          ? 'flex h-6 w-6 items-center justify-center rounded-full bg-success/20 text-xs text-success'
          : props.state === 'active'
            ? 'flex h-6 w-6 items-center justify-center rounded-full bg-primary/20 text-xs text-primary'
            : 'flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground'
      }>
        {props.index}
      </span>
      <span className={props.state === 'todo' ? 'text-sm text-muted-foreground' : 'text-sm'}>{props.label}</span>
    </div>
  )
}

/** The technician-id confirmation dialog (start and complete share it). */
function TechnicianDialog(props: {
  open: boolean
  title: string
  busy: boolean
  onConfirm: (id: string) => void
  onCancel: () => void
}): ReactNode {
  const [id, setId] = useState('')
  useEffect(() => { if (props.open) setId('') }, [props.open])
  const trimmed = id.trim()
  return (
    <Dialog open={props.open} onOpenChange={open => { if (!open) props.onCancel() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>请技术员输入本人的工号确认。</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="technician-id">技术员工号</Label>
          <Input
            id="technician-id"
            autoFocus
            value={id}
            onChange={event => { setId(event.target.value) }}
            onKeyDown={event => { if (event.key === 'Enter' && trimmed !== '') props.onConfirm(trimmed) }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onCancel}>取消</Button>
          <Button disabled={trimmed === '' || props.busy} onClick={() => props.onConfirm(trimmed)}>
            {props.busy ? '确认中…' : '确认'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FaultPage(props: { ctx: Context, controller: FaultController }): ReactNode {
  const { ctx, controller } = props
  const [now, setNow] = useState(() => Date.now())
  const [dialog, setDialog] = useState<'start' | 'complete' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const clock = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(clock) }
  }, [])

  const { records, openIndex } = controller.state
  const open = openIndex === -1 ? null : records[openIndex] ?? null
  const step: 'idle' | 'waiting' | 'repairing' = open === null
    ? 'idle'
    : open.repairStartedAt === null ? 'waiting' : 'repairing'

  const act = (action: 'fault.report' | 'fault.repair-start' | 'fault.repair-complete', technician?: string): void => {
    setBusy(true)
    setError(null)
    void ctx.client.link.call('audit.record', {
      action,
      ...technician !== undefined ? { detail: { technician } } : {},
    })
      .then(result => {
        if (!result.ok) throw new Error(`操作失败（${result.error.code}）`)
        return controller.refresh()
      })
      .catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { setBusy(false); setDialog(null) })
  }

  return (
    <div className="grid h-full grid-cols-[1fr_360px] gap-3 p-4" data-page="fault">
      <Card className="flex flex-col">
        <CardContent className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
          {step === 'idle' && (
            <button
              type="button"
              aria-label="故障提报"
              className="flex h-40 w-40 items-center justify-center rounded-full bg-destructive text-lg font-semibold text-destructive-foreground shadow-lg transition-transform hover:scale-105 active:scale-100"
              disabled={busy}
              onClick={() => act(FAULT_REPORT)}
            >
              故障提报
            </button>
          )}
          {step !== 'idle' && (
            <>
              <div className="flex flex-col gap-3">
                <Step index={1} label="故障提报" state="done" />
                <Step index={2} label="等待技术员接单" state={step === 'waiting' ? 'active' : 'done'} />
                <Step index={3} label="技术员维修中" state={step === 'repairing' ? 'active' : 'todo'} />
                <Step index={4} label="完成" state="todo" />
              </div>
              {open !== null && (
                <div className="text-xs text-muted-foreground">
                  发生于 {formatClock(open.reportedAt)}，已持续 {formatDuration(now - open.reportedAt)}
                </div>
              )}
              {step === 'waiting' && (
                <Button className="h-10 px-8" disabled={busy} onClick={() => setDialog('start')}>开始维修</Button>
              )}
              {step === 'repairing' && (
                <Button className="h-10 px-8" disabled={busy} onClick={() => setDialog('complete')}>完成维修</Button>
              )}
            </>
          )}
          {error !== null && <div className="text-xs text-destructive" role="alert">{error}</div>}
        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-col">
        <CardHeader><CardTitle>故障记录</CardTitle></CardHeader>
        <CardContent className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {records.length === 0 && <div className="text-xs text-muted-foreground">暂无故障记录。</div>}
          {records.map((record, index) => (
            <div key={`${record.reportedAt}-${index}`} className="rounded-md border border-border p-2 text-xs" data-fault-row={index}>
              <div className="mb-1 flex items-center gap-2">
                {record.completedAt === null
                  ? <Badge variant="destructive">进行中</Badge>
                  : <Badge variant="success">已修复</Badge>}
                <span className="text-muted-foreground">#{records.length - index}</span>
              </div>
              <div className="grid grid-cols-[64px_1fr] gap-y-1">
                <span className="text-muted-foreground">发生时间</span><span className="font-mono">{formatClock(record.reportedAt)}</span>
                <span className="text-muted-foreground">修复时间</span>
                <span className="font-mono">{record.completedAt === null ? '—' : formatClock(record.completedAt)}</span>
                <span className="text-muted-foreground">持续时长</span>
                <span className="font-mono">{record.completedAt === null ? formatDuration(now - record.reportedAt) : formatDuration(record.completedAt - record.reportedAt)}</span>
                {record.technician !== null && (
                  <>
                    <span className="text-muted-foreground">维修技术员</span>
                    <span className="font-mono">{record.technician}</span>
                  </>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <TechnicianDialog
        open={dialog === 'start'}
        title="开始维修"
        busy={busy}
        onConfirm={id => { act(FAULT_REPAIR_START, id) }}
        onCancel={() => { setDialog(null) }}
      />
      <TechnicianDialog
        open={dialog === 'complete'}
        title="完成维修"
        busy={busy}
        onConfirm={id => { act(FAULT_REPAIR_COMPLETE, id) }}
        onCancel={() => { setDialog(null) }}
      />
    </div>
  )
}

/** The fault workflow occupant; fault state and alert run at plugin scope. */
const faultPlugin: Plugin.Object<void> = {
  name: 'process-fault',
  inject: ['uiSlots', 'client', 'session', 'workflows', 'timer'],
  apply(ctx: Context): void {
    const controller: FaultController = {
      state: { records: [], openIndex: -1 },
      async refresh(): Promise<void> {
        const result = await ctx.client.link.call('audit.list', { actions: FAULT_ACTIONS, limit: 500 })
        if (!result.ok) return
        const events: FaultEvent[] = result.value.entries.map(entry => {
          const technician = (entry.detail as { technician?: unknown } | undefined)?.technician
          return {
            action: entry.action,
            time: entry.time,
            ...typeof technician === 'string' ? { technician } : {},
          }
        })
        const derived = deriveFaults(events)
        controller.state.records = derived.records
        controller.state.openIndex = derived.openIndex
        ctx.workflows.setAlert(WORKFLOW_ID, derived.openIndex === -1 ? null : { kind: 'steady', color: 'red' })
      },
    }
    void controller.refresh()
    ctx.interval(() => { void controller.refresh() }, 2000)

    ctx.workflows.register(ctx, {
      id: WORKFLOW_ID,
      title: '故障提报',
      order: 40,
      requires: [],
      render(): ReactNode {
        return <FaultPage ctx={ctx} controller={controller} />
      },
    })
  },
}

export default faultPlugin
