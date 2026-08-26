/**
 * Dev orchestration: start the Vite dev server, then launch Electron with
 * `SNAP_RAIL_DEV_URL` pointing at it. Ctrl+C or server shutdown tears the
 * Electron child down with it.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const electronBin = require('electron')

const server = await createServer({ configFile: new URL('../vite.config.ts', import.meta.url).href })
await server.listen()
const port = server.config.server.port
if (port === undefined) throw new Error('dev: vite did not report a port')
const url = `http://localhost:${port}/`
console.log(`[snap-rail] vite dev server at ${url}`)

const child = spawn(electronBin, ['.'], {
  cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  env: { ...process.env, SNAP_RAIL_DEV_URL: url },
  stdio: 'inherit',
})

let exiting = false
const exit = async (signal) => {
  if (exiting) return
  exiting = true
  child.kill(signal)
  await server.close()
  process.exit(0)
}
child.on('exit', () => exit())
process.on('SIGINT', () => void exit('SIGINT'))
