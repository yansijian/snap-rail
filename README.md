# snap-rail

An open, plugin-based industrial terminal. Everything is a plugin — the point
table, the protocol adapters, the layout, the title bar — composed at boot from
an ordered plugin list over the vendored Cordis framework.

Phase 1 delivers the core: the host plugin runtime (Electron main process),
the four-quadrant RPC protocol between host and renderer, the field seam
(live point table + connections), and a complete set of first-party plugins
that exercise the whole pipeline: a mock driver, a dashboard panel, plugin and
connection management pages, and a replaceable default layout.

## Layout

```
vendor/      Vendored Cordis framework (pinned source copies; vendor/README.md)
packages/    Capability groups: packages/<group>/<pkg>
  boot/        app-boot — host boot glue (scan, two-layer composition, boot)
  protocol/    protocol / gateway / connection — the RPC seam
  field/       field (point table seam) + driver-mock (first provider)
  client/      desktop client spine (kernel / slots / runtime) + UI plugins
  audit/ settings/ util/
apps/desktop  The Electron application (frameless window, IPC carrier)
```

## Commands

```sh
pnpm install
pnpm run build      # tsc -b (lib/types) + tsdown (lib)
pnpm run typecheck
pnpm run test
```

License: Apache-2.0 (vendored Cordis packages keep their upstream MIT
license files).
