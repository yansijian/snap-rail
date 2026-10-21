/**
 * The operator window's renderer entry. All of the boot logic lives in
 * `renderer-boot.tsx` — shared verbatim with the auxiliary surfaces — so this
 * module only states what is specific to `main`: it renders into `index.html`
 * and follows plugin-row changes with a reload.
 *
 * Dev and production are the same flow: installable plugins come from the
 * plugin pool in both, so `pnpm app:dev` without installed zips shows exactly
 * what a fresh install shows — the kernel's bootstrap install page (drag a zip
 * in, enable, restart).
 *
 * @module @snap-rail/desktop/client-main
 */

import { installRendererAutoReload } from '@snap-rail/client-kernel'
import { bootRenderer } from './renderer-boot.tsx'

const element = document.getElementById('root')
if (element === null) throw new Error('client: #root is missing from index.html')

const handle = await bootRenderer({ element, surface: 'main' })
// Row changes hot-apply host-side; the window reloads so the renderer's
// mounted occupants follow without an operator restart (settings-toggleable).
installRendererAutoReload(handle)