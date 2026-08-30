/**
 * Badge: small status/label chip. `success` carries the online/live state,
 * `warning` the attention state (e.g. partial failure, float type),
 * `destructive` the offline/abnormal one.
 *
 * @module @snap-rail/client-ui/badge
 */

import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from './utils.ts'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        success: 'border-transparent bg-success/15 text-success',
        warning: 'border-transparent bg-warning/15 text-warning',
        destructive: 'border-transparent bg-destructive/15 text-destructive',
        outline: 'text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

/** Props of {@link Badge}. */
export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>

/** A themed status chip. */
export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
