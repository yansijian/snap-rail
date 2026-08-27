/**
 * Resident layout plugin: fills the `layout` slot with the default regions —
 * a titlebar strip, an optional sidebar beside the view area, and a
 * statusbar strip. Regions collapse when their slot has no occupants; the
 * sidebar scrolls its occupants with the shared ScrollArea.
 *
 * @module @snap-rail/layout-default
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { ScrollArea } from '@snap-rail/client-ui'
import type { SlotId } from '@snap-rail/client-slots'

function SlotRegion(props: { ctx: Context, slot: SlotId, className?: string }): ReactNode {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const detach = props.ctx.on('ui/slot-changed', () => setTick(value => value + 1))
    return () => { detach() }
  }, [props.ctx])

  const occupants = props.ctx.uiSlots.list(props.slot)
  if (occupants.length === 0) return null
  const inner = occupants.map(occupant => <Fragment key={occupant.id}>{occupant.render()}</Fragment>)

  return (
    <div className={props.className} data-slot={props.slot} data-tick={tick}>
      {props.slot === 'sidebar'
        ? <ScrollArea className="h-full">{inner}</ScrollArea>
        : inner}
    </div>
  )
}

/** The default layout occupant. */
const layoutPlugin: Plugin.Object<void> = {
  name: 'layout-default',
  inject: ['uiSlots'],
  apply(ctx: Context): void {
    ctx.uiSlots.register(ctx, 'layout', {
      id: 'default',
      order: 0,
      render(): ReactNode {
        return (
          <div className="flex h-full flex-col">
            <SlotRegion ctx={ctx} slot="titlebar" />
            <div className="flex min-h-0 flex-1">
              <SlotRegion ctx={ctx} slot="sidebar" className="w-64 shrink-0 border-r border-border" />
              <SlotRegion ctx={ctx} slot="view" className="min-w-0 flex-1" />
            </div>
            <SlotRegion ctx={ctx} slot="statusbar" />
          </div>
        )
      },
    })
  },
}

export default layoutPlugin
