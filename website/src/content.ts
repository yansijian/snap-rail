/**
 * Website content data. Shared URLs and page vocabulary live here; the
 * plugin catalog and the recipes render from `src/generated/catalog.ts` —
 * regenerated from the feed's catalog.json on every publish, so the site
 * never drifts from what the feed serves. Page-level marketing copy stays
 * in the HTML itself for SEO (static content must not require JS).
 * Future i18n: translate the HTML sections and this file as one unit.
 */

/** Canonical project links (GitHub is the public source home; the intranet
 * Gitea continues as a mirror/build host). */
export const SITE = {
  repo: 'https://github.com/yansijian/snap-rail',
  repoPush: 'https://github.com/yansijian/snap-rail.git',
  docs: 'https://github.com/yansijian/snap-rail/blob/master/docs/architecture.md',
  readme: 'https://github.com/yansijian/snap-rail#readme',
  releases: 'https://github.com/yansijian/snap-rail/releases',
  /** The discovery marker every community plugin repo carries. */
  topic: 'https://github.com/topics/snap-rail-plugin',
  license: 'Apache-2.0',
} as const;

/** Kind → display label for catalog cards. */
export const KIND_META: Record<string, { label: string }> = {
  suite: { label: '业务套件' },
  driver: { label: '通讯驱动' },
  framework: { label: '界面框架' },
  tool: { label: '工具插件' },
  plugin: { label: '插件' },
};

/** The offline-first hands-on shown on the plugins page. An industrial
 * intranet PC downloads here; the terminal itself may never see the web. */
export const INSTALL_STEPS: { title: string; detail: string }[] = [
  {
    title: '在联网 PC 下载',
    detail: '下载 Windows 安装包，以及要装的组合包或单插件 zip；组合包已带上全部成员插件。',
  },
  {
    title: '拷进离线现场',
    detail: '用 U 盘/堡垒机把 zip 与安装包带进内网。终端不需要访问任何插件服务器。',
  },
  {
    title: '拖入终端安装',
    detail: '装好终端后把 .zip 拖进「插件」页（或引导页）：单插件走预览确认；组合包自动批量安装成员并写入组合预设。',
  },
];
