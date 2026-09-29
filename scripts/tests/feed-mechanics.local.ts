/** Local mechanics test for syncGiteaFeed (Phase 0): exercises the fresh
 * orphan-branch path and the existing-branch path against a local bare repo
 * standing in for Gitea. Run with: pnpm exec tsx scripts/tests/feed-mechanics.local.ts */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = join(tmpdir(), `snap-rail-feed-test-${Date.now()}`)
const giteaRoot = join(root, 'gitea')
const bareDir = join(giteaRoot, 'snap-rail', 'snap-rail.git')
const stage = join(root, 'stage')

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
}

// 1. A bare "Gitea" origin with one commit on the default branch.
mkdirSync(bareDir, { recursive: true })
git(bareDir, 'init', '--bare', '--initial-branch=main', '.')
const seed = join(root, 'seed')
mkdirSync(seed)
git(seed, 'init', '--initial-branch=main', '.')
git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init')
git(seed, 'push', bareDir, 'main')

// 2. A staged feed tree.
mkdirSync(join(stage, 'plugins'), { recursive: true })
writeFileSync(join(stage, 'plugins', 'index.json'), `${JSON.stringify({ plugins: [] }, null, 2)}\n`)

const { syncGiteaFeed } = await import('../publish.ts')
const gitea = { url: `file:///${giteaRoot.replaceAll('\\', '/')}`, owner: 'snap-rail', repo: 'snap-rail' }

// 3. First publish — the feed branch does not exist yet (orphan path).
await syncGiteaFeed(gitea, stage, '0.1.0')
const firstTree = execFileSync('git', ['--git-dir', bareDir, 'ls-tree', '--name-only', 'feed'], { encoding: 'utf8' })
console.log('feed tree after first publish:', JSON.stringify(firstTree.trim()))
if (!firstTree.includes('plugins')) throw new Error('FAIL: feed branch lacks plugins/')
const firstParentCount = execFileSync('git', ['--git-dir', bareDir, 'rev-list', '--count', 'feed'], { encoding: 'utf8' }).trim()
if (firstParentCount !== '1') throw new Error(`FAIL: orphan branch should carry exactly 1 commit, got ${firstParentCount}`)

// 4. Second publish — the branch exists (replace-tree path).
writeFileSync(join(stage, 'plugins', 'index.json'), '{"plugins":[],"v":2}\n')
await syncGiteaFeed(gitea, stage, '0.1.0')
const count = execFileSync('git', ['--git-dir', bareDir, 'rev-list', '--count', 'feed'], { encoding: 'utf8' }).trim()
const content = execFileSync('git', ['--git-dir', bareDir, 'show', 'feed:plugins/index.json'], { encoding: 'utf8' })
if (count !== '2') throw new Error(`FAIL: expected 2 commits on feed, got ${count}`)
if (!content.includes('"v":2')) throw new Error('FAIL: second publish did not replace the tree')

rmSync(root, { recursive: true, force: true })
console.log('OK: orphan seed + existing-branch replace both work')
