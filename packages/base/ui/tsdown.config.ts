import { defineConfig } from 'tsdown'

/** The UI substrate ships several pure/client entries; the host build only
 * needs the JS faces (types ride tsc's declaration output). */
const shared = {
  outDir: 'lib',
  format: ['esm'],
  platform: 'browser',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
} as const

export default defineConfig([
  { ...shared, entry: ['lib/types/index.js'] },
  { ...shared, entry: ['lib/types/components/index.js'] },
  { ...shared, entry: ['lib/types/charts.js'] },
  { ...shared, entry: ['lib/types/contract.js'] },
  { ...shared, entry: ['lib/types/slots.js'] },
  { ...shared, entry: ['lib/types/skins.js'] },
  { ...shared, entry: ['lib/types/settings.js'] },
  { ...shared, entry: ['lib/types/settings-pages/index.js'] },
  { ...shared, entry: ['lib/types/runtime.js'] },
  { ...shared, entry: ['lib/types/pages.js'] },
  { ...shared, entry: ['lib/types/fallback.js'] },
])