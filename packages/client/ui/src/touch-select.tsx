/**
 * TouchSelect: a touch-first single-choice picker. The trigger opens a
 * modal listing one full-width button row per option — no popover aiming,
 * every row a 56px target; tapping a row commits and closes. Replaces
 * dropdown selects across the touch terminal.
 *
 * @module @snap-rail/client-ui/touch-select
 */

import { useState, type ReactNode } from 'react'
import { Button } from './button.tsx'
import { Dialog, DialogContent, DialogTitle } from './dialog.tsx'
import { DragScroll } from './drag-scroll.tsx'
import { cn } from './utils.ts'

/** One selectable row: `label`/`hint` render inside the list; `triggerLabel`
 * is what the closed trigger summarizes (defaults to `label`). */
export interface TouchSelectOption {
  value: string
  label: ReactNode
  hint?: ReactNode
  triggerLabel?: ReactNode
  disabled?: boolean
}

/** A chevron pointing up: the picker opens an upward modal, not a dropdown. */
function ChevronUp(): ReactNode {
  return (
    <svg viewBox="0 0 12 12" className="h-4 w-4 shrink-0 opacity-60" fill="none" aria-hidden="true">
      <path d="m2.5 7.5 3.5-3.5 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The committed row's check mark, mirroring the Checkbox indicator stroke. */
function CheckIcon(): ReactNode {
  return (
    <svg viewBox="0 0 12 12" className="h-4 w-4 text-primary" fill="none" aria-hidden="true">
      <path d="M2 6.5 4.8 9 10 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A modal-based picker: an outline trigger plus a Dialog list of rows. */
export function TouchSelect(props: {
  /** Field name; doubles as the trigger's aria-label and the modal title. */
  label: string
  value: string
  options: readonly TouchSelectOption[]
  onValueChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
}): ReactNode {
  const { label, value, options, onValueChange, placeholder = '请选择', disabled = false, className } = props
  const [open, setOpen] = useState(false)
  const selected = options.find(option => option.value === value)
  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        aria-label={label}
        data-touch-select-trigger={label}
        className={cn('h-12 w-full justify-between px-4 text-base font-normal', className)}
        onClick={() => { setOpen(true) }}
      >
        {selected === undefined
          ? <span className="truncate text-muted-foreground">{placeholder}</span>
          : <span className="min-w-0 truncate">{selected.triggerLabel ?? selected.label}</span>}
        <ChevronUp />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined} className="max-w-md p-0">
          <div className="border-b border-border px-5 py-4">
            <DialogTitle className="text-base font-medium">{label}</DialogTitle>
          </div>
          <DragScroll className="max-h-[65vh] p-2">
            {options.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">暂无选项</div>
            )}
            {options.map(option => {
              const isSelected = option.value === value
              return (
                <Button
                  key={option.value}
                  type="button"
                  variant="ghost"
                  disabled={option.disabled}
                  data-option={option.value}
                  aria-pressed={isSelected}
                  className={cn(
                    'h-14 w-full justify-between px-4 text-base font-normal',
                    isSelected && 'bg-secondary channel-keyline',
                  )}
                  onClick={() => {
                    onValueChange(option.value)
                    setOpen(false)
                  }}
                >
                  <span className="min-w-0 truncate">{option.label}</span>
                  <span className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
                    {option.hint}
                    {isSelected && <CheckIcon />}
                  </span>
                </Button>
              )
            })}
          </DragScroll>
        </DialogContent>
      </Dialog>
    </>
  )
}
