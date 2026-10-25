/**
 * Text-entry semantics: the wrapper owns the anatomy (prefix/suffix/clear),
 * the native field keeps keyboard and IME behaviour. Skins style the parts.
 *
 * @module @snap-rail/ui/components/input
 */

import type { ComponentPropsWithoutRef, ReactNode } from 'react'
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

/** A single-line text field with semantic prefix/suffix slots. */
export function Input({
  size = 'md',
  invalid = false,
  prefix,
  suffix,
  onClear,
  componentName = 'input',
  className,
  disabled,
  ...props
}: InputProps): ReactNode {
  return (
    <div
      {...part(componentName, 'root')}
      className={cn('snap-input', className)}
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

/** A multi-line text field. */
export function Textarea({
  size = 'md',
  invalid = false,
  className,
  disabled,
  ...props
}: TextareaProps): ReactNode {
  return (
    <div
      {...part('textarea', 'root')}
      className={cn('snap-textarea', className)}
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

/** A numeric field with the numeric keyboard hint and native stepping. */
export function NumberInput({ min, max, step, ...props }: NumberInputProps): ReactNode {
  return (
    <Input
      {...props}
      componentName="number-input"
      type="number"
      inputMode="decimal"
      {...min !== undefined ? { min } : {}}
      {...max !== undefined ? { max } : {}}
      {...step !== undefined ? { step } : {}}
    />
  )
}