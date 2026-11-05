/**
 * Attention surfaces: alerts (inline banners), separators, skeletons, and
 * lists. Read-only primitives; the skin owns their visuals through the
 * `alert.*`, `separator.*`, `skeleton.*`, and `list.*` parts.
 *
 * @module @snap-rail/ui/components/alert
 */

import * as SeparatorPrimitive from '@radix-ui/react-separator'
import type { ComponentPropsWithoutRef, KeyboardEvent, ReactNode } from 'react'
import { cn, part } from '../utils.ts'
import type { ButtonIntent } from './button.tsx'

/** Props of {@link Alert}. */
export interface AlertProps extends ComponentPropsWithoutRef<'div'> {
  /** The semantic tone; the skin maps it to colour like a button intent. */
  intent?: ButtonIntent
}

/** An inline status banner for results and failures. */
export function Alert({ intent = 'neutral', className, children, ...props }: AlertProps): ReactNode {
  return (
    <div {...part('alert', 'root')} role="alert" className={cn('snap-alert', className)} data-intent={intent} {...props}>
      {children}
    </div>
  )
}

/** The alert heading line. */
export function AlertTitle({ className, children, ...props }: ComponentPropsWithoutRef<'h5'>): ReactNode {
  return <h5 {...part('alert', 'title')} className={cn('snap-alert-title', className)} {...props}>{children}</h5>
}

/** The alert body text. */
export function AlertDescription({ className, children, ...props }: ComponentPropsWithoutRef<'div'>): ReactNode {
  return <div {...part('alert', 'description')} className={cn('snap-alert-description', className)} {...props}>{children}</div>
}

/** Props of {@link Separator}. */
export interface SeparatorProps extends ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root> {
  orientation?: 'horizontal' | 'vertical'
}

/** A themed rule between sections. */
export function Separator({ orientation = 'horizontal', className, ...props }: SeparatorProps): ReactNode {
  return (
    <SeparatorPrimitive.Root
      {...part('separator', 'root')}
      orientation={orientation}
      className={cn('snap-separator', className)}
      {...props}
    />
  )
}

/** Props of {@link Skeleton}. */
export interface SkeletonProps extends ComponentPropsWithoutRef<'div'> {
  /** The shape variant; `text` matches the line height of body text. */
  variant?: 'block' | 'text' | 'circle'
}

/** A neutral loading placeholder shaped by the skin. */
export function Skeleton({ variant = 'block', className, ...props }: SkeletonProps): ReactNode {
  return <div {...part('skeleton', 'root')} className={cn('snap-skeleton', className)} data-variant={variant} aria-hidden="true" {...props} />
}

/** Props of {@link List}. */
export interface ListProps extends ComponentPropsWithoutRef<'ul'> {
  /** Draw hairlines between items (default false). */
  divided?: boolean
}

/** A vertical collection of {@link ListItem} rows. */
export function List({ divided = false, className, children, ...props }: ListProps): ReactNode {
  return (
    <ul {...part('list', 'root')} className={cn('snap-list', className)} data-divided={divided || undefined} {...props}>
      {children}
    </ul>
  )
}

/** Props of {@link ListItem}. */
export interface ListItemProps extends Omit<ComponentPropsWithoutRef<'li'>, 'onClick' | 'disabled'> {
  /** Leading glyph/figure slot (status LED, icon, thumbnail). */
  leading?: ReactNode
  /** Trailing slot (badge, timestamp, action). */
  trailing?: ReactNode
  /** Marks the row as the current selection. */
  selected?: boolean
  /** Dim the row and ignore activation. */
  disabled?: boolean
  /** Makes the row interactive (role=button, keyboard activation). */
  onClick?: () => void
}

/** One list row with leading/trailing slots. */
export function ListItem({
  leading,
  trailing,
  selected = false,
  disabled = false,
  onClick,
  className,
  children,
  ...props
}: ListItemProps): ReactNode {
  const interactive = onClick !== undefined && !disabled
  const activate = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onClick?.()
    }
  }
  return (
    <li
      {...part('list', 'item')}
      className={cn('snap-list-item', className)}
      data-selected={selected || undefined}
      data-interactive={interactive || undefined}
      data-disabled={disabled || undefined}
      aria-disabled={disabled || undefined}
      {...interactive ? { role: 'button', tabIndex: 0, onClick, onKeyDown: activate } : {}}
      {...props}
    >
      {leading !== undefined && <span {...part('list', 'leading')}>{leading}</span>}
      <span {...part('list', 'content')} style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {trailing !== undefined && <span {...part('list', 'trailing')}>{trailing}</span>}
    </li>
  )
}
