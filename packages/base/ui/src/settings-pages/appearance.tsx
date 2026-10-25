/**
 * The built-in 外观与显示 page: colour mode, installed skins, the operator
 * window profile, and the floating-ball profile. Everything writes the same
 * settings.json rows the host applies live, so the page is a control surface,
 * not a second source of truth.
 *
 * @module @snap-rail/ui/settings-pages/appearance
 */

import type { HostLink } from '@snap-rail/connection'
import { rpcErrorText, subscribeFrame } from '@snap-rail/connection'
import { settingsChangedSchema } from '@snap-rail/station-rpc/contract'
import { useEffect, useState, type ReactNode } from 'react'
import { Badge, Button, Page, Row, Section, Stack, Switch, Tabs, TabsList, TabsTrigger } from '../components/index.ts'
import { useClient } from '../runtime.tsx'

type ThemeMode = 'system' | 'light' | 'dark'

const THEME_KEY = 'ui.theme'
const WINDOW_KEY = 'ui.window'
const BALL_KEY = 'ui.ball'

const WINDOW_PRESETS = [
  { label: '1280 × 800', width: 1280, height: 800 },
  { label: '1440 × 900', width: 1440, height: 900 },
  { label: '1600 × 900', width: 1600, height: 900 },
  { label: '1920 × 1080', width: 1920, height: 1080 },
] as const

const BALL_SIZES = [96, 112, 128, 160, 192] as const

/** One installed skin row from `plugins.list`. */
interface SkinRow {
  name: string
  title: string
  enabled: boolean
}

/** Read a settings value through the host link. */
async function readSetting(link: HostLink, key: string): Promise<unknown> {
  const result = await link.call('settings.get', { key })
  return result.ok ? result.value.value : undefined
}

/** Write a settings value; `null` clears the row. */
async function writeSetting(link: HostLink, key: string, value: unknown): Promise<void> {
  await link.call('settings.set', { key, value })
}

/** The appearance/display page. */
export function AppearancePage(): ReactNode {
  const { link } = useClient()
  const [mode, setMode] = useState<ThemeMode>('dark')
  const [windowPreset, setWindowPreset] = useState<string | undefined>(undefined)
  const [ballSize, setBallSize] = useState<number>(128)
  const [ballEnabled, setBallEnabled] = useState(true)
  const [ballDockable, setBallDockable] = useState(true)
  const [ballCollapse, setBallCollapse] = useState(true)
  const [skins, setSkins] = useState<readonly SkinRow[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void Promise.all([
      readSetting(link, THEME_KEY),
      readSetting(link, WINDOW_KEY),
      readSetting(link, BALL_KEY),
      link.call('plugins.list', {}),
    ]).then(([theme, windowRow, ballRow, plugins]) => {
      const themeMode = (theme as { mode?: unknown } | null)?.mode
      if (themeMode === 'system' || themeMode === 'light' || themeMode === 'dark') setMode(themeMode)
      const windowProfile = windowRow as { width?: unknown, height?: unknown } | null | undefined
      if (windowProfile !== null && windowProfile !== undefined && typeof windowProfile.width === 'number' && typeof windowProfile.height === 'number') {
        const preset = WINDOW_PRESETS.find(item => item.width === windowProfile.width && item.height === windowProfile.height)
        setWindowPreset(preset?.label)
      }
      const ballProfile = ballRow as { size?: unknown, enabled?: unknown, dockable?: unknown, collapse?: unknown } | null | undefined
      if (ballProfile !== null && ballProfile !== undefined && typeof ballProfile.size === 'number') setBallSize(ballProfile.size)
      if (ballProfile !== null && ballProfile !== undefined && typeof ballProfile.enabled === 'boolean') setBallEnabled(ballProfile.enabled)
      if (ballProfile !== null && ballProfile !== undefined && typeof ballProfile.dockable === 'boolean') setBallDockable(ballProfile.dockable)
      if (ballProfile !== null && ballProfile !== undefined && typeof ballProfile.collapse === 'boolean') setBallCollapse(ballProfile.collapse)
      if (plugins.ok) {
        setSkins(plugins.value.plugins
          .filter(plugin => plugin.kind === 'skin' && plugin.source !== 'builtin')
          .map(plugin => ({ name: plugin.packageName, title: plugin.title ?? plugin.packageName, enabled: plugin.enabled })))
      }
    }).catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
    return subscribeFrame(link, 'settings/changed', settingsChangedSchema, change => {
      if (change.key === THEME_KEY) {
        const next = (change.value as { mode?: unknown } | null)?.mode
        if (next === 'system' || next === 'light' || next === 'dark') setMode(next)
      }
    })
  }, [link])

  const saveTheme = (next: ThemeMode): void => {
    setMode(next)
    void writeSetting(link, THEME_KEY, { mode: next }).catch(cause => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const saveWindow = (width: number, height: number, label: string): void => {
    setWindowPreset(label)
    void writeSetting(link, WINDOW_KEY, { width, height, minWidth: 960, minHeight: 600 }).catch(cause => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const resetWindow = (): void => {
    setWindowPreset(undefined)
    void writeSetting(link, WINDOW_KEY, null).catch(cause => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const saveBall = (patch: { size?: number, enabled?: boolean, dockable?: boolean, collapse?: boolean }): void => {
    const next = {
      size: patch.size ?? ballSize,
      enabled: patch.enabled ?? ballEnabled,
      dockable: patch.dockable ?? ballDockable,
      collapse: patch.collapse ?? ballCollapse,
    }
    if (patch.size !== undefined) setBallSize(patch.size)
    if (patch.enabled !== undefined) setBallEnabled(patch.enabled)
    if (patch.dockable !== undefined) setBallDockable(patch.dockable)
    if (patch.collapse !== undefined) setBallCollapse(patch.collapse)
    void writeSetting(link, BALL_KEY, next).catch(cause => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const toggleSkin = (skin: SkinRow): void => {
    setBusy(true)
    void link.call('plugins.set-enabled', { name: skin.name, enabled: !skin.enabled })
      .then(result => {
        if (!result.ok) {
          setError(rpcErrorText(result.error))
          return
        }
        setSkins(current => current.map(item => item.name === skin.name ? { ...item, enabled: !item.enabled } : item))
      })
      .catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { setBusy(false) })
  }

  return (
    <Page title="外观与显示" description="主题、皮肤、主窗口尺寸和悬浮球外观；保存后立即生效。">
      <Stack gap="lg">
        {error !== undefined && <div role="alert" style={{ color: 'var(--snap-color-danger)' }}>{error}</div>}

        <Section title="主题模式">
          <Tabs value={mode} onValueChange={value => saveTheme(value as ThemeMode)}>
            <TabsList aria-label="主题模式">
              <TabsTrigger value="system">跟随系统</TabsTrigger>
              <TabsTrigger value="light">白天</TabsTrigger>
              <TabsTrigger value="dark">黑夜</TabsTrigger>
            </TabsList>
          </Tabs>
        </Section>

        <Section title="界面皮肤" description="皮肤由独立插件提供；启用后需要重启终端。">
          <Stack gap="sm">
            <Row gap="sm" align="center">
              <Badge intent="success">默认（内置）</Badge>
              <span style={{ color: 'var(--snap-color-muted)', fontSize: 'var(--snap-text-sm)' }}>工业钴蓝，始终可用</span>
            </Row>
            {skins.length === 0
              ? <span style={{ color: 'var(--snap-color-muted)' }}>尚未安装其他皮肤插件。</span>
              : skins.map(skin => (
                  <Row key={skin.name} gap="sm" align="center">
                    <span>{skin.title}</span>
                    <Badge intent={skin.enabled ? 'success' : 'neutral'}>{skin.enabled ? '已启用' : '未启用'}</Badge>
                    <Button
                      size="sm"
                      emphasis="outline"
                      disabled={busy}
                      onClick={() => toggleSkin(skin)}
                    >
                      {skin.enabled ? '停用' : '启用'}
                    </Button>
                  </Row>
                ))}
          </Stack>
        </Section>

        <Section title="主窗口" description="布局/套件会声明推荐尺寸；这里的选择会覆盖布局推荐。">
          <Stack gap="sm">
            <Row gap="sm" wrap>
              {WINDOW_PRESETS.map(preset => (
                <Button
                  key={preset.label}
                  size="sm"
                  intent={windowPreset === preset.label ? 'primary' : 'neutral'}
                  emphasis={windowPreset === preset.label ? 'solid' : 'outline'}
                  onClick={() => saveWindow(preset.width, preset.height, preset.label)}
                >
                  {preset.label}
                </Button>
              ))}
              <Button size="sm" emphasis="ghost" onClick={resetWindow}>跟随布局</Button>
            </Row>
            <span style={{ color: 'var(--snap-color-muted)', fontSize: 'var(--snap-text-sm)' }}>
              当前：{windowPreset ?? '跟随布局推荐 / 默认 1280 × 800'}
            </span>
          </Stack>
        </Section>

        <Section title="悬浮球" description="球面尺寸与停泊行为；球内显示内容由业务套件决定。">
          <Stack gap="md">
            <Row gap="sm" wrap align="center">
              {BALL_SIZES.map(size => (
                <Button
                  key={size}
                  size="sm"
                  intent={ballSize === size ? 'primary' : 'neutral'}
                  emphasis={ballSize === size ? 'solid' : 'outline'}
                  onClick={() => saveBall({ size })}
                >
                  {size}px
                </Button>
              ))}
            </Row>
            <Row gap="lg" wrap align="center">
              <Switch label="启用悬浮球" checked={ballEnabled} onCheckedChange={enabled => saveBall({ enabled })} />
              <Switch label="允许贴边" checked={ballDockable} onCheckedChange={dockable => saveBall({ dockable })} />
              <Switch label="贴边后收起" checked={ballCollapse} onCheckedChange={collapse => saveBall({ collapse })} />
            </Row>
          </Stack>
        </Section>
      </Stack>
    </Page>
  )
}

export default AppearancePage