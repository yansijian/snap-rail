/**
 * Chinese, audience-facing copy for the first-party catalog. The feed stays
 * the source of facts (name, version, size, signature); this module only
 * supplies the words a factory reader needs. Community plugins fall back to
 * their manifest title/description.
 */

export interface PluginCopy {
  /** Human title shown before the package name. */
  title: string
  /** One plain sentence: what it does for the reader. */
  description: string
  /** Anchor id on the plugins page. */
  slug: string
}

export interface ComboCopy {
  title: string
  /** Small label above the title. */
  eyebrow: string
  description: string
  /** What the reader will actually see after installing. */
  whatYouSee: string[]
  /** Three-step install, kept short. */
  install: string[]
  /** Honest boundary note. */
  note?: string
}

/** The slug every page uses for a package anchor. */
export function pluginSlug(name: string): string {
  return name.replace(/^@[^/]+\//, '').replaceAll('/', '-')
}

export const PLUGIN_COPY: Record<string, PluginCopy> = {
  '@snap-rail/store-sqlite': {
    title: '本地存储（SQLite）',
    description: '数据留在本机：每个命名空间一个 SQLite 库文件，单活存储后端。',
    slug: 'store-sqlite',
  },
  '@snap-rail/equipment': {
    title: '设备底座',
    description: '设备、组、点统一管理；驱动只负责协议，配置表与实时点表都住在底座。',
    slug: 'equipment',
  },
  '@snap-rail/equipment-station': {
    title: '设备管理',
    description: '建设备、测连接、看点位实时值与组健康灯的统一设置页。',
    slug: 'equipment-station',
  },
  '@snap-rail/framework-shadcn': {
    title: '界面框架',
    description: '设置中心、主题、页面容器与共享 UI 原语；没有它，终端只有内核引导页。',
    slug: 'framework-shadcn',
  },
  '@snap-rail/driver-modbus': {
    title: 'ModbusTCP 驱动',
    description: '接 PLC、仪表、变频器：块采集、编码解码、写回与连接诊断。',
    slug: 'driver-modbus',
  },
  '@snap-rail/driver-enip': {
    title: 'EtherNet/IP 驱动',
    description: '接 EtherNet/IP 设备：CIP 会话、标签读写与逐点异常处理。',
    slug: 'driver-enip',
  },
  '@snap-rail/suite-terminal-ops': {
    title: '生产作业套件',
    description: '五流程 + 班产看板：维护、生产、抽检、故障、停机，一块屏跑完一个班。',
    slug: 'suite-terminal-ops',
  },
}

export const COMBO_COPY: Record<string, ComboCopy> = {
  'production-board': {
    title: '产线看板',
    eyebrow: '场景包 · SCENARIO',
    description: '标准基座之上加装 ModbusTCP 采集与生产作业套件——设备管理、点位采集、班产统计、作业流程一条链。',
    whatYouSee: [
      '设备在线灯、组健康灯、点位实时值',
      '本班实际 / 理论产量，24 小时柱状图',
      '维护、生产、抽检、故障、停机五流程',
    ],
    install: [
      '联网 PC 下载 production-board.zip',
      '拷进内网，拖进客户端「插件」页',
      '重启一次，按快速上手建一组演示设备',
    ],
    note: '组合包本身不签名；成员 zip 各自保留发布签名，预览逐成员校验。',
  },
  'standard-base': {
    title: '标准基座',
    eyebrow: '基座 · BASE',
    description: '存储、设备底座、界面框架、设备管理页一次就位。第一次装终端，先装它。',
    whatYouSee: [
      '本机 SQLite 存储与本地设置',
      '设备 / 组 / 点统一管理',
      '设置中心、插件管理与主题',
    ],
    install: [
      '联网 PC 下载 standard-base.zip',
      '拖进客户端引导页或「插件」页',
      '重启一次，开始建设备、测连接',
    ],
    note: '标准基座是第一次必装；产线看板等场景包在它之上叠加。',
  },
}

/** Resolve a plugin's Chinese title/description with a manifest fallback. */
export function pluginCopyOf(name: string, fallbackTitle?: string, fallbackDescription?: string): PluginCopy {
  const known = PLUGIN_COPY[name]
  if (known !== undefined) return known
  return {
    title: fallbackTitle ?? name,
    description: fallbackDescription ?? '社区插件；安装前请查看来源、版本与验证状态。',
    slug: pluginSlug(name),
  }
}

/** Resolve a combo's curated copy with a feed-description fallback. */
export function comboCopyOf(id: string, fallbackTitle: string, fallbackDescription: string): ComboCopy {
  const known = COMBO_COPY[id]
  if (known !== undefined) return known
  return {
    title: fallbackTitle,
    eyebrow: '场景包',
    description: fallbackDescription,
    whatYouSee: [],
    install: ['下载 zip', '拖进客户端「插件」页', '重启一次'],
  }
}
