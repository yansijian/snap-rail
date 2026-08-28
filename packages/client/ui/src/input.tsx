/**
 * Input: themed single-line text entry for ids, numbers, and short values.
 *
 * @module @snap-rail/client-ui/input
 */

import type { ComponentProps } from 'react'
import { cn } from './utils.ts'

/** A themed text input. */
export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm',
        'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
