/**
 * The built-in 外观与显示 page: the theme (one flat list — the factory
 * day/night pair plus every installed skin package), the operator window
 * profile, and the floating-ball profile. Picking a loaded theme writes one
 * settings row (`ui.theme {id}`) the runtime applies live; picking an
 * unloaded skin package enables it first and the window reloads once, so the
 * selection lands on boot.
 *
 * @module @snap-rail/ui/settings-pages/appearance
 */

import type { HostLink } from '@snap-rail/connection'
import { rpcErrorText } from '@snap-rail/connection'
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Page, Row, Section, Stack, Switch, Tabs, TabsList, TabsTrigger } from '../components/index.ts'
import { useSkinId, useSkins } from '../skins.tsx'
import { useClient } from '../runtime.tsx'

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

/** One selectable entry in the theme tab strip. */
interface ThemeTab {
  id: string
  title: string
  /** The skin package to enable first; the selection lands after the reload. */
  enable?: string
}

/** One installed skin package row from `plugins.list`. */
interface SkinPackage {
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
  const skins = useSkins()
  const activeId = useSkinId()
  const [packages, setPackages] = useState<readonly SkinPackage[]>([])
  const [windowPreset, setWindowPreset] = useState<string | undefined>(undefined)
  const [ballSize, setBallSize] = useState<number>(128)
  const [ballEnabled, setBallEnabled] = useState(true)
  const [ballCollapse, setBallCollapse] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void Promise.all([
      readSetting(link, WINDOW_KEY),
      readSetting(link, BALL_KEY),
      link.call('plugins.list', {}),
    ]).then(([windowRow, ballRow, plugins]) => {
      const windowProfile = windowRow as { width?: unknown, height?: unknown } | null | undefined
      if (windowProfile !== null && windowProfile !== undefined && typeof windowProfile.width === 'number' && typeof windowProfile.height === 'number') {
        const preset = WINDOW_PRESETS.find(item => item.width === windowProfile.width && item.height === windowProfile.height)
        setWindowPreset(preset?.label)
      }
      const ballProfile = ballRow as { size?: unknown, enabled?: unknown, collapse?: unknown } | null | undefined
      if (ballProfile !== null && ballProfile !== undefined && typeof ballProfile.size === 'number') setBallSize(ballProfile.size)
      if (ballProfile !== null && ballProfile !== undefined && typeof ballProfile.enabled === 'boolean') setBallEnabled(ballProfile.enabled)
      if (ballProfile !== null && ballProfile !== undefined && typeof ballProfile.collapse === 'boolean') setBallCollapse(ballProfile.collapse)
      if (plugins.ok) {
        setPackages(plugins.value.plugins
          .filter(plugin => plugin.kind === 'skin' && plugin.source !== 'builtin')
          .map(plugin => ({ name: plugin.packageName, title: plugin.title ?? plugin.packageName, enabled: plugin.enabled })))
      }
    }).catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
  }, [link])

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

  const saveBall = (patch: { size?: number, enabled?: boolean, collapse?: boolean }): void => {
    const next = {
      size: patch.size ?? ballSize,
      enabled: patch.enabled ?? ballEnabled,
      collapse: patch.collapse ?? ballCollapse,
    }
    if (patch.size !== undefined) setBallSize(patch.size)
    if (patch.enabled !== undefined) setBallEnabled(patch.enabled)
    if (patch.collapse !== undefined) setBallCollapse(patch.collapse)
    void writeSetting(link, BALL_KEY, next).catch(cause => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  // Loaded themes select through the settings row alone and the runtime
  // re-tokens every surface in place. An unloaded package needs its row
  // enabled first; the row change reloads the window and the stored
  // selection activates on boot.
  const tabs: readonly ThemeTab[] = [
    ...skins.list().map(row => ({ id: row.id, title: row.title })),
    ...packages.filter(pkg => !pkg.enabled).map(pkg => ({ id: pkg.name, title: pkg.title, enable: pkg.name })),
  ]

  const selectTheme = (tab: ThemeTab): void => {
    if (busy) return
    if (tab.enable === undefined) {
      void writeSetting(link, THEME_KEY, { id: tab.id }).catch(cause => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      return
    }
    setBusy(true)
    void link.call('plugins.set-enabled', { name: tab.enable, enabled: true })
      .then(result => {
        if (!result.ok) {
          setError(rpcErrorText(result.error))
          return
        }
        setPackages(current => current.map(pkg => pkg.name === tab.enable ? { ...pkg, enabled: true } : pkg))
        return writeSetting(link, THEME_KEY, { id: tab.id })
      })
      .catch(cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { setBusy(false) })
  }

  return (
    <Page title="外观与显示" description="主题、主窗口尺寸和悬浮球外观。">
      <Stack gap="lg">
        {error !== undefined && <div role="alert" style={{ color: 'var(--snap-color-danger)' }}>{error}</div>}

        <Section title="主题">
          <Tabs value={activeId} onValueChange={value => {
            const tab = tabs.find(item => item.id === value)
            if (tab !== undefined) selectTheme(tab)
          }}>
            <TabsList aria-label="主题">
              {tabs.map(tab => (
                <TabsTrigger key={tab.id} value={tab.id} disabled={busy}>{tab.title}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </Section>

        <Section title="主窗口">
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

        <Section title="悬浮球" description="球面尺寸与停泊行为。">
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
              <Switch label="允许贴边收起" checked={ballCollapse} onCheckedChange={collapse => saveBall({ collapse })} />
            </Row>
          </Stack>
        </Section>
      </Stack>
    </Page>
  )
}

export default AppearancePage
