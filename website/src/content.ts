/**
 * Website content data. Shared URLs and page vocabulary live here; the
 * plugin catalog and the recipes render from `src/generated/catalog.ts` —
 * regenerated from the feed's catalog.json on every publish, so the site
 * never drifts from what the feed serves. Page-level marketing copy stays
 * in the HTML itself for SEO (static content must not require JS).
 * Future i18n: translate the HTML sections and this file as one unit.
 */

/** Canonical project links (Gitee is the source home; mirrors may exist). */
export const SITE = {
  repo: 'https://gitee.com/yansijian/snap-rail',
  repoPush: 'https://gitee.com/yansijian/snap-rail.git',
  docs: 'https://gitee.com/yansijian/snap-rail/blob/master/docs/architecture.md',
  readme: 'https://gitee.com/yansijian/snap-rail#readme',
  releases: 'https://gitee.com/yansijian/snap-rail/releases',
  license: 'Apache-2.0',
} as const;

/** Kind → display label for catalog cards. */
export const KIND_META: Record<string, { label: string }> = {
  suite: { label: '业务套件' },
  driver: { label: '通讯驱动' },
  tool: { label: '工具插件' },
  plugin: { label: '插件' },
};

/** The three-step hands-on shown on the plugins page (mirrors the real
 * settings page and the recipes page's per-combination guides). */
export const INSTALL_STEPS: { title: string; detail: string }[] = [
  {
    title: '下载安装终端',
    detail: '从下方下载 Windows 安装包并安装；已有终端可跳过这一步。',
  },
  {
    title: '配置插件源',
    detail: '设置 → 插件市场，填入插件源地址（内网如 http://192.168.1.10/snap-rail/plugins/），保存即生效。',
  },
  {
    title: '装组合或挑插件',
    detail: '「组合」区一键安装基座/场景组合；「插件」区按分类浏览，逐个安装。',
  },
];
