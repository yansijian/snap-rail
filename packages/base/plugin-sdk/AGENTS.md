# Plugin SDK Agent Guide

Read `README.md` first. This package is the only authoring surface an
independent plugin repository needs; never solve a missing contract by copying
files from the snap-rail workspace.

- Validate `package.json.snapRail` with `definePluginManifest` and declare every
  versioned capability in `provides`/`requires`.
- Depend on published SDK and contract packages. Do not import `apps/desktop` or
  `packages/*/src` from an external plugin.
- Drivers import the pure `@snap-rail/equipment/driver` registration contract
  and do not own equipment storage. UI plugins register semantic
  views/layouts/navigation through the
  framework contract and use shared renderer primitives.
- Store providers implement the versioned `store.backend` capability and are
  globally exclusive; use the pure `@snap-rail/store` `StoreService` type and
  let the provider own its backend. Consumers depend on the store definition
  instead of importing a backend implementation.
- Build with `hostBundle` and/or `clientBundle`; the release packer includes
  only built faces and the trimmed manifest, never `src/`.
- Before publishing, run `snap-rail-plugin doctor .`, `pnpm build`, `snap-rail-plugin inspect <zip>`, and
  `snap-rail-plugin verify <zip> --public-key <key.pem> --key-id <id>`.
