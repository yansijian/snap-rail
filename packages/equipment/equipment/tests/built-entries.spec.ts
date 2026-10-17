// @vitest-environment node
/**
 * Runs built-entries.probe.mjs under plain node: the probe boots the real
 * host stack from the BUILT faces (lib/index.js + lib/rpc.js through the
 * node_modules surface — the desktop resolution), which is the only vantage
 * point that can see class-duplication packaging bugs. Vitest's own graph
 * mixes src aliases and lib artifacts and would mask them; the child
 * process keeps this spec honest. Build before testing (repo convention).
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('equipment built host entries', () => {
  // The child boots the real host stack; under the full suite's parallel
  // load that easily passes vitest's 5s default — the probe's own spawn
  // timeout (30s) stays the honest bound, this only stops vitest racing it.
  it('maps seam failures to readable wire errors across the entry boundary', () => {
    const run = spawnSync(process.execPath,
      [fileURLToPath(new URL('./built-entries.probe.mjs', import.meta.url))],
      { encoding: 'utf8', timeout: 30_000 })
    if (run.status !== 0) {
      throw new Error(`probe failed (${run.status}):\n${run.stderr || run.stdout}`)
    }
    expect(run.stdout).toContain('BUILT-ENTRIES-OK')
  }, 60_000)
})
