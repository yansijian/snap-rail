// @vitest-environment node
/**
 * Class-scanning gate for theme.css — the sole stylesheet. @source globs
 * resolve relative to the css file itself (not the Vite cwd), so a package
 * whose sources sit outside them silently loses every utility class it
 * alone uses: the c2860df move out of packages/client did exactly that to
 * the titlebar and the workflow pages. The checks are prefix-level on
 * purpose — the globs in use are broad by design (a single src-only sweep
 * of the packages tree) so the occupant roster is never re-listed outside
 * util/manifest.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const themeCssPath = fileURLToPath(new URL('../src/theme.css', import.meta.url))
const themeCssDir = dirname(themeCssPath)

/** Static (glob-free) prefixes of the @source directives, resolved css-relative. */
function sourcePrefixes(): string[] {
  const css = readFileSync(themeCssPath, 'utf8')
  const patterns = [...css.matchAll(/^@source\s+"([^"]+)";\s*$/gm)].map(match => match[1]!)
  expect(patterns.length, 'theme.css must declare at least one @source').toBeGreaterThan(0)
  return patterns.map(pattern => {
    const staticSegments: string[] = []
    for (const segment of pattern.split('/')) {
      if (segment.includes('*') || segment.includes('{')) break
      staticSegments.push(segment)
    }
    return resolve(themeCssDir, ...staticSegments)
  })
}

describe('theme.css class scanning', () => {
  it('keeps every @source directive live (dead path math fails loud)', () => {
    for (const prefix of sourcePrefixes()) {
      expect(existsSync(prefix), `@source prefix does not exist: ${prefix}`).toBe(true)
    }
  })

  it('covers every workspace package (renderer sources must stay in the scan)', () => {
    const packagesRoot = resolve(themeCssDir, '../../..')
    const prefixes = sourcePrefixes()
    const packages = readdirSync(packagesRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'node_modules')
      .flatMap(group => readdirSync(join(packagesRoot, group.name), { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name !== 'node_modules')
        .map(entry => join(packagesRoot, group.name, entry.name)))
      .filter(dir => existsSync(join(dir, 'package.json')))
    expect(packages.length, 'the packages walk found nothing — path math rotted').toBeGreaterThan(0)
    for (const dir of packages) {
      const covered = prefixes.some(prefix => {
        const rel = relative(prefix, dir)
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
      })
      expect(covered, `package outside every @source prefix: ${relative(packagesRoot, dir)}`).toBe(true)
    }
  })
})
