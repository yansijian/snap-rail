/**
 * Plugin catalog page entry: shared site behavior plus hydration of the
 * ecosystem catalog from src/content.ts (one data source for the cards).
 */
import './styles.css';
import { initSite } from './site';
import { INSTALL_STEPS, KIND_META, PLUGIN_GROUPS, SITE } from './content';

// 先注入目录再 initSite——显现观察器只认调用时刻在 DOM 里的 .reveal。
renderCatalog();
renderInstallSteps();
initSite('plugins');

function renderCatalog(): void {
  const root = document.querySelector<HTMLElement>('#catalog');
  if (!root) return;

  const sections = PLUGIN_GROUPS.map((group) => {
    const cards = group.plugins
      .map((plugin) => {
        const kind = KIND_META[plugin.kind];
        const badges = [
          plugin.badge ? `<span class="badge text-primary">${plugin.badge}</span>` : '',
          ...plugin.permissions.map(
            (perm) => `<span class="badge text-warning/90">${perm}</span>`,
          ),
        ]
          .filter(Boolean)
          .join('');
        return `
          <article class="section-card reveal flex flex-col gap-4 p-6">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h3 class="font-mono text-base font-semibold">${plugin.name}</h3>
                <p class="mt-0.5 text-xs text-muted-foreground">${kind.label} · v0.1.0</p>
              </div>
              <div class="flex flex-wrap justify-end gap-1.5">${badges}</div>
            </div>
            <p class="text-sm leading-relaxed text-muted-foreground">${plugin.description}</p>
            <a class="btn btn-ghost mt-auto self-start text-sm" href="${SITE.releases}" target="_blank" rel="noopener">
              下载 zip
            </a>
          </article>`;
      })
      .join('');
    return `
      <section class="mt-14 first:mt-0">
        <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 class="text-xl font-semibold">${group.title}</h2>
          <p class="text-sm text-muted-foreground">${group.note}</p>
        </div>
        <div class="mt-5 grid gap-5 md:grid-cols-2">${cards}</div>
      </section>`;
  });
  root.innerHTML = sections.join('');
}

function renderInstallSteps(): void {
  const root = document.querySelector<HTMLElement>('#install-steps');
  if (!root) return;
  root.innerHTML = INSTALL_STEPS.map(
    (step, i) => `
      <li class="section-card flex gap-4 p-5">
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-primary/50 bg-primary/10 font-mono text-sm text-primary">${i + 1}</span>
        <div>
          <h3 class="font-semibold">${step.title}</h3>
          <p class="mt-1 text-sm leading-relaxed text-muted-foreground">${step.detail}</p>
        </div>
      </li>`,
      ).join('');
}
