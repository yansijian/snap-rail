/**
 * Overlay semantics over Radix: tooltips, popovers, and dropdown menus; the
 * toast queue runs on Sonner (the Radix toast primitive is deprecated
 * upstream). Behaviour/keyboard/focus handling stays here; skins target the
 * stable parts (`tooltip.*`, `popover.*`, `menu.*`) and Sonner's toast data
 * attributes. The imperative toast() helper pairs with the <Toaster/> the
 * runtime mounts in every surface root.
 *
 * @module @snap-rail/ui/components/overlay
 */

import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { Toaster as SonnerToaster, toast as sonnerToast } from 'sonner'
import {
  useRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react'
import { cn, part } from '../utils.ts'

/* ------------------------------------------------------------------ Tooltip */

/** The tooltip root; wraps `TooltipTrigger`/`TooltipContent` and owns delay. */
export function Tooltip({
  delayDuration,
  ...props
}: ComponentPropsWithoutRef<typeof TooltipPrimitive.Root>): ReactNode {
  return <TooltipPrimitive.Root {...props} delayDuration={delayDuration ?? 300} />
}

/** The tooltip provider; the runtime mounts one, pages only need it standalone. */
export function TooltipProvider(props: ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>): ReactNode {
  return <TooltipPrimitive.Provider {...props} />
}

/** The tooltip trigger; wraps its child and anchors the bubble. */
export function TooltipTrigger(props: ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>): ReactNode {
  return <TooltipPrimitive.Trigger {...props} {...part('tooltip', 'trigger')} />
}

/** Props of {@link TooltipContent}. */
export interface TooltipContentProps extends ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> {
  /** Bubble side (default `top`). */
  side?: 'top' | 'right' | 'bottom' | 'left'
  sideOffset?: number
}

/** The portalled tooltip bubble. */
export function TooltipContent({ side = 'top', sideOffset = 6, className, children, ...props }: TooltipContentProps): ReactNode {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        className={cn('snap-tooltip', className)}
        side={side}
        sideOffset={sideOffset}
        {...props}
        {...part('tooltip', 'content')}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

/* ------------------------------------------------------------------ Popover */

/** The popover root. */
export const Popover = PopoverPrimitive.Root

/** The popover trigger; wraps its child and toggles the panel. */
export function PopoverTrigger(props: ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>): ReactNode {
  return <PopoverPrimitive.Trigger {...props} {...part('popover', 'trigger')} />
}

/** An element the panel positions against without toggling it. */
export const PopoverAnchor = PopoverPrimitive.Anchor

/** Closes the popover from inside the panel. */
export function PopoverClose(props: ComponentPropsWithoutRef<typeof PopoverPrimitive.Close>): ReactNode {
  return <PopoverPrimitive.Close {...props} />
}

/** Props of {@link PopoverContent}. */
export interface PopoverContentProps extends ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> {
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  /** Overrides the open-focus heuristic. Default: a panel opened from an
   * editable element (anchored combobox typing into a field) keeps the focus
   * in it; otherwise the panel takes focus as Radix does. `false` never
   * moves focus into the panel, `true` always lets the FocusScope run. */
  autoFocusOnOpen?: boolean
}

/** Whether the element can hold a text caret (the anchored-combobox opener). */
function isEditableElement(element: Element | null): boolean {
  if (element === null || !(element instanceof HTMLElement)) return false
  return element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable
}

/**
 * The portalled popover panel, with the two focus dead ends Radix leaves
 * open in anchored mode: on open, the FocusScope default steals the focus
 * from the field a combobox is typing into; on close, the default handler
 * focuses the trigger ref — which is `null` without a `PopoverTrigger`, so
 * focus strands on `body` and every keystroke dies. The wrapper remembers
 * the element that opened the panel and returns focus there; when that
 * element is editable it also keeps the focus in it while the panel is
 * open. Trigger-mode popovers behave exactly as Radix does (the opener IS
 * the trigger).
 */
export function PopoverContent({
  side = 'bottom',
  align = 'center',
  sideOffset = 6,
  autoFocusOnOpen,
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onInteractOutside,
  ...props
}: PopoverContentProps): ReactNode {
  const openerRef = useRef<HTMLElement | null>(null)
  const interactedOutsideRef = useRef(false)
  const handleOpenAutoFocus = (event: Event): void => {
    // Radix dispatches this while the opener still holds focus; record it
    // before anything can move focus — the close path returns to it.
    openerRef.current = document.activeElement as HTMLElement | null
    interactedOutsideRef.current = false
    onOpenAutoFocus?.(event)
    if (event.defaultPrevented) return
    const exempt = autoFocusOnOpen === false
      || (autoFocusOnOpen === undefined && isEditableElement(openerRef.current))
    if (exempt) event.preventDefault()
  }
  const handleCloseAutoFocus = (event: Event): void => {
    onCloseAutoFocus?.(event)
    if (event.defaultPrevented) return
    if (interactedOutsideRef.current) return
    const opener = openerRef.current
    if (opener !== null && opener !== document.body && opener.isConnected) {
      event.preventDefault()
      opener.focus({ preventScroll: true })
    }
  }
  const handleInteractOutside = (event: Parameters<NonNullable<PopoverContentProps['onInteractOutside']>>[0]): void => {
    interactedOutsideRef.current = true
    onInteractOutside?.(event)
  }
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        className={cn('snap-popover', className)}
        side={side}
        align={align}
        sideOffset={sideOffset}
        onOpenAutoFocus={handleOpenAutoFocus}
        onCloseAutoFocus={handleCloseAutoFocus}
        onInteractOutside={handleInteractOutside}
        {...props}
        {...part('popover', 'content')}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  )
}

/* -------------------------------------------------------------------- Menu */

/** The dropdown menu root. */
export const Menu = DropdownMenuPrimitive.Root

/** The menu trigger; wraps its child and toggles the dropdown. */
export function MenuTrigger(props: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Trigger>): ReactNode {
  return <DropdownMenuPrimitive.Trigger {...props} {...part('menu', 'trigger')} />
}

/** Props of {@link MenuContent}. */
export interface MenuContentProps extends ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> {
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
}

/** The portalled dropdown list. */
export function MenuContent({ side = 'bottom', align = 'start', sideOffset = 4, className, children, ...props }: MenuContentProps): ReactNode {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        className={cn('snap-menu', className)}
        side={side}
        align={align}
        sideOffset={sideOffset}
        {...props}
        {...part('menu', 'content')}
      >
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  )
}

/** One menu action. */
export function MenuItem({ className, children, ...props }: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>): ReactNode {
  return (
    <DropdownMenuPrimitive.Item className={cn('snap-menu-item', className)} {...props} {...part('menu', 'item')}>
      {children}
    </DropdownMenuPrimitive.Item>
  )
}

/** A checkable menu action with an indicator slot. */
export function MenuCheckboxItem({ className, children, ...props }: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>): ReactNode {
  return (
    <DropdownMenuPrimitive.CheckboxItem className={cn('snap-menu-item', className)} {...props} {...part('menu', 'checkbox-item')}>
      <DropdownMenuPrimitive.ItemIndicator {...part('menu', 'item-indicator')} className="snap-menu-indicator">✓</DropdownMenuPrimitive.ItemIndicator>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

/** A non-interactive group heading. */
export function MenuLabel({ className, children, ...props }: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>): ReactNode {
  return <DropdownMenuPrimitive.Label className={cn('snap-menu-label', className)} {...props} {...part('menu', 'label')}>{children}</DropdownMenuPrimitive.Label>
}

/** A group container for items. */
export function MenuGroup(props: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Group>): ReactNode {
  return <DropdownMenuPrimitive.Group {...props} />
}

/** A horizontal rule between menu sections. */
export function MenuSeparator({ className, ...props }: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>): ReactNode {
  return <DropdownMenuPrimitive.Separator className={cn('snap-menu-separator', className)} {...props} {...part('menu', 'separator')} />
}

/* ------------------------------------------------------------------- Toast */

/** One queued toast. */
export interface ToastEntry {
  title: ReactNode
  description?: ReactNode
  intent?: 'neutral' | 'primary' | 'danger' | 'success' | 'warning'
  /** Auto-dismiss after this many ms; 0 keeps the toast until dismissed
   * (default 5000). */
  duration?: number
}

/** Stroke glyphs per intent (lucide-style 24-box, `currentColor`); the skin
 * colours them through the toast's `[data-icon]`. */
const TOAST_INTENT_PATHS: Record<NonNullable<ToastEntry['intent']>, ReactNode> = {
  neutral: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
  primary: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
  success: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  warning: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  danger: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </>
  ),
}

function toastIcon(intent: NonNullable<ToastEntry['intent']>): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {TOAST_INTENT_PATHS[intent]}
    </svg>
  )
}

/** Enqueue a toast on the runtime-mounted {@link Toaster}s. Backed by Sonner
 * (the Radix toast primitive is deprecated upstream): `success`/`warning`/
 * `danger` map to the typed emitters, `neutral`/`primary` ride the plain one,
 * and every toast carries an `snap-intent-*` class the skins target. */
export function toast(entry: ToastEntry): number {
  const intent = entry.intent ?? 'neutral'
  const options = {
    description: entry.description,
    icon: toastIcon(intent),
    duration: entry.duration === 0 ? Number.POSITIVE_INFINITY : (entry.duration ?? 5000),
    className: `snap-intent-${intent}`,
  }
  switch (intent) {
    case 'success': return sonnerToast.success(entry.title, options) as number
    case 'warning': return sonnerToast.warning(entry.title, options) as number
    case 'danger': return sonnerToast.error(entry.title, options) as number
    default: return sonnerToast(entry.title, options) as number
  }
}

/** Dismiss a queued toast by id. */
export function dismissToast(id: number): void {
  sonnerToast.dismiss(id)
}

/** The runtime-mounted viewport: renders the shared toast queue. Pages never
 * mount this themselves — the runtime provides one per surface root. */
export function Toaster(): ReactNode {
  return <SonnerToaster position="bottom-right" closeButton />
}
