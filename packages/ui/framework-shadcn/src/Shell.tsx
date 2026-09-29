/**
 * The slot-driven shell: renders every registered layout occupant, or the
 * degradation notice when none did. Any `ui/slot-changed` emission re-renders
 * the whole shell — occupants stay tiny; reconciliation is React's problem.
 *
 * @module @snap-rail/framework-shadcn/runtime/Shell
 */

import type { Context } from '@snap-rail/cordis'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { UI_SLOT_IDS } from './slots.tsx'

/** Shell root; mounted once by {@link ../index.tsx | createClientRuntime}. */
export function Shell(props: { ctx: Context }): ReactNode {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const detach = props.ctx.on('ui/slot-changed', () => setTick(value => value + 1))
    return () => { detach() }
  }, [props.ctx])

  const layouts = props.ctx.uiSlots.list(UI_SLOT_IDS.layout)
  const content = layouts.length > 0
    ? layouts.map(occupant => <Fragment key={occupant.id}>{occupant.render()}</Fragment>)
    : <div className="m-auto text-muted-foreground">没有已加载的布局插件。</div>

  // `tick` participates so slot changes re-run the render.
  return <div className="flex h-full flex-col" data-tick={tick}>{content}</div>
}
