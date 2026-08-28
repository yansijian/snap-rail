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
 * @module @snap-rail/layout-station
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, Card, CardContent, Input, cn } from '@snap-rail/client-ui'
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

const STEADY_COLORS = { red: '#f85149', yellow: '#d29922' } as const

function alertStyle(entry: WorkflowEntry): CSSProperties | undefined {
  const alert = entry.alert
  if (alert === null) return undefined
  if (alert.kind === 'steady') {
    return { '--breathe-color': STEADY_COLORS[alert.color], '--breathe-period': '1.5s' } as CSSProperties
  }
  return { '--breathe-color': haloColor(alert.progress), '--breathe-period': haloPeriod(alert.progress) } as CSSProperties
}

function useRefresh(ctx: Context): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const bump = (): void => setTick(value => value + 1)
    const detachers = [
      ctx.on('session/changed', bump),
      ctx.on('workflow/changed', bump),
      ctx.on('ui/slot-changed', bump),
    ]
    return () => { for (const detach of detachers) detach() }
  }, [ctx])
}

function LoginScreen(props: { ctx: Context }): ReactNode {
  useRefresh(props.ctx)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = value.trim()

  const submit = (): void => {
    if (id === '' || busy) return
    setBusy(true)
    setError(null)
    void props.ctx.session.login(id)
      .catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { setBusy(false) })
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center" data-region="login">
      <Card className="w-80">
        <CardContent className="p-6">
          <div className="mb-1 text-base font-medium">操作人登录</div>
          <div className="mb-4 text-xs text-muted-foreground">输入工号开始当班作业，所有操作将以该工号记录。</div>
          <Input
            autoFocus
            aria-label="工号"
            placeholder="工号"
            value={value}
            onChange={event => { setValue(event.target.value); setError(null) }}
            onKeyDown={event => { if (event.key === 'Enter') submit() }}
          />
          {error !== null && <div className="mt-2 text-xs text-destructive" role="alert">{error}</div>}
          <Button className="mt-4 w-full" disabled={id === '' || busy} onClick={submit}>
            {busy ? '登录中…' : '登录'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

function SidebarItem(props: { ctx: Context, entry: WorkflowEntry }): ReactNode {
  const { entry } = props
  const base = 'flex h-11 w-full items-center rounded-md px-3 text-left text-sm transition-colors'
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
        entry.active && 'bg-accent text-accent-foreground',
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
  useRefresh(props.ctx)
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
    <div className="flex min-h-0 w-56 shrink-0 flex-col border-r border-border p-2" data-region="workflow-list">
      {entries.map(entry => <SidebarItem key={entry.id} ctx={props.ctx} entry={entry} />)}
      {active === undefined && <div className="p-3 text-xs text-muted-foreground">暂无已解锁的作业流程</div>}
    </div>
  )
}

function SlotRegion(props: { ctx: Context, slot: 'titlebar' }): ReactNode {
  useRefresh(props.ctx)
  const occupants = props.ctx.uiSlots.list(props.slot)
  if (occupants.length === 0) return null
  return <>{occupants.map(occupant => <div key={occupant.id} className="flex flex-col">{occupant.render()}</div>)}</>
}

function Station(props: { ctx: Context }): ReactNode {
  useRefresh(props.ctx)
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
