/**
 * Website release gate: the things a visual redesign must not silently lose.
 * Run after `pnpm --filter @snap-rail/website run build` (the HTML is checked
 * before Vite hashes assets, so paths are source-level).
 *
 * @module snap-rail/scripts/verify-website
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const site = join(root, 'website')
const errors: string[] = []

function read(path: string): string {
  const full = join(site, path)
  if (!existsSync(full)) {
    errors.push(`missing ${path}`)
    return ''
  }
  return readFileSync(full, 'utf8')
}

function requireText(path: string, needle: string, label: string): void {
  if (!read(path).includes(needle)) errors.push(`${path}: missing ${label} (${needle})`)
}

const pages = ['index.html', 'scenarios.html', 'plugins.html', 'dev.html', 'start.html']
for (const page of pages) {
  const html = read(page)
  if (html === '') continue
  for (const needle of ['<title>', 'name="description"', 'property="og:image"']) {
    if (!html.includes(needle)) errors.push(`${page}: missing ${needle}`)
  }
  if (/截图待放置|TODO|FIXME|lorem ipsum/i.test(html)) errors.push(`${page}: placeholder text found`)
}

requireText('index.html', '接上设备', 'H1 outcome')
requireText('index.html', 'data-download="installer"', 'installer CTA')
requireText('index.html', 'media/hero-test-top.webp', 'real hero screenshot')
requireText('index.html', 'data-image="scenario-standard-base"', 'built-in base screenshot slot')
requireText('index.html', 'https://www.snap-rail.top/og.png', 'production og:image origin')
requireText('scenarios.html', 'id="combos"', 'combo mount')
requireText('plugins.html', 'id="plugin-catalog"', 'catalog mount')
requireText('plugins.html', 'id="plugin-search"', 'catalog search')
requireText('plugins.html', 'href="./dev.html"', 'local plugin-dev link')
requireText('dev.html', 'id="dev-doc"', 'doc mount')
requireText('dev.html', 'id="doc-toc"', 'doc TOC mount')
requireText('start.html', 'id="download"', 'download section')
requireText('start.html', 'data-download="installer"', 'installer download')
requireText('vite.config.ts', "scenarios: 'scenarios.html'", 'scenarios entry')
requireText('vite.config.ts', "dev: 'dev.html'", 'dev entry')
requireText('vite.config.ts', "start: 'start.html'", 'start entry')
// The nav on every page carries the dev page (desktop nav + mobile menu +
// footer are three separate hardcodes).
for (const page of ['index.html', 'scenarios.html', 'plugins.html', 'start.html']) {
  const count = [...read(page).matchAll(/data-nav="dev"/g)].length
  if (count < 2) errors.push(`${page}: dev nav missing (${count}/2 nav instances)`)
  if (!read(page).includes('href="./dev.html"')) errors.push(`${page}: dev link missing`)
}

// SEO metadata follows the production domain (the OSS custom domain); the
// GitHub Pages mirror keeps it as canonical on purpose.
requireText('public/sitemap.xml', 'https://www.snap-rail.top/dev.html', 'dev page in sitemap')
requireText('public/robots.txt', 'https://www.snap-rail.top/sitemap.xml', 'robots sitemap origin')

// ICP 备案号展示是境内上线合规项（非可选）：每一页的 footer-bottom 都必须
// 带指向工信部备案系统的链接，页面重设计不得悄悄丢掉它。
for (const page of pages) {
  requireText(page, 'beian.miit.gov.cn', 'ICP 备案链接')
  requireText(page, '粤ICP备2026167367号-1', 'ICP 备案号')
}

// 站点以「个人开发的开源项目」署名（与当前备案性质一致）；同时按现阶段
// 「不出现经营性表述」的要求反向把关——未来变更备案性质补充商业信息时，
// 随新文案一并调整这份清单。
for (const page of pages) {
  requireText(page, '个人开发的开源项目', '开源项目署名')
  for (const needle of ['商业服务', '服务与合作入口', '花小钱', '不被一家', '合同里']) {
    if (read(page).includes(needle)) errors.push(`${page}: 出现阶段不应出现的经营性表述 (${needle})`)
  }
}

// The generated doc body must carry the contract every reader needs: the
// one-command start, all nine templates, and the publish flow.
const devPage = read('src/generated/dev-page.ts')
for (const needle of [
  'pnpm dlx @snap-rail/plugin-sdk',
  // The nine templates each appear code-wrapped in the doc's template table.
  '<code>driver</code>',
  '<code>store-provider</code>',
  '<code>ui-view</code>',
  '<code>ui-layout</code>',
  '<code>ui-extension</code>',
  '<code>ui-skin</code>',
  '<code>host-service</code>',
  '<code>tool</code>',
  '<code>suite</code>',
  'snap-rail-plugin pack',
  'snap-rail-plugin feed',
  'Ed25519',
]) {
  if (!devPage.includes(needle)) errors.push(`generated/dev-page.ts: missing ${needle}`)
}

for (const asset of [
  'public/media/hero-test-top.webp',
  'public/media/scenario-standard-base.webp',
  'public/og.png',
  'public/robots.txt',
  'public/sitemap.xml',
]) {
  if (!existsSync(join(site, asset))) errors.push(`missing asset ${asset}`)
}

// The hero shows the real connection-test wizard. That wizard ships with
// the desktop build; until the feed serves a release that contains it, the
// site is a local preview only. Keep this visible in CI rather than silently
// deploying a promise the download cannot keep.
const catalogSource = read('src/generated/catalog.ts')
const version = /"desktop":\s*\{[\s\S]*?"version":\s*"([^"]+)"/.exec(catalogSource)?.[1]
// Structured data is static HTML; it must not advertise a version the feed
// no longer serves (the download buttons follow the catalog automatically).
const ldVersion = /"softwareVersion":\s*"([^"]+)"/.exec(read('index.html'))?.[1]
if (version !== undefined && ldVersion !== undefined && ldVersion !== version) {
  errors.push(`index.html: ld+json softwareVersion ${ldVersion} ≠ feed ${version}（下载按钮跟 feed，结构化数据会漂）`)
}
// The ld+json downloadUrl is a full installer filename; its version drifts the
// same way softwareVersion does (the live site once shipped a 0.2.0 link while
// the feed served 0.3.0).
const ldDownload = /"downloadUrl":\s*"[^"]*snap-rail-([^"]+)-x64-setup\.exe"/.exec(read('index.html'))?.[1]
if (version !== undefined && ldDownload !== undefined && ldDownload !== version) {
  errors.push(`index.html: ld+json downloadUrl ${ldDownload} ≠ feed ${version}（下载直链会漂）`)
}
if (version !== undefined && version.localeCompare('0.3.0', undefined, { numeric: true }) < 0) {
  console.warn(`verify-website — RELEASE GATE: feed is ${version}, hero shows the 0.3.0 connection-test wizard; do not deploy until the installer is published`)
}

if (errors.length > 0) {
  console.error('verify-website — FAIL')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`verify-website — clean (${pages.length} pages, assets present)`)
}
