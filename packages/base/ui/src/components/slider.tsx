/**
 * Coarse value adjustment for touch operation: a Radix slider with the
 * semantic anatomy (`slider.root/track/range/thumb`). Thumb size rides the
 * skin's control tokens so gloved operation keeps a real target.
 *
 * @module @snap-rail/ui/components/slider
 */

import * as SliderPrimitive from '@radix-ui/react-slider'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { cn, part } from '../utils.ts'

/** Props of {@link Slider}. */
export interface SliderProps extends ComponentPropsWithoutRef<typeof SliderPrimitive.Root> {
  /** The track label announced to assistive tech. */
  label?: string
  children?: ReactNode
}

/** A ranged control with a large touch target and keyboard stepping. */
export function Slider({ label, className, children, ...props }: SliderProps): ReactNode {
  return (
    <SliderPrimitive.Root
      className={cn('snap-slider', className)}
      aria-label={label}
      {...props}
      {...part('slider', 'root')}
    >
      <SliderPrimitive.Track {...part('slider', 'track')} className="snap-slider-track">
        <SliderPrimitive.Range {...part('slider', 'range')} className="snap-slider-range" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb {...part('slider', 'thumb')} className="snap-slider-thumb" aria-label={label} />
      {children}
    </SliderPrimitive.Root>
  )
}
