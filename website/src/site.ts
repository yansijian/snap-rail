/**
 * Shared website behavior: nav state, mobile menu, reveal-on-scroll, media
 * slots, the shell chooser, copy buttons, the mobile download bar and the
 * download-link hydration from the generated feed catalog.
 *
 * Marketing copy stays in HTML for SEO; this module only upgrades controls
 * and fills URLs that must match the current feed.
 */

import { SITE } from './content'
import { CATALOG, FEED_BASE } from './generated/catalog'

export type PageId = 'index' | 'scenarios' | 'plugins' | 'dev' | 'start'

/** Human file size for the download labels; feed sizes are bytes. */
function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return ''
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Point every download control at the release the feed currently serves. */
export function hydrateDownloads(): void {
  const desktop = CATALOG.desktop
  if (desktop !== null && desktop.setupFile !== '') {
    const href = `${FEED_BASE}${desktop.setupFile}`
    const size = formatBytes(desktop.size)
    for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-download="installer"]')) {
      link.href = href
      link.setAttribute('download', '')
      const label = link.dataset['downloadLabel']
      if (label !== undefined) {
        link.textContent = label
          .replace('{version}', `v${desktop.version}`)
          .replace('{size}', size)
      }
    }
    for (const node of document.querySelectorAll<HTMLElement>('[data-version-label]')) {
      node.textContent = `v${desktop.version} · ${size} · Windows`
    }
  }

  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-download="combo"]')) {
    const id = link.dataset['combo']
    if (id === undefined) continue
    const combo = CATALOG.combos.find(entry => entry.id === id)
    if (combo === undefined) continue
    link.href = `${FEED_BASE}${combo.file}`
    link.setAttribute('download', '')
  }
}

/** Mark the current page's nav links and set the canonical URL. */
function initNav(page: PageId): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[data-nav]')) {
    if (link.dataset['nav'] === page) {
      link.classList.add('active')
      link.setAttribute('aria-current', 'page')
    }
  }
  if (document.querySelector('link[rel="canonical"]') === null) {
    const path = page === 'index' ? '' : `${page}.html`
    const canonical = document.createElement('link')
    canonical.rel = 'canonical'
    canonical.href = new URL(path, SITE.siteUrl).href
    document.head.append(canonical)
  }
}

/** Mobile menu: one toggle, closes after a link (anchor navigation). */
function initMobileMenu(): void {
  const toggle = document.querySelector<HTMLButtonElement>('[data-menu-toggle]')
  const menu = document.querySelector<HTMLElement>('[data-mobile-menu]')
  if (toggle === null || menu === null) return
  const setOpen = (open: boolean): void => {
    toggle.setAttribute('aria-expanded', String(open))
    menu.classList.toggle('is-open', open)
  }
  toggle.addEventListener('click', () => {
    setOpen(!menu.classList.contains('is-open'))
  })
  menu.addEventListener('click', event => {
    if ((event.target as HTMLElement).closest('a') !== null) setOpen(false)
  })
}

/** Fade sections in as they enter the viewport; static under reduced motion. */
function initReveal(): void {
  const targets = document.querySelectorAll<HTMLElement>('.reveal')
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (const el of targets) el.classList.add('revealed')
    return
  }
  const observer = new IntersectionObserver(
    entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('revealed')
        observer.unobserve(entry.target)
      }
    },
    { rootMargin: '-40px 0px' },
  )
  for (const el of targets) observer.observe(el)
}

/**
 * Mount real screenshots into `[data-image]` slots. While the asset is absent
 * the in-slot composition stays visible; a loaded image flips `.is-ready`.
 * The site never renders a gray "coming soon" box.
 */
function initMediaSlots(): void {
  for (const slot of document.querySelectorAll<HTMLElement>('[data-image]')) {
    const name = slot.dataset['image']
    if (name === undefined || name === '') continue
    const img = document.createElement('img')
    img.alt = slot.dataset['alt'] ?? 'snap-rail 客户端界面'
    img.loading = 'lazy'
    img.decoding = 'async'
    const ext = slot.dataset['ext'] ?? 'webp'
    img.src = `./media/${name}.${ext}`
    img.addEventListener('load', () => slot.classList.add('is-ready'), { once: true })
    img.addEventListener('error', () => slot.classList.add('is-missing'), { once: true })
    slot.append(img)
  }
}

/** The shell chooser: same note slot, no capability matrix. */
function initShells(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('[data-shell]')
  const note = document.querySelector<HTMLElement>('[data-shell-note]')
  if (buttons.length === 0 || note === null) return
  const notes: Record<string, string> = {
    terminal: '当前安装包默认交付：工业终端 / HMI。设备管理、点位、画面、场景包都在里面。',
    hmi: 'HMI 面板：由界面插件 + 布局插件组成，给一台设备或一个工位做专用画面；今天可以从终端骨架裁出。',
    scada: 'SCADA 工作站：由驱动、点表、画面、存储插件组合出监控层；多设备、多画面、历史与报警取决于你装哪些插件。',
    controller: '边缘控制器：把逻辑放到现场边缘；实时性、现场总线和安全等级按运行平台与项目定义，不预设上限。',
  }
  for (const button of buttons) {
    button.addEventListener('click', () => {
      for (const other of buttons) other.setAttribute('aria-pressed', String(other === button))
      note.textContent = notes[button.dataset['shell'] ?? ''] ?? notes['terminal']!
    })
  }
}

/** Copy buttons: `[data-copy="<target-id>"]` copies that node's text. */
function initCopy(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    button.addEventListener('click', () => {
      const target = document.getElementById(button.dataset['copy'] ?? '')
      if (target === null) return
      const text = target.textContent ?? ''
      void navigator.clipboard.writeText(text).then(() => {
        const original = button.textContent
        button.textContent = '已复制'
        window.setTimeout(() => { button.textContent = original }, 1400)
      }).catch(() => {
        button.textContent = '复制失败'
      })
    })
  }
}

/** The mobile sticky download bar appears after the first screen. */
function initDownloadBar(): void {
  const bar = document.querySelector<HTMLElement>('[data-download-bar]')
  if (bar === null) return
  const update = (): void => {
    bar.classList.toggle('is-visible', window.scrollY > 560)
  }
  window.addEventListener('scroll', update, { passive: true })
  update()
}

/** Wire everything a page needs; called from each page entry module. */
export function initSite(page: PageId): void {
  initNav(page)
  initMobileMenu()
  initReveal()
  initMediaSlots()
  initShells()
  initCopy()
  initDownloadBar()
  hydrateDownloads()
}
