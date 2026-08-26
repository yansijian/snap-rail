/**
 * Resident frameless-window titlebar: identity on the left inside a drag
 * region, window controls on the right wired to the `window.control` rpc
 * method. Every control sits in a no-drag island so clicks stay precise.
 *
 * @module @snap-rail/chrome-titlebar
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import type { ReactNode } from 'react'
import '@snap-rail/client-slots'
import '@snap-rail/client-runtime'

type Action = 'minimize' | 'toggle-maximize' | 'close'

const buttonBase = {
  background: 'transparent',
  border: 'none',
  color: 'var(--sr-text-dim)',
  cursor: 'pointer',
  fontSize: 13,
  lineHeight: 1,
  padding: '10px 14px',
}

function Titlebar(props: { control: (action: Action) => void }): ReactNode {
  return (
    <div
      className="sr-drag"
      style={{
        alignItems: 'center',
        borderBottom: '1px solid var(--sr-border)',
        display: 'flex',
        justifyContent: 'space-between',
        userSelect: 'none',
      }}
    >
      <span style={{ color: 'var(--sr-text-dim)', fontSize: 12, padding: '0 var(--sr-space)' }}>snap-rail</span>
      <div className="sr-nodrag" style={{ display: 'flex' }}>
        <button type="button" style={buttonBase} aria-label="最小化" onClick={() => props.control('minimize')}>─</button>
        <button type="button" style={buttonBase} aria-label="最大化切换" onClick={() => props.control('toggle-maximize')}>□</button>
        <button
          type="button"
          style={{ ...buttonBase, color: 'var(--sr-bad)' }}
          aria-label="关闭"
          onClick={() => props.control('close')}
        >✕</button>
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
