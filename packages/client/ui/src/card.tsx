/**
 * Card: the panel container family (card, header, title, content).
 *
 * @module @snap-rail/client-ui/card
 */

import type { ComponentProps } from 'react'
import { cn } from './utils.ts'

/** The container surface. */
export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('rounded-lg border border-border bg-card text-card-foreground', className)} {...props} />
}

/** Top padding/heading zone of a card. */
export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 p-3', className)} {...props} />
}

/** Card heading line. */
export function CardTitle({ className, ...props }: ComponentProps<'h3'>) {
  return <h3 className={cn('text-xs font-medium text-muted-foreground', className)} {...props} />
}

/** Body zone of a card. */
export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-3 pt-0', className)} {...props} />
}
