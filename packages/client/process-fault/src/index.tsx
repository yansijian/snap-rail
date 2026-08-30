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
 * Field faults: when the config binds a device group (the 故障报警 group
 * configured in the ModbusTCP settings), the page shows a live 设备故障
 * strip — any member active lists the point names — and the sidebar also
 * breathes red while the group is active. Field faults never write the
 * audit stream; reporting stays a human act.
 *
 * @module @snap-rail/process-fault
 */

import { formatClock, formatDuration } from '@snap-rail/util'
import { Context, type Plugin } from '@snap-rail/cordis'
// Side-effect: pulls in the timer augmentation (`ctx.interval`).
import '@snap-rail/cordis-plugin-timer'
// Wire rows for the station-domain methods this resident calls.
import '@snap-rail/station-rpc/contract'
import { watchBinding, type BindingView } from '@snap-rail/client-variables'
import { useEffect, useState, type ReactNode } from 'react'
import { z } from 'zod'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DragScroll, NumberPad } from '@snap-rail/client-ui'
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

/** Config schema: the optional device-fault group binding from plugins.yml. */
export const faultConfigSchema = z.object({
  /** Bind the 设备故障 strip to one device's business group (configured in
   * the ModbusTCP settings); absent keeps the page purely manual. */
  faultBinding: z.object({
    device: z.string().min(1),
    group: z.string().min(1),
  }).optional(),
})

export type FaultConfig = z.infer<typeof faultConfigSchema>

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
  state: { records: FaultRecord[], openIndex: number, deviceFault: BindingView }
  refresh(): Promise<void>
}

function Step(props: { index: number, label: string, state: 'done' | 'active' | 'todo' }): ReactNode {
  return (
    <div className="flex items-center gap-3" data-step={props.label} data-state={props.state}>
      <span className={
        props.state === 'done'
          ? 'flex h-8 w-8 items-center justify-center rounded-full bg-success/20 text-sm text-success'
          : props.state === 'active'
            ? 'glow-number flex h-8 w-8 items-center justify-center rounded-full bg-primary/20 text-sm text-primary'
            : 'flex h-8 w-8 items-center justify-center rounded-full bg-muted text-sm text-muted-foreground'
      }>
        {props.index}
      </span>
      <span className={props.state === 'todo' ? 'text-base text-muted-foreground' : 'text-base'}>{props.label}</span>
    </div>
  )
}

/** The technician-id confirmation dialog (start and complete share it); the
 * numeric keypad is embedded — same entry style as the login screen. */
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
          <DialogTitle className="text-lg font-medium">{props.title}</DialogTitle>
          <DialogDescription>请技术员输入本人的工号确认。</DialogDescription>
        </DialogHeader>
        <div
          aria-label="技术员工号"
          data-cell="technician-id"
          className="mb-4 mt-2 flex h-14 items-center justify-end rounded-md border border-input px-4 font-mono text-2xl tabular-nums"
        >
          {id === '' ? <span className="text-base text-muted-foreground">请输入工号</span> : id}
        </div>
        <NumberPad
          value={id}
          onChange={setId}
          confirmLabel={props.busy ? '确认中…' : '确认'}
          onConfirm={() => { if (trimmed !== '' && !props.busy) props.onConfirm(trimmed) }}
        />
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
  const deviceFault = controller.state.deviceFault
  const open = openIndex === -1 ? null : records[openIndex] ?? null
  const step: 'idle' | 'waiting' | 'repairing' = open === null
    ? 'idle'
    : open.repairStartedAt === null ? 'waiting' : 'repairing'
  /** The strip's coarse state for tests and styling: fault beats abnormal. */
  const faultStripState = deviceFault.kind === 'group'
    ? deviceFault.status === 'active' ? 'fault' : deviceFault.abnormal.length > 0 ? 'abnormal' : 'normal'
    : 'normal'

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
    <div className="grid h-full grid-cols-[1fr_400px] gap-4 p-6" data-page="fault">
      <Card className="flex flex-col">
        {deviceFault.kind === 'group' && (
          <div
            data-region="device-fault"
            data-state={faultStripState}
            className={
              faultStripState === 'fault'
                ? 'flex flex-wrap items-center gap-2 rounded-t-lg border-b border-destructive/40 bg-destructive/10 px-5 py-3 text-base text-destructive'
                : faultStripState === 'abnormal'
                  ? 'flex flex-wrap items-center gap-2 rounded-t-lg border-b border-border bg-muted px-5 py-3 text-base text-muted-foreground'
                  : 'flex flex-wrap items-center gap-2 rounded-t-lg border-b border-border bg-success/10 px-5 py-3 text-base text-success'
            }
          >
            {faultStripState === 'fault' && deviceFault.kind === 'group' && (
              <>
                <span>设备故障：</span>
                <span className="font-semibold" data-cell="device-fault-names">
                  {deviceFault.active.map(member => member.name).join('、')}
                </span>
              </>
            )}
            {faultStripState === 'abnormal' && deviceFault.kind === 'group' && (
              <span>设备通讯异常（{deviceFault.abnormal.length} 个点位待恢复）</span>
            )}
            {faultStripState === 'normal' && <span>设备正常</span>}
          </div>
        )}
        <CardContent className="flex flex-1 flex-col items-center justify-center gap-8 p-6">
          {step === 'idle' && (
            <button
              type="button"
              aria-label="故障提报"
              className="flex h-56 w-56 items-center justify-center rounded-full bg-destructive text-2xl font-semibold text-destructive-foreground shadow-lg transition-transform hover:scale-105 active:scale-100"
              disabled={busy}
              onClick={() => act(FAULT_REPORT)}
            >
              故障提报
            </button>
          )}
          {step !== 'idle' && (
            <>
              <div className="flex flex-col gap-4">
                <Step index={1} label="故障提报" state="done" />
                <Step index={2} label="等待技术员接单" state={step === 'waiting' ? 'active' : 'done'} />
                <Step index={3} label="技术员维修中" state={step === 'repairing' ? 'active' : 'todo'} />
                <Step index={4} label="完成" state="todo" />
              </div>
              {open !== null && (
                <div className="text-sm text-muted-foreground">
                  发生于 {formatClock(open.reportedAt)}，已持续 {formatDuration(now - open.reportedAt)}
                </div>
              )}
              {step === 'waiting' && (
                <Button size="lg" className="px-10" disabled={busy} onClick={() => setDialog('start')}>开始维修</Button>
              )}
              {step === 'repairing' && (
                <Button size="lg" className="px-10" disabled={busy} onClick={() => setDialog('complete')}>完成维修</Button>
              )}
            </>
          )}
          {error !== null && <div className="text-sm text-destructive" role="alert">{error}</div>}
        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-col">
        <CardHeader><CardTitle>故障记录</CardTitle></CardHeader>
        <DragScroll className="min-h-0 flex-1 space-y-2 p-5 pt-0">
          {records.length === 0 && <div className="text-sm text-muted-foreground">暂无故障记录。</div>}
          {records.map((record, index) => (
            <div key={`${record.reportedAt}-${index}`} className="rounded-md border border-border p-3 text-sm" data-fault-row={index}>
              <div className="mb-1.5 flex items-center gap-2">
                {record.completedAt === null
                  ? <Badge variant="destructive">进行中</Badge>
                  : <Badge variant="success">已修复</Badge>}
                <span className="text-muted-foreground">#{records.length - index}</span>
              </div>
              <div className="grid grid-cols-[80px_1fr] gap-y-1">
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
        </DragScroll>
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
const faultPlugin: Plugin.Object<FaultConfig> = {
  name: 'process-fault',
  inject: ['uiSlots', 'client', 'session', 'workflows', 'timer'],
  Config: faultConfigSchema,
  apply(ctx: Context, config: FaultConfig): void {
    const controller: FaultController = {
      state: { records: [], openIndex: -1, deviceFault: { kind: 'unresolved' } },
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
        applyAlert()
      },
    }

    /** Red breathe while a manual fault is open OR the bound group is active. */
    function applyAlert(): void {
      const groupActive = controller.state.deviceFault.kind === 'group' && controller.state.deviceFault.status === 'active'
      ctx.workflows.setAlert(WORKFLOW_ID, controller.state.openIndex === -1 && !groupActive ? null : { kind: 'steady', color: 'red' })
    }

    const binding = config.faultBinding
    if (binding !== undefined) {
      // Effects take a body producing the disposer; watchBinding's stop
      // function is exactly that. Re-resolves on modbus/config-changed, so
      // re-mapping or re-grouping applies without reloading the page.
      ctx.effect(() => watchBinding(ctx, binding, view => {
        controller.state.deviceFault = view
        applyAlert()
      }))
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
