/**
 * Plugin catalog page entry: shared site behavior plus hydration of the
 * ecosystem catalog and the download section from src/generated/catalog.ts
 * (regenerated from the feed's catalog.json on every publish — the site and
 * the feed can not drift).
 */
import './styles.css';
import { initSite } from './site';
import { INSTALL_STEPS, KIND_META } from './content';
import { CATALOG, FEED_BASE, type CatalogPlugin } from './generated/catalog';

// 先注入目录再 initSite——显现观察器只认调用时刻在 DOM 里的 .reveal。
renderCatalog();
renderDownload();
renderInstallSteps();
initSite('plugins');

/** Collapse a readme to a one-line plain-text excerpt for the card. */
function excerpt(readme: string | undefined): string {
  if (!readme) return '';
  const text = readme
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`|[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 150 ? `${text.slice(0, 150)}…` : text;
}

function renderCatalog(): void {
  const root = document.querySelector<HTMLElement>('#catalog');
  if (!root) return;

  if (CATALOG.plugins.length === 0) {
    root.innerHTML = `
      <div class="section-card p-8 text-center text-sm text-muted-foreground">
        插件目录尚未发布——先在仓库运行 <code class="font-mono">pnpm run publish</code> 装配 feed，再重新构建本站。
      </div>`;
    return;
  }

  // Group by the author's category marker (其他 pinned last), matching the
  // in-app plugins page's grouping vocabulary.
  const sections = new Map<string, CatalogPlugin[]>();
  for (const plugin of CATALOG.plugins) {
    const marker = plugin.category ?? '其他';
    const bucket = sections.get(marker);
    if (bucket) bucket.push(plugin);
    else sections.set(marker, [plugin]);
  }
  const ordered = [...sections.entries()].sort(([a], [b]) => {
    if (a === '其他') return 1;
    if (b === '其他') return -1;
    return a.localeCompare(b, 'zh-Hans-CN');
  });

  root.innerHTML = ordered
    .map(([marker, plugins]) => {
      const cards = plugins
        .map((plugin) => {
          const kind = KIND_META[plugin.kind ?? 'plugin'];
          const badges = [
            ...(plugin.permissions ?? []).map(
              (perm) => `<span class="badge text-warning/90">${perm}</span>`,
            ),
          ]
            .filter(Boolean)
            .join('');
          const screenshot = plugin.screenshots?.[0];
          const repo =
            plugin.repository !== undefined
              ? `<a class="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" href="${plugin.repository}" target="_blank" rel="noopener">源码仓库 →</a>`
              : '';
          const download = `<a class="btn btn-ghost px-3 py-1.5 text-xs" href="${FEED_BASE}${plugin.file}" download>下载 zip</a>`;
          return `
          <article class="section-card reveal flex flex-col gap-4 p-6">
            ${screenshot ? `<div class="overflow-hidden rounded-md border border-border"><img src="${screenshot}" alt="${plugin.title ?? plugin.name} 截图" class="aspect-16/9 w-full object-cover object-left-top" loading="lazy" /></div>` : ''}
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <h3 class="truncate text-base font-semibold">${plugin.title ?? plugin.name}</h3>
                <p class="mt-0.5 truncate font-mono text-xs text-muted-foreground">${plugin.name} · v${plugin.version}</p>
              </div>
              <div class="flex shrink-0 flex-wrap justify-end gap-1.5">
                <span class="badge">${kind?.label ?? plugin.kind ?? '插件'}</span>${badges}
              </div>
            </div>
            <p class="text-sm leading-relaxed text-muted-foreground">${plugin.description ?? excerpt(plugin.readme)}</p>
            ${plugin.description !== undefined && excerpt(plugin.readme) !== '' ? `<p class="text-xs leading-relaxed text-muted-foreground/70">${excerpt(plugin.readme)}</p>` : ''}
            <div class="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2">
              ${download}
              ${repo}
              ${plugin.author ? `<span class="text-xs text-muted-foreground/70">by ${plugin.author}</span>` : ''}
              ${plugin.license ? `<span class="text-xs text-muted-foreground/70">${plugin.license}</span>` : ''}
            </div>
          </article>`;
        })
        .join('');
      return `
      <section class="mt-14 first:mt-0">
        <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 class="text-xl font-semibold">${marker}</h2>
          <p class="text-sm text-muted-foreground">${plugins.length} 个插件</p>
        </div>
        <div class="mt-5 grid gap-5 md:grid-cols-2">${cards}</div>
      </section>`;
    })
    .join('');
}

/** The download section: the desktop release the same server hosts, with a
 * graceful fallback before the first packaged build is published. */
function renderDownload(): void {
  const root = document.querySelector<HTMLElement>('#download-body');
  if (!root) return;
  const release = CATALOG.desktop;
  root.innerHTML = release
    ? `
      <div class="flex flex-wrap items-center justify-between gap-6">
        <div>
          <h2 class="text-2xl font-bold">下载终端 <span class="ml-2 font-mono text-base text-muted-foreground">v${release.version}</span></h2>
          <p class="mt-2 text-sm leading-relaxed text-muted-foreground">
            Windows 安装包，与应用自更新通道同源（终端内「软件更新」页走同一目录）。
          </p>
        </div>
        <a class="btn btn-primary" href="${FEED_BASE}${release.setupFile}" download>下载 Windows 安装包</a>
      </div>`
    : `
      <div>
        <h2 class="text-2xl font-bold">下载终端</h2>
        <p class="mt-2 text-sm leading-relaxed text-muted-foreground">
          安装包尚未发布到本源；发布后从滚动 Release 的 <code class="font-mono">feed</code> 标签获取（与插件源同址）。
        </p>
      </div>`;
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
