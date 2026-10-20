/**
 * The《插件开发》page: mounts the doc body generated from
 * `docs/plugin-development.md` (`generated/dev-page.ts` — the repo doc is the
 * single source; `pnpm run gen:dev-page -- --check` gates drift), builds the
 * sticky TOC from the heading tree, and wires copy buttons onto code blocks.
 */
import './styles.css'
import { initSite } from './site'
import { DEV_DOC_HTML, DEV_DOC_TOC } from './generated/dev-page'

function mountDoc(): void {
  const doc = document.querySelector<HTMLElement>('#dev-doc')
  const tocRoot = document.querySelector<HTMLElement>('#doc-toc')
  if (doc === null) return

  doc.innerHTML = DEV_DOC_HTML

  // The TOC links h2 sections (h3 nests beneath, indented).
  if (tocRoot !== null) {
    tocRoot.innerHTML = DEV_DOC_TOC.map(entry =>
      `<a class="doc-toc-link doc-toc-l${entry.level}" href="#${entry.id}">${entry.text}</a>`,
    ).join('')
  }

  // Copy buttons: each code block gets a wrapper with an absolute button.
  for (const pre of doc.querySelectorAll('pre')) {
    const wrapper = document.createElement('div')
    wrapper.className = 'doc-code'
    pre.replaceWith(wrapper)
    wrapper.append(pre)
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'copy-btn doc-copy'
    button.textContent = '复制'
    button.addEventListener('click', () => {
      void navigator.clipboard.writeText(pre.textContent ?? '').then(() => {
        button.textContent = '已复制'
        window.setTimeout(() => { button.textContent = '复制' }, 1400)
      }).catch(() => {
        button.textContent = '复制失败'
      })
    })
    wrapper.append(button)
  }
}

mountDoc()
initSite('dev')
