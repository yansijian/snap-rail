/**
 * Button: cva variants over a native button. Ghost/outline cover chrome
 * surfaces (titlebar, panel toggles); `icon` size squares the padding for
 * glyph-only controls.
 *
 * @module @snap-rail/client-ui/button
 */

import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from './utils.ts'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive/90 text-destructive-foreground hover:bg-destructive',
        outline: 'border border-border bg-transparent hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        xl: 'h-16 px-8 text-lg',
        lg: 'h-14 px-6 text-lg',
        default: 'h-12 px-5 py-1.5',
        sm: 'h-10 px-4 text-sm',
        icon: 'h-12 w-12',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

/** Props of {@link Button}. */
export type ButtonProps = ComponentProps<'button'>
  & VariantProps<typeof buttonVariants>
  & { asChild?: boolean }

/** A themed button; `asChild` renders the child element instead. */
export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Component = asChild ? Slot : 'button'
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
