/**
 * Overlay semantics over Radix: tooltips, popovers, dropdown menus, and
 * toasts. Behaviour/keyboard/focus handling stays here; skins target the
 * stable parts (`tooltip.*`, `popover.*`, `menu.*`, `toast.*`) and state
 * attributes. The imperative toast() helper pairs with the <Toaster/> the
 * runtime mounts in every surface root.
 *
 * @module @snap-rail/ui/components/overlay
 */

import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import * as ToastPrimitive from '@radix-ui/react-toast'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import {
  useSyncExternalStore,
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
  return <TooltipPrimitive.Trigger {...part('tooltip', 'trigger')} {...props} />
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
        {...part('tooltip', 'content')}
        className={cn('snap-tooltip', className)}
        side={side}
        sideOffset={sideOffset}
        {...props}
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
  return <PopoverPrimitive.Trigger {...part('popover', 'trigger')} {...props} />
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
}

/** The portalled popover panel. */
export function PopoverContent({ side = 'bottom', align = 'center', sideOffset = 6, className, children, ...props }: PopoverContentProps): ReactNode {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        {...part('popover', 'content')}
        className={cn('snap-popover', className)}
        side={side}
        align={align}
        sideOffset={sideOffset}
        {...props}
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
  return <DropdownMenuPrimitive.Trigger {...part('menu', 'trigger')} {...props} />
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
        {...part('menu', 'content')}
        className={cn('snap-menu', className)}
        side={side}
        align={align}
        sideOffset={sideOffset}
        {...props}
      >
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  )
}

/** One menu action. */
export function MenuItem({ className, children, ...props }: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>): ReactNode {
  return (
    <DropdownMenuPrimitive.Item {...part('menu', 'item')} className={cn('snap-menu-item', className)} {...props}>
      {children}
    </DropdownMenuPrimitive.Item>
  )
}

/** A checkable menu action with an indicator slot. */
export function MenuCheckboxItem({ className, children, ...props }: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>): ReactNode {
  return (
    <DropdownMenuPrimitive.CheckboxItem {...part('menu', 'checkbox-item')} className={cn('snap-menu-item', className)} {...props}>
      <DropdownMenuPrimitive.ItemIndicator {...part('menu', 'item-indicator')} className="snap-menu-indicator">✓</DropdownMenuPrimitive.ItemIndicator>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

/** A non-interactive group heading. */
export function MenuLabel({ className, children, ...props }: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>): ReactNode {
  return <DropdownMenuPrimitive.Label className={cn('snap-menu-label', className)} {...props}>{children}</DropdownMenuPrimitive.Label>
}

/** A group container for items. */
export function MenuGroup(props: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Group>): ReactNode {
  return <DropdownMenuPrimitive.Group {...props} />
}

/** A horizontal rule between menu sections. */
export function MenuSeparator({ className, ...props }: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>): ReactNode {
  return <DropdownMenuPrimitive.Separator {...part('menu', 'separator')} className={cn('snap-menu-separator', className)} {...props} />
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

/** The module-level toast store: {@link toast} publishes from anywhere (event
 * handlers included — no render context needed) and every mounted
 * {@link Toaster} renders the queue. */
interface ToastRecord extends ToastEntry {
  id: number
}

let toastNextId = 1
let toastRecords: readonly ToastRecord[] = []
const toastListeners = new Set<() => void>()

function toastEmit(): void {
  for (const listener of toastListeners) listener()
}

function toastDismiss(id: number): void {
  toastRecords = toastRecords.filter(record => record.id !== id)
  toastEmit()
}

/** Enqueue a toast on the runtime-mounted {@link Toaster}s. */
export function toast(entry: ToastEntry): number {
  const id = toastNextId++
  toastRecords = [...toastRecords, { ...entry, id }]
  toastEmit()
  return id
}

/** Dismiss a queued toast by id. */
export function dismissToast(id: number): void {
  toastDismiss(id)
}

/** The runtime-mounted viewport: renders the shared toast queue. Pages never
 * mount this themselves — the runtime provides one per surface root. */
export function Toaster(props: Omit<ComponentPropsWithoutRef<typeof ToastPrimitive.Provider>, 'duration'>): ReactNode {
  const records = useSyncExternalStore(
    (onStoreChange) => {
      toastListeners.add(onStoreChange)
      return () => toastListeners.delete(onStoreChange)
    },
    () => toastRecords,
    () => toastRecords,
  )
  return (
    <ToastPrimitive.Provider {...props}>
      {records.map(record => (
        <ToastPrimitive.Root
          key={record.id}
          {...part('toast', 'root')}
          className="snap-toast"
          data-intent={record.intent ?? 'neutral'}
          duration={record.duration ?? 5000}
          onOpenChange={(open) => {
            if (!open) toastDismiss(record.id)
          }}
        >
          <ToastTitle>{record.title}</ToastTitle>
          {record.description !== undefined && <ToastDescription>{record.description}</ToastDescription>}
          <ToastClose aria-label="关闭" />
        </ToastPrimitive.Root>
      ))}
      <ToastViewport />
    </ToastPrimitive.Provider>
  )
}

/** The raw toast root for pages that manage their own open state. */
export const Toast = ToastPrimitive.Root

/** A toast title with its part tag. */
export function ToastTitle({ className, children, ...props }: ComponentPropsWithoutRef<typeof ToastPrimitive.Title>): ReactNode {
  return <ToastPrimitive.Title {...part('toast', 'title')} className={cn('snap-toast-title', className)} {...props}>{children}</ToastPrimitive.Title>
}

/** A toast description with its part tag. */
export function ToastDescription({ className, children, ...props }: ComponentPropsWithoutRef<typeof ToastPrimitive.Description>): ReactNode {
  return <ToastPrimitive.Description {...part('toast', 'description')} className={cn('snap-toast-description', className)} {...props}>{children}</ToastPrimitive.Description>
}

/** An interactive toast action (confirm/retry affordances). */
export function ToastAction({ className, children, ...props }: ComponentPropsWithoutRef<typeof ToastPrimitive.Action>): ReactNode {
  return <ToastPrimitive.Action {...part('toast', 'action')} className={cn('snap-toast-action', className)} {...props}>{children}</ToastPrimitive.Action>
}

/** A toast dismissal button. */
export function ToastClose({ className, children, ...props }: ComponentPropsWithoutRef<typeof ToastPrimitive.Close>): ReactNode {
  return <ToastPrimitive.Close {...part('toast', 'close')} className={cn('snap-toast-close', className)} {...props}>{children ?? <span aria-hidden="true">×</span>}</ToastPrimitive.Close>
}

/** The toast viewport; only the runtime's {@link Toaster} mounts one. */
export function ToastViewport({ className, ...props }: ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>): ReactNode {
  return <ToastPrimitive.Viewport {...part('toast', 'viewport')} className={cn('snap-toast-viewport', className)} {...props} />
}
