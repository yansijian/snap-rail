/**
 * The visualization bridge: semantic frame around any third-party chart
 * library, plus token-derived themes. The skin owns the frame, title,
 * toolbar and palette; the chart library owns its internal DOM.
 *
 * @module @snap-rail/ui/charts
 */

import type { CSSProperties, ReactNode } from 'react'
import { cn, part } from './utils.ts'
import { useSkinTokens, type SkinTokens } from './skins.tsx'

/** The chart lifecycle state the frame renders around the child. */
export type ChartState = 'ready' | 'loading' | 'empty' | 'error'

/** Props of {@link ChartFrame}. */
export interface ChartFrameProps {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  state?: ChartState
  empty?: ReactNode
  error?: ReactNode
  loading?: ReactNode
  children?: ReactNode
  className?: string
  style?: CSSProperties
}

/** A semantic frame for a chart, gauge, map, or custom visualization. */
export function ChartFrame({
  title,
  description,
  actions,
  state = 'ready',
  empty,
  error,
  loading,
  children,
  className,
  style,
}: ChartFrameProps): ReactNode {
  return (
    <section {...part('chart-frame', 'root')} className={cn('snap-chart-frame', className)} data-state={state} style={style}>
      {(title !== undefined || description !== undefined || actions !== undefined) && (
        <header {...part('chart-frame', 'header')} className="snap-chart-frame-header">
          <div>
            {title !== undefined && <div {...part('chart-frame', 'title')}>{title}</div>}
            {description !== undefined && <div className="snap-chart-frame-description">{description}</div>}
          </div>
          {actions !== undefined && <div {...part('chart-frame', 'actions')}>{actions}</div>}
        </header>
      )}
      <div {...part('chart-frame', 'body')} className="snap-chart-frame-body" data-state={state}>
        {state === 'loading'
          ? loading ?? <div {...part('visualization', 'loading')}>加载中…</div>
          : state === 'empty'
            ? empty ?? <div {...part('visualization', 'empty')}>暂无数据</div>
            : state === 'error'
              ? error ?? <div {...part('visualization', 'error')} role="alert">图表加载失败</div>
              : children}
      </div>
    </section>
  )
}

/** A chart frame that exposes the `visualization.*` anatomy as well. */
export function Visualization(props: ChartFrameProps): ReactNode {
  return <ChartFrame {...props} />
}

/** The theme object ECharts/D3 adapters can consume. */
export interface ChartTheme {
  color: readonly string[]
  backgroundColor: string
  textStyle: { color: string, fontFamily: string, fontSize: number }
  axisLine: { lineStyle: { color: string } }
  splitLine: { lineStyle: { color: string, type: 'dashed' } }
  tooltip: {
    backgroundColor: string
    borderColor: string
    textStyle: { color: string, fontFamily: string }
  }
}

/** Turn the active skin tokens into a chart-library theme. */
export function chartThemeOf(tokens: SkinTokens): ChartTheme {
  return {
    color: [tokens.chart1, tokens.chart2, tokens.chart3, tokens.chart4, tokens.chart5, tokens.chart6],
    backgroundColor: tokens.colorSurface,
    textStyle: {
      color: tokens.colorText,
      fontFamily: tokens.fontSans,
      fontSize: Number.parseInt(tokens.textSm, 10) || 14,
    },
    axisLine: { lineStyle: { color: tokens.colorBorder } },
    splitLine: { lineStyle: { color: tokens.colorBorder, type: 'dashed' } },
    tooltip: {
      backgroundColor: tokens.colorSurfaceRaised,
      borderColor: tokens.colorBorder,
      textStyle: { color: tokens.colorText, fontFamily: tokens.fontSans },
    },
  }
}

/** The active chart theme, re-derived whenever the skin/mode changes. */
export function useChartTheme(): ChartTheme {
  return chartThemeOf(useSkinTokens())
}