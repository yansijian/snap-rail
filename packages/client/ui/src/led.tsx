/**
 * Led: the breathing status dot connection/group health renders as. A plain
 * span (not a Radix part) — `data-tone` is the test hook.
 *
 * @module @snap-rail/client-ui/led
 */

import type { ComponentProps } from 'react'
import { cn } from './utils.ts'

/** Health tones: green = all good, yellow = partial, red = down. */
export type LedTone = 'green' | 'yellow' | 'red'

const TONE_CLASS: Record<LedTone, string> = {
  green: 'bg-success',
  yellow: 'bg-warning',
  red: 'bg-destructive',
}

/** One pulsing dot; pass `aria-label` when it is the only status surface. */
export function Led({ tone, className, ...props }: ComponentProps<'span'> & { tone: LedTone }) {
  return (
    <span
      data-tone={tone}
      className={cn('inline-block h-3 w-3 shrink-0 animate-pulse rounded-full', TONE_CLASS[tone], className)}
      {...props}
    />
  )
}
