// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ScrollArea } from '../src/components/index.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

/** The Radix-backed scroll area mounts its themed scrollbars after mount;
 * with `always` they stay mounted regardless of overflow. The thumb itself
 * additionally requires real layout (thumbRatio ∈ (0,1)), which happy-dom's
 * zero-size world cannot produce — it is covered by dev smoke instead. */
describe('ScrollArea', () => {
  it('mounts themed scrollbar parts when the type is always', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(<ScrollArea scrollbarType="always">内容</ScrollArea>)
    })
    expect(container.innerHTML).toContain('data-snap-part="scroll-area.viewport"')
    expect(container.innerHTML).toContain('data-snap-part="scroll-area.scrollbar"')
  })

  it('renders only the vertical bar by default and both for both', async () => {
    for (const direction of ['vertical', 'both'] as const) {
      const container = document.createElement('div')
      document.body.append(container)
      const root = createRoot(container)
      roots.push(root)
      await act(async () => {
        root.render(<ScrollArea scrollbarType="always" direction={direction}>内容</ScrollArea>)
      })
      const bars = container.querySelectorAll('[data-snap-part="scroll-area.scrollbar"]')
      expect(bars.length).toBe(direction === 'both' ? 2 : 1)
      expect(bars[0]?.getAttribute('data-orientation')).toBe('vertical')
    }
  })
})
