/**
 * Tooltip: Radix tooltip wrapping its own provider so occupants mount it
 * standalone (no app-level provider requirement).
 *
 * @module @snap-rail/client-ui/tooltip
 */

import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from './utils.ts'

/** Props of {@link Tooltip}. */
export interface TooltipProps {
  /** The tip text (or node). */
  content: ReactNode
  /** The wrapped trigger; keeps its own markup. */
  children: ReactNode
  /** Open delay in milliseconds; defaults near-instant for chrome controls. */
  delay?: number
}

/** Hover/focus tip over any trigger. */
export function Tooltip({ content, children, delay = 200 }: TooltipProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={delay}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            sideOffset={4}
            className={cn(
              'z-50 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground',
            )}
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}

/** Re-export the primitive root for direct composition. */
export const TooltipRoot = TooltipPrimitive.Root

/** Props alias for content-side customization. */
export type TooltipContentProps = ComponentProps<typeof TooltipPrimitive.Content>
