/**
 * Collapsible: the shadcn collapsible over Radix Collapsible — an
 * independently controlled show/hide section. The root carries the card
 * surface. A section may carry several triggers (title zone, chevron zone);
 * each renders the shared {@link CollapsibleChevron} where it wants the
 * rotating arrow. Icons are inline strokes so the UI seam needs no icon
 * dependency.
 *
 * @module @snap-rail/client-ui/collapsible
 */

import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from './utils.ts'

/** Controlled/uncontrolled root; renders the bordered card surface. */
export function Collapsible({ className, ...props }: ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return (
    <CollapsiblePrimitive.Root
      className={cn('rounded-md border border-border bg-card', className)}
      {...props}
    />
  )
}

/** The header button. The `group` class lets a nested chevron sense the
 * open state (see {@link CollapsibleChevron}). */
export function CollapsibleTrigger({ className, ...props }: ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      className={cn(
        'group flex w-full items-center gap-2 text-xs font-medium',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      {...props}
    />
  )
}

/** The rotating disclosure arrow; renders inside a trigger and turns with
 * that trigger's open state. */
export function CollapsibleChevron({ className }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 12 12" className={cn('h-3 w-3 shrink-0 opacity-60 transition-transform duration-200 group-data-[state=open]:rotate-180', className)} fill="none" aria-hidden="true">
      <path d="m2.5 4.5 3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The body; mounted only while open. */
export function CollapsibleContent({ className, ...props }: ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      className={cn('overflow-hidden', className)}
      {...props}
    />
  )
}
