/**
 * Resident frameless-window titlebar: identity on the left inside a drag
 * region, window controls on the right wired to the `window.control` rpc
 * method. Controls sit in a no-drag island with tooltips.
 *
 * @module @snap-rail/chrome-titlebar
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import { Minus, Square, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button, Tooltip } from '@snap-rail/client-ui'
import '@snap-rail/client-slots'
import '@snap-rail/client-runtime'

type Action = 'minimize' | 'toggle-maximize' | 'close'

function Titlebar(props: { control: (action: Action) => void }): ReactNode {
  return (
    <div className="drag-region flex select-none items-center justify-center border-b border-border relative">
      <span className="absolute left-2 text-xs text-muted-foreground">snap-rail</span>
      <div className="no-drag flex">
        <Tooltip content="最小化">
          <Button variant="ghost" size="icon" aria-label="最小化" onClick={() => props.control('minimize')}>
            <Minus className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
        <Tooltip content="最大化切换">
          <Button variant="ghost" size="icon" aria-label="最大化切换" onClick={() => props.control('toggle-maximize')}>
            <Square className="h-3 w-3" />
          </Button>
        </Tooltip>
        <Tooltip content="关闭">
          <Button
            variant="ghost"
            size="icon"
            aria-label="关闭"
            className="hover:bg-destructive/20 hover:text-destructive"
            onClick={() => props.control('close')}
          >
            <X className="h-4 w-4" />
          </Button>
        </Tooltip>
      </div>
    </div>
  )
}

/** The titlebar occupant. */
const titlebarPlugin: Plugin.Object<void> = {
  name: 'chrome-titlebar',
  inject: ['uiSlots', 'client'],
  apply(ctx: Context): void {
    // One stable sender for the plugin lifetime; late fires after teardown
    // must not surface as unhandled rejections.
    const control = (action: Action): void => {
      void ctx.client.link.call('window.control', { action }).catch(() => {})
    }
    ctx.uiSlots.register(ctx, 'titlebar', {
      id: 'chrome',
      order: 0,
      render(): ReactNode {
        return <Titlebar control={control} />
      },
    })
  },
}

export default titlebarPlugin
