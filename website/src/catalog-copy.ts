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
}

export const COMBO_COPY: Record<string, ComboCopy> = {}

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
