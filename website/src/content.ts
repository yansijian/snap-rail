/**
 * Website content data. Shared URLs and the plugin ecosystem catalog live
 * here so the two pages hydrate from one source; page-level marketing copy
 * stays in the HTML itself for SEO (static content must not require JS).
 * Future i18n: translate the HTML sections and this file as one unit.
 */

/** Canonical project links (GitHub is the open-source home). */
export const SITE = {
  repo: 'https://github.com/yansijian/snap-rail',
  repoPush: 'https://github.com/yansijian/snap-rail.git',
  docs: 'https://github.com/yansijian/snap-rail/blob/master/docs/architecture.md',
  readme: 'https://github.com/yansijian/snap-rail#readme',
  releases: 'https://github.com/yansijian/snap-rail/releases',
  license: 'Apache-2.0',
} as const;

/** Plugin card vocabulary for the ecosystem catalog. */
export interface PluginEntry {
  /** Package name as shown on the card. */
  name: string;
  /** One-line description. */
  description: string;
  /** Installable kind — mirrors the manifest `snapRail.kind`. */
  kind: 'suite' | 'driver' | 'tool';
  /** Extra chip beyond the kind (e.g. 单活 for suites). */
  badge?: string;
  /** Declared permissions, shown as chips at install time. */
  permissions: string[];
}

/** A catalog group: one row per `snapRail.kind`. */
export interface PluginGroup {
  key: 'suite' | 'driver' | 'tool';
  title: string;
  note: string;
  plugins: PluginEntry[];
}

/** The shipped first-party catalog (`pnpm run pack:plugins` output). */
export const PLUGIN_GROUPS: PluginGroup[] = [
  {
    key: 'suite',
    title: '业务套件',
    note: '一个场景的全部界面合成一枚套件，单活：启用新套件自动停用旧的。',
    plugins: [
      {
        name: '@snap-rail/suite-terminal-ops',
        kind: 'suite',
        badge: '单活',
        description:
          '终端作业场景：工号登录闸门、五流程页（维护/生产/抽检/故障/停机）、产量看板与班次统计。',
        permissions: [],
      },
    ],
  },
  {
    key: 'driver',
    title: '通讯驱动',
    note: '纯协议适配器，可多枚并存；设备/组/点由底座统一管理，驱动零渲染端代码。',
    plugins: [
      {
        name: '@snap-rail/driver-mock',
        kind: 'driver',
        description:
          '参考驱动：模拟 float/BigInt/bool/时间戳点流、离线注入与写入回显，用于无硬件联调。',
        permissions: [],
      },
      {
        name: '@snap-rail/driver-modbus',
        kind: 'driver',
        description: 'ModbusTCP 适配：块轮询、编解码、abcd/cdab 字节序、连接探测。',
        permissions: [],
      },
    ],
  },
  {
    key: 'tool',
    title: '工具插件',
    note: '宿主能力面的扩展工具，与套件、驱动并存。',
    plugins: [
      {
        name: '@snap-rail/forge',
        kind: 'tool',
        badge: 'AI',
        description:
          'AI 创造工作室：对话生成运行时插件，版本化保存、即时挂载、导出可安装 zip。',
        permissions: ['network', 'eval-code', 'store'],
      },
    ],
  },
];

/** Kind metadata used by both the landing kind-cards and the catalog. */
export const KIND_META: Record<PluginGroup['key'], { label: string; blurb: string }> = {
  suite: {
    label: '业务套件',
    blurb: '一个场景的全部界面（布局、流程页、设置页）合成一枚 zip，成套交付、成套丢弃。',
  },
  driver: {
    label: '通讯驱动',
    blurb: '只上交 schema 与连接适配，方言表单由底座渲染——新协议照抄 driver-mock。',
  },
  tool: {
    label: '工具插件',
    blurb: '往宿主塞新能力的工具，AI 创造工作室 forge 就是这么一号住户。',
  },
};

/** Install flow shown on the catalog page (mirrors the real settings page). */
export const INSTALL_STEPS: { title: string; detail: string }[] = [
  { title: '打开设置', detail: '终端设置页 →「插件管理」，三类插件分栏列出。' },
  { title: '安装插件', detail: '点「安装插件」，从本地选择下载好的 zip。' },
  { title: '预检', detail: '宿主 inspect 预检：名称、版本、类型与权限声明。' },
  { title: '确认落地', detail: '确认后解压进 <home>/plugins/，池扫描即时挂载。' },
];
