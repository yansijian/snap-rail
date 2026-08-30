/**
 * Tabs: themed pager over Radix Tabs (list, trigger, content). Icons are
 * inline strokes so the UI seam needs no icon dependency.
 *
 * @module @snap-rail/client-ui/tabs
 */

import * as TabsPrimitive from '@radix-ui/react-tabs'
import type { ComponentProps } from 'react'
import { cn } from './utils.ts'

/** Controlled/uncontrolled root; re-exported so callers need one import. */
export const Tabs = TabsPrimitive.Root

/** The tab strip; triggers rest on the muted surface, the active one lifts. */
export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex h-8 items-center gap-0.5 rounded-md bg-muted p-0.5 text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

/** One tab button; the data attributes carry the active/hover styling. */
export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-sm px-2.5 py-1 text-xs font-medium',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:pointer-events-none disabled:opacity-50',
        'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
        className,
      )}
      {...props}
    />
  )
}

/** The panel of one tab; mounted only while its trigger is active. */
export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn('mt-3 focus-visible:outline-none', className)}
      {...props}
    />
  )
}
