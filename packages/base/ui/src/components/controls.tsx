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
import { useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { cn, part } from '../utils.ts'
import { Button } from './button.tsx'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './dialog.tsx'

/** A form label. */
export function Label({ className, children, ...props }: ComponentPropsWithoutRef<typeof LabelPrimitive.Root>): ReactNode {
  return <LabelPrimitive.Root className={cn('snap-label', className)} {...props}>{children}</LabelPrimitive.Root>
}

/** The tabs root. */
export const Tabs = TabsPrimitive.Root

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
}

/** A boolean switch. */
export function Switch({ className, label, ...props }: SwitchProps): ReactNode {
  return (
    <label className="snap-switch-label">
      <SwitchPrimitive.Root {...part('switch', 'root')} className={cn('snap-switch', className)} {...props}>
        <SwitchPrimitive.Thumb {...part('switch', 'thumb')} className="snap-switch-thumb" />
      </SwitchPrimitive.Root>
      {label !== undefined && <span {...part('switch', 'label')}>{label}</span>}
    </label>
  )
}

/** Props of {@link Checkbox}. */
export interface CheckboxProps extends Omit<ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>, 'children'> {
  label?: ReactNode
}

/** A tri-state checkbox with an inline indicator. */
export function Checkbox({ className, label, ...props }: CheckboxProps): ReactNode {
  return (
    <label className="snap-checkbox-label">
      <CheckboxPrimitive.Root {...part('checkbox', 'root')} className={cn('snap-checkbox', className)} {...props}>
        <CheckboxPrimitive.Indicator {...part('checkbox', 'indicator')} className="snap-checkbox-indicator">
          ✓
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      {label !== undefined && <span {...part('checkbox', 'label')}>{label}</span>}
    </label>
  )
}

/** The radio group root. */
export function RadioGroup({ className, children, ...props }: ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>): ReactNode {
  return <RadioGroupPrimitive.Root {...part('radio-group', 'root')} className={cn('snap-radio-group', className)} {...props}>{children}</RadioGroupPrimitive.Root>
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

/** Props of {@link Select}. */
export interface SelectProps {
  value?: string
  onValueChange?: (value: string) => void
  options: readonly SelectOption[]
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  size?: 'sm' | 'md' | 'lg'
  className?: string
  'aria-label'?: string
}

/** Props of {@link TouchSelect}: a modal list for gloved/touch operation. */
export interface TouchSelectProps extends SelectProps {
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
    <>
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
      >
        <span style={{ flex: 1, textAlign: 'left' }}>{selected?.label ?? placeholder}</span>
        <span aria-hidden="true">▾</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent presentation="modal" size="sm">
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
              >
                {option.label}
              </Button>
            ))}
            {options.length === 0 && <span style={{ color: 'var(--snap-color-muted)' }}>无可选项</span>}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** A popover select. */
export function Select({
  value,
  onValueChange,
  options,
  placeholder = '请选择',
  disabled = false,
  invalid = false,
  size = 'md',
  className,
  'aria-label': ariaLabel,
}: SelectProps): ReactNode {
  return (
    <SelectPrimitive.Root
      {...value !== undefined ? { value } : {}}
      {...onValueChange !== undefined ? { onValueChange } : {}}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        {...part('select', 'trigger')}
        className={cn('snap-select-trigger', className)}
        data-size={size}
        data-invalid={invalid || undefined}
        data-disabled={disabled || undefined}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
      >
        <SelectPrimitive.Value {...part('select', 'value')} placeholder={placeholder} />
        <SelectPrimitive.Icon {...part('select', 'chevron')} className="snap-select-chevron">▾</SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content {...part('select', 'content')} className="snap-select-content" position="popper" sideOffset={4}>
          <SelectPrimitive.Viewport>
            {options.map(option => (
              <SelectPrimitive.Item
                key={option.value}
                {...part('select', 'item')}
                className="snap-select-item"
                value={option.value}
                disabled={option.disabled === true}
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator {...part('select', 'item-indicator')} className="snap-select-item-indicator">✓</SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
            {options.length === 0 && <div {...part('select', 'empty')} className="snap-select-empty">无可选项</div>}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}