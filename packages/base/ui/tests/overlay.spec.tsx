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
      </TooltipProvider>,
    )
    // Portals mount their content only while open; the anchors are static.
    expect(html).toContain('data-snap-part="tooltip.trigger"')
    expect(html).toContain('data-snap-part="popover.trigger"')
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
    expect(container.innerHTML).toContain('data-snap-part="menu.trigger"')
    await act(async () => {
      container.querySelector('[data-snap-part="menu.trigger"]')?.dispatchEvent(
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

    let id = 0
    await act(async () => {
      id = toast({ title: '保存成功', description: '配置已写入设备', intent: 'success' })
    })
    expect(container.innerHTML).toContain('data-snap-part="toast.root"')
    expect(container.innerHTML).toContain('data-snap-part="toast.viewport"')
    expect(container.innerHTML).toContain('保存成功')
    expect(container.innerHTML).toContain('data-intent="success"')

    await act(async () => {
      dismissToast(id)
    })
    expect(container.innerHTML).not.toContain('保存成功')
  })
})
