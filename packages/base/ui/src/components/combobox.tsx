/**
 * A text field with an anchored suggestion list: search pickers, filtered
 * choosers, async candidate feeds (operator lookups, assignee search). The
 * focus never leaves the field — keyboard navigation rides
 * `aria-activedescendant`, pointer picks suppress the field's blur, and the
 * panel opens without taking the focus — so typing keeps working through
 * open, navigate, and select. The field is a regular {@link Input}; skins
 * style the `combobox.*` parts around it.
 *
 * @module @snap-rail/ui/components/combobox
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { part } from '../utils.ts'
import type { SelectOption } from './controls.tsx'
import { Input, type InputSize } from './input.tsx'
import { Popover, PopoverAnchor, PopoverContent } from './overlay.tsx'

/** Props of {@link Combobox}. */
export interface ComboboxProps {
  /** Controlled selected value. */
  value?: string
  /** Uncontrolled initial value. */
  defaultValue?: string
  onValueChange?: (value: string) => void
  /** The field text changed. When set, `options` are taken as already
   * matched (an async search feeds them); otherwise the list filters by
   * label locally. */
  onInputValueChange?: (text: string) => void
  options: readonly SelectOption[]
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  size?: InputSize
  /** Candidates are being fetched (async search). */
  loading?: boolean
  /** Shown when no option matches (default `无匹配项`). */
  emptyText?: ReactNode
  /** The field's id; also wires a label's `htmlFor`. */
  id?: string
  /** Dresses the field wrapper. */
  className?: string
  /** Dresses the suggestion panel. */
  contentClassName?: string
  'aria-label'?: string
}

/** The text an option contributes to filtering and to the field once picked. */
function textOf(option: SelectOption): string {
  return typeof option.label === 'string' || typeof option.label === 'number' ? String(option.label) : option.value
}

/** The next enabled row index from `from`, wrapping; -1 when none is enabled. */
function nextEnabled(rows: readonly SelectOption[], from: number, step: 1 | -1): number {
  if (rows.length === 0) return -1
  let index = from < 0 ? (step > 0 ? -1 : 0) : from
  for (let tries = 0; tries < rows.length; tries++) {
    index = (index + step + rows.length) % rows.length
    if (rows[index]?.disabled !== true) return index
  }
  return -1
}

/** A field with an anchored, keyboard-navigable suggestion list. */
export function Combobox({
  value,
  defaultValue,
  onValueChange,
  onInputValueChange,
  options,
  placeholder,
  disabled = false,
  invalid = false,
  size = 'md',
  loading = false,
  emptyText = '无匹配项',
  id,
  className,
  contentClassName,
  'aria-label': ariaLabel,
}: ComboboxProps): ReactNode {
  const listId = useId()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [uncontrolled, setUncontrolled] = useState(defaultValue)
  const current = value !== undefined ? value : uncontrolled
  const selected = options.find(option => option.value === current)
  const selectedText = selected !== undefined ? textOf(selected) : undefined
  const [text, setText] = useState(selectedText ?? '')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)

  // An external value change (or async options delivering the selected row)
  // re-dresses the field with the selected label.
  useEffect(() => {
    if (selectedText !== undefined) setText(selectedText)
  }, [selectedText])

  const query = text.trim().toLowerCase()
  const rows = onInputValueChange !== undefined || query === '' || text === selectedText
    ? options
    : options.filter(option => textOf(option).toLowerCase().includes(query))
  const optionId = (index: number): string => `${listId}-${index}`

  useEffect(() => {
    if (active < 0) return
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' })
  })

  const close = (): void => {
    setOpen(false)
    setActive(-1)
  }
  const choose = (option: SelectOption): void => {
    if (option.disabled === true) return
    if (value === undefined) setUncontrolled(option.value)
    setText(textOf(option))
    onValueChange?.(option.value)
    close()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      setActive(index => nextEnabled(rows, index, event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (event.key === 'Enter' && open && active >= 0) {
      const option = rows[active]
      if (option !== undefined) {
        event.preventDefault()
        choose(option)
      }
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      close()
    }
  }

  return (
    <span {...part('combobox', 'root')} className="snap-combobox">
      <Popover open={open && !disabled} onOpenChange={next => { if (!next) close() }}>
        <PopoverAnchor asChild>
          <span ref={anchorRef} {...part('combobox', 'anchor')}>
            <Input
              id={id}
              size={size}
              invalid={invalid}
              disabled={disabled}
              placeholder={placeholder}
              className={className}
              value={text}
              role="combobox"
              autoComplete="off"
              aria-label={ariaLabel}
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
              onChange={event => {
                setText(event.target.value)
                setActive(-1)
                setOpen(true)
                onInputValueChange?.(event.target.value)
              }}
              onFocus={() => setOpen(true)}
              onBlur={close}
              onKeyDown={onKeyDown}
            />
          </span>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          sideOffset={4}
          autoFocusOnOpen={false}
          className={contentClassName}
          onInteractOutside={event => {
            // A press on the field itself is not "outside": keep the list open.
            if (anchorRef.current?.contains(event.target as Node) === true) event.preventDefault()
          }}
        >
          <div {...part('combobox', 'list')} role="listbox" id={listId}>
            {rows.map((option, index) => (
              <div
                key={option.value}
                {...part('combobox', 'option')}
                id={optionId(index)}
                role="option"
                aria-selected={option.value === current}
                aria-disabled={option.disabled === true || undefined}
                data-active={index === active || undefined}
                data-disabled={option.disabled === true || undefined}
                onMouseDown={event => event.preventDefault()}
                onClick={() => choose(option)}
              >
                {option.label}
              </div>
            ))}
            {loading && <div {...part('combobox', 'empty')}>搜索中…</div>}
            {!loading && rows.length === 0 && <div {...part('combobox', 'empty')}>{emptyText}</div>}
          </div>
        </PopoverContent>
      </Popover>
    </span>
  )
}
