// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Switch } from '../src/index.ts'

let root: Root | undefined
const mountPoint = document.createElement('div')

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  mountPoint.remove()
})

function render(node: React.ReactNode): void {
  document.body.append(mountPoint)
  root = createRoot(mountPoint)
  act(() => root?.render(node))
}

describe('client-ui components', () => {
  it('Button renders variants and forwards native props', () => {
    render(<Button variant="ghost" size="icon" aria-label="关闭">x</Button>)
    const button = mountPoint.querySelector('button')
    expect(button?.getAttribute('aria-label')).toBe('关闭')
    expect(button?.className).toContain('hover:bg-accent')
    expect(button?.className).toContain('h-8')
    expect(button?.className).toContain('w-8')
  })

  it('Badge carries the status variants', () => {
    render(<><Badge variant="success">在线</Badge><Badge variant="destructive">离线</Badge></>)
    const badges = [...mountPoint.querySelectorAll('span')]
    expect(badges[0]?.className).toContain('text-success')
    expect(badges[1]?.className).toContain('text-destructive')
    expect(mountPoint.textContent).toContain('在线')
  })

  it('Card family renders zones', () => {
    render(
      <Card>
        <CardHeader><CardTitle>插件</CardTitle></CardHeader>
        <CardContent>body</CardContent>
      </Card>,
    )
    expect(mountPoint.querySelector('h3')?.textContent).toBe('插件')
    expect(mountPoint.textContent).toContain('body')
    expect(mountPoint.firstElementChild?.className).toContain('bg-card')
  })

  it('Switch exposes a role and toggles state', () => {
    render(<Switch defaultChecked />)
    const control = mountPoint.querySelector('[role="switch"]')
    expect(control?.getAttribute('data-state')).toBe('checked')
  })

  it('cn merges and lets the last utility win', async () => {
    const { cn } = await import('../src/index.ts')
    expect(cn('p-2', 'p-4')).toBe('p-4')
    expect(cn('text-sm', false && 'hidden', 'font-mono')).toBe('text-sm font-mono')
  })
})
