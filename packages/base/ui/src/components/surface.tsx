/**
 * Surface primitives: cards, panels, and tables. Their structure is semantic
 * (headers/bodies/rows); skins own borders, density, hover, and empty states.
 *
 * @module @snap-rail/ui/components/surface
 */

import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { cn, part } from '../utils.ts'

/** Props of {@link Card}. */
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode
}

/** A content card. */
export function Card({ className, children, ...props }: CardProps): ReactNode {
  return <div {...part('card', 'root')} className={cn('snap-card', className)} {...props}>{children}</div>
}

/** The card header region. */
export function CardHeader({ className, children, ...props }: HTMLAttributes<HTMLDivElement>): ReactNode {
  return <div {...part('card', 'header')} className={cn('snap-card-header', className)} {...props}>{children}</div>
}

/** The card title. */
export function CardTitle({ className, children, ...props }: HTMLAttributes<HTMLDivElement>): ReactNode {
  return <div {...part('card', 'title')} className={cn('snap-card-title', className)} {...props}>{children}</div>
}

/** The card description. */
export function CardDescription({ className, children, ...props }: HTMLAttributes<HTMLDivElement>): ReactNode {
  return <div {...part('card', 'description')} className={cn('snap-card-description', className)} {...props}>{children}</div>
}

/** The card body. */
export function CardContent({ className, children, ...props }: HTMLAttributes<HTMLDivElement>): ReactNode {
  return <div {...part('card', 'body')} className={cn('snap-card-content', className)} {...props}>{children}</div>
}

/** The card footer. */
export function CardFooter({ className, children, ...props }: HTMLAttributes<HTMLDivElement>): ReactNode {
  return <div {...part('card', 'footer')} className={cn('snap-card-footer', className)} {...props}>{children}</div>
}

/** Props of {@link Panel}. */
export interface PanelProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
}

/** A bounded panel with optional header/footer. */
export function Panel({ title, actions, footer, className, children, ...props }: PanelProps): ReactNode {
  return (
    <div {...part('panel', 'root')} className={cn('snap-panel', className)} {...props}>
      {(title !== undefined || actions !== undefined) && (
        <div {...part('panel', 'header')} className="snap-panel-header">
          <div {...part('panel', 'title')}>{title}</div>
          {actions !== undefined && <div>{actions}</div>}
        </div>
      )}
      <div {...part('panel', 'body')} className="snap-panel-body">{children}</div>
      {footer !== undefined && <div {...part('panel', 'footer')} className="snap-panel-footer">{footer}</div>}
    </div>
  )
}

/** A semantic table. */
export function Table({ className, children, ...props }: HTMLAttributes<HTMLTableElement>): ReactNode {
  return (
    <div {...part('table', 'root')} className={cn('snap-table', className)}>
      <table {...props}>{children}</table>
    </div>
  )
}

/** The table head. */
export function TableHeader({ className, children, ...props }: HTMLAttributes<HTMLTableSectionElement>): ReactNode {
  return <thead {...part('table', 'header')} className={cn('snap-table-header', className)} {...props}>{children}</thead>
}

/** The table body. */
export function TableBody({ className, children, ...props }: HTMLAttributes<HTMLTableSectionElement>): ReactNode {
  return <tbody {...part('table', 'body')} className={cn('snap-table-body', className)} {...props}>{children}</tbody>
}

/** A table row. */
export function TableRow({ className, children, ...props }: HTMLAttributes<HTMLTableRowElement>): ReactNode {
  return <tr {...part('table', 'row')} className={cn('snap-table-row', className)} {...props}>{children}</tr>
}

/** A table header cell. */
export function TableHead({ className, children, ...props }: ThHTMLAttributes<HTMLTableCellElement>): ReactNode {
  return <th {...part('table', 'head')} className={cn('snap-table-head', className)} {...props}>{children}</th>
}

/** A table body cell. */
export function TableCell({ className, children, ...props }: TdHTMLAttributes<HTMLTableCellElement>): ReactNode {
  return <td {...part('table', 'cell')} className={cn('snap-table-cell', className)} {...props}>{children}</td>
}

/** A full-width empty row. */
export function TableEmpty({ colSpan, children }: { colSpan: number; children: ReactNode }): ReactNode {
  return (
    <TableRow>
      <TableCell colSpan={colSpan}>
        <div {...part('table', 'empty')}>{children}</div>
      </TableCell>
    </TableRow>
  )
}