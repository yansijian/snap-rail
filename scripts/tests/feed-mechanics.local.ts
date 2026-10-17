/** Local mechanics test for syncRollingRelease: exercises the fresh-tag path
 * and the delete-and-recreate path against an in-process HTTP stand-in for
 * the Gitea release API. Run with: pnpm exec tsx scripts/tests/feed-mechanics.local.ts */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = join(tmpdir(), `snap-rail-feed-test-${Date.now()}`)
const stage = join(root, 'stage')

/** The stand-in Gitea: one release per tag, assets kept by name. */
const releases = new Map<string, { id: number, assets: Map<string, Uint8Array> }>()
let nextId = 1

function bodyOf(request: import('node:http').IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  request.on('data', chunk => chunks.push(chunk))
  return new Promise(resolve => request.on('end', () => resolve(Buffer.concat(chunks))))
}

const server: Server = await new Promise(resolve => {
  const it = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://test')
    const respond = (status: number, payload?: unknown): void => {
      response.statusCode = status
      if (payload === undefined) response.end()
      else {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(payload))
      }
    }
    if (request.method === 'GET' && /^\/api\/v1\/repos\/[^/]+\/[^/]+\/releases\/tags\/(.+)$/.test(url.pathname)) {
      const tag = decodeURIComponent(url.pathname.split('/').pop()!)
      const release = releases.get(tag)
      if (release === undefined) return respond(404, { message: 'not found' })
      return respond(200, { id: release.id, assets: [...release.assets.keys()].map(name => ({ id: name.length, name })) })
    }
    if (request.method === 'DELETE' && /^\/api\/v1\/repos\/[^/]+\/[^/]+\/releases\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/').pop())
      for (const [tag, release] of releases) if (release.id === id) releases.delete(tag)
      return respond(204)
    }
    if (request.method === 'DELETE' && /\/tags\//.test(url.pathname)) {
      const tag = decodeURIComponent(url.pathname.split('/').pop()!)
      releases.delete(tag)
      return respond(204)
    }
    if (request.method === 'POST' && /\/releases$/.test(url.pathname)) {
      const parsed = JSON.parse((await bodyOf(request)).toString('utf8')) as { tag_name: string }
      releases.set(parsed.tag_name, { id: nextId++, assets: new Map() })
      return respond(201, { id: nextId - 1 })
    }
    if (request.method === 'POST' && /\/assets$/.test(url.pathname)) {
      const name = url.searchParams.get('name')!
      const id = Number(url.pathname.match(/\/releases\/(\d+)\/assets$/)![1])
      for (const release of releases.values()) {
        if (release.id === id) release.assets.set(name, new Uint8Array(await bodyOf(request)))
      }
      return respond(201, { id: 0, name })
    }
    respond(404, { message: `unrouted ${request.method} ${url.pathname}` })
  })
  it.listen(0, '127.0.0.1', () => resolve(it))
})
const port = (server.address() as { port: number }).port

// A staged feed tree: one plugin-feed file plus one desktop-trio file.
mkdirSync(join(stage, 'plugins'), { recursive: true })
mkdirSync(join(stage, 'desktop'), { recursive: true })
writeFileSync(join(stage, 'plugins', 'index.json'), `${JSON.stringify({ plugins: [] }, null, 2)}\n`)
writeFileSync(join(stage, 'desktop', 'latest.yml'), 'version: 0.1.0\n')

const { syncRollingRelease } = await import('../publish.ts')
const gitea = { kind: 'gitea' as const, url: `http://127.0.0.1:${port}`, owner: 'snap-rail', repo: 'snap-rail', token: 'test' }

// First publish — the tag does not exist yet (create path).
await syncRollingRelease(gitea, stage, 'feed')
const first = releases.get('feed')
if (first === undefined) throw new Error('FAIL: feed release missing after first publish')
if (![...first.assets.keys()].includes('index.json')) throw new Error('FAIL: index.json not uploaded')
if (![...first.assets.keys()].includes('latest.yml')) throw new Error('FAIL: desktop trio not uploaded flat')

// Second publish — the tag exists (delete-and-recreate path, new content).
writeFileSync(join(stage, 'plugins', 'index.json'), '{"plugins":[],"v":2}\n')
await syncRollingRelease(gitea, stage, 'feed')
const second = releases.get('feed')
if (second === undefined) throw new Error('FAIL: feed release missing after republish')
if (second.id === first.id) throw new Error('FAIL: the old release was not deleted and recreated')
const bytes = second.assets.get('index.json')
if (bytes === undefined || !Buffer.from(bytes).includes('"v":2')) throw new Error('FAIL: republished asset content did not replace the old one')

await new Promise(resolve => server.close(() => resolve(undefined)))
rmSync(root, { recursive: true, force: true })
console.log('OK: fresh-tag create + delete-and-recreate both work (flat assets, gitea dialect)')
