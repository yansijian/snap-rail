/**
 * Progress: the Radix progress bar with snap-rail chrome — determinate
 * download/scan progress for long-running host work.
 *
 * @module @snap-rail/framework-shadcn/ui/progress
 */

import * as ProgressPrimitive from '@radix-ui/react-progress'
import type { ComponentProps } from 'react'
import { cn } from './utils.ts'

/** A themed linear progress bar (`value` 0–100, `aria-valuenow` included). */
export function Progress({ className, value, ...props }: ComponentProps<typeof ProgressPrimitive.Root>) {
  const percent = typeof value === 'number' ? Math.min(100, Math.max(0, value)) : 0
  return (
    <ProgressPrimitive.Root
      className={cn(
        'relative h-2 w-full overflow-hidden rounded-full bg-secondary',
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className="h-full w-full rounded-full bg-primary transition-transform"
        style={{ transform: `translateX(-${100 - percent}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}
