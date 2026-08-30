/**
 * Table: the data-table family (table, header, body, row, head, cell) —
 * themed native elements in the shadcn shape, no behaviour attached.
 *
 * @module @snap-rail/client-ui/table
 */

import type { ComponentProps } from 'react'
import { DragScroll } from './drag-scroll.tsx'
import { cn } from './utils.ts'

/** The grid container with a hairline bottom rule; the wrapper pans under
 * a held mouse drag (see {@link DragScroll}). */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <DragScroll className="w-full">
      <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </DragScroll>
  )
}

/** Header group. */
export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return <thead className={cn('[&_tr]:border-b', className)} {...props} />
}

/** Body group. */
export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />
}

/** One row: hairline separators, hover affordance when interactive. */
export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      className={cn('border-b border-border transition-colors hover:bg-accent/40 data-[state=selected]:bg-accent', className)}
      {...props}
    />
  )
}

/** One column head: muted, left-aligned unless overridden. */
export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return <th className={cn('h-11 px-3 text-left align-middle text-sm font-medium text-muted-foreground', className)} {...props} />
}

/** One cell. */
export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-3 py-3 align-middle', className)} {...props} />
}
