/**
 * Feedback primitives: badges, status LEDs, progress, and empty states. These
 * are read-only surfaces; their parts are skin-owned.
 *
 * @module @snap-rail/ui/components/feedback
 */

import type { ReactNode } from 'react'
import { cn, part } from '../utils.ts'
import type { ButtonIntent } from './button.tsx'

/** Props of {@link Badge}. */
export interface BadgeProps {
  children?: ReactNode
  intent?: ButtonIntent
  className?: string
}

/** A compact status/count label. */
export function Badge({ children, intent = 'neutral', className }: BadgeProps): ReactNode {
  return (
    <span {...part('badge', 'root')} className={cn('snap-badge', className)} data-intent={intent}>
      {children}
    </span>
  )
}

/** The semantic LED tones. */
export type LedTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

/** Props of {@link Led}. */
export interface LedProps {
  tone?: LedTone
  label?: string
  className?: string
}

/** A status light with a separate halo part for breathing/glow skins. */
export function Led({ tone = 'neutral', label, className }: LedProps): ReactNode {
  return (
    <span {...part('led', 'root')} className={cn('snap-led', className)} data-tone={tone} aria-label={label} role={label !== undefined ? 'img' : undefined}>
      <span {...part('led', 'halo')} aria-hidden="true" />
    </span>
  )
}

/** Props of {@link Progress}. */
export interface ProgressProps {
  /** Completion in `0..1`; `null` renders an indeterminate track. */
  value: number | null
  label?: string
  className?: string
}

/** A linear progress indicator. */
export function Progress({ value, label, className }: ProgressProps): ReactNode {
  const clamped = value === null ? null : Math.min(1, Math.max(0, value))
  return (
    <div
      {...part('progress', 'root')}
      className={cn('snap-progress', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...clamped !== null ? { 'aria-valuenow': Math.round(clamped * 100) } : {}}
      data-indeterminate={clamped === null || undefined}
    >
      <div {...part('progress', 'track')} className="snap-progress-track">
        <div
          {...part('progress', 'indicator')}
          className="snap-progress-indicator"
          style={clamped === null ? undefined : { width: `${Math.round(clamped * 100)}%` }}
        />
      </div>
    </div>
  )
}

/** Props of {@link EmptyState}. */
export interface EmptyStateProps {
  title: ReactNode
  description?: ReactNode
  icon?: ReactNode
  action?: ReactNode
  className?: string
}

/** A centered empty/zero-state block. */
export function EmptyState({ title, description, icon, action, className }: EmptyStateProps): ReactNode {
  return (
    <div {...part('empty-state', 'root')} className={cn('snap-empty-state', className)}>
      {icon !== undefined && <div {...part('empty-state', 'icon')}>{icon}</div>}
      <div {...part('empty-state', 'title')}>{title}</div>
      {description !== undefined && <div {...part('empty-state', 'description')}>{description}</div>}
      {action !== undefined && <div {...part('empty-state', 'action')}>{action}</div>}
    </div>
  )
}