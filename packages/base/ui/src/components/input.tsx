/**
 * Text-entry semantics: the wrapper owns the anatomy (prefix/suffix/clear),
 * the native field keeps keyboard and IME behaviour. Skins style the parts.
 *
 * @module @snap-rail/ui/components/input
 */

import { useRef, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { cn, part } from '../utils.ts'

/** The control size shared by single-line inputs. */
export type InputSize = 'sm' | 'md' | 'lg'

/** Props of {@link Input}. */
export interface InputProps extends Omit<ComponentPropsWithoutRef<'input'>, 'size' | 'prefix'> {
  size?: InputSize
  invalid?: boolean
  prefix?: ReactNode
  suffix?: ReactNode
  onClear?: (() => void) | undefined
  /** Internal anatomy name so NumberInput can reuse the field. */
  componentName?: 'input' | 'number-input'
}

/** A single-line text field with semantic prefix/suffix slots. Layout
 * `style`/`className` dress the wrapper — the visible control; the native
 * field already stretches inside it. */
export function Input({
  size = 'md',
  invalid = false,
  prefix,
  suffix,
  onClear,
  componentName = 'input',
  className,
  style,
  disabled,
  ...props
}: InputProps): ReactNode {
  return (
    <div
      {...part(componentName, 'root')}
      className={cn('snap-input', className)}
      style={style}
      data-size={size}
      data-invalid={invalid || undefined}
      data-disabled={disabled === true || undefined}
    >
      {prefix !== undefined && <span {...part(componentName, 'prefix')}>{prefix}</span>}
      <input
        {...part(componentName, 'field')}
        className="snap-input-field"
        disabled={disabled}
        aria-invalid={invalid || undefined}
        {...props}
      />
      {onClear !== undefined && typeof props.value === 'string' && props.value !== '' && (
        <button
          {...part(componentName, 'clear')}
          type="button"
          className="snap-input-clear"
          aria-label="清除"
          onClick={onClear}
        >
          ×
        </button>
      )}
      {suffix !== undefined && <span {...part(componentName, 'suffix')}>{suffix}</span>}
    </div>
  )
}

/** Props of {@link Textarea}. */
export interface TextareaProps extends Omit<ComponentPropsWithoutRef<'textarea'>, 'size'> {
  size?: InputSize
  invalid?: boolean
}

/** A multi-line text field. Like {@link Input}, layout `style`/`className`
 * dress the wrapper; the field stretches inside it. */
export function Textarea({
  size = 'md',
  invalid = false,
  className,
  style,
  disabled,
  ...props
}: TextareaProps): ReactNode {
  return (
    <div
      {...part('textarea', 'root')}
      className={cn('snap-textarea', className)}
      style={style}
      data-size={size}
      data-invalid={invalid || undefined}
      data-disabled={disabled === true || undefined}
    >
      <textarea
        {...part('textarea', 'field')}
        className="snap-textarea-field"
        disabled={disabled}
        aria-invalid={invalid || undefined}
        {...props}
      />
    </div>
  )
}

/** Props of {@link NumberInput}. */
export interface NumberInputProps extends Omit<InputProps, 'type' | 'prefix' | 'suffix' | 'onClear'> {
  min?: number
  max?: number
  step?: number
}

/** A numeric field with touch steppers: `step-up`/`step-down` commit through
 * the normal `onChange` (a native input event on the field), clamped to
 * `min`/`max`. */
export function NumberInput({
  min,
  max,
  step = 1,
  size = 'md',
  invalid = false,
  className,
  style,
  disabled,
  value,
  onChange,
  ...props
}: NumberInputProps): ReactNode {
  const fieldRef = useRef<HTMLInputElement>(null)
  const current = typeof value === 'number' ? value : undefined
  const stepBy = (delta: number): void => {
    const field = fieldRef.current
    if (field === null || disabled === true) return
    const parsed = typeof value === 'number' ? value : Number(field.value)
    let next = (Number.isFinite(parsed) ? parsed : (min ?? 0)) + delta * step
    if (min !== undefined && next < min) next = min
    if (max !== undefined && next > max) next = max
    // Commit through the native setter + input event so controlled consumers
    // observe a regular change event on the field itself.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, String(next))
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }
  return (
    <div
      {...part('number-input', 'root')}
      className={cn('snap-input', 'snap-number-input', className)}
      style={style}
      data-size={size}
      data-invalid={invalid || undefined}
      data-disabled={disabled === true || undefined}
    >
      <input
        ref={fieldRef}
        {...part('number-input', 'field')}
        className="snap-input-field"
        type="number"
        inputMode="decimal"
        disabled={disabled}
        aria-invalid={invalid || undefined}
        value={value}
        onChange={onChange}
        {...min !== undefined ? { min } : {}}
        {...max !== undefined ? { max } : {}}
        {...step !== undefined ? { step } : {}}
        {...props}
      />
      <span className="snap-number-input-steps">
        <button
          {...part('number-input', 'step-up')}
          type="button"
          tabIndex={-1}
          className="snap-number-input-step"
          aria-label="增大"
          disabled={disabled === true || (current !== undefined && max !== undefined && current >= max)}
          onClick={() => stepBy(1)}
        >
          ＋
        </button>
        <button
          {...part('number-input', 'step-down')}
          type="button"
          tabIndex={-1}
          className="snap-number-input-step"
          aria-label="减小"
          disabled={disabled === true || (current !== undefined && min !== undefined && current <= min)}
          onClick={() => stepBy(-1)}
        >
          －
        </button>
      </span>
    </div>
  )
}