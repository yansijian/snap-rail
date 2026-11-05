/**
 * React Hook Form integration in the shadcn composite shape: `FormField`
 * binds a controller, `FormItem`/`FormLabel`/`FormControl`/
 * `FormDescription`/`FormMessage` render the same `field.*` anatomy the plain
 * {@link Field} uses, driven by the form state. The RHF hooks and
 * `zodResolver` are re-exported so plugin bundles consume the seed's single
 * module instance — RHF context is module-scoped, and a copy bundled inside a
 * plugin zip would never see the form state.
 *
 * @module @snap-rail/ui/components/form-rhf
 */

import { Slot } from '@radix-ui/react-slot'
import { Controller, useFormState, type ControllerProps, type FieldPath, type FieldValues } from 'react-hook-form'
import { createContext, useContext, useId, type ReactNode } from 'react'
import { cn, part } from '../utils.ts'
import { Label } from './controls.tsx'
import type { FieldOrientation } from './form.tsx'

export {
  Controller,
  FormProvider,
  useController,
  useFieldArray,
  useForm,
  useFormContext,
  useFormState,
  useWatch,
} from 'react-hook-form'

export type {
  Control,
  DefaultValues,
  FieldError,
  FieldPath,
  FieldValues,
  Path,
  PathValue,
  Resolver,
  SubmitErrorHandler,
  SubmitHandler,
  UseFormReturn,
} from 'react-hook-form'

export { zodResolver } from '@hookform/resolvers/zod'

/** The control name the anatomy parts share. */
interface FormFieldBinding {
  name: string
}

const FormFieldContext = createContext<FormFieldBinding | null>(null)
const FormItemContext = createContext<{ id: string } | null>(null)

/** Read the enclosing field binding; fails loud outside a {@link FormField}. */
function useFormField(): { id: string, name: string } {
  const field = useContext(FormFieldContext)
  const item = useContext(FormItemContext)
  if (field === null || item === null) throw new Error('表单字段部件必须渲染在 FormField 内')
  return { id: item.id, name: field.name }
}

/** Props of {@link FormField}. */
export interface FormFieldProps<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> extends Omit<ControllerProps<TFieldValues, TName>, 'render'> {
  render: ControllerProps<TFieldValues, TName>['render']
}

/** Bind a controller and expose its name to the anatomy parts inside. */
export function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>(props: FormFieldProps<TFieldValues, TName>): ReactNode {
  const name = props.name
  return (
    <FormFieldContext.Provider value={{ name }}>
      <Controller {...props} name={name} render={props.render} />
    </FormFieldContext.Provider>
  )
}

/** Props of {@link FormItem}. */
export interface FormItemProps {
  children?: ReactNode
  className?: string
  /** Place the label beside the control (default `vertical`, label on top). */
  orientation?: FieldOrientation
}

/** The field row: owns the shared id every aria attribute anchors to. */
export function FormItem({ children, className, orientation = 'vertical' }: FormItemProps): ReactNode {
  const id = useId()
  return (
    <FormItemContext.Provider value={{ id }}>
      <div
        {...part('field', 'root')}
        className={cn('snap-field', className)}
        data-orientation={orientation}
      >
        {children}
      </div>
    </FormItemContext.Provider>
  )
}

/** The field label; carries `data-invalid` when the field has an error. */
export function FormLabel({ className, children }: { className?: string, children?: ReactNode }): ReactNode {
  const { id, name } = useFormField()
  const formState = useFormState({ name })
  const invalid = formState.errors[name] !== undefined
  return (
    <Label
      htmlFor={id}
      {...part('field', 'label')}
      className={cn('snap-form-label', className)}
      data-invalid={invalid || undefined}
    >
      {children}
    </Label>
  )
}

/** Merges the field binding onto the single control child it wraps. */
export function FormControl({ children }: { children: ReactNode }): ReactNode {
  const { id, name } = useFormField()
  const formState = useFormState({ name })
  const invalid = formState.errors[name] !== undefined
  return (
    <Slot
      id={id}
      aria-invalid={invalid || undefined}
      aria-describedby={`${id}-description ${id}-message`}
    >
      {children}
    </Slot>
  )
}

/** Helper text under the control; linked as `aria-describedby`. */
export function FormDescription({ className, children }: { className?: string, children?: ReactNode }): ReactNode {
  const { id } = useFormField()
  return (
    <div {...part('field', 'help')} id={`${id}-description`} className={cn('snap-field-help', className)}>
      {children}
    </div>
  )
}

/** Props of {@link FormMessage}. */
export interface FormMessageProps {
  /** Overrides the error text from the form state. */
  message?: ReactNode
  children?: ReactNode
  className?: string
}

/** The validation message for the bound field. */
export function FormMessage({ message, children, className }: FormMessageProps): ReactNode {
  const { id, name } = useFormField()
  const formState = useFormState({ name })
  const error = formState.errors[name]
  // A nested field's error carries a FieldError tree, not renderable text —
  // fall back to `children` in that case.
  const raw = error?.message
  const body = message
    ?? (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'bigint' || typeof raw === 'boolean' ? String(raw) : undefined)
    ?? children
  if (body === undefined || body === '') return null
  return (
    <div {...part('field', 'error')} id={`${id}-message`} className={cn('snap-field-error', className)} role="alert">
      {body}
    </div>
  )
}
