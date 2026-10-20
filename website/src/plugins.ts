/**
 * Plugin catalog: the feed's facts rendered with Chinese, audience-facing
 * copy. Search and category filters are client-side over the generated
 * catalog; the first-party copy lives in `catalog-copy.ts`, community
 * plugins fall back to their manifest text.
 */
import './styles.css'
import { initSite } from './site'
import { CATALOG, FEED_BASE } from './generated/catalog'
import { KIND_META } from './content'
import { pluginCopyOf, pluginSlug } from './catalog-copy'

interface State {
  query: string
  category: string
}

const state: State = { query: '', category: '全部' }

function categoriesOf(): string[] {
  const seen = new Set<string>()
  for (const plugin of CATALOG.plugins) seen.add(plugin.category ?? '其他')
  return ['全部', ...[...seen].sort((a, b) => {
    if (a === '其他') return 1
    if (b === '其他') return -1
    return a.localeCompare(b, 'zh-Hans-CN')
  })]
}

function matches(plugin: (typeof CATALOG.plugins)[number]): boolean {
  const copy = pluginCopyOf(plugin.name, plugin.title, plugin.description)
  const category = plugin.category ?? '其他'
  if (state.category !== '全部' && category !== state.category) return false
  const query = state.query.trim().toLowerCase()
  if (query === '') return true
  return [plugin.name, copy.title, copy.description, category, plugin.kind ?? '']
    .join(' ')
    .toLowerCase()
    .includes(query)
}

function cardOf(plugin: (typeof CATALOG.plugins)[number]): string {
  const copy = pluginCopyOf(plugin.name, plugin.title, plugin.description)
  const kind = KIND_META[plugin.kind ?? 'plugin'] ?? KIND_META['plugin']!
  const category = plugin.category ?? '其他'
  const repo = plugin.repository !== undefined
    ? `<a class="link-arrow" href="${plugin.repository}" target="_blank" rel="noopener">源码仓库</a>`
    : ''
  const signed = plugin.signature !== undefined
    ? `<span class="badge">${plugin.signature.algorithm} · ${plugin.signature.keyId}</span>`
    : ''
  const requires = (plugin.requires ?? []).length > 0
    ? `<p class="plugin-requires">需要：${plugin.requires!.map(name => `<code>${name}</code>`).join(' · ')}</p>`
    : ''
  return `
    <article class="plugin-card reveal" id="${pluginSlug(plugin.name)}" data-plugin="${plugin.name}">
      <div class="plugin-card-top">
        <div>
          <h3>${copy.title}</h3>
          <p class="pkg">${plugin.name} · v${plugin.version}</p>
        </div>
        <div class="plugin-badges">
          <span class="badge">${kind.label}</span>
          ${kind.label === category ? '' : `<span class="badge">${category}</span>`}
        </div>
      </div>
      <p class="plugin-desc">${copy.description}</p>
      ${requires}
      <div class="plugin-card-foot">
        <a class="btn btn-secondary btn-sm" href="${FEED_BASE}${plugin.file}" download>下载 zip</a>
        ${repo}
        ${signed}
        ${plugin.license !== undefined ? `<span class="plugin-license">${plugin.license}</span>` : ''}
      </div>
    </article>`
}

function render(): void {
  const root = document.querySelector<HTMLElement>('#plugin-catalog')
  const count = document.querySelector<HTMLElement>('#plugin-count')
  const chips = document.querySelector<HTMLElement>('#plugin-categories')
  if (root === null) return

  if (chips !== null) {
    chips.innerHTML = categoriesOf().map(category => `
      <button type="button" class="filter-chip${category === state.category ? ' is-active' : ''}" data-category="${category}" aria-pressed="${String(category === state.category)}">${category}</button>
    `).join('')
  }

  const visible = CATALOG.plugins.filter(matches)
  if (count !== null) {
    count.textContent = `${visible.length} / ${CATALOG.plugins.length} 个插件`
  }
  if (visible.length === 0) {
    root.innerHTML = '<div class="proof" style="grid-column:1/-1"><h3>没有匹配的插件</h3><p>换个关键词，或切回“全部”。</p></div>'
    return
  }

  const grouped = new Map<string, typeof CATALOG.plugins>()
  for (const plugin of visible) {
    const category = plugin.category ?? '其他'
    grouped.set(category, [...(grouped.get(category) ?? []), plugin])
  }
  const order = [...grouped.entries()].sort(([a], [b]) => {
    if (a === '其他') return 1
    if (b === '其他') return -1
    return a.localeCompare(b, 'zh-Hans-CN')
  })

  root.innerHTML = order.map(([category, plugins]) => `
    <section class="plugin-group">
      <div class="plugin-group-head">
        <h2>${category}</h2>
        <span>${plugins.length}</span>
      </div>
      <div class="plugin-grid">${plugins.map(cardOf).join('')}</div>
    </section>
  `).join('')

  // New cards need the reveal observer after a filter re-render.
  for (const card of root.querySelectorAll<HTMLElement>('.reveal')) {
    card.classList.add('revealed')
  }
}

function wireFilters(): void {
  const input = document.querySelector<HTMLInputElement>('#plugin-search')
  input?.addEventListener('input', () => {
    state.query = input.value
    render()
  })
  document.querySelector<HTMLElement>('#plugin-categories')?.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-category]')
    if (button === null) return
    state.category = button.dataset['category'] ?? '全部'
    render()
  })
}

render()
wireFilters()
initSite('plugins')
