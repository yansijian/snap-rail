/**
 * ScrollArea: Radix scroll area with a themed slim scrollbar — panels keep
 * native scrolling semantics without OS chrome.
 *
 * @module @snap-rail/client-ui/scroll-area
 */

import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import type { ComponentProps } from 'react'
import { cn } from './utils.ts'

/** A themed scrollable viewport. */
export function ScrollArea({ className, children, ...props }: ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root className={cn('overflow-hidden', className)} {...props}>
      <ScrollAreaPrimitive.Viewport className="h-full w-full">{children}</ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        orientation="vertical"
        className="flex w-1.5 touch-none select-none border-l border-transparent p-px"
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-muted-foreground/40" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}
