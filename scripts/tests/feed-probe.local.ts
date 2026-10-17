/** Local probe test for check-feed-endpoint (Phase 0): builds a fake feed
 * (latest.yml + installer + index.json + zip), serves it over loopback HTTP
 * with no Range support, and runs the checker end-to-end.
 * Run with: pnpm exec tsx scripts/tests/feed-probe.local.ts */
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = join(import.meta.dirname, '..', '..')
const root = join(tmpdir(), `snap-rail-probe-${Date.now()}`)
const feed = join(root, 'feed')
mkdirSync(join(feed, 'desktop'), { recursive: true })
mkdirSync(join(feed, 'plugins'), { recursive: true })

const exeName = 'snap-rail-0.1.0-x64-setup.exe'
const exe = randomBytes(2048)
writeFileSync(join(feed, 'desktop', exeName), exe)
writeFileSync(join(feed, 'desktop', 'latest.yml'), `version: 0.1.0\npath: ${exeName}\nfiles:\n  - url: ${exeName}\n    sha512: aaa\n    size: ${exe.length}\n`)

const zip = randomBytes(1024)
const sha256 = createHash('sha256').update(zip).digest('hex')
writeFileSync(join(feed, 'plugins', '@t__mini.zip'), zip)
writeFileSync(join(feed, 'plugins', 'index.json'), `${JSON.stringify({ plugins: [{ name: '@t/mini', version: '1.0.0', file: '@t__mini.zip', sha256, size: zip.length }] }, null, 2)}\n`)
writeFileSync(join(feed, 'plugins', 'catalog.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), plugins: [], combos: [] }, null, 2)}\n`)

const server = createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url!, 'http://x').pathname)).replaceAll('..', '')
  try {
    const bytes = readFileSync(join(feed, path))
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) })
    response.end(bytes)
  } catch {
    response.writeHead(404).end('nope')
  }
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`

try {
  // spawn (not execSync): the server needs this process's event loop alive
  // to accept the checker's connections.
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'scripts/check-feed-endpoint.ts', '--update', `${base}/desktop`, '--plugins', `${base}/plugins`], {
      cwd: repoRoot,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    })
    child.on('exit', code => resolve(code ?? 1))
    child.on('error', reject)
  })
  if (code !== 0) throw new Error(`checker exited ${code}`)
  console.log('OK: probe completed (expect Range warning — the test server has no Range support)')
} finally {
  server.close()
  rmSync(root, { recursive: true, force: true })
}
