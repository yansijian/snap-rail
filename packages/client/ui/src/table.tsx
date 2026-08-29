/**
 * Table: the data-table family (table, header, body, row, head, cell) —
 * themed native elements in the shadcn shape, no behaviour attached.
 *
 * @module @snap-rail/client-ui/table
 */

import type { ComponentProps } from 'react'
import { cn } from './utils.ts'

/** The grid container with a hairline bottom rule. */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="w-full overflow-auto">
      <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
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
  return <th className={cn('h-8 px-2 text-left align-middle text-xs font-medium text-muted-foreground', className)} {...props} />
}

/** One cell. */
export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('p-2 align-middle', className)} {...props} />
}
