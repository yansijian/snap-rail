/**
 * Select: themed picker over Radix Select (trigger, popover list, item
 * check). Icons are inline strokes so the UI seam needs no icon dependency.
 *
 * @module @snap-rail/client-ui/select
 */

import * as SelectPrimitive from '@radix-ui/react-select'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from './utils.ts'

/** Controlled/uncontrolled root; re-exported so callers need one import. */
export const Select = SelectPrimitive.Root

/** The value summary part inside the trigger. */
export const SelectValue = SelectPrimitive.Value

/** A minimal chevron; inline so the seam carries no asset files. */
function ChevronDown(): ReactNode {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 opacity-60" fill="none" aria-hidden="true">
      <path d="m2.5 4.5 3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The item's checked mark, mirroring the Checkbox indicator stroke. */
function CheckIcon(): ReactNode {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden="true">
      <path d="M2 6.5 4.8 9 10 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The closed control: current value plus the chevron. */
export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'flex h-8 w-full items-center justify-between gap-1 rounded-md border border-input bg-transparent px-2 py-1 text-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon><ChevronDown /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

/** The popover list; portals into body with the popover surface. */
export function SelectContent({ className, children, position = 'popper', ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        className={cn(
          'z-50 max-h-72 min-w-[8rem] overflow-auto rounded-md border border-border bg-popover text-popover-foreground shadow-xl',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

/** One option: check mark when selected, muted when disabled. */
export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-sm py-1.5 pl-6 pr-2 text-sm outline-none',
        'data-[state=checked]:font-medium data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <span className="absolute left-1 flex items-center justify-center">
        <SelectPrimitive.ItemIndicator><CheckIcon /></SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}
