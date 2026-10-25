/**
 * Scenarios page: feed combos rendered with curated copy, a visible install
 * path, and an honest "your own scene" exit. The feed supplies id/version/
 * file/plugins; this module supplies the story and the download wiring.
 */
import './styles.css'
import { initSite } from './site'
import { CATALOG, FEED_BASE } from './generated/catalog'
import { comboCopyOf } from './catalog-copy'

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return ''
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function mockOf(): string {
  return `
    <div class="mock">
      <div class="mock-screen">
        <div class="bar"><i></i><i></i><i></i></div>
        <div class="screen">
          <div class="mock-kpi"><strong>1843</strong><span>本班实产 / 件</span></div>
          <div class="mock-bars"><i style="height:34%"></i><i style="height:52%"></i><i style="height:41%"></i><i style="height:66%"></i><i style="height:58%"></i><i style="height:79%"></i><i style="height:71%"></i><i style="height:88%"></i><i style="height:62%"></i><i style="height:95%"></i><i style="height:74%"></i><i style="height:84%"></i></div>
          <div class="mock-rows"><span></span><span></span><span></span></div>
        </div>
      </div>
      <span class="mock-label">界面示意</span>
    </div>`
}

function renderCombos(): void {
  const root = document.querySelector<HTMLElement>('#combos')
  if (root === null) return
  if (CATALOG.combos.length === 0) {
    root.innerHTML = '<div class="proof" style="grid-column:1/-1"><h3>一方场景包首发中</h3><p>场景包由插件 SDK 组出来：驱动 + 页面 + 套件打包成一个 zip。先看 <a class="link-arrow" href="./dev.html">插件开发指南</a>，或从社区插件源安装别人做好的场景包。</p></div>'
    return
  }

  const order: string[] = []
  const combos = [...CATALOG.combos].sort((a, b) => {
    const ai = order.indexOf(a.id)
    const bi = order.indexOf(b.id)
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
  })

  root.innerHTML = combos.map(combo => {
    const copy = comboCopyOf(combo.id, combo.title, combo.description ?? '')
    const kind = combo.kind === 'base' ? '第一次必装' : '场景'
    const badgeClass = combo.kind === 'base' ? 'badge badge--amber' : 'badge badge--green'
    const size = formatBytes(combo.size)
    return `
      <article class="scenario reveal">
        <div class="scenario-media media-slot" data-image="scenario-${combo.id}" data-alt="${copy.title} 客户端界面">
          ${mockOf()}
        </div>
        <div class="scenario-body">
          <div class="scenario-top">
            <div>
              <h3>${copy.title}</h3>
              <p class="sub">${copy.eyebrow} · v${combo.version}${size === '' ? '' : ` · ${size}`}</p>
            </div>
            <span class="${badgeClass}">${kind}</span>
          </div>
          <p>${copy.description}</p>
          ${copy.whatYouSee.length > 0 ? `<ul>${copy.whatYouSee.map(item => `<li>${item}</li>`).join('')}</ul>` : ''}
          <div class="scenario-chips">${combo.plugins.map(name => `<span class="badge">${name.replace(/^@[^/]+\//, '')}</span>`).join('')}</div>
          <ol class="install-list">
            ${copy.install.map((step, index) => `<li><b>${String(index + 1).padStart(2, '0')}</b><span>${step}</span></li>`).join('')}
          </ol>
          ${copy.note !== undefined ? `<p class="hint" style="font-family:var(--font-mono);font-size:10px;color:var(--faint)">${copy.note}</p>` : ''}
          <div class="scenario-foot">
            <a class="btn ${combo.kind === 'base' ? 'btn-secondary' : 'btn-primary'} btn-sm" data-download="combo" data-combo="${combo.id}" href="${FEED_BASE}${combo.file}">下载 ${copy.title}（.zip）</a>
            <a class="link-arrow" href="./start.html#scene">怎么安装</a>
          </div>
        </div>
      </article>`
  }).join('')
}

renderCombos()
initSite('scenarios')
