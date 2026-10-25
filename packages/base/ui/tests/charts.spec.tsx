import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChartFrame, chartThemeOf } from '../src/charts.tsx'
import { DEFAULT_SKIN } from '../src/skins.tsx'

describe('visualization bridge', () => {
  it('renders the semantic chart frame and its empty state', () => {
    const html = renderToStaticMarkup(
      <ChartFrame title="每小时产量" description="实际 / 目标" state="empty">
        <div>chart</div>
      </ChartFrame>,
    )
    expect(html).toContain('data-snap-part="chart-frame.root"')
    expect(html).toContain('data-snap-part="chart-frame.title"')
    expect(html).toContain('暂无数据')
  })

  it('derives a chart palette and typography from skin tokens', () => {
    const theme = chartThemeOf(DEFAULT_SKIN.tokens.dark)
    expect(theme.color).toHaveLength(6)
    expect(theme.color[0]).toBe(DEFAULT_SKIN.tokens.dark.chart1)
    expect(theme.textStyle.color).toBe(DEFAULT_SKIN.tokens.dark.colorText)
    expect(theme.tooltip.backgroundColor).toBe(DEFAULT_SKIN.tokens.dark.colorSurfaceRaised)
  })
})