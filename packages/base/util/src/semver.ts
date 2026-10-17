/**
 * The one semver-ish comparator every version check in snap-rail shares:
 * the installer's strictly-higher update rule, the engines ranges, and the
 * `requires` entries' `name@range` suffixes all read through this module —
 * never a private copy.
 *
 * Deliberately not the full semver spec: no dependency on a semver package,
 * just the subset snap-rail manifests use (core segments numeric, `-suffix`
 * prerelease ordering, `^ ~ >= > <= < =` and exact ranges).
 *
 * @module @snap-rail/util/semver
 */

/**
 * Compare two version strings: core segments compare numerically (missing
 * or non-numeric = 0), a `-suffix` prerelease orders before its release,
 * and prerelease identifiers compare numerically when both numeric and
 * lexicographically otherwise.
 *
 * @returns negative when `a < b`, positive when `a > b`, zero when equal.
 */
export function compareVersions(a: string, b: string): number {
  const [coreA, ...preA] = a.split('-')
  const [coreB, ...preB] = b.split('-')
  const segsA = (coreA ?? '').split('.')
  const segsB = (coreB ?? '').split('.')
  for (let i = 0; i < Math.max(segsA.length, segsB.length); i++) {
    const rawA = segsA[i]
    const rawB = segsB[i]
    const numA = rawA !== undefined && /^\d+$/.test(rawA) ? Number(rawA) : 0
    const numB = rawB !== undefined && /^\d+$/.test(rawB) ? Number(rawB) : 0
    if (numA !== numB) return numA < numB ? -1 : 1
  }
  const isPreA = preA.length > 0
  const isPreB = preB.length > 0
  if (isPreA !== isPreB) return isPreA ? -1 : 1
  if (!isPreA) return 0
  const idsA = preA.join('-').split('.')
  const idsB = preB.join('-').split('.')
  for (let i = 0; i < Math.max(idsA.length, idsB.length); i++) {
    const idA = idsA[i]
    const idB = idsB[i]
    if (idA === idB) continue
    if (idA === undefined) return -1
    if (idB === undefined) return 1
    const numA = /^\d+$/.test(idA) ? Number(idA) : null
    const numB = /^\d+$/.test(idB) ? Number(idB) : null
    if (numA !== null && numB !== null && numA !== numB) return numA < numB ? -1 : 1
    if ((numA === null) !== (numB === null)) return numA !== null ? -1 : 1
    return idA < idB ? -1 : 1
  }
  return 0
}

/** Does `version` satisfy `range`? Supported range forms: `^x.y.z` (same
 * major, at least), `~x.y.z` (same major.minor, at least), `>=` `>` `<=` `<`
 * `=` with an exact version, and a bare exact version. An unparsable range
 * or version satisfies nothing. */
export function satisfiesRange(version: string, range: string): boolean {
  const trimmed = range.trim()
  const target = parseCore(trimmed.replace(/^[^0-9]*/, ''))
  const actual = parseCore(version)
  if (target === undefined || actual === undefined) return false
  if (trimmed.startsWith('^')) return sameMajor(actual, target) && compareVersions(version, trimmed.slice(1).trim()) >= 0
  if (trimmed.startsWith('~')) {
    return sameMajor(actual, target) && actual[1] === target[1] && compareVersions(version, trimmed.slice(1).trim()) >= 0
  }
  if (trimmed.startsWith('>=')) return compareVersions(version, trimmed.slice(2).trim()) >= 0
  if (trimmed.startsWith('>')) return compareVersions(version, trimmed.slice(1).trim()) > 0
  if (trimmed.startsWith('<=')) return compareVersions(version, trimmed.slice(2).trim()) <= 0
  if (trimmed.startsWith('<')) return compareVersions(version, trimmed.slice(1).trim()) < 0
  if (trimmed.startsWith('=')) return compareVersions(version, trimmed.slice(1).trim()) === 0
  return compareVersions(version, trimmed) === 0
}

/** Split a `name@range` requires entry: the package name (scoped names
 * split at the second `@`) and the range suffix, or `undefined` when the
 * entry carries no range. */
export function splitNameRange(entry: string): { name: string, range?: string } {
  const startsWithScope = entry.startsWith('@')
  const separator = startsWithScope ? entry.indexOf('@', 1) : entry.indexOf('@')
  if (separator < 0) return { name: entry }
  const name = entry.slice(0, separator)
  const range = entry.slice(separator + 1)
  if (name === '' || range === '') return { name: entry }
  return { name, range }
}

function sameMajor(actual: readonly [number, number, number], target: readonly [number, number, number]): boolean {
  return actual[0] === target[0]
}

/** Parse `x.y.z` tolerating missing minor/patch (`^1.0`, `2`): absent
 * segments are zero. `undefined` when nothing numeric leads. */
function parseCore(value: string): [number, number, number] | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(value.trim())
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}
