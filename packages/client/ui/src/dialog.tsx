/**
 * Dialog: modal overlay + panel over Radix Dialog. Chrome surfaces use it
 * for confirmations (window close, technician id entry); content pages use
 * it for small forms. No built-in close affordance — callers render their
 * own buttons in the footer.
 *
 * @module @snap-rail/client-ui/dialog
 */

import * as DialogPrimitive from '@radix-ui/react-dialog'
import type { ComponentProps } from 'react'
import { cn } from './utils.ts'

/** Controlled/uncontrolled root; re-exported so callers need one import. */
export const Dialog = DialogPrimitive.Root

/** The overlay + centered panel; mounts through a portal into body. */
export function DialogContent({ className, children, ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="overlay-in fixed inset-0 z-50 bg-background/80 backdrop-blur-[1px]" />
      <DialogPrimitive.Content
        className={cn(
          'dialog-in fixed left-1/2 top-1/2 z-50 w-[calc(100%-2.5rem)] max-w-md -translate-x-1/2 -translate-y-1/2',
          'rounded-lg border border-border bg-card text-card-foreground shadow-xl',
          'p-5 focus:outline-none',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

/** Title bar block inside a dialog. */
export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mb-4 space-y-1', className)} {...props} />
}

/** The dialog's accessible title. */
export const DialogTitle = DialogPrimitive.Title

/** Optional supporting line under the title. */
export const DialogDescription = DialogPrimitive.Description

/** Action row (buttons) at the bottom; defaults to right-aligned. */
export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mt-5 flex justify-end gap-3', className)} {...props} />
}
