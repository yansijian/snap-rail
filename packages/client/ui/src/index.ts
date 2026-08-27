/**
 * The UI primitive seam: theme tokens (theme.css) plus the shadcn-style
 * component set every UI plugin shares. Consumers import components by
 * package name; the runtime imports `@snap-rail/client-ui/theme.css` once.
 *
 * @module @snap-rail/client-ui
 */

export { cn } from './utils.ts'
export { Button, type ButtonProps } from './button.tsx'
export { Card, CardHeader, CardTitle, CardContent } from './card.tsx'
export { Badge, type BadgeProps } from './badge.tsx'
export { Switch } from './switch.tsx'
export { Tooltip, TooltipRoot, type TooltipProps, type TooltipContentProps } from './tooltip.tsx'
export { ScrollArea } from './scroll-area.tsx'
