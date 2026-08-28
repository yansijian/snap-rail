/**
 * Workflow page: 抽检记录 — a cron-scheduled inspection whose sidebar halo
 * wakes 5 minutes before due (amber, accelerating toward red; overdue stays
 * deep red at the fastest period) and dies on submit. The scheduler runs at
 * plugin scope (not inside the page), so the halo keeps breathing while
 * another workflow is active. Four weights and an airtightness verdict land
 * in the audit log as `sampling.submit`.
 *
 * @module @snap-rail/process-sampling
 */

import { Context, type Plugin } from '@snap-rail/cordis'
// Side-effect: pulls in the timer augmentation (`ctx.interval`).
import '@snap-rail/cordis-plugin-timer'
import { z } from 'zod'
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, RadioGroup, RadioGroupItem } from '@snap-rail/client-ui'
import { PRODUCTION_START } from '@snap-rail/process-production'
import { nextDue, parseCron, type CronSpec } from './schedule.ts'
import '@snap-rail/client-slots'
import '@snap-rail/client-runtime'
import '@snap-rail/client-session'
import '@snap-rail/client-workflows'

/** Audit action: one sampling inspection submitted (four weights + verdict). */
export const SAMPLING_SUBMIT = 'sampling.submit'

/** The halo wakes this long before the due minute. */
export const SAMPLING_LEAD_MS = 5 * 60 * 1000

/** Config schema: the schedule, written in the plugins.yml row. */
export const samplingConfigSchema = z.object({
  /** Five-field cron; only minute/hour may vary (sub-hourly frequencies). */
  schedule: z.string().default('*/30 * * * *'),
})

export type SamplingConfig = z.infer<typeof samplingConfigSchema>

const WORKFLOW_ID = 'sampling'

/** Shared scheduler state: the page renders it, the apply-scope tick drives it. */
interface DueState {
  spec: CronSpec
  /** The inspection currently pending (epoch ms), or `null` before production starts. */
  due: number | null
}

function formatClock(time: number): string {
  return new Date(time).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
}

function formatRemaining(ms: number): string {
  const total = Math.abs(Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}分${String(seconds).padStart(2, '0')}秒`
}

function SamplingPage(props: { ctx: Context, dueState: DueState }): ReactNode {
  const { dueState } = props
  const [now, setNow] = useState(() => Date.now())
  const [weights, setWeights] = useState<string[]>(['', '', '', ''])
  const [airtight, setAirtight] = useState<'yes' | 'no' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const tick = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(tick) }
  }, [])

  const due = dueState.due
  const remaining = due === null ? null : due - now

  const submit = (): void => {
    const values = weights.map(weight => Number.parseFloat(weight))
    if (values.some(value => !Number.isFinite(value))) {
      setError('四个重量都需要填写数字（单位 g）。')
      return
    }
    if (airtight === null) {
      setError('请选择气密性是否合格。')
      return
    }
    setBusy(true)
    setError(null)
    void props.ctx.client.link.call('audit.record', {
      action: SAMPLING_SUBMIT,
      detail: { weights: values, airtight: airtight === 'yes' },
    })
      .then(result => {
        if (!result.ok) throw new Error(`提交失败（${result.error.code}）`)
        setWeights(['', '', '', ''])
        setAirtight(null)
        // The apply-scope tick recomputes the next due from this submit.
        dueState.due = nextDue(dueState.spec, new Date())
        props.ctx.workflows.setAlert(WORKFLOW_ID, null)
      })
      .catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { setBusy(false) })
  }

  return (
    <div className="h-full overflow-y-auto p-4" data-page="sampling">
      <div className="mx-auto max-w-xl space-y-3">
        <Card>
          <CardHeader><CardTitle>抽检记录</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {due === null
              ? <div className="text-sm text-muted-foreground">今日开始生产后，抽检将按配置的计划时间进行。</div>
              : remaining !== null && remaining >= 0
                ? (
                    <div className="text-sm" role="status">
                      下次抽检 <span className="font-mono">{formatClock(due)}</span>，还有 {formatRemaining(remaining)}。
                    </div>
                  )
                : <div className="text-sm text-destructive" role="alert">抽检已逾期 {formatRemaining(remaining ?? 0)}，请尽快完成并提交。</div>}

            <div className="grid grid-cols-2 gap-3">
              {weights.map((weight, index) => (
                <div key={index} className="space-y-1">
                  <Label htmlFor={`sampling-weight-${index}`}>重量{index + 1}（g）</Label>
                  <Input
                    id={`sampling-weight-${index}`}
                    inputMode="decimal"
                    value={weight}
                    onChange={event => {
                      setWeights(values => values.map((value, i) => i === index ? event.target.value : value))
                      setError(null)
                    }}
                  />
                </div>
              ))}
            </div>

            <div className="space-y-1">
              <Label>气密性合格</Label>
              <RadioGroup
                {...airtight !== null ? { value: airtight } : {}}
                onValueChange={value => { setAirtight(value === 'yes' ? 'yes' : 'no'); setError(null) }}
                className="flex gap-6"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="yes" id="airtight-yes" />
                  <Label htmlFor="airtight-yes">是</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="no" id="airtight-no" />
                  <Label htmlFor="airtight-no">否</Label>
                </div>
              </RadioGroup>
            </div>

            {error !== null && <div className="text-xs text-destructive" role="alert">{error}</div>}
            <Button className="w-full" disabled={busy} onClick={submit}>{busy ? '提交中…' : '确认提交'}</Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

/** The sampling workflow occupant; scheduling runs at plugin scope. */
const samplingPlugin: Plugin.Object<SamplingConfig> = {
  name: 'process-sampling',
  inject: ['uiSlots', 'client', 'session', 'workflows', 'timer'],
  Config: samplingConfigSchema,
  apply(ctx: Context, config: SamplingConfig): void {
    const spec = parseCron(config.schedule)
    const dueState: DueState = { spec, due: null }

    // Anchor = the later of the last submit and today's first production
    // start; the pending inspection is the first cron slot after it.
    const recompute = (): void => {
      void ctx.client.link.call('audit.list', {
        actions: [SAMPLING_SUBMIT, PRODUCTION_START],
        limit: 200,
      }).then(result => {
        if (!result.ok) return
        let lastSubmit = 0
        let lastStart = 0
        for (const entry of result.value.entries) {
          if (entry.action === SAMPLING_SUBMIT && entry.time > lastSubmit) lastSubmit = entry.time
          if (entry.action === PRODUCTION_START && entry.time > lastStart) lastStart = entry.time
        }
        const anchor = Math.max(lastSubmit, lastStart)
        dueState.due = anchor === 0 ? null : nextDue(spec, new Date(anchor))
      })
    }
    recompute()
    ctx.on('session/changed', recompute)

    // The halo tick: one hertz at plugin scope, alive across page switches.
    // While idle (no production yet) the tick re-anchors every ~10 s so a
    // production start elsewhere wakes the schedule without a re-login.
    let ticks = 0
    ctx.interval(() => {
      ticks += 1
      const due = dueState.due
      if (due === null) {
        ctx.workflows.setAlert(WORKFLOW_ID, null)
        if (ticks % 10 === 0) recompute()
        return
      }
      const remaining = due - Date.now()
      if (remaining > SAMPLING_LEAD_MS) {
        ctx.workflows.setAlert(WORKFLOW_ID, null)
        return
      }
      // 0 at wake-up → 1 at due; overdue pins at 1 (deep red, fastest).
      const progress = remaining >= 0 ? 1 - remaining / SAMPLING_LEAD_MS : 1
      ctx.workflows.setAlert(WORKFLOW_ID, { kind: 'halo', progress })
    }, 1000)

    ctx.workflows.register(ctx, {
      id: WORKFLOW_ID,
      title: '抽检记录',
      order: 30,
      requires: [{ action: PRODUCTION_START, scope: 'day' }],
      render(): ReactNode {
        return <SamplingPage ctx={ctx} dueState={dueState} />
      },
    })
  },
}

export default samplingPlugin
