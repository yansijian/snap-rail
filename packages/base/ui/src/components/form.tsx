/**
 * Form semantics: a field owns its label/control/help/error anatomy; a form
 * owns its fields/actions regions. Validation stays with the page (or a
 * schema renderer); the parts carry `data-invalid` for the skin. React Hook
 * Form wiring lives in `./form-rhf.tsx`.
 *
 * @module @snap-rail/ui/components/form
 */

import type { CSSProperties, FormEvent, ReactNode } from 'react'
import { FormProvider, type FieldValues, type SubmitErrorHandler, type SubmitHandler, type UseFormReturn } from 'react-hook-form'
import { cn, part, space } from '../utils.ts'
import { Label } from './controls.tsx'

/** Which side of the control the label and its message column occupy. */
export type FieldOrientation = 'vertical' | 'horizontal'

/** Props of {@link Field}. */
export interface FieldProps {
  label?: ReactNode
  htmlFor?: string
  help?: ReactNode
  error?: ReactNode
  invalid?: boolean
  required?: boolean
  /** Place the label beside the control (default `vertical`, label on top). */
  orientation?: FieldOrientation
  /** In horizontal orientation, the label column's width (px or any CSS width). */
  labelWidth?: number | string
  /** In horizontal orientation, the label's text alignment (default `start`). */
  labelAlign?: 'start' | 'end'
  children: ReactNode
  className?: string
  style?: CSSProperties
}

/** A labelled form row. */
export function Field({
  label,
  htmlFor,
  help,
  error,
  invalid = false,
  required = false,
  orientation = 'vertical',
  labelWidth,
  labelAlign = 'start',
  children,
  className,
  style,
}: FieldProps): ReactNode {
  const bad = invalid || error !== undefined
  return (
    <div
      {...part('field', 'root')}
      className={cn('snap-field', className)}
      data-invalid={bad || undefined}
      data-required={required || undefined}
      data-orientation={orientation}
      style={style}
    >
      {label !== undefined && (
        <Label
          {...htmlFor !== undefined ? { htmlFor } : {}}
          {...part('field', 'label')}
          style={{
            ...labelWidth !== undefined ? { width: typeof labelWidth === 'number' ? `${labelWidth}px` : labelWidth, flexShrink: 0 } : {},
            ...labelAlign !== 'start' ? { textAlign: labelAlign } : {},
          }}
        >
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

/** How a {@link Form} lays out its fields region. */
export type FormOrientation = 'stack' | 'inline' | 'grid'

/** Props of {@link Form}. */
export interface FormProps<TFieldValues extends FieldValues = FieldValues> {
  children?: ReactNode
  actions?: ReactNode
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void
  className?: string
  /** `stack` (default) flows fields vertically; `inline` wraps them in a row
   * with the actions inlined at the end; `grid` arranges them in `columns`. */
  orientation?: FormOrientation
  /** The gap token between fields (default `md`). */
  gap?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  /** In `grid` orientation, the column count (default 2). */
  columns?: number
  /** Provide a React Hook Form instance to publish its context (so
   * `FormField` and friends work) and wire submission through
   * `form.handleSubmit`. */
  form?: UseFormReturn<TFieldValues>
  /** With `form`, called with the validated values on submit. */
  onValid?: SubmitHandler<TFieldValues>
  /** With `form`, called with the validation errors when submit fails. */
  onInvalid?: SubmitErrorHandler<TFieldValues>
}

/** A form with a fields region and an actions region. */
export function Form<TFieldValues extends FieldValues = FieldValues>({
  children,
  actions,
  onSubmit,
  className,
  orientation = 'stack',
  gap = 'md',
  columns = 2,
  form,
  onValid,
  onInvalid,
}: FormProps<TFieldValues>): ReactNode {
  const fieldsStyle: CSSProperties = orientation === 'grid'
    ? { display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: space(gap) }
    : orientation === 'inline'
      ? { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: space(gap) }
      : { display: 'flex', flexDirection: 'column', gap: space(gap) }
  const body = (
    <>
      <div {...part('form', 'fields')} className="snap-form-fields" style={fieldsStyle}>
        {children}
      </div>
      {actions !== undefined && <div {...part('form', 'actions')} className="snap-form-actions">{actions}</div>}
    </>
  )
  const submit = form !== undefined && onValid !== undefined
    ? form.handleSubmit(onValid, onInvalid)
    : onSubmit
  if (form === undefined) {
    return (
      <form {...part('form', 'root')} className={cn('snap-form', className)} data-orientation={orientation} onSubmit={submit}>
        {body}
      </form>
    )
  }
  return (
    <FormProvider {...form}>
      <form {...part('form', 'root')} className={cn('snap-form', className)} data-orientation={orientation} onSubmit={submit}>
        {body}
      </form>
    </FormProvider>
  )
}
