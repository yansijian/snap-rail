/**
 * Combo page entry: the industrial-scenario showcase — base combos (the
 * standard install unit) and scenario combos (what a team downloads to
 * reproduce a complete effect on an offline terminal). Data comes from
 * src/generated/catalog.ts; each card renders the combo's readme (the effect
 * story and the hands-on guide) with a minimal markdown pass and a download
 * link to the combo zip on the rolling release.
 */
import './styles.css';
import { initSite } from './site';
import { CATALOG, FEED_BASE, type CatalogCombo } from './generated/catalog';

renderCombos();
initSite('recipes');

/** Escape HTML, then apply just enough markdown to read naturally: headers,
 * lists, bold, inline code; table rows render as mono lines. */
function renderMarkdown(md: string): string {
  const esc = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (text: string): string =>
    text
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">$1</code>');
  const out: string[] = [];
  let listOpen = false;
  const closeList = (): void => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };
  for (const raw of esc.split('\n')) {
    const line = raw.trimEnd();
    if (line === '') {
      closeList();
      continue;
    }
    if (line.startsWith('|')) {
      closeList();
      out.push(`<div class="font-mono text-xs text-muted-foreground">${line}</div>`);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1]!.length;
      const cls = ['text-2xl font-bold', 'text-lg font-semibold', 'text-base font-semibold', 'text-sm font-semibold'][
        level - 1
      ];
      out.push(`<p class="mt-5 first:mt-0 ${cls}">${inline(heading[2]!)}</p>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!listOpen) out.push('<ul class="list-disc space-y-1 pl-5">');
      listOpen = true;
      out.push(`<li class="text-sm leading-relaxed text-muted-foreground">${inline(line.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }
    closeList();
    out.push(`<p class="text-sm leading-relaxed text-muted-foreground">${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

function comboCard(combo: CatalogCombo, first: boolean): string {
  const screenshot = combo.screenshots?.[0];
  const kindBadge =
    combo.kind === 'base'
      ? '<span class="badge text-primary">基座组合</span>'
      : '<span class="badge text-success">场景组合</span>';
  return `
    <article class="section-card reveal flex flex-col gap-5 p-7 ${first ? '' : 'mt-8'}" data-combo-card="${combo.id}">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-2xl font-bold">${combo.title}</h2>
            ${kindBadge}
            <span class="font-mono text-xs text-muted-foreground">v${combo.version}</span>
          </div>
          ${combo.description ? `<p class="mt-2 max-w-2xl leading-relaxed text-muted-foreground">${combo.description}</p>` : ''}
        </div>
        <div class="flex shrink-0 flex-col items-end gap-2">
          <a class="btn btn-primary px-4 py-2 text-sm" href="${FEED_BASE}${combo.file}" download>下载组合包（.zip）</a>
          <span class="text-xs text-muted-foreground">下载后拷到终端，拖入「插件」页批量安装</span>
        </div>
      </div>
      <div class="flex flex-wrap gap-1.5">
        ${combo.plugins.map((name) => `<span class="badge font-mono text-[11px]">${name}</span>`).join('')}
      </div>
      ${screenshot ? `<div class="overflow-hidden rounded-md border border-border"><img src="${screenshot}" alt="${combo.title} 效果截图" class="aspect-16/9 w-full object-cover object-left-top" loading="lazy" /></div>` : ''}
      ${combo.readme ? `<div class="flex flex-col gap-1 border-t border-border/60 pt-4">${renderMarkdown(combo.readme)}</div>` : ''}
    </article>`;
}

function renderCombos(): void {
  const root = document.querySelector<HTMLElement>('#combos');
  if (!root) return;
  if (CATALOG.combos.length === 0) {
    root.innerHTML = `
      <div class="section-card p-8 text-center text-sm text-muted-foreground">
        组合包尚未发布——先在仓库运行 <code class="font-mono">pnpm run publish -- --skip-sync</code> 装配 feed，再重新构建本站。
      </div>`;
    return;
  }
  // Scenario combinations are the showpiece; base combinations follow as
  // the standard install unit they stack on.
  const scenario = CATALOG.combos.filter((combo) => combo.kind === 'scenario');
  const base = CATALOG.combos.filter((combo) => combo.kind === 'base');
  const cards = [...scenario, ...base];
  root.innerHTML = cards.map((combo, i) => comboCard(combo, i === 0)).join('');
}
