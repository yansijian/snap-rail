/**
 * The framework root barrel: one import site for the whole UI substrate —
 * the renderer runtime, the slot registry, the shared shadcn-style
 * primitives, the theme tokens, and the settings/session/variables/workflows
 * services. Component plugins bind to this package through
 * `snapRail.framework`; replacing it is an ecosystem switch, not a hot swap.
 *
 * @module @snap-rail/framework-shadcn
 */

export * from './runtime.tsx'
export * from './slots.tsx'
export * from './semantic.tsx'
export * from './settings-pages.ts'
export * from './session.ts'
export * from './variables.ts'
export * from './workflows.ts'
export * from './fallback.tsx'
