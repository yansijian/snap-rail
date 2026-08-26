/**
 * Phase-1 design tokens: CSS custom properties + base classes occupants may
 * reference. A theming capability replaces this seat later.
 *
 * @module @snap-rail/client-runtime/theme
 */

export const THEME_CSS = `
:root {
  --sr-bg: #0b0f14;
  --sr-panel: #11161d;
  --sr-border: #1e2630;
  --sr-text: #c9d1d9;
  --sr-text-dim: #8b949e;
  --sr-accent: #2f81f7;
  --sr-ok: #3fb950;
  --sr-bad: #f85149;
  --sr-radius: 6px;
  --sr-space: 8px;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--sr-bg);
  color: var(--sr-text);
  font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 14px;
}
#root { height: 100%; }
.sr-shell { height: 100%; display: flex; flex-direction: column; }
.sr-shell-empty { margin: auto; color: var(--sr-text-dim); }
.sr-drag { -webkit-app-region: drag; }
.sr-nodrag { -webkit-app-region: no-drag; }
`
