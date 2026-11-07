/**
 * Small helpers shared by the headless semantic components: class merging and
 * the stable `data-snap-*` anatomy that skins target.
 *
 * @module @snap-rail/ui/utils
 */

/** Join truthy class names. */
export function cn(...values: ReadonlyArray<string | false | null | undefined>): string {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ')
}

/**
 * The anatomy attributes every semantic component renders. The identity is
 * component-owned: components spread these AFTER caller props so a composite
 * can never mask a host part (a masked `button.root` loses every skin rule
 * and falls back to the UA default look). Composites tag their own wrappers
 * instead of pushing `part()` into a child component's props.
 */
export function part(component: string, name: string): Record<string, string> {
  return {
    'data-snap-component': component,
    'data-snap-part': `${component}.${name}`,
  }
}

/** Map a semantic size token to a control-height CSS variable. */
export function controlHeight(size: 'sm' | 'md' | 'lg'): string {
  return `var(--snap-control-height-${size})`
}

/** Map a semantic spacing token to a CSS variable. */
export function space(token: 'xs' | 'sm' | 'md' | 'lg' | 'xl'): string {
  return `var(--snap-space-${token})`
}