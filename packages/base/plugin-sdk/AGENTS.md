# Plugin SDK Agent Guide

Read `README.md` first. This package is the only authoring surface an
independent plugin repository needs; never solve a missing contract by copying
files from the snap-rail workspace.

- Validate `package.json.snapRail` with `definePluginManifest` and declare
  every *plugin* dependency once in `requires` — package names, `name@range`
  version-constrained packages, or `service:` ids. npm type packages (the
  SDK's `./api` facade, `@snap-rail/protocol`, `@snap-rail/ui`) belong in
  `dependencies`/`devDependencies`, never in `requires`.
  `snapRail.framework` / `snapRail.capabilities` are retired. Renderer
  plugins declare `uiProfile: native|integrated|custom`.
- Depend on published SDK and contract packages from public npm. Do not import
  `apps/desktop` or `packages/*/src` from an external plugin.
- Base service authoring APIs are the SDK's `./api` (host types:
  `GatewayService`, `SettingsService`) and `./api/client` (renderer:
  `HostLink`, `subscribeFrame`, `rpcErrorText`). The underlying
  gateway/connection/settings packages are SDK dependencies; external plugins
  must not install or import them directly.
- Drivers import the pure `@snap-rail/equipment/driver` registration contract
  and do not own equipment storage. UI plugins register pages
  (`ctx.pages`), layouts (`ctx.ui`), settings pages (`ctx.settings`) and skins
  (`ctx.skins`) through `@snap-rail/ui` and use its shared semantic
  components; `@snap-rail/ui` is a base seed, not a plugin dependency.
- Store providers implement the store seam and are globally exclusive
  (`snapRail.exclusive: 'store-backend'`); use the pure `@snap-rail/store`
  `StoreService` type and let the provider own its backend. Consumers depend on
  the store definition instead of importing a backend implementation.
- Build with `hostBundle` and/or `clientBundle`; the release packer includes
  only built faces and the trimmed manifest, never `src/`. `clientBundle`
  stamps `snapRail.client.seedAbi`; never hand-write it.
- Publish to your own repository's rolling `feed` release and tag the repo
  `snap-rail-plugin` — there is no central market repo and no PR gate.
- Before publishing, run `snap-rail-plugin doctor .`, `pnpm build`, `snap-rail-plugin inspect <zip>`, and
  `snap-rail-plugin verify <zip> --public-key <key.pem> --key-id <id>`.
