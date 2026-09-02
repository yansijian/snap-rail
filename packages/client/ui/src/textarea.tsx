/**
 * Textarea: themed multi-line text entry for prompts, notes, and free-form
 * descriptions (ported from shadcn/ui's textarea primitive, flattened to
 * this theme's tokens and touch baseline).
 *
 * @module @snap-rail/client-ui/textarea
 */

import type { ComponentProps } from 'react'
import { cn } from './utils.ts'

/** A themed multi-line text area. */
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'flex min-h-24 w-full rounded-md border border-input bg-transparent px-4 py-3 text-base',
        'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
