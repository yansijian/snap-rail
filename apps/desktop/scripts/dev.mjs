/**
 * Dev orchestration: fall back to one root build when a built-in plugin
 * entry has no lib output, rebuild the host faces, start the Vite dev
 * server, then launch Electron with `SNAP_RAIL_DEV_URL` pointing at it.
 * Server shutdown or child exit tears the other side down with it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const electronBin = require('electron')
const yaml = require('js-yaml')

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url))
const appDir = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

// Composition resolves every built-in entry from the app tree via
// require.resolve (app-boot's resolveModuleSpecifier), so a workspace
// package that never saw a root build — no lib/ output — only surfaces
// after Electron is up as "cannot resolve plugin". Probe the exact same
// names the exact same way and fall back to one root build. Stale
// already-built output is deliberately not detected: refreshing it is
// the documented build-before-test workflow.
const hostRequire = createRequire(join(appDir, 'package.json'))
const builtinNames = yaml
  .load(readFileSync(join(appDir, 'resources', 'builtins.cordis.yml'), 'utf8'))
  .map(entry => entry.name)
  // names compose passes through untouched don't go through require.resolve
  .filter(name => !name.startsWith('cordis:') && !name.startsWith('.') && !name.startsWith('file:') && !isAbsolute(name))
const unresolved = builtinNames.filter(name => {
  try {
    hostRequire.resolve(name)
    return false
  } catch {
    return true
  }
})
if (unresolved.length > 0) {
  const unlinked = unresolved.filter(name => !existsSync(join(appDir, 'node_modules', ...name.split('/').slice(0, 2))))
  if (unlinked.length > 0) throw new Error(`dev: workspace packages not linked (${unlinked.join(', ')}); run \`pnpm install\` first`)
  console.log(`[snap-rail] builtin entries without lib output: ${unresolved.join(', ')}; running root build`)
  const root = spawnSync('pnpm run build', { cwd: repoRoot, stdio: 'inherit', shell: true })
  if (root.status !== 0) throw new Error('dev: root build failed')
}

// dist/main and dist/preload are not in the root build graph; Electron
// would happily launch a stale bundle still running pre-refactor host code
// (e.g. injecting a renamed service). tsc -b is incremental, so this is a
// fast no-op whenever the faces are already current.
const faces = spawnSync('pnpm run build:faces:host', { cwd: appDir, stdio: 'inherit', shell: true })
if (faces.status !== 0) throw new Error('dev: host faces build failed')

const server = await createServer({ configFile })
await server.listen()

const url = server.resolvedUrls?.local[0]
if (url === undefined) throw new Error('dev: vite did not report a local url')
console.log(`[snap-rail] vite dev server at ${url}`)

const child = spawn(electronBin, ['.'], {
  cwd: appDir,
  env: { ...process.env, SNAP_RAIL_DEV_URL: url },
  stdio: 'inherit',
})

let exiting = false
function exit(signal = 'SIGINT') {
  if (exiting) return
  exiting = true
  child.kill(signal)
  // server.close() can hang on open sockets/watchers (Windows): force exit
  // shortly after, win or lose.
  void server.close()
  setTimeout(() => process.exit(0), 1000)
}
child.on('exit', () => exit('SIGKILL'))
process.on('SIGINT', () => exit())
process.on('SIGTERM', () => exit('SIGTERM'))
