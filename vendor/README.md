# Vendored Packages

This directory contains source-vendored copies of the Cordis framework and its
foundation libraries. They are copied into this monorepo instead of being
depended on via npm, so snap-rail fully owns its framework layer (auditable,
patchable, pinned).

All vendored packages are renamed into the `@snap-rail` scope (`cordis` →
`@snap-rail/cordis`, `@cordisjs/plugin-<x>` → `@snap-rail/cordis-plugin-<x>`).

## Provenance

This vendored tree was copied from the [deepseek-harness](../..) repository's
`vendor/` directory at commit `141eb6fef8` and rescoped from `@deepseek-ai/` to
`@snap-rail/` (a delimited token rewrite over package names, dependency
entries, and import specifiers; `pnpm run verify-vendor-names` asserts zero
residue). The sources therefore carry **all 18 local hardening modifications**
documented in the origin repo's `vendor/README.md` local-modification log —
fiber lifecycle hardening, transactional Loader/Include config reconciliation,
durable debounced writes (Windows rename races), lazy config resolution, and
the rest. Re-apply that log's entries, not upstream-plain sources, when syncing
a package; the authoritative log lives in the deepseek-harness repository that
this tree was vendored from.

## Manifest

| Directory | npm name | Upstream name | Version | Upstream repo | Commit |
|---|---|---|---|---|---|
| `cosmokit/` | `@snap-rail/cosmokit` | `cosmokit` | 1.8.1 | https://github.com/deepseek-harness/cosmokit | `16f6fc058ade66e8ac5da0033d35a8d0f279f544` |
| `schemastery/` | `@snap-rail/schemastery` | `schemastery` | 3.18.0 | https://github.com/deepseek-harness/cordis (`packages/core`) | `e67cee00ad725bd1534aee930a979ea3eec6f698` |
| `cordis/` | `@snap-rail/cordis` | `cordis` | 4.0.0-rc.7 | https://github.com/cordiverse/cordis (`packages/core`) | `56b3d4f725681cf4556c1a8695a709cc3b6eed74` |
| `loader/` | `@snap-rail/cordis-plugin-loader` | `@cordisjs/plugin-loader` | 1.0.0-rc.5 | https://github.com/cordiverse/cordis (`packages/loader`) | `56b3d4f725681cf4556c1a8695a709cc3b6eed74` |
| `include/` | `@snap-rail/cordis-plugin-include` | `@cordisjs/plugin-include` | 1.0.4 | https://github.com/deepseek-harness/cordis (`packages/include`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `group/` | `@snap-rail/cordis-plugin-group` | `@cordisjs/plugin-group` | 1.0.0 | https://github.com/deepseek-harness/cordis (`packages/group`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |
| `timer/` | `@snap-rail/cordis-plugin-timer` | `@cordisjs/plugin-timer` | 1.1.2 | https://github.com/cordiverse/cordis (`packages/timer`) | `56b3d4f725681cf4556c1a8695a709cc3b6eed74` |
| `hmr/` | `@snap-rail/cordis-plugin-hmr` | `@cordisjs/plugin-hmr` | 1.0.15 | https://github.com/cordiverse/cordis (`packages/hmr`) | `56b3d4f725681cf4556c1a8695a709cc3b6eed74` |
| `logger-console/` | `@snap-rail/cordis-plugin-logger-console` | `@cordisjs/plugin-logger-console` | 1.0.0 | https://github.com/deepseek-harness/cordis (`packages/logger-console`) | `abb0a307cb1d3b0947f455d590cf5ba922d4caa4` |

Third-party dependencies of the vendored packages stay on npm:
`@standard-schema/spec`, `js-yaml`, `chokidar`, `picomatch`, `@babel/code-frame`,
`supports-color`, `node-addon-require-builtin`.

## Sync procedure

To update a vendored package:

1. Sync it in the origin deepseek-harness repository first (its `vendor/README.md`
   owns the exhaustive local-modification log and the upstream sync workflow).
2. Copy the synced `src/` (and `bin.js`, `README.md`, `LICENSE` if changed)
   over the directory here.
3. Re-apply the `@snap-rail/` scope rename (`pnpm run verify-vendor-names`
   must stay green).
4. Update the version and commit hash in the manifest table.
5. Run `pnpm install && pnpm run test && pnpm run build` at the repo root.
