/** Tiny static file server for local feed probing. `pnpm exec tsx scripts/tests/serve-feed.local.ts <dir> [port]` */
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'

const root = process.argv[2]!
const port = Number(process.argv[3] ?? 8123)
const server = createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname)).replaceAll('..', '')
  const file = join(root, path)
  try {
    if (!existsSync(file) || !statSync(file).isFile()) throw new Error('not a file')
    const bytes = readFileSync(file)
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) })
    response.end(bytes)
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' })
    response.end('nope')
  }
})
server.listen(port, '127.0.0.1', () => console.log(`serving ${root} at http://127.0.0.1:${port}`))
