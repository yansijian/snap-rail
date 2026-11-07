// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Combobox, type SelectOption } from '../src/components/index.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The first-class combobox: a field with an anchored suggestion list whose
 * focus never leaves the field — the anchored-popover focus dead ends (stolen
 * on open, stranded on body on close) are what made hand-rolled comboboxes
 * swallow every keystroke.
 */

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

const OPERATORS: readonly SelectOption[] = [
  { value: 'e01', label: '张三 E01' },
  { value: 'e02', label: '李四 E02' },
  { value: 'e03', label: '王五 E03', disabled: true },
  { value: 'e04', label: '赵六 E04' },
]

function mount(): Root {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  return root
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

function field(): HTMLInputElement {
  return document.querySelector('input[role="combobox"]') as HTMLInputElement
}

function optionTexts(): string[] {
  return [...document.querySelectorAll('[data-snap-part="combobox.option"]')].map(node => node.textContent ?? '')
}

/** Type like a user: the native value setter plus a bubbling input event. */
async function type(text: string): Promise<void> {
  const input = field()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}

async function press(key: string): Promise<void> {
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
  await settle()
}

async function focusField(): Promise<void> {
  await act(async () => {
    field().focus()
  })
  await settle()
}

describe('combobox', () => {
  it('renders the field and root anatomy', () => {
    const html = renderToStaticMarkup(<Combobox options={OPERATORS} aria-label="工号" />)
    expect(html).toContain('data-snap-part="combobox.root"')
    expect(html).toContain('data-snap-part="combobox.anchor"')
    expect(html).toContain('role="combobox"')
    expect(html).toContain('aria-autocomplete="list"')
  })

  it('filters locally while the focus stays in the field', async () => {
    const root = mount()
    await act(async () => root.render(<Combobox options={OPERATORS} aria-label="工号" />))
    await focusField()
    expect(optionTexts()).toHaveLength(4)

    await type('李')
    expect(optionTexts()).toEqual(['李四 E02'])
    expect(document.activeElement).toBe(field())
  })

  it('navigates with the keyboard, skipping disabled rows, and picks with Enter', async () => {
    const picked = vi.fn()
    const root = mount()
    await act(async () => root.render(<Combobox options={OPERATORS} onValueChange={picked} aria-label="工号" />))
    await focusField()

    await press('ArrowDown') // e01
    await press('ArrowDown') // e02
    await press('ArrowDown') // e03 is disabled → e04
    expect(field().getAttribute('aria-activedescendant')).not.toBeNull()
    await press('Enter')
    expect(picked).toHaveBeenCalledWith('e04')
    expect(field().value).toBe('赵六 E04')
    expect(document.activeElement).toBe(field())
    expect(optionTexts()).toHaveLength(0)
  })

  it('picks with the pointer without blurring the field', async () => {
    const picked = vi.fn()
    const root = mount()
    await act(async () => root.render(<Combobox options={OPERATORS} onValueChange={picked} aria-label="工号" />))
    await focusField()
    const row = [...document.querySelectorAll('[data-snap-part="combobox.option"]')][1] as HTMLElement

    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    await act(async () => {
      row.dispatchEvent(press)
      row.click()
    })
    await settle()
    expect(press.defaultPrevented).toBe(true)
    expect(picked).toHaveBeenCalledWith('e02')
    expect(field().value).toBe('李四 E02')
    expect(document.activeElement).toBe(field())
  })

  it('feeds an async search without filtering its candidates', async () => {
    const queries: string[] = []
    function AsyncPicker() {
      const [candidates, setCandidates] = useState<readonly SelectOption[]>([])
      return (
        <Combobox
          options={candidates}
          aria-label="维修人"
          onInputValueChange={text => {
            queries.push(text)
            // The server matches by employee id; the labels need not contain the query.
            setCandidates(text === '' ? [] : [{ value: 'u7', label: '孙七' }])
          }}
        />
      )
    }
    const root = mount()
    await act(async () => root.render(<AsyncPicker />))
    await focusField()
    expect(document.querySelector('[data-snap-part="combobox.empty"]')?.textContent).toBe('无匹配项')

    await type('E07')
    expect(queries).toEqual(['E07'])
    expect(optionTexts()).toEqual(['孙七'])
    expect(document.activeElement).toBe(field())
  })

  it('reports loading and closes with Escape', async () => {
    const root = mount()
    await act(async () => root.render(<Combobox options={[]} loading aria-label="维修人" />))
    await focusField()
    expect(document.querySelector('[data-snap-part="combobox.empty"]')?.textContent).toBe('搜索中…')

    await press('Escape')
    expect(document.querySelector('[data-snap-part="combobox.list"]')).toBeNull()
    expect(document.activeElement).toBe(field())
  })
})
