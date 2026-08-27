/**
 * Switch: the Radix switch with snap-rail chrome — boolean control for
 * toggles like the offline simulation.
 *
 * @module @snap-rail/client-ui/switch
 */

import * as SwitchPrimitive from '@radix-ui/react-switch'
import type { ComponentProps } from 'react'
import { cn } from './utils.ts'

/** A themed on/off control. */
export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-secondary',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block h-3 w-3 rounded-full bg-foreground shadow transition-transform data-[state=checked]:translate-x-3.5 data-[state=unchecked]:translate-x-0.5" />
    </SwitchPrimitive.Root>
  )
}
