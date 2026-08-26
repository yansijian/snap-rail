/**
 * Resident layout plugin: fills the `layout` slot with the default regions —
 * a titlebar strip, an optional sidebar beside the view area, and a
 * statusbar strip. Regions collapse when their slot has no occupants.
 *
 * @module @snap-rail/layout-default
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import type { SlotId } from '@snap-rail/client-slots'

function SlotRegion(props: { ctx: Context, slot: SlotId, className?: string }): ReactNode {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const detach = props.ctx.on('ui/slot-changed', () => setTick(value => value + 1))
    return () => { detach() }
  }, [props.ctx])

  const occupants = props.ctx.uiSlots.list(props.slot)
  if (occupants.length === 0) return null
  return (
    <div className={props.className} data-slot={props.slot} data-tick={tick}>
      {occupants.map(occupant => <Fragment key={occupant.id}>{occupant.render()}</Fragment>)}
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
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <SlotRegion ctx={ctx} slot="titlebar" />
            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
              <SlotRegion ctx={ctx} slot="sidebar" className="sr-sidebar" />
              <SlotRegion ctx={ctx} slot="view" className="sr-view" />
            </div>
            <SlotRegion ctx={ctx} slot="statusbar" />
          </div>
        )
      },
    })
  },
}

export default layoutPlugin
