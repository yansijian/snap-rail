// @vitest-environment happy-dom
/**
 * NumberInput: the keypad commits on 确定 only, honours the decimal-point
 * rule, and cancels clean.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NumberInput } from '../src/number-input.tsx'

afterEach(cleanup)

describe('NumberInput', () => {
  it('commits the keypad draft on 确定 and closes', () => {
    const onChange = vi.fn()
    render(<NumberInput label="端口" value="502" onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: '端口' }))
    fireEvent.click(screen.getByRole('button', { name: '清除' }))
    fireEvent.click(screen.getByRole('button', { name: '1' }))
    fireEvent.click(screen.getByRole('button', { name: '5' }))
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('15')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('allows at most one decimal point', () => {
    const onChange = vi.fn()
    render(<NumberInput label="重量" value="" allowDecimal onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: '重量' }))
    fireEvent.click(screen.getByRole('button', { name: '1' }))
    fireEvent.click(screen.getByRole('button', { name: '·' }))
    fireEvent.click(screen.getByRole('button', { name: '·' }))
    fireEvent.click(screen.getByRole('button', { name: '2' }))
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(onChange).toHaveBeenCalledWith('1.2')
  })

  it('discards the draft when the dialog is dismissed', () => {
    const onChange = vi.fn()
    render(<NumberInput label="地址" value="7" onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: '地址' }))
    fireEvent.click(screen.getByRole('button', { name: '清除' }))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    // the trigger still shows the unchanged committed value
    expect(screen.getByRole('button', { name: '地址' }).textContent).toContain('7')
  })
})
