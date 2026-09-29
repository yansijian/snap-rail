/**
 * Recipes page entry: the combination showcase — base combinations (the
 * standard install unit) and scenario combinations (what developers look at
 * to see an effect and reproduce it with one click). Data comes from
 * src/generated/catalog.ts; each card renders the combination's readme
 * (the effect story and the hands-on guide) with a minimal markdown pass.
 */
import './styles.css';
import { initSite } from './site';
import { CATALOG, type CatalogRecipe } from './generated/catalog';

renderRecipes();
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

function recipeCard(recipe: CatalogRecipe, first: boolean): string {
  const screenshot = recipe.screenshots?.[0];
  const kindBadge =
    recipe.kind === 'base'
      ? '<span class="badge text-primary">基座组合</span>'
      : '<span class="badge text-success">场景组合</span>';
  return `
    <article class="section-card reveal flex flex-col gap-5 p-7 ${first ? '' : 'mt-8'}" data-recipe-card="${recipe.id}">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-2xl font-bold">${recipe.title}</h2>
            ${kindBadge}
            <span class="font-mono text-xs text-muted-foreground">v${recipe.version}</span>
          </div>
          ${recipe.description ? `<p class="mt-2 max-w-2xl leading-relaxed text-muted-foreground">${recipe.description}</p>` : ''}
        </div>
        <div class="flex shrink-0 flex-wrap gap-1.5">
          ${recipe.plugins.map((name) => `<span class="badge font-mono text-[11px]">${name}</span>`).join('')}
        </div>
      </div>
      ${screenshot ? `<div class="overflow-hidden rounded-md border border-border"><img src="${screenshot}" alt="${recipe.title} 效果截图" class="aspect-16/9 w-full object-cover object-left-top" loading="lazy" /></div>` : ''}
      ${recipe.readme ? `<div class="flex flex-col gap-1 border-t border-border/60 pt-4">${renderMarkdown(recipe.readme)}</div>` : ''}
    </article>`;
}

function renderRecipes(): void {
  const root = document.querySelector<HTMLElement>('#recipes');
  if (!root) return;
  if (CATALOG.recipes.length === 0) {
    root.innerHTML = `
      <div class="section-card p-8 text-center text-sm text-muted-foreground">
        组合目录尚未发布——先在仓库运行 <code class="font-mono">pnpm run publish</code> 装配 feed，再重新构建本站。
      </div>`;
    return;
  }
  // Scenario combinations are the showpiece; base combinations follow as
  // the standard install unit they stack on.
  const scenario = CATALOG.recipes.filter((recipe) => recipe.kind === 'scenario');
  const base = CATALOG.recipes.filter((recipe) => recipe.kind === 'base');
  const cards = [...scenario, ...base];
  root.innerHTML = cards.map((recipe, i) => recipeCard(recipe, i === 0)).join('');
}
