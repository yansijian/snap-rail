/**
 * Headless host probe: boots the exact desktop composition (same builtins,
 * same appRoot) and dumps connection status, frames, and samples after a few
 * ticks. Run with `node scripts/probe-host.mjs` from apps/desktop.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '@snap-rail/app-boot'

const home = mkdtempSync(join(tmpdir(), 'sr-probe-'))
const ctx = await boot({
  binName: 'probe',
  home,
  builtinLayerPath: join(process.cwd(), 'resources/builtins.cordis.yml'),
  userLayerPath: join(home, 'plugins.yml'),
  appRoot: process.cwd(),
})

console.log('connections:', JSON.stringify(ctx.get('connections')?.list()))
console.log('points:', ctx.get('points')?.list().map(p => p.id).join(', '))

const frames = []
ctx.get('gateway')?.attachDownlink(frame => frames.push(frame.method))
await new Promise(resolve => setTimeout(resolve, 1600))

console.log('frame methods (first 15):', JSON.stringify(frames.slice(0, 15)))
console.log('frame total:', frames.length)
for (const id of ['demo.temperature', 'demo.counter', 'demo.running', 'demo.device']) {
  console.log('sample', id, JSON.stringify(ctx.get('points')?.read(id), (_, value) =>
    typeof value === 'bigint' ? `${value}n` : value))
}

await ctx.fiber.dispose()
rmSync(home, { recursive: true, force: true })
