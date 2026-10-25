/**
 * The built-in UI substrate's root barrel: semantic contract, region slots,
 * skin registry, and (as they land) components, layout primitives, settings,
 * charts, runtime, and fallback.
 *
 * @module @snap-rail/ui
 */

export * from './contract.ts'
export * from './charts.tsx'
export * from './components/index.ts'
export * from './fallback.tsx'
export * from './pages.tsx'
export * from './runtime.tsx'
export * from './settings.tsx'
export * from './slots.tsx'
export * from './skins.tsx'
export { default as slotsPlugin } from './slots.tsx'
export { default as skinsPlugin } from './skins.tsx'