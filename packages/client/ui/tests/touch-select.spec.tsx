// @vitest-environment happy-dom
/**
 * TouchSelect: the modal picker contract — a trigger tap opens the list,
 * a row tap commits and closes, the selected row is marked, and the trigger
 * summarizes the selection.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TouchSelect } from '../src/touch-select.tsx'

afterEach(cleanup)

const OPTIONS = [
  { value: 'a', label: '选项甲' },
  { value: 'b', label: '选项乙' },
  { value: 'c', label: '选项丙' },
]

describe('TouchSelect', () => {
  it('opens a modal list on trigger tap, commits a row tap, and closes', () => {
    const onValueChange = vi.fn()
    render(
      <TouchSelect label="设备" value="a" options={OPTIONS} onValueChange={onValueChange} />,
    )

    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '设备' }))

    const row = screen.getByRole('button', { name: /选项乙/ })
    expect(row.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(row)
    expect(onValueChange).toHaveBeenCalledTimes(1)
    expect(onValueChange).toHaveBeenCalledWith('b')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('marks the selected row and summarizes it on the closed trigger', () => {
    render(
      <TouchSelect label="设备" value="b" options={OPTIONS} onValueChange={() => {}} />,
    )
    expect(screen.getByRole('button', { name: /设备/ }).textContent).toContain('选项乙')

    fireEvent.click(screen.getByRole('button', { name: '设备' }))
    const selected = screen.getByRole('button', { name: /选项乙/ })
    expect(selected.getAttribute('aria-pressed')).toBe('true')
    const others = screen.getByRole('button', { name: /选项甲/ })
    expect(others.getAttribute('aria-pressed')).toBe('false')
  })

  it('shows the placeholder when the value names no option', () => {
    render(
      <TouchSelect label="设备" value="zz" options={OPTIONS} onValueChange={() => {}} placeholder="点此选择" />,
    )
    expect(screen.getByRole('button', { name: '设备' }).textContent).toContain('点此选择')
  })
})
