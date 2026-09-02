/**
 * NumberInput / NumberPad: numeric entry for the touch terminal. The field
 * is a button styled as an input (no system soft keyboard ever pops); a tap
 * opens the NumberPad modal — a 3×4 keypad plus 清除/确定. NumberPad also
 * mounts inline where the keypad should stay visible (the login card).
 *
 * @module @snap-rail/client-ui/number-input
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Button } from './button.tsx'
import { Dialog, DialogContent, DialogTitle } from './dialog.tsx'
import { cn } from './utils.ts'

/** The keypad's backspace glyph; inline so the seam carries no icon dep. */
function BackspaceIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" aria-hidden="true">
      <path d="M9 5h11a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 20 19H9l-6.5-7L9 5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="m12.5 9.5 5 5m0-5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/** An inline 3×4 keypad (digits, optional decimal point, backspace) with a
 * clear/confirm action row; every key is a full-size Button. */
export function NumberPad(props: {
  /** The current digit string (controlled). */
  value: string
  onChange: (value: string) => void
  /** Fires on the confirm key; inline mounts use it as their primary action. */
  onConfirm?: () => void
  /** Allow one decimal point (weights, scale factors). */
  allowDecimal?: boolean
  /** Confirm key text (defaults to 确定). */
  confirmLabel?: string
  className?: string
}): ReactNode {
  const { value, onChange, onConfirm, allowDecimal = false, confirmLabel = '确定', className } = props

  const press = (key: string): void => {
    if (key === '.' && (value.includes('.') || value === '')) return
    onChange(value + key)
  }
  const backspace = (): void => { onChange(value.slice(0, -1)) }
  const clear = (): void => { onChange('') }

  return (
    <div className={cn('grid grid-cols-3 gap-2', className)}>
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(digit => (
        <Button
          key={digit}
          type="button"
          variant="secondary"
          data-key={digit}
          className="h-14 font-mono text-xl"
          onClick={() => { press(digit) }}
        >
          {digit}
        </Button>
      ))}
      {allowDecimal
        ? (
            <Button type="button" variant="secondary" data-key="dot" className="h-14 font-mono text-xl" onClick={() => { press('.') }}>
              ·
            </Button>
          )
        : <div aria-hidden="true" />}
      <Button type="button" variant="secondary" data-key="0" className="h-14 font-mono text-xl" onClick={() => { press('0') }}>
        0
      </Button>
      <Button type="button" variant="secondary" aria-label="退格" data-key="back" className="h-14" onClick={backspace}>
        <BackspaceIcon />
      </Button>
      <Button type="button" variant="outline" data-key="clear" className="h-14 text-base" onClick={clear}>
        清除
      </Button>
      <Button type="button" data-key="confirm" className="col-span-2 h-14 text-base" onClick={() => { onConfirm?.() }}>
        {confirmLabel}
      </Button>
    </div>
  )
}

/** A numeric field: an input-styled button that opens the NumberPad modal;
 * `onChange` commits on 确定 only — a cancelled edit changes nothing. */
export function NumberInput(props: {
  /** Field name; doubles as the trigger's aria-label and the modal title. */
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  allowDecimal?: boolean
  disabled?: boolean
  className?: string
}): ReactNode {
  const { label, value, onChange, placeholder = '', allowDecimal = false, disabled = false, className } = props
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    if (open) setDraft(value)
  }, [open, value])

  const confirm = (): void => {
    onChange(draft)
    setOpen(false)
  }

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        data-number-input={label}
        className={cn(
          'flex h-12 w-full items-center rounded-md border border-input bg-transparent px-4 text-left',
          'font-mono text-base tabular-nums',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        onClick={() => { setOpen(true) }}
      >
        {value === '' ? <span className="text-muted-foreground">{placeholder}</span> : value}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined} className="max-w-sm p-0">
          <div className="border-b border-border px-5 py-4">
            <DialogTitle className="text-base font-medium">{label}</DialogTitle>
          </div>
          <div className="px-5 pb-5 pt-4">
            <div className="mb-4 min-h-14 rounded-md border border-border bg-muted px-4 py-3 text-right font-mono text-2xl tabular-nums" data-number-display>
              {draft === '' ? <span className="text-muted-foreground">—</span> : draft}
            </div>
            <NumberPad value={draft} onChange={setDraft} onConfirm={confirm} allowDecimal={allowDecimal} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
