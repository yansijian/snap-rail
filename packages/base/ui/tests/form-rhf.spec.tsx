// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  Button,
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  useForm,
  zodResolver,
} from '../src/components/index.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

const schema = z.object({
  host: z.string().min(1, '主机不能为空'),
})

function HostForm({ onValid }: { onValid: (values: z.infer<typeof schema>) => void }): React.ReactNode {
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { host: '' },
  })
  return (
    <Form form={form} onValid={values => onValid(values)}>
      <FormField
        name="host"
        render={({ field }) => (
          <FormItem>
            <FormLabel>主机</FormLabel>
            <FormControl><Input value={field.value} onChange={field.onChange} /></FormControl>
            <FormDescription>设备的地址</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <Button type="submit">保存</Button>
    </Form>
  )
}

function typeInto(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

/** The shadcn-shaped composite form over the shared React Hook Form instance. */
describe('react-hook-form integration', () => {
  it('exposes the re-exported single-instance hooks and resolver', () => {
    expect(typeof useForm).toBe('function')
    expect(typeof zodResolver).toBe('function')
  })

  it('surfaces the resolver error on submit and passes the values once fixed', async () => {
    const onValid = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(<HostForm onValid={values => onValid(values)} />)
    })

    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(container.innerHTML).toContain('主机不能为空')
    expect(onValid).not.toHaveBeenCalled()

    const field = container.querySelector('input')
    expect(field).not.toBeNull()
    await act(async () => {
      typeInto(field as HTMLInputElement, '192.168.1.10')
    })
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(onValid).toHaveBeenCalledWith({ host: '192.168.1.10' })
    expect(container.innerHTML).not.toContain('主机不能为空')
  })

  it('binds the label, description, and message anchors to the control', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(<HostForm onValid={() => {}} />)
    })

    const control = container.querySelector('input')
    const describedBy = control?.getAttribute('aria-describedby') ?? ''
    expect(describedBy).toContain('-description')
    expect(describedBy).toContain('-message')
    const label = container.querySelector('[data-snap-part="field.label"]')
    expect(label?.getAttribute('for')).toBe(control?.id)
    expect(container.querySelector('[data-snap-part="field.help"]')?.id).toContain('-description')
  })
})
