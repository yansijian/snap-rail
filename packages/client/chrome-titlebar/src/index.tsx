/**
 * Resident frameless-window titlebar: logo and title on the left inside a
 * drag region; on the right the signed-on operator with sign-off, then
 * minimize / maximize / close as full-height flush buttons (no gaps to the
 * top or right edges). Close asks for confirmation first — the station is
 * always mid-shift, an accidental click must not kill the terminal.
 *
 * @module @snap-rail/chrome-titlebar
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import { LogOut, Minus, Square, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@snap-rail/client-ui'
import '@snap-rail/client-slots'
import '@snap-rail/client-runtime'
import '@snap-rail/client-session'

type Action = 'minimize' | 'toggle-maximize' | 'close'

/** A minimal rail-track mark; inline so the chrome carries no asset files. */
function LogoMark(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[18px] w-[18px] text-primary"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M7 4v16" />
      <path d="M17 4v16" />
      <path d="M5 9h14" />
      <path d="M5 15h14" />
    </svg>
  )
}

function Titlebar(props: {
  ctx: Context
  control: (action: Action) => void
}): ReactNode {
  const [, setTick] = useState(0)
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    const detach = props.ctx.on('session/changed', () => setTick(value => value + 1))
    return () => { detach() }
  }, [props.ctx])

  const operator = props.ctx.session.current()
  const close = (): void => props.control('close')

  return (
    <div className="drag-region relative flex h-12 select-none items-stretch justify-between border-b border-border">
      <div className="flex items-center gap-2 pl-3">
        <LogoMark />
        <span className="text-sm font-medium tracking-wide">snap-rail</span>
      </div>

      <div className="no-drag flex items-stretch">
        {operator !== null && (
          <div className="mr-1 flex items-center gap-1 pr-1">
            <span
              className="inline-flex h-6 items-center rounded border border-border px-2 font-mono text-xs text-muted-foreground"
              data-operator={operator}
            >
              {operator}
            </span>
            <Button
              variant="ghost"
              className="h-6 px-2 text-xs text-muted-foreground"
              onClick={() => { void props.ctx.session.logout().catch(() => {}) }}
            >
              <LogOut className="h-3 w-3" />
              退出登录
            </Button>
          </div>
        )}

        <div className="flex items-stretch">
          <Button
            variant="ghost"
            aria-label="最小化"
            className="h-full w-11 rounded-none px-0"
            onClick={() => props.control('minimize')}
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            aria-label="最大化切换"
            className="h-full w-11 rounded-none px-0"
            onClick={() => props.control('toggle-maximize')}
          >
            <Square className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            aria-label="关闭"
            className="h-full w-11 rounded-none px-0 rounded-r-none hover:bg-destructive/20 hover:text-destructive"
            onClick={() => setConfirming(true)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>退出客户端？</DialogTitle>
            <DialogDescription>
              关闭后生产、抽检与异常记录入口将不可用；未提交的数据已随操作落盘。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>取消</Button>
            <Button variant="destructive" onClick={() => { setConfirming(false); close() }}>退出</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** The titlebar occupant. */
const titlebarPlugin: Plugin.Object<void> = {
  name: 'chrome-titlebar',
  inject: ['uiSlots', 'client', 'session'],
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
        return <Titlebar ctx={ctx} control={control} />
      },
    })
  },
}

export default titlebarPlugin
