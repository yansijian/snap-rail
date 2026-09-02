import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SEED_MODULES } from '@snap-rail/plugin-kit/seeds'
import { describe, expect, it } from 'vitest'

/**
 * Renderer seed discipline: the installable client bundle externalizes
 * exactly SEED_MODULES, so every `@snap-rail/*` import in a renderer page
 * (.tsx) must be a seeded id — anything else would inline a duplicate copy
 * into the zip. Host-side faces (stats*.ts) are exempt: they run on the node
 * side where bare imports anchor to the app tree.
 */
describe('renderer seed discipline', () => {
  it('every @snap-rail import in .tsx pages resolves to a seeded module', () => {
    const src = join(import.meta.dirname, '../src')
    const offenders: string[] = []
    for (const file of readdirSync(src)) {
      if (!file.endsWith('.tsx')) continue
      const ids = [...readFileSync(join(src, file), 'utf8')
        .matchAll(/from ['"](@snap-rail\/[^'"]+)['"]/g)]
        .map(match => match[1]!)
      for (const id of ids) {
        if (!SEED_MODULES.includes(id)) offenders.push(`${file}: ${id}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
