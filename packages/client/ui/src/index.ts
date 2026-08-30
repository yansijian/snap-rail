/**
 * The UI primitive seam: theme tokens (theme.css) plus the shadcn-style
 * component set every UI plugin shares. Consumers import components by
 * package name; the runtime imports `@snap-rail/client-ui/theme.css` once.
 *
 * @module @snap-rail/client-ui
 */

export { cn } from './utils.ts'
export { useRefresh } from './hooks.tsx'
export { Button, type ButtonProps } from './button.tsx'
export { Card, CardHeader, CardTitle, CardContent } from './card.tsx'
export { Badge, type BadgeProps } from './badge.tsx'
export { Switch } from './switch.tsx'
export { Tooltip, TooltipRoot, type TooltipProps, type TooltipContentProps } from './tooltip.tsx'
export { ScrollArea } from './scroll-area.tsx'
export { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './dialog.tsx'
export { Input } from './input.tsx'
export { Label } from './label.tsx'
export { Checkbox } from './checkbox.tsx'
export { RadioGroup, RadioGroupItem } from './radio-group.tsx'
export { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from './select.tsx'
export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from './table.tsx'
export { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs.tsx'
export { Collapsible, CollapsibleTrigger, CollapsibleChevron, CollapsibleContent } from './collapsible.tsx'
export { Led, type LedTone } from './led.tsx'
