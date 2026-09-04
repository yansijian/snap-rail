/**
 * The station layout occupant: the shell between login and work. While no
 * operator is signed on, the whole body is the login page (the titlebar
 * stays mounted — window controls must never disappear). Once signed on, the
 * left rail lists the registered workflows in order (locked ones render as
 * plain gray, no extra text) and the remaining area renders the active
 * workflow's own plugin. This plugin also owns the gating feed: on every
 * session change it pulls today's audit events and feeds them to
 * `ctx.workflows`, which evaluates each workflow's declarative `requires`.
 *
 * @module @snap-rail/suite-terminal-ops/layout
 */

// Wire rows for the station-domain methods this resident calls.
import '@snap-rail/station-rpc/contract'
import { Context, type Plugin } from '@snap-rail/cordis'
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Card, CardContent, DragScroll, NumberPad, cn, useRefresh } from '@snap-rail/client-ui'
import type { WorkflowEntry } from '@snap-rail/client-workflows'
import '@snap-rail/client-slots'
import '@snap-rail/client-runtime'
import '@snap-rail/client-session'
import '@snap-rail/client-workflows'

/** Halo colors: amber at `progress` 0 to destructive red at 1. */
const HALO_FROM = [0xe3, 0xb3, 0x41] as const
const HALO_TO = [0xf8, 0x51, 0x49] as const

function haloColor(progress: number): string {
  const channel = (from: number, to: number): number => Math.round(from + (to - from) * progress)
  const [r, g, b] = [channel(HALO_FROM[0], HALO_TO[0]), channel(HALO_FROM[1], HALO_TO[1]), channel(HALO_FROM[2], HALO_TO[2])]
  return `rgb(${r}, ${g}, ${b})`
}

/** Breathing period shrinks from 2.4s (calm) to 0.7s (due) with progress. */
function haloPeriod(progress: number): string {
  return `${(2.4 - 1.7 * progress).toFixed(2)}s`
}

/** Sidebar events that re-render the rail and every slot consumer. */
const RAIL_EVENTS = ['session/changed', 'session/restored', 'workflow/changed', 'ui/slot-changed'] as const

// Theme tokens by name — the breathing halo colors ride CSS custom properties,
// so retinting the theme retints the alerts.
const STEADY_COLORS = { red: 'var(--color-destructive)', yellow: 'var(--color-warning)' } as const

function alertStyle(entry: WorkflowEntry): CSSProperties | undefined {
  const alert = entry.alert
  if (alert === null) return undefined
  if (alert.kind === 'steady') {
    return { '--breathe-color': STEADY_COLORS[alert.color], '--breathe-period': '1.5s' } as CSSProperties
  }
  return { '--breathe-color': haloColor(alert.progress), '--breathe-period': haloPeriod(alert.progress) } as CSSProperties
}

function LoginScreen(props: { ctx: Context }): ReactNode {
  useRefresh(props.ctx, RAIL_EVENTS)
  const [id, setId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = (): void => {
    const operator = id.trim()
    if (operator === '' || busy) return
    setBusy(true)
    setError(null)
    void props.ctx.session.login(operator)
      .catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { setBusy(false) })
  }

  // Touch-first login: the operator id is numeric, so the keypad is the
  // keyboard — no text field, no system soft input.
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center" data-region="login">
      <Card className="w-96">
        <CardContent className="p-6">
          <div className="text-xl font-semibold text-foreground">操作人登录</div>
          <div className="mb-4 mt-1 text-sm text-muted-foreground">输入工号开始当班作业，所有操作将以该工号记录。</div>
          <div
            aria-label="工号"
            data-cell="operator-id"
            className="mb-4 flex h-14 items-center justify-end rounded-md border border-input bg-transparent px-4 font-mono text-2xl tabular-nums"
          >
            {id === '' ? <span className="text-base text-muted-foreground">请输入工号</span> : id}
          </div>
          <NumberPad value={id} onChange={next => { setId(next); setError(null) }} onConfirm={submit} confirmLabel="登录" />
          {busy && <div className="mt-3 text-sm text-muted-foreground">登录中…</div>}
          {error !== null && <div className="mt-3 text-sm text-destructive" role="alert">{error}</div>}
        </CardContent>
      </Card>
    </div>
  )
}

function SidebarItem(props: { ctx: Context, entry: WorkflowEntry }): ReactNode {
  const { entry } = props
  const base = 'flex h-14 w-full items-center rounded-md px-4 text-left text-base transition-colors'
  if (!entry.unlocked) {
    // Locked items stay plain gray — no icon, no explanation text.
    return <span className={cn(base, 'cursor-not-allowed text-muted-foreground/40')} data-workflow={entry.id} aria-disabled="true">{entry.title}</span>
  }
  return (
    <button
      type="button"
      className={cn(
        base,
        'hover:bg-accent hover:text-accent-foreground',
        entry.active && 'bg-accent font-medium text-accent-foreground channel-keyline',
        entry.alert !== null && 'breathe',
      )}
      style={alertStyle(entry)}
      data-workflow={entry.id}
      onClick={() => props.ctx.workflows.setActive(entry.id)}
    >
      {entry.title}
    </button>
  )
}

function WorkflowSidebar(props: { ctx: Context }): ReactNode {
  useRefresh(props.ctx, RAIL_EVENTS)
  const entries = props.ctx.workflows.list()

  // Keep an unlocked workflow active: after login, gating changes, or a
  // workflow unload, fall back to the first unlocked entry.
  useEffect(() => {
    const list = props.ctx.workflows.list()
    const current = list.find(entry => entry.active)
    if (current === undefined || !current.unlocked) {
      const first = list.find(entry => entry.unlocked)
      if (first !== undefined) props.ctx.workflows.setActive(first.id)
    }
  })

  const active = entries.find(entry => entry.active && entry.unlocked)
  return (
    <div className="flex min-h-0 w-64 shrink-0 flex-col border-r border-border p-2" data-region="workflow-list">
      <DragScroll className="flex min-h-0 flex-1 flex-col gap-1">
        {entries.map(entry => <SidebarItem key={entry.id} ctx={props.ctx} entry={entry} />)}
        {active === undefined && <div className="p-3 text-sm text-muted-foreground">暂无已解锁的作业流程</div>}
      </DragScroll>
    </div>
  )
}

function SlotRegion(props: { ctx: Context, slot: 'titlebar' }): ReactNode {
  useRefresh(props.ctx, RAIL_EVENTS)
  const occupants = props.ctx.uiSlots.list(props.slot)
  if (occupants.length === 0) return null
  return <>{occupants.map(occupant => <div key={occupant.id} className="flex flex-col">{occupant.render()}</div>)}</>
}

function Station(props: { ctx: Context }): ReactNode {
  useRefresh(props.ctx, RAIL_EVENTS)
  // The boot restore probe races the first frame: hold a blank body (the
  // titlebar stays mounted) until it settles — a restart with a persisted
  // operator must never flash the login card's keypad. The render reads
  // `restored()` directly, so correctness never hangs on catching the event.
  if (!props.ctx.session.restored()) {
    return (
      <div className="flex h-full flex-col">
        <SlotRegion ctx={props.ctx} slot="titlebar" />
        <div className="min-h-0 flex-1" data-region="session-restoring" />
      </div>
    )
  }
  const operator = props.ctx.session.current()
  const body = operator === null
    ? <LoginScreen ctx={props.ctx} />
    : (
        <div className="flex min-h-0 flex-1">
          <WorkflowSidebar ctx={props.ctx} />
          <main className="min-w-0 flex-1 overflow-hidden" data-region="workflow-view">
            {(() => {
              const active = props.ctx.workflows.list().find(entry => entry.active && entry.unlocked)
              return active === undefined ? null : active.render()
            })()}
          </main>
        </div>
      )
  return (
    <div className="flex h-full flex-col">
      <SlotRegion ctx={props.ctx} slot="titlebar" />
      {body}
    </div>
  )
}

/** The station layout occupant. */
const layoutPlugin: Plugin.Object<void> = {
  name: 'layout-station',
  inject: ['uiSlots', 'client', 'session', 'workflows'],
  apply(ctx: Context): void {
    // The gating feed: on every session transition, anchor the operator and
    // rebuild today's event set from the audit log (the durable truth).
    const syncGating = (): void => {
      const operator = ctx.session.current()
      ctx.workflows.setOperator(operator)
      if (operator === null) {
        ctx.workflows.feedEvents([])
        return
      }
      const midnight = new Date()
      midnight.setHours(0, 0, 0, 0)
      void ctx.client.link.call('audit.list', { since: midnight.getTime() }).then(result => {
        // A late answer after another session change must not backdate.
        if (!result.ok || ctx.session.current() !== operator) return
        ctx.workflows.feedEvents(result.value.entries.map(entry => ({
          action: entry.action,
          actor: entry.actor,
          time: entry.time,
        })))
      })
    }
    ctx.on('session/changed', syncGating)
    // The session may have restored before this plugin mounted; sync once.
    syncGating()

    ctx.uiSlots.register(ctx, 'layout', {
      id: 'station',
      order: 0,
      render(): ReactNode {
        return <Station ctx={ctx} />
      },
    })
  },
}

export default layoutPlugin
