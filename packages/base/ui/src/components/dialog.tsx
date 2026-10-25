/**
 * Dialog/sheet semantics over Radix's focus trap and portal. The skin chooses
 * the presentation (modal, sheet, fullscreen) through the `presentation`
 * attribute; the core owns dismissal and focus behaviour.
 *
 * @module @snap-rail/ui/components/dialog
 */

import * as DialogPrimitive from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'
import { cn, part } from '../utils.ts'

/** The presentation variants the core implements for overlays. */
export type DialogPresentation = 'modal' | 'sheet' | 'fullscreen'

/** Props of {@link DialogContent}. */
export interface DialogContentProps {
  children?: ReactNode
  className?: string
  /** `auto` currently resolves to the skin default; explicit values win. */
  presentation?: DialogPresentation | 'auto'
  size?: 'sm' | 'md' | 'lg'
  showClose?: boolean
}

/** The dialog root. */
export const Dialog = DialogPrimitive.Root

/** The dialog trigger. */
export const DialogTrigger = DialogPrimitive.Trigger

/** The dialog close. */
export const DialogClose = DialogPrimitive.Close

/** The portalled dialog content. */
export function DialogContent({
  children,
  className,
  presentation = 'auto',
  size = 'md',
  showClose = true,
}: DialogContentProps): ReactNode {
  const resolved = presentation === 'auto' ? 'modal' : presentation
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay {...part('dialog', 'overlay')} className="snap-dialog-overlay" />
      <DialogPrimitive.Content
        {...part('dialog', 'panel')}
        className={cn('snap-dialog-panel', className)}
        data-presentation={resolved}
        data-size={size}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close {...part('dialog', 'close')} className="snap-dialog-close" aria-label="关闭">
            ×
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

/** The dialog header. */
export function DialogHeader({ children, className }: { children?: ReactNode; className?: string }): ReactNode {
  return <div {...part('dialog', 'header')} className={cn('snap-dialog-header', className)}>{children}</div>
}

/** The dialog title. */
export function DialogTitle({ children, className }: { children?: ReactNode; className?: string }): ReactNode {
  return (
    <DialogPrimitive.Title {...part('dialog', 'title')} className={cn('snap-dialog-title', className)}>
      {children}
    </DialogPrimitive.Title>
  )
}

/** The dialog description. */
export function DialogDescription({ children, className }: { children?: ReactNode; className?: string }): ReactNode {
  return (
    <DialogPrimitive.Description {...part('dialog', 'description')} className={cn('snap-dialog-description', className)}>
      {children}
    </DialogPrimitive.Description>
  )
}

/** The dialog body. */
export function DialogBody({ children, className }: { children?: ReactNode; className?: string }): ReactNode {
  return <div {...part('dialog', 'body')} className={cn('snap-dialog-body', className)}>{children}</div>
}

/** The dialog footer. */
export function DialogFooter({ children, className }: { children?: ReactNode; className?: string }): ReactNode {
  return <div {...part('dialog', 'footer')} className={cn('snap-dialog-footer', className)}>{children}</div>
}

/** A sheet is a dialog with the `sheet` presentation by default. */
export function Sheet(props: Omit<DialogContentProps, 'presentation'> & { presentation?: DialogPresentation }): ReactNode {
  return <DialogContent {...props} presentation={props.presentation ?? 'sheet'} />
}