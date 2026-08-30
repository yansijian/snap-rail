/**
 * Shared React recipes over the client runtime's event fabric.
 *
 * @module @snap-rail/client-ui/hooks
 */

import { useEffect, useState } from 'react'
import type { Context, Events } from '@snap-rail/cordis'

/**
 * Re-render the component whenever any of the named ctx events fires —
 * the standard "surface follows the seam" tick. The cordis import is
 * type-only: this module stays a pure React utility at runtime.
 *
 * @param ctx - the plugin context whose events drive the refresh.
 * @param events - event names to listen on (identity is not part of the
 * effect key; a freshly built array literal is fine).
 */
export function useRefresh(ctx: Context, events: ReadonlyArray<keyof Events>): void {
  const [, setTick] = useState(0)
  const key = events.join('\n')
  useEffect(() => {
    const bump = (): void => setTick(value => value + 1)
    const names = (key === '' ? [] : key.split('\n')) as Array<keyof Events>
    const detachers = names.map(event => ctx.on(event, bump))
    return () => { for (const detach of detachers) detach() }
  }, [ctx, key])
}
