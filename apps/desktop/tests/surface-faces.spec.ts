import { describe, expect, it } from 'vitest'
import type { ClientConfigRow } from '@snap-rail/station-rpc/contract'
import { faceFor, isSeedProvider, plannedFace } from '../src/client/surface-faces.ts'

/**
 * The renderer's face-selection rule: one package, one bundle per window. The
 * main window loads the package's own bundle under the package id; an
 * auxiliary window loads the bundle built for it under `<package>/<surface>`;
 * seed providers load everywhere because their contributed modules are what
 * every face requires.
 */

/** A row for a package shipping a main bundle plus a ball face. */
function row(overrides: Partial<ClientConfigRow> = {}): ClientConfigRow {
  return {
    name: '@acme/suite',
    enabled: true,
    clientUrl: 'snap-plugin://pool/acme-suite/lib-client/client.js',
    surfaceUrls: { ball: 'snap-plugin://pool/acme-suite/lib-client/ball.js' },
    ...overrides,
  }
}

describe('face selection', () => {
  it('loads the main bundle under the package id on the operator window', () => {
    expect(faceFor(row(), 'main')).toEqual({
      url: 'snap-plugin://pool/acme-suite/lib-client/client.js',
      moduleId: '@acme/suite',
    })
  })

  it('loads the surface bundle under <package>/<surface> on an auxiliary window', () => {
    expect(faceFor(row(), 'ball')).toEqual({
      url: 'snap-plugin://pool/acme-suite/lib-client/ball.js',
      moduleId: '@acme/suite/ball',
    })
  })

  it('contributes nothing to a surface the package ships no bundle for', () => {
    expect(faceFor(row(), 'panel')).toBeUndefined()
    // And a row without a renderer bundle at all is invisible everywhere.
    expect(faceFor(row({ clientUrl: undefined }), 'main')).toBeUndefined()
  })

  it('never reuses the main bundle as an auxiliary face', () => {
    const noSurfaces = row({ surfaceUrls: undefined })
    expect(faceFor(noSurfaces, 'ball')).toBeUndefined()
    // The provider rule below loads it — under the package id, as a provider.
    expect(plannedFace(noSurfaces, 'ball')).toBeUndefined()
  })
})

describe('seed providers', () => {
  it('recognises the framework and any row contributing seeds', () => {
    expect(isSeedProvider(row({ kind: 'framework' }))).toBe(true)
    expect(isSeedProvider(row({ seeds: ['ui', 'runtime'] }))).toBe(true)
    expect(isSeedProvider(row({ seeds: [] }))).toBe(false)
    expect(isSeedProvider(row())).toBe(false)
  })

  it('loads a provider on every surface from its main bundle', () => {
    const framework = row({
      name: '@acme/framework',
      kind: 'framework',
      seeds: ['ui', 'runtime'],
      surfaceUrls: undefined,
    })
    // On main the provider's own bundle is the main face.
    expect(plannedFace(framework, 'main')).toEqual({
      url: 'snap-plugin://pool/acme-suite/lib-client/client.js',
      moduleId: '@acme/framework',
    })
    // On the ball it still loads (its seeds and styling are required) …
    expect(plannedFace(framework, 'ball')).toEqual({
      url: 'snap-plugin://pool/acme-suite/lib-client/client.js',
      moduleId: '@acme/framework',
    })
    // … but a plain occupant without a ball face does not.
    expect(plannedFace(row({ name: '@acme/widget', surfaceUrls: undefined }), 'ball')).toBeUndefined()
  })

  it('prefers the surface bundle over the provider fallback', () => {
    // A framework that ships its own ball face loads that one, not its main
    // bundle, even though it is a seed provider.
    const framework = row({ kind: 'framework', seeds: ['ui'] })
    expect(plannedFace(framework, 'ball')).toEqual({
      url: 'snap-plugin://pool/acme-suite/lib-client/ball.js',
      moduleId: '@acme/suite/ball',
    })
  })
})