/**
 * Website copy and canonical links. Feed facts (versions, sizes, plugin
 * names) stay in `generated/catalog.ts`; this module owns the sentences and
 * the stable URLs around them.
 *
 * The service/contact block is deliberately absent for now. `SERVICE` is the
 * reserved slot: when the product and support model are ready, fill it and
 * render a contact section — never a dead "coming soon" link.
 */

/** Canonical project links (GitHub is the public source home; Gitee/Gitea stay mirrors). */
export const SITE = {
  repo: 'https://github.com/yansijian/snap-rail',
  repoPush: 'https://github.com/yansijian/snap-rail.git',
  docs: 'https://github.com/yansijian/snap-rail/blob/master/docs/architecture.md',
  /** The local《插件开发》page (generated from docs/plugin-development.md). */
  pluginDocs: './dev.html',
  readme: 'https://github.com/yansijian/snap-rail#readme',
  releases: 'https://github.com/yansijian/snap-rail/releases',
  issues: 'https://github.com/yansijian/snap-rail/issues',
  topic: 'https://github.com/topics/snap-rail-plugin',
  license: 'Apache-2.0',
  /** Absolute canonical origin; overridable for an intranet build. The
   * default is the production domain (custom domain on the OSS bucket). */
  siteUrl: (import.meta.env['VITE_SITE_URL'] as string | undefined) ?? 'https://www.snap-rail.top/',
} as const

/** Reserved for the future service/cooperation block (person, email, WeChat,
 * phone). Keep `null` until the product is ready; the templates simply do not
 * render a contact section while this is unset. */
export const SERVICE: null | {
  title: string
  body: string
  email?: string
  phone?: string
  wechat?: string
} = null

/** Kind → display label for catalog cards and chips. */
export const KIND_META: Record<string, { label: string; tone?: 'amber' | 'green' }> = {
  suite: { label: '业务套件', tone: 'green' },
  driver: { label: '通讯驱动' },
  framework: { label: '界面框架' },
  tool: { label: '工具插件' },
  store: { label: '存储' },
  equipment: { label: '设备底座' },
  ui: { label: '界面' },
  plugin: { label: '插件' },
}

/** Page labels for the shared nav. */
export const NAV = [
  { id: 'scenarios', label: '场景', href: './scenarios.html' },
  { id: 'plugins', label: '插件生态', href: './plugins.html' },
  { id: 'dev', label: '插件开发', href: './dev.html' },
  { id: 'start', label: '快速上手', href: './start.html' },
] as const

/** The honest first-run path: two downloads, then the connection test. */
export const FIRST_RUN = [
  {
    title: '装客户端',
    detail: '下载 Windows 安装包，装好打开。未做商业代码签名，SmartScreen 可能提示“未知发布者”。',
  },
  {
    title: '装标准基座',
    detail: '把 standard-base.zip 拖进引导页或「插件」页；重启一次，设备管理页就出现了。',
  },
  {
    title: '测第一台设备',
    detail: '新建设备，填 IP/端口/单元号，点“测试连接”；通了就套模板建点，回设备页看实时值。',
  },
] as const
