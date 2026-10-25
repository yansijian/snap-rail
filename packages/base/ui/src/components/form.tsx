/**
 * Form semantics: a field owns its label/control/help/error anatomy; a form
 * owns its fields/actions regions. Validation stays with the page (or a
 * schema renderer); the parts carry `data-invalid` for the skin.
 *
 * @module @snap-rail/ui/components/form
 */

import type { FormEvent, ReactNode } from 'react'
import { cn, part } from '../utils.ts'
import { Label } from './controls.tsx'

/** Props of {@link Field}. */
export interface FieldProps {
  label?: ReactNode
  htmlFor?: string
  help?: ReactNode
  error?: ReactNode
  invalid?: boolean
  required?: boolean
  children: ReactNode
  className?: string
}

/** A labelled form row. */
export function Field({
  label,
  htmlFor,
  help,
  error,
  invalid = false,
  required = false,
  children,
  className,
}: FieldProps): ReactNode {
  const bad = invalid || error !== undefined
  return (
    <div {...part('field', 'root')} className={cn('snap-field', className)} data-invalid={bad || undefined} data-required={required || undefined}>
      {label !== undefined && (
        <Label {...htmlFor !== undefined ? { htmlFor } : {}} {...part('field', 'label')}>
          {label}
          {required && <span aria-hidden="true"> *</span>}
        </Label>
      )}
      <div {...part('field', 'control')}>{children}</div>
      {help !== undefined && error === undefined && <div {...part('field', 'help')} className="snap-field-help">{help}</div>}
      {error !== undefined && <div {...part('field', 'error')} className="snap-field-error" role="alert">{error}</div>}
    </div>
  )
}

/** Props of {@link Form}. */
export interface FormProps {
  children?: ReactNode
  actions?: ReactNode
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void
  className?: string
}

/** A form with a fields region and an actions region. */
export function Form({ children, actions, onSubmit, className }: FormProps): ReactNode {
  return (
    <form {...part('form', 'root')} className={cn('snap-form', className)} onSubmit={onSubmit}>
      <div {...part('form', 'fields')} className="snap-form-fields">{children}</div>
      {actions !== undefined && <div {...part('form', 'actions')} className="snap-form-actions">{actions}</div>}
    </form>
  )
}