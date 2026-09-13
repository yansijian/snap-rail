/**
 * Icon primitives: lucide-style inline stroke glyphs the Button and page
 * headers embed. Icons are inline strokes (no icon-package dependency, no
 * fill dependencies on currentColor semantics) — same convention as
 * {@link CollapsibleChevron}.
 *
 * @module @snap-rail/framework-shadcn/ui/icons
 */

import type { ReactNode } from 'react'
import { cn } from './utils.ts'

/** The shared stroke skeleton every icon renders. */
function icon(path: ReactNode, className?: string): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('h-4 w-4 shrink-0', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  )
}

/** A plus glyph — the "add / install something" affordance. */
export function IconPlus({ className }: { className?: string }): ReactNode {
  return icon(
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>,
    className,
  )
}

/** Chevrons pointing together (down-up) — the "collapse all" affordance. */
export function IconChevronsDownUp({ className }: { className?: string }): ReactNode {
  return icon(
    <>
      <path d="m7 20 5-5 5 5" />
      <path d="m7 4 5 5 5-5" />
    </>,
    className,
  )
}

/** Chevrons pointing apart (up-down) — the "expand all" affordance. */
export function IconChevronsUpDown({ className }: { className?: string }): ReactNode {
  return icon(
    <>
      <path d="m7 15 5 5 5-5" />
      <path d="m7 9 5-5 5 5" />
    </>,
    className,
  )
}
