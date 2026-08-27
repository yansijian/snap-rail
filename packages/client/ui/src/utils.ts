/**
 * Class-name combiner: clsx joins, tailwind-merge resolves conflicting
 * Tailwind utilities with the last one winning — the shadcn convention.
 *
 * @module @snap-rail/client-ui/utils
 */

import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge conditional class names into one Tailwind-aware string.
 * @param inputs - class values (strings, arrays, conditional objects).
 * @returns the merged class string.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
