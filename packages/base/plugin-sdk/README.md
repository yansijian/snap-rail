# @snap-rail/plugin-sdk

The public authoring surface for snap-rail plugins. Use this package from an
independent plugin repository; do not import snap-rail workspace source paths.

The repository templates are the reference implementations for drivers, store
providers, UI views, layouts, host services, tools, and suites. A plugin must build a host
face, a client face, or both, and must ship only through the release packer.
`definePluginManifest` and `pluginPackageSchema` are the machine-readable
schema; agents should read their generated declarations instead of searching
the snap-rail source tree.

## Development flow

```sh
pnpm dlx snap-rail-plugin init my-plugin --template driver
cd my-plugin
pnpm install
pnpm build
snap-rail-plugin doctor .
snap-rail-plugin pack . --out dist --sign-key publisher.private.pem --key-id gitea-main-2026
snap-rail-plugin inspect dist/my-plugin.zip
snap-rail-plugin verify dist/my-plugin.zip --public-key publisher.pem --key-id gitea-main-2026
```

The SDK exports the manifest schema, capability requirements, client and host
bundle presets, release assembly, and Ed25519 release signing helpers.
Driver templates consume the pure `@snap-rail/equipment/driver` type face; the
equipment Host implementation remains behind the Host service boundary.
