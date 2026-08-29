/**
 * Workflow page: 自主维护 — the daily checklist that gates production. Each
 * placeholder item carries a name, instructions, and a reference photo, and
 * must be answered 完成维护 or 异常 (default: neither); the 完成 button
 * unlocks only after every item is answered, then records
 * `maintenance.complete` (actor = the operator) which the production page
 * requires for the current operator and day.
 *
 * @module @snap-rail/process-maintenance
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Card, CardContent } from '@snap-rail/client-ui'
import cleanImage from './assets/clean.jpg'
import lubricateImage from './assets/lubricate.jpg'
import fastenImage from './assets/fasten.png'
import sensorImage from './assets/sensor.jpg'
import safetyImage from './assets/safety.jpg'
import '@snap-rail/client-slots'
import '@snap-rail/client-runtime'
import '@snap-rail/client-session'
import '@snap-rail/client-workflows'

/** Audit action: this operator finished the maintenance checklist today. */
export const MAINTENANCE_COMPLETE = 'maintenance.complete'

/** Per-item outcome picked by the operator; null until a button is pressed. */
type ItemResult = 'ok' | 'abnormal'

interface MaintenanceItem {
  /** Item name shown atop the card. */
  name: string
  /** What the check involves. */
  content: string
  /** Reference photo of the check point. */
  image: string
}

/** Placeholder checklist; real stations override wording per machine. */
const ITEMS: readonly MaintenanceItem[] = [
  { name: '设备清洁', content: '清除机身、导轨与工作台面的粉尘和碎屑，检查排屑口无堵塞。', image: cleanImage },
  { name: '润滑加油', content: '按润滑表为导轨、丝杠加注润滑油，确认油路通畅、油位在标线内。', image: lubricateImage },
  { name: '紧固检查', content: '检查主轴、夹具与主要联接螺栓，按扭矩要求紧固松动的紧固件。', image: fastenImage },
  { name: '传感器检查', content: '清洁各传感器感应面，遮挡测试信号通断，读数应随动作正常变化。', image: sensorImage },
  { name: '安全装置检查', content: '测试急停按钮与安全光栅：触发后设备应立即停止并保持锁定。', image: safetyImage },
]

function MaintenancePage(props: { ctx: Context }): ReactNode {
  const [, setTick] = useState(0)
  const [results, setResults] = useState<Array<ItemResult | null>>(() => ITEMS.map(() => null))
  const [completedAt, setCompletedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const operator = props.ctx.session.current()

  useEffect(() => {
    const detach = props.ctx.on('session/changed', () => setTick(value => value + 1))
    return () => { detach() }
  }, [props.ctx])

  // Today's completion for the signed-on operator (restores after restart).
  useEffect(() => {
    if (operator === null) return
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    let active = true
    void props.ctx.client.link.call('audit.list', {
      actions: [MAINTENANCE_COMPLETE],
      actor: operator,
      since: midnight.getTime(),
    }).then(result => {
      if (!active || !result.ok) return
      const entries = result.value.entries
      const last = entries.length === 0 ? undefined : entries[entries.length - 1]
      setCompletedAt(last?.time ?? null)
    })
    return () => { active = false }
  }, [props.ctx, operator])

  const answeredCount = results.filter(result => result !== null).length
  const allAnswered = answeredCount === ITEMS.length
  const done = completedAt !== null

  const setResult = (index: number, value: ItemResult): void => {
    setResults(values => values.map((current, i) => i === index ? (current === value ? null : value) : current))
  }

  const complete = (): void => {
    if (done || busy || !allAnswered) return
    setBusy(true)
    setError(null)
    void props.ctx.client.link.call('audit.record', { action: MAINTENANCE_COMPLETE })
      .then(result => {
        if (!result.ok) throw new Error(`提交失败（${result.error.code}）`)
        setCompletedAt(result.value.time)
        props.ctx.workflows.announce(MAINTENANCE_COMPLETE)
      })
      .catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { setBusy(false) })
  }

  return (
    <div className="h-full overflow-y-auto p-4" data-page="maintenance">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {ITEMS.map((item, index) => (
          <Card key={item.name}>
            <CardContent className="p-0">
              <img src={item.image} alt={item.name} className="h-36 w-full rounded-t-md object-cover" />
              <div className="space-y-2 p-3">
                <span className="text-sm font-medium">{item.name}</span>
                <p className="text-xs leading-relaxed text-muted-foreground">{item.content}</p>
                <div className="flex gap-2">
                  <Button
                    variant={done || results[index] === 'ok' ? 'default' : 'outline'}
                    disabled={done}
                    className="flex-1"
                    onClick={() => { setResult(index, 'ok') }}
                  >
                    完成维护
                  </Button>
                  <Button
                    variant={results[index] === 'abnormal' ? 'destructive' : 'outline'}
                    disabled={done}
                    className="flex-1"
                    onClick={() => { setResult(index, 'abnormal') }}
                  >
                    异常
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between rounded-md border border-border bg-card p-3">
        {done
          ? (
              <span className="text-sm text-success" role="status">
                今日自主维护已完成（{new Date(completedAt).toLocaleTimeString('zh-CN', { hour12: false })}），生产任务已解锁。
              </span>
            )
          : (
              <span className="text-sm text-muted-foreground">
                {error !== null
                  ? <span className="text-destructive" role="alert">{error}</span>
                  : <>已选择 {answeredCount}/{ITEMS.length} 项，全部选择后可完成。</>}
              </span>
            )}
        <Button disabled={done || !allAnswered || busy} onClick={complete}>
          {busy ? '提交中…' : '完成'}
        </Button>
      </div>
    </div>
  )
}

/** The maintenance workflow occupant. */
const maintenancePlugin: Plugin.Object<void> = {
  name: 'process-maintenance',
  inject: ['uiSlots', 'client', 'session', 'workflows'],
  apply(ctx: Context): void {
    ctx.workflows.register(ctx, {
      id: 'maintenance',
      title: '自主维护',
      order: 10,
      requires: [],
      render(): ReactNode {
        return <MaintenancePage ctx={ctx} />
      },
    })
  },
}

export default maintenancePlugin
