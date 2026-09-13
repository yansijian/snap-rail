/**
 * Export-synthesis gates: the generated plugin's file set must match the
 * release format plugin-kit assembles — a trimmed manifest naming the host
 * face, an ESM shim whose static imports cover exactly the body's requires,
 * and the client face in the clientBundle wrapper shape (which must stay
 * executable through the module loader's `load` registration).
 *
 * @module snap-rail/forge/tests/export.spec
 */

import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { buildExportFiles, buildExportZip, exportPackageName } from '../src/export.ts'
import type { VersionRecord } from '../src/registry.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** A host half requiring two whitelisted modules (one twice — deduped). */
const HOST_SRC = [
  "const { z } = require('zod')",
  "const { Context } = require('@snap-rail/cordis')",
  "require('zod')",
  'return {',
  "  name: 'weekly-report-host',",
  '  apply() {},',
  '}',
].join('\n')

const CLIENT_SRC = "return { name: 'weekly-report-client', apply() {} }"

/** The version record an export packages. */
function sampleVersion(): VersionRecord {
  return {
    pluginId: 'weekly-report',
    seq: 3,
    versionId: 'v3',
    summary: '增加标题',
    hostSrc: HOST_SRC,
    clientSrc: CLIENT_SRC,
    createdAt: 1_700_000_000_000,
  }
}

describe('export file-set synthesis', () => {
  it('names exports @forge/<id> and emits manifest + both faces', () => {
    expect(exportPackageName('weekly-report')).toBe('@forge/weekly-report')
    const files = buildExportFiles({ version: sampleVersion(), title: '周报', description: '每周产量' })
    expect(Object.keys(files).sort()).toEqual(['client/client.js', 'host/index.js', 'package.json'])
    const manifest = JSON.parse(new TextDecoder().decode(files['package.json']!)) as Record<string, unknown>
    expect(manifest['name']).toBe('@forge/weekly-report')
    expect(manifest['version']).toBe('0.3.0')
    expect(manifest['type']).toBe('module')
    expect(manifest['main']).toBe('host/index.js')
    expect(manifest['snapRail']).toEqual({ kind: 'plugin', client: { entry: 'client/client.js' } })
  })

  it('omits the client face for host-only versions and refuses client-only ones', () => {
    const hostOnly = buildExportFiles({
      version: { ...sampleVersion(), clientSrc: null },
      title: '周报',
      description: '',
    })
    expect(Object.keys(hostOnly).sort()).toEqual(['host/index.js', 'package.json'])
    expect((JSON.parse(new TextDecoder().decode(hostOnly['package.json']!)) as { snapRail: unknown }).snapRail)
      .toEqual({ kind: 'plugin' })
    expect(() => buildExportFiles({
      version: { ...sampleVersion(), hostSrc: null },
      title: '周报',
      description: '',
    })).toThrow(/宿主半边/)
  })

  it('imports exactly the distinct whitelisted requires of the body and embeds it verbatim', () => {
    const host = new TextDecoder().decode(buildExportFiles({ version: sampleVersion(), title: 't', description: '' })['host/index.js']!)
    expect(host).toContain('import * as m0 from "zod";')
    expect(host).toContain('import * as m1 from "@snap-rail/cordis";')
    expect(host).not.toContain('m2')
    expect(host).toContain('export default plugin')
    // The body rides in as a JSON string literal, "use strict" prepended.
    expect(host).toContain(JSON.stringify(`"use strict";\n${HOST_SRC}`).slice(1, -1))
  })

  it('wraps the client half in the clientBundle registration shape and it executes', () => {
    const client = new TextDecoder().decode(buildExportFiles({ version: sampleVersion(), title: 't', description: '' })['client/client.js']!)
    expect(client.startsWith('window.__ModuleLoader__.load({ id: "@forge/weekly-report", factory: function (require, module, exports) {')).toBe(true)
    expect(client.trimEnd().endsWith('return module.exports && module.exports.__esModule === true && "default" in module.exports ? module.exports.default : module.exports; } });')).toBe(true)

    // Executability: the wrapper only touches the loader global; feed it a
    // recording stub and run the factory the way a renderer would.
    const loaded: Array<{ id: string, plugin: unknown }> = []
    const previousWindow = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = {
      __ModuleLoader__: {
        load(entry: { id: string, factory: (require: (id: string) => unknown, module: Record<string, unknown>, exports: Record<string, unknown>) => unknown }): void {
          const module: Record<string, unknown> = {}
          const exports: Record<string, unknown> = {}
          const value = entry.factory(() => undefined, module, exports)
          loaded.push({ id: entry.id, plugin: value ?? module })
        },
      },
    }
    try {
      // eslint-disable-next-line no-new-func -- the wrapper is a classic script
      new Function(client)()
      expect(loaded).toHaveLength(1)
      expect(loaded[0]!.id).toBe('@forge/weekly-report')
      expect((loaded[0]!.plugin as { name?: string }).name).toBe('weekly-report-client')
    } finally {
      if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window
      else (globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('round-trips through a real zip', async () => {
    const home = mkdtempSync(join(tmpdir(), 'snap-rail-forge-export-'))
    homes.push(home)
    const path = join(home, 'weekly-report.zip')
    const zipped = Buffer.from(buildExportZip({ version: sampleVersion(), title: '周报', description: '' }))
    writeFileSync(path, zipped)
    const files = unzipSync(new Uint8Array(readFileSync(path)))
    expect(Object.keys(files).sort()).toEqual(['client/client.js', 'host/index.js', 'package.json'])
  })
})
