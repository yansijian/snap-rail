/**
 * Selection and toggle semantics over Radix: tabs, select, switch, checkbox,
 * and radio groups. All behaviour/keyboard handling stays here; skins target
 * the stable parts and state attributes.
 *
 * @module @snap-rail/ui/components/controls
 */

import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import * as LabelPrimitive from '@radix-ui/react-label'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import * as SelectPrimitive from '@radix-ui/react-select'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { useId, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { cn, part } from '../utils.ts'
import { Button } from './button.tsx'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './dialog.tsx'

/** A form label. */
export function Label({ className, children, ...props }: ComponentPropsWithoutRef<typeof LabelPrimitive.Root>): ReactNode {
  return <LabelPrimitive.Root className={cn('snap-label', className)} {...props}>{children}</LabelPrimitive.Root>
}

/** The tabs root. */
export function Tabs({ className, children, ...props }: ComponentPropsWithoutRef<typeof TabsPrimitive.Root>): ReactNode {
  return <TabsPrimitive.Root {...part('tabs', 'root')} className={cn('snap-tabs', className)} {...props}>{children}</TabsPrimitive.Root>
}

/** The tabs list. */
export function TabsList({ className, children, ...props }: ComponentPropsWithoutRef<typeof TabsPrimitive.List>): ReactNode {
  return <TabsPrimitive.List {...part('tabs', 'list')} className={cn('snap-tabs-list', className)} {...props}>{children}</TabsPrimitive.List>
}

/** A tab trigger. */
export function TabsTrigger({ className, children, ...props }: ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>): ReactNode {
  return <TabsPrimitive.Trigger {...part('tabs', 'trigger')} className={cn('snap-tabs-trigger', className)} {...props}>{children}</TabsPrimitive.Trigger>
}

/** A tab panel. */
export function TabsContent({ className, children, ...props }: ComponentPropsWithoutRef<typeof TabsPrimitive.Content>): ReactNode {
  return <TabsPrimitive.Content {...part('tabs', 'content')} className={cn('snap-tabs-content', className)} {...props}>{children}</TabsPrimitive.Content>
}

/** Props of {@link Switch}. */
export interface SwitchProps extends Omit<ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>, 'children'> {
  label?: ReactNode
  /** Which side of the switch the label sits on (default `end`). */
  labelPosition?: 'start' | 'end'
  /** Helper text under the label row. */
  description?: ReactNode
  /** Escape hatch for the outermost wrapper (only rendered with `description`). */
  containerClassName?: string
}

/** A boolean switch with an optional label on either side. */
export function Switch({ className, label, labelPosition = 'end', description, containerClassName, ...props }: SwitchProps): ReactNode {
  const labelNode = label !== undefined && <span {...part('switch', 'label')}>{label}</span>
  const row = (
    <label className="snap-switch-label">
      {labelPosition === 'start' && labelNode}
      <SwitchPrimitive.Root {...part('switch', 'root')} className={cn('snap-switch', className)} {...props}>
        <SwitchPrimitive.Thumb {...part('switch', 'thumb')} className="snap-switch-thumb" />
      </SwitchPrimitive.Root>
      {labelPosition === 'end' && labelNode}
    </label>
  )
  if (description === undefined) return row
  return (
    <span {...part('switch', 'field')} className={cn('snap-switch-field', containerClassName)}>
      {row}
      <span {...part('switch', 'description')} className="snap-field-help">{description}</span>
    </span>
  )
}

/** Props of {@link Checkbox}. */
export interface CheckboxProps extends Omit<ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>, 'children'> {
  label?: ReactNode
  /** Which side of the checkbox the label sits on (default `end`). */
  labelPosition?: 'start' | 'end'
  /** Helper text under the label row. */
  description?: ReactNode
  /** Escape hatch for the outermost wrapper (only rendered with `description`). */
  containerClassName?: string
}

/** A tri-state checkbox with an optional label on either side. */
export function Checkbox({ className, label, labelPosition = 'end', description, containerClassName, ...props }: CheckboxProps): ReactNode {
  const labelNode = label !== undefined && <span {...part('checkbox', 'label')}>{label}</span>
  const row = (
    <label className="snap-checkbox-label">
      {labelPosition === 'start' && labelNode}
      <CheckboxPrimitive.Root {...part('checkbox', 'root')} className={cn('snap-checkbox', className)} {...props}>
        <CheckboxPrimitive.Indicator {...part('checkbox', 'indicator')} className="snap-checkbox-indicator">
          ✓
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      {labelPosition === 'end' && labelNode}
    </label>
  )
  if (description === undefined) return row
  return (
    <span {...part('checkbox', 'field')} className={cn('snap-checkbox-field', containerClassName)}>
      {row}
      <span {...part('checkbox', 'description')} className="snap-field-help">{description}</span>
    </span>
  )
}

/** Props of {@link RadioGroup}. */
export interface RadioGroupProps extends ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root> {
  /** A label above the group; linked via `aria-labelledby`. */
  label?: ReactNode
  /** Helper text below the group. */
  description?: ReactNode
}

/** A labelled group of radio items. */
export function RadioGroup({ className, label, description, children, ...props }: RadioGroupProps): ReactNode {
  const labelId = useId()
  const group = (
    <RadioGroupPrimitive.Root
      {...part('radio-group', 'root')}
      className={cn('snap-radio-group', className)}
      {...label !== undefined ? { 'aria-labelledby': labelId } : {}}
      {...props}
    >
      {children}
    </RadioGroupPrimitive.Root>
  )
  if (label === undefined && description === undefined) return group
  return (
    <div {...part('radio-group', 'block')} className="snap-radio-group-block">
      {label !== undefined && <Label id={labelId} {...part('radio-group', 'label')}>{label}</Label>}
      {group}
      {description !== undefined && <div {...part('radio-group', 'description')} className="snap-field-help">{description}</div>}
    </div>
  )
}

/** One radio item. */
export function RadioGroupItem({ className, ...props }: ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>): ReactNode {
  return (
    <RadioGroupPrimitive.Item {...part('radio-group', 'item')} className={cn('snap-radio-item', className)} {...props}>
      <RadioGroupPrimitive.Indicator {...part('radio-group', 'indicator')} className="snap-radio-indicator" />
    </RadioGroupPrimitive.Item>
  )
}

/** One option in a {@link Select} or {@link TouchSelect}. */
export interface SelectOption {
  value: string
  label: ReactNode
  disabled?: boolean
}

/** The popper side the select content opens to. */
export type SelectSide = 'top' | 'right' | 'bottom' | 'left'

/** Props of {@link Select}. */
export interface SelectProps {
  /** Controlled value. */
  value?: string
  /** Uncontrolled initial value. */
  defaultValue?: string
  onValueChange?: (value: string) => void
  /** Data-driven options; mutually exclusive with `children` (children win). */
  options?: readonly SelectOption[]
  /** Composite mode: build the content from {@link SelectItem} children. */
  children?: ReactNode
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  /** Associates a hidden native select for form submission. */
  name?: string
  required?: boolean
  /** The trigger's id; also wires the label's `htmlFor`. */
  id?: string
  size?: 'sm' | 'md' | 'lg'
  /** Content placement (default `bottom`). */
  side?: SelectSide
  /** Content alignment against the trigger (default `start`). */
  align?: 'start' | 'center' | 'end'
  /** Content offset from the trigger in px (default 4). */
  sideOffset?: number
  className?: string
  contentClassName?: string
  'aria-label'?: string
}

/** Props of {@link TouchSelect}: a modal list for gloved/touch operation. */
export interface TouchSelectProps extends Omit<SelectProps, 'options' | 'children'> {
  options: readonly SelectOption[]
  title?: ReactNode
}

/** A modal option list; use on touch terminals in place of the popover select. */
export function TouchSelect({
  value,
  onValueChange,
  options,
  placeholder = '请选择',
  disabled = false,
  invalid = false,
  size = 'md',
  className,
  'aria-label': ariaLabel,
  title,
}: TouchSelectProps): ReactNode {
  const [open, setOpen] = useState(false)
  const selected = options.find(option => option.value === value)
  return (
    <span {...part('touch-select', 'root')} className="snap-touch-select">
      <Button
        type="button"
        size={size}
        emphasis="outline"
        className={className}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        {...part('touch-select', 'trigger')}
      >
        <span style={{ flex: 1, textAlign: 'left' }}>{selected?.label ?? placeholder}</span>
        <span aria-hidden="true">▾</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent presentation="modal" size="sm" {...part('touch-select', 'sheet')}>
          <DialogHeader><DialogTitle>{title ?? ariaLabel ?? '请选择'}</DialogTitle></DialogHeader>
          <div {...part('touch-select', 'options')} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--snap-space-sm)' }}>
            {options.map(option => (
              <Button
                key={option.value}
                type="button"
                size="lg"
                emphasis={option.value === value ? 'solid' : 'outline'}
                intent={option.value === value ? 'primary' : 'neutral'}
                disabled={option.disabled === true}
                onClick={() => {
                  onValueChange?.(option.value)
                  setOpen(false)
                }}
                {...part('touch-select', 'option')}
              >
                {option.label}
              </Button>
            ))}
            {options.length === 0 && <span style={{ color: 'var(--snap-color-muted)' }}>无可选项</span>}
          </div>
        </DialogContent>
      </Dialog>
    </span>
  )
}

/** The select trigger; composes a {@link SelectValue} inside. */
export function SelectTrigger({
  className,
  size = 'md',
  invalid = false,
  disabled = false,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & { size?: 'sm' | 'md' | 'lg', invalid?: boolean }): ReactNode {
  return (
    <SelectPrimitive.Trigger
      {...part('select', 'trigger')}
      className={cn('snap-select-trigger', className)}
      data-size={size}
      data-invalid={invalid || undefined}
      data-disabled={disabled || undefined}
      aria-invalid={invalid || undefined}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon {...part('select', 'chevron')} className="snap-select-chevron">▾</SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

/** The selected-value slot of a trigger. */
export function SelectValue(props: ComponentPropsWithoutRef<typeof SelectPrimitive.Value>): ReactNode {
  return <SelectPrimitive.Value {...part('select', 'value')} {...props} />
}

/** Props of {@link SelectContent}. */
export interface SelectContentProps extends ComponentPropsWithoutRef<typeof SelectPrimitive.Content> {
  side?: SelectSide
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
}

/** The portalled option list. */
export function SelectContent({ side = 'bottom', align = 'start', sideOffset = 4, className, children, ...props }: SelectContentProps): ReactNode {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        {...part('select', 'content')}
        className={cn('snap-select-content', className)}
        position="popper"
        side={side}
        align={align}
        sideOffset={sideOffset}
        {...props}
      >
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

/** One option row. */
export function SelectItem({ className, children, ...props }: ComponentPropsWithoutRef<typeof SelectPrimitive.Item>): ReactNode {
  return (
    <SelectPrimitive.Item {...part('select', 'item')} className={cn('snap-select-item', className)} {...props}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator {...part('select', 'item-indicator')} className="snap-select-item-indicator">✓</SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

/** A labelled group of options. */
export function SelectGroup(props: ComponentPropsWithoutRef<typeof SelectPrimitive.Group>): ReactNode {
  return <SelectPrimitive.Group {...props} />
}

/** A group heading. */
export function SelectLabel({ className, ...props }: ComponentPropsWithoutRef<typeof SelectPrimitive.Label>): ReactNode {
  return <SelectPrimitive.Label className={cn('snap-select-label', className)} {...props} />
}

/** A popover select: data-driven via `options`, or composed from
 * {@link SelectItem} children for full layout control. */
export function Select({
  value,
  defaultValue,
  onValueChange,
  options,
  children,
  placeholder = '请选择',
  disabled = false,
  invalid = false,
  required,
  name,
  id,
  size = 'md',
  side = 'bottom',
  align = 'start',
  sideOffset = 4,
  className,
  contentClassName,
  'aria-label': ariaLabel,
}: SelectProps): ReactNode {
  const composite = children !== undefined
  const empty = !composite && (options ?? []).length === 0
  return (
    <span {...part('select', 'root')} className="snap-select">
      <SelectPrimitive.Root
        {...value !== undefined ? { value } : {}}
        {...defaultValue !== undefined ? { defaultValue } : {}}
        {...onValueChange !== undefined ? { onValueChange } : {}}
        disabled={disabled}
        {...name !== undefined ? { name } : {}}
        {...required !== undefined ? { required } : {}}
      >
        <SelectTrigger id={id} size={size} invalid={invalid} disabled={disabled} className={className} aria-label={ariaLabel}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent side={side} align={align} sideOffset={sideOffset} className={contentClassName}>
          {composite
            ? children
            : (options ?? []).map(option => (
              <SelectItem key={option.value} value={option.value} disabled={option.disabled === true}>
                {option.label}
              </SelectItem>
            ))}
          {empty && <div {...part('select', 'empty')} className="snap-select-empty">无可选项</div>}
        </SelectContent>
      </SelectPrimitive.Root>
    </span>
  )
}