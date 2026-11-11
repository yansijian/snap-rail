// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
  Toaster,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  dismissToast,
  toast,
} from '../src/components/index.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

/** Mount a fresh React root in the document. */
function mount(): Root {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  return root
}

/** Let FocusScope's mount effect and its unmount `setTimeout(0)` run. */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
}

/** An anchored combobox shape: a field the panel positions against, no trigger. */
function Anchored({ open, autoFocusOnOpen }: { open: boolean, autoFocusOnOpen?: boolean }) {
  return (
    <Popover open={open}>
      <PopoverAnchor asChild>
        <span style={{ display: 'block' }}><input id="field" /></span>
      </PopoverAnchor>
      <PopoverContent {...autoFocusOnOpen !== undefined ? { autoFocusOnOpen } : {}}>
        <button type="button" id="first">第一项</button>
      </PopoverContent>
    </Popover>
  )
}

/** A trigger-mode popover opened from a button. */
function Triggered({ open, onOpenAutoFocus }: { open: boolean, onOpenAutoFocus?: (event: Event) => void }) {
  return (
    <Popover open={open}>
      <PopoverTrigger asChild><button type="button" id="opener">打开</button></PopoverTrigger>
      <PopoverContent {...onOpenAutoFocus !== undefined ? { onOpenAutoFocus } : {}}>
        <button type="button" id="first">第一项</button>
      </PopoverContent>
    </Popover>
  )
}

/** The anchored-combobox focus dead ends: Radix's FocusScope steals the focus
 * from the field on open, and its close path focuses a `null` trigger ref, so
 * focus strands on body and every keystroke dies. */
describe('popover focus', () => {
  it('keeps the focus in an editable opener and returns it on close', async () => {
    const root = mount()
    await act(async () => root.render(<Anchored open={false} />))
    const field = document.getElementById('field') as HTMLInputElement
    field.focus()
    await act(async () => root.render(<Anchored open />))
    await settle()
    expect(document.activeElement).toBe(field)

    // Focus wandered into the panel (a tab press); closing returns it to the
    // field instead of stranding it on body.
    ;(document.getElementById('first') as HTMLButtonElement).focus()
    await act(async () => root.render(<Anchored open={false} />))
    await settle(10)
    expect(document.activeElement).toBe(field)
  })

  it('moves focus into the panel from a non-editable opener and back on close', async () => {
    const root = mount()
    await act(async () => root.render(<Triggered open={false} />))
    const opener = document.getElementById('opener') as HTMLButtonElement
    opener.focus()
    await act(async () => root.render(<Triggered open />))
    await settle()
    expect(document.activeElement).toBe(document.getElementById('first'))

    await act(async () => root.render(<Triggered open={false} />))
    await settle(10)
    expect(document.activeElement).toBe(opener)
  })

  it('honours the explicit open-focus switch and the caller handler', async () => {
    const forced = mount()
    await act(async () => forced.render(<Anchored open={false} autoFocusOnOpen />))
    ;(document.getElementById('field') as HTMLInputElement).focus()
    await act(async () => forced.render(<Anchored open autoFocusOnOpen />))
    await settle()
    expect(document.activeElement).toBe(document.getElementById('first'))
    forced.unmount()
    roots.splice(roots.indexOf(forced), 1)
    document.body.innerHTML = ''

    const kept = mount()
    await act(async () => kept.render(<Triggered open={false} onOpenAutoFocus={event => event.preventDefault()} />))
    const opener = document.getElementById('opener') as HTMLButtonElement
    opener.focus()
    await act(async () => kept.render(<Triggered open onOpenAutoFocus={event => event.preventDefault()} />))
    await settle()
    expect(document.activeElement).toBe(opener)
  })
})

/** The overlay four the contract has promised since r1: tooltip, popover,
 * menu, toast — now with real React components. */
describe('overlay components', () => {
  it('renders the tooltip and popover trigger anatomy', () => {
    const html = renderToStaticMarkup(
      // The runtime mounts a TooltipProvider in every surface root; the test
      // mirrors that shell.
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild><Button>悬停</Button></TooltipTrigger>
          <TooltipContent>提示文字</TooltipContent>
        </Tooltip>
        <Popover>
          <PopoverTrigger asChild><Button>打开</Button></PopoverTrigger>
          <PopoverContent>面板内容</PopoverContent>
        </Popover>
        <Tooltip>
          {/* Without asChild the trigger owns its element and keeps its part. */}
          <TooltipTrigger><span>裸元素</span></TooltipTrigger>
          <TooltipContent>提示文字</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    )
    // Portals mount their content only while open; the anchors are static.
    // asChild composes onto a semantic child, and the child's own identity
    // wins (a masked button.root would fall back to the UA look); Radix's
    // behaviour attributes still ride along through the props merge.
    expect(html).toContain('data-snap-part="button.root"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('data-snap-part="tooltip.trigger"')
  })

  it('renders the menu trigger and item anatomy once open', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(
        <Menu>
          <MenuTrigger asChild><Button>操作</Button></MenuTrigger>
          <MenuContent>
            <MenuItem>导出</MenuItem>
          </MenuContent>
        </Menu>,
      )
    })
    expect(container.innerHTML).toContain('data-snap-part="button.root"')
    expect(container.innerHTML).toContain('aria-haspopup="menu"')
    await act(async () => {
      container.querySelector('[aria-haspopup="menu"]')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })
    expect(document.body.innerHTML).toContain('data-snap-part="menu.content"')
    expect(document.body.innerHTML).toContain('data-snap-part="menu.item"')
    expect(document.body.innerHTML).toContain('导出')
  })

  it('renders queued toasts in the runtime-mounted toaster and dismisses them', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(<Toaster />)
    })

    // sonner applies queue changes on a macrotask (and dismissals on a
    // rAF) to escape React batching — flush both before asserting. The
    // final unmount rides sonner's own 200ms exit timer, which happy-dom
    // does not run to completion; the exit state is the wrapper's contract.
    const flushQueue = async (): Promise<void> => {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
        await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
      })
    }

    let id = ''
    await act(async () => {
      id = toast({ title: '保存成功', description: '配置已写入设备', intent: 'success' })
    })
    await flushQueue()
    expect(container.innerHTML).toContain('data-sonner-toast')
    expect(container.innerHTML).toContain('data-type="success"')
    expect(container.innerHTML).toContain('snap-intent-success')
    expect(container.innerHTML).toContain('保存成功')
    expect(container.innerHTML).toContain('配置已写入设备')
    expect(container.innerHTML).toContain('<svg')

    let failure = ''
    await act(async () => {
      failure = toast({ title: '退回失败', intent: 'danger' })
    })
    await flushQueue()
    expect(container.innerHTML).toContain('data-type="error"')
    expect(container.innerHTML).toContain('snap-intent-danger')
    expect(container.innerHTML).toContain('退回失败')

    await act(async () => {
      dismissToast(Number(id) || id)
      dismissToast(Number(failure) || failure)
    })
    await flushQueue()
    for (const toastRoot of container.querySelectorAll('[data-sonner-toast]')) {
      expect(toastRoot.getAttribute('data-removed')).toBe('true')
    }
  })
})
