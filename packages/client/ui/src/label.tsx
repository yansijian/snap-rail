/**
 * Label: form field caption over Radix Label (click focuses the control).
 *
 * @module @snap-rail/client-ui/label
 */

import * as LabelPrimitive from '@radix-ui/react-label'
import type { ComponentProps } from 'react'
import { cn } from './utils.ts'

/** A themed field label. */
export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn('text-sm font-medium text-muted-foreground select-none', className)}
      {...props}
    />
  )
}
