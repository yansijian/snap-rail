/**
 * Semantic layout primitives. Pages compose these instead of raw flex/grid
 * utility classes; the structural rules are inline (so layout survives
 * without a skin) while spacing/density values ride skin tokens.
 *
 * @module @snap-rail/ui/components/layout
 */

import type { CSSProperties, ReactNode } from 'react'
import { cn, part, space } from '../utils.ts'

/** A spacing token. */
export type SpaceToken = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

/** Shared layout props. */
export interface LayoutProps {
  children?: ReactNode
  className?: string
  style?: CSSProperties
}

/** Props of {@link Stack}. */
export interface StackProps extends LayoutProps {
  gap?: SpaceToken
  padding?: SpaceToken
  align?: CSSProperties['alignItems']
}

/** A vertical flow. */
export function Stack({ gap = 'md', padding, align, className, style, children }: StackProps): ReactNode {
  return (
    <div
      {...part('stack', 'root')}
      className={cn('snap-stack', className)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: space(gap),
        ...padding !== undefined ? { padding: space(padding) } : {},
        ...align !== undefined ? { alignItems: align } : {},
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/** Props of {@link Row}. */
export interface RowProps extends LayoutProps {
  gap?: SpaceToken
  padding?: SpaceToken
  align?: CSSProperties['alignItems']
  justify?: CSSProperties['justifyContent']
  wrap?: boolean
}

/** A horizontal flow. */
export function Row({ gap = 'sm', padding, align, justify, wrap = false, className, style, children }: RowProps): ReactNode {
  return (
    <div
      {...part('row', 'root')}
      className={cn('snap-row', className)}
      style={{
        display: 'flex',
        flexDirection: 'row',
        gap: space(gap),
        ...padding !== undefined ? { padding: space(padding) } : {},
        ...align !== undefined ? { alignItems: align } : {},
        ...justify !== undefined ? { justifyContent: justify } : {},
        ...wrap ? { flexWrap: 'wrap' } : {},
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/** Props of {@link Grid}. */
export interface GridProps extends LayoutProps {
  gap?: SpaceToken
  padding?: SpaceToken
  /** A fixed column count or any CSS grid-template-columns value. */
  columns?: number | string
  minColumnWidth?: string
}

/** A responsive grid. */
export function Grid({ gap = 'md', padding, columns = 2, minColumnWidth, className, style, children }: GridProps): ReactNode {
  const template = typeof columns === 'number'
    ? `repeat(${columns}, minmax(0, 1fr))`
    : columns
  return (
    <div
      {...part('grid', 'root')}
      className={cn('snap-grid', className)}
      style={{
        display: 'grid',
        gap: space(gap),
        gridTemplateColumns: minColumnWidth !== undefined
          ? `repeat(auto-fit, minmax(${minColumnWidth}, 1fr))`
          : template,
        ...padding !== undefined ? { padding: space(padding) } : {},
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/** Props of {@link Split}. */
export interface SplitProps extends LayoutProps {
  start: ReactNode
  end: ReactNode
  gap?: SpaceToken
  /** The start column's share; defaults to a stable 2:3 split. */
  ratio?: string
}

/** A two-pane split (sidebar + content, list + detail). */
export function Split({ start, end, gap = 'md', ratio = 'minmax(0, 2fr) minmax(0, 3fr)', className, style }: SplitProps): ReactNode {
  return (
    <div
      {...part('split', 'root')}
      className={cn('snap-split', className)}
      style={{ display: 'grid', gridTemplateColumns: ratio, gap: space(gap), minHeight: 0, ...style }}
    >
      <div {...part('split', 'start')} style={{ minWidth: 0, minHeight: 0 }}>{start}</div>
      <div {...part('split', 'end')} style={{ minWidth: 0, minHeight: 0 }}>{end}</div>
    </div>
  )
}

/** Props of {@link AppShell}. */
export interface AppShellProps extends LayoutProps {
  header?: ReactNode
  sidebar?: ReactNode
  footer?: ReactNode
}

/** The operator-window shell frame. */
export function AppShell({ header, sidebar, footer, className, style, children }: AppShellProps): ReactNode {
  return (
    <div
      {...part('app-shell', 'root')}
      className={cn('snap-app-shell', className)}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, ...style }}
    >
      {header !== undefined && <div {...part('app-shell', 'header')} style={{ flexShrink: 0 }}>{header}</div>}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {sidebar !== undefined && (
          <div {...part('app-shell', 'sidebar')} style={{ flexShrink: 0, minHeight: 0 }}>{sidebar}</div>
        )}
        <div {...part('app-shell', 'main')} style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
          {children}
        </div>
      </div>
      {footer !== undefined && <div {...part('app-shell', 'footer')} style={{ flexShrink: 0 }}>{footer}</div>}
    </div>
  )
}

/** Props of {@link Page}. */
export interface PageProps extends LayoutProps {
  header?: ReactNode
  actions?: ReactNode
  title?: ReactNode
  /** Controls that belong to the title itself; rendered right beside it,
   * before the far-aligned `actions`. */
  titleExtra?: ReactNode
  description?: ReactNode
}

/** A page body with its own header/actions anatomy. */
export function Page({ header, actions, title, titleExtra, description, className, style, children }: PageProps): ReactNode {
  return (
    <div
      {...part('page', 'root')}
      className={cn('snap-page', className)}
      style={{ display: 'flex', flexDirection: 'column', minHeight: 0, ...style }}
    >
      {(header !== undefined || title !== undefined || description !== undefined || actions !== undefined) && (
        <div {...part('page', 'header')} style={{ display: 'flex', flexDirection: 'column', gap: space('sm'), flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: space('md') }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: space('sm') }}>
              {title !== undefined && <div {...part('page', 'title')}>{title}</div>}
              {titleExtra !== undefined && <div {...part('page', 'title-extra')}>{titleExtra}</div>}
            </div>
            {actions !== undefined && <div {...part('page', 'actions')}>{actions}</div>}
          </div>
          {description !== undefined && <div {...part('page', 'description')}>{description}</div>}
          {header}
        </div>
      )}
      <div {...part('page', 'body')} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {children}
      </div>
    </div>
  )
}

/** Props of {@link Section}. */
export interface SectionProps extends LayoutProps {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
}

/** A titled content section. */
export function Section({ title, description, actions, className, style, children }: SectionProps): ReactNode {
  return (
    <section {...part('section', 'root')} className={cn('snap-section', className)} style={{ display: 'flex', flexDirection: 'column', gap: space('sm'), ...style }}>
      {(title !== undefined || actions !== undefined) && (
        <div {...part('section', 'header')} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space('md') }}>
          <div>
            {title !== undefined && <div {...part('section', 'title')}>{title}</div>}
            {description !== undefined && <div>{description}</div>}
          </div>
          {actions !== undefined && <div {...part('section', 'actions')}>{actions}</div>}
        </div>
      )}
      <div {...part('section', 'body')}>{children}</div>
    </section>
  )
}

/** Props of {@link Toolbar}. */
export interface ToolbarProps extends LayoutProps {
  start?: ReactNode
  end?: ReactNode
}

/** A compact action bar. */
export function Toolbar({ start, end, className, style }: ToolbarProps): ReactNode {
  return (
    <div
      {...part('toolbar', 'root')}
      className={cn('snap-toolbar', className)}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space('sm'), ...style }}
    >
      <div {...part('toolbar', 'start')} style={{ display: 'flex', alignItems: 'center', gap: space('sm'), minWidth: 0 }}>{start}</div>
      <div {...part('toolbar', 'end')} style={{ display: 'flex', alignItems: 'center', gap: space('sm'), flexShrink: 0 }}>{end}</div>
    </div>
  )
}

/** Props of {@link ScrollArea}. */
export interface ScrollAreaProps extends LayoutProps {
  /** `vertical`, `horizontal`, or `both`. */
  direction?: 'vertical' | 'horizontal' | 'both'
}

/** A native scroll container with a stable anatomy. */
export function ScrollArea({ direction = 'vertical', className, style, children }: ScrollAreaProps): ReactNode {
  return (
    <div
      {...part('scroll-area', 'root')}
      className={cn('snap-scroll-area', className)}
      style={{
        overflowY: direction === 'horizontal' ? 'hidden' : 'auto',
        overflowX: direction === 'vertical' ? 'hidden' : 'auto',
        minHeight: 0,
        ...style,
      }}
    >
      <div {...part('scroll-area', 'viewport')}>{children}</div>
    </div>
  )
}

/** Props of {@link DragScroll}. */
export interface DragScrollProps extends LayoutProps {
  direction?: 'vertical' | 'horizontal' | 'both'
}

/** A touch-friendly scroll container; pointer dragging pans the viewport. */
export function DragScroll({ direction = 'vertical', className, style, children }: DragScrollProps): ReactNode {
  return (
    <div
      {...part('drag-scroll', 'root')}
      className={cn('snap-drag-scroll', className)}
      style={{
        overflowY: direction === 'horizontal' ? 'hidden' : 'auto',
        overflowX: direction === 'vertical' ? 'hidden' : 'auto',
        minHeight: 0,
        ...style,
      }}
    >
      <div {...part('drag-scroll', 'viewport')}>{children}</div>
    </div>
  )
}