/**
 * Dev orchestration: rebuild the host faces, start the Vite dev server,
 * then launch Electron with `SNAP_RAIL_DEV_URL` pointing at it. Server
 * shutdown or child exit tears the other side down with it.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const electronBin = require('electron')

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url))
const appDir = fileURLToPath(new URL('..', import.meta.url))

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
