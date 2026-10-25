/**
 * Semantic buttons: one behaviour, skin-owned visuals. The DOM exposes
 * `button.root`, `button.label`, `button.icon`, and `button.spinner` parts;
 * intent/emphasis/size are data attributes a skin styles.
 *
 * @module @snap-rail/ui/components/button
 */

import { Slot as RadixSlot } from '@radix-ui/react-slot'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { cn, part } from '../utils.ts'

/** The semantic emphasis of a button. */
export type ButtonIntent = 'neutral' | 'primary' | 'danger' | 'success' | 'warning'

/** How strongly the intent is expressed. */
export type ButtonEmphasis = 'solid' | 'soft' | 'outline' | 'ghost' | 'link'

/** The control size. */
export type ButtonSize = 'sm' | 'md' | 'lg'

/** Props of {@link Button}. */
export interface ButtonProps extends Omit<ComponentPropsWithoutRef<'button'>, 'color'> {
  intent?: ButtonIntent
  emphasis?: ButtonEmphasis
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
  iconPosition?: 'start' | 'end'
  asChild?: boolean
}

/** A spinner that inherits the current text colour. */
export function Spinner(props: { className?: string }): ReactNode {
  return (
    <svg
      {...part('button', 'spinner')}
      className={cn('snap-spinner', props.className)}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

/** A themed button; `asChild` composes the behaviour onto a child element. */
export function Button({
  intent = 'neutral',
  emphasis = 'solid',
  size = 'md',
  loading = false,
  icon,
  iconPosition = 'start',
  asChild = false,
  disabled,
  className,
  children,
  type,
  ...props
}: ButtonProps): ReactNode {
  const Component = asChild ? RadixSlot : 'button'
  const content = asChild
    ? children
    : (
        <>
          {icon !== undefined && iconPosition === 'start' && <span {...part('button', 'icon')}>{icon}</span>}
          {children !== undefined && <span {...part('button', 'label')}>{children}</span>}
          {icon !== undefined && iconPosition === 'end' && <span {...part('button', 'icon')}>{icon}</span>}
          {loading && <Spinner />}
        </>
      )
  return (
    <Component
      {...part('button', 'root')}
      {...type !== undefined ? { type } : !asChild ? { type: 'button' as const } : {}}
      className={cn('snap-button', className)}
      data-intent={intent}
      data-emphasis={emphasis}
      data-size={size}
      data-loading={loading || undefined}
      data-disabled={disabled === true || undefined}
      aria-busy={loading || undefined}
      disabled={!asChild ? disabled === true || loading : undefined}
      {...props}
    >
      {content}
    </Component>
  )
}

/** An icon-only button; `label` is required for accessibility. */
export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'iconPosition'> {
  icon: ReactNode
  label: string
  active?: boolean
}

/** A square glyph button with a mandatory accessible label. */
export function IconButton({
  icon,
  label,
  active = false,
  intent = 'neutral',
  emphasis = 'ghost',
  size = 'md',
  className,
  ...props
}: IconButtonProps): ReactNode {
  return (
    <button
      {...part('icon-button', 'root')}
      type="button"
      className={cn('snap-icon-button', className)}
      data-intent={intent}
      data-emphasis={emphasis}
      data-size={size}
      data-active={active || undefined}
      aria-label={label}
      aria-pressed={active || undefined}
      {...props}
    >
      <span {...part('icon-button', 'icon')} aria-hidden="true">{icon}</span>
    </button>
  )
}