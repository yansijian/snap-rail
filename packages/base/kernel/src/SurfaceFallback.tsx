/**
 * The auxiliary-surface fallback: what the ball and panel windows show when no
 * installed plugin contributes a face for them — and what they keep showing if
 * the UI framework crashes. The app's promise is that a floating window is
 * never a dead rectangle: the fallback ball is draggable and summons the
 * operator window, the fallback panel explains what is missing and can close
 * itself.
 *
 * Styling stays local by design, exactly like {@link BootstrapPage}: theme
 * tokens arrive only with an installed framework, and these windows exist
 * precisely when none is loaded. The palette mirrors the framework's dark-mode
 * token values (single source: the framework repo's `src/ui/theme.css`, see
 * docs/theme.md) — change them together.
 *
 * @module @snap-rail/client-kernel/SurfaceFallback
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { subscribeFrame, type HostLink } from '@snap-rail/connection'
import { ballStateSchema, type BallState, type BallTone } from '@snap-rail/shell/contract'
import type { AuxSurfaceId } from '@snap-rail/protocol'

/** The dark-mode token values the fallback palette reproduces. */
const PALETTE = {
  surface: '#0b0f14',
  raised: '#11161d',
  border: 'rgba(148, 163, 184, 0.22)',
  text: '#e2e8f0',
  muted: '#94a3b8',
  danger: '#ef4444',
} as const

/** Ring color per ball tone (the theme's semantic colors). */
const TONE_COLOR: Record<BallTone, string> = {
  neutral: '#64748b',
  accent: '#3b82f6',
  warning: '#f59e0b',
  danger: '#ef4444',
}

/** The ball's resting state before the host answers (a quiet grey orb). */
const IDLE_BALL: BallState = { progress: null, label: null, tone: 'neutral' }

/** Present a surface through the wire; failures are cosmetic here. */
function present(link: HostLink, surface: 'main' | AuxSurfaceId): void {
  void link.call('shell.surface.present', { surface })
}

/** Hide an auxiliary surface through the wire. */
function hide(link: HostLink, surface: AuxSurfaceId): void {
  void link.call('shell.surface.hide', { surface })
}

/**
 * Follow the host-aggregated ball state: one initial read plus the
 * `shell/ball-changed` push. The ball face never subscribes to equipment
 * points — a hidden ball must not keep a data path alive.
 *
 * @param link - the surface's host link.
 * @returns the live ball state (idle state until the host answers).
 */
function useBallState(link: HostLink): BallState {
  const [state, setState] = useState<BallState>(IDLE_BALL)
  useEffect(() => {
    let live = true
    void link.call('shell.ball.state', {}).then(result => {
      if (live && result.ok) setState(result.value)
    })
    const drop = subscribeFrame(link, 'shell/ball-changed', ballStateSchema, next => { setState(next) })
    return () => {
      live = false
      drop()
    }
  }, [link])
  return state
}

/** Props every surface fallback shares. */
export interface SurfaceFallbackProps {
  link: HostLink
  /** The surface being rendered. */
  surface: AuxSurfaceId
  /** A failure that brought this window down here (framework crash, refused face). */
  notice?: string | undefined
}

/**
 * The ball fallback: a 112px orb that fills the 128px transparent window. The
 * whole orb drags the window (`-webkit-app-region: drag`); the inner core is
 * the click target that summons the operator window — the one action a
 * frameless window with no installed UI can still offer.
 */
function BallFallback({ link, notice }: SurfaceFallbackProps): ReactNode {
  const ball = useBallState(link)
  const ring = ball.progress === null
    ? PALETTE.border
    : `conic-gradient(${TONE_COLOR[ball.tone]} ${Math.round(ball.progress * 360)}deg, rgba(148, 163, 184, 0.18) 0deg)`
  const outer: CSSProperties = {
    width: 112,
    height: 112,
    borderRadius: '50%',
    background: ring,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 6px 18px rgba(0, 0, 0, 0.35)',
    // The ring drags the window; only the core below opts out to stay clickable.
    WebkitAppRegion: 'drag',
  } as CSSProperties
  const core: CSSProperties = {
    width: 96,
    height: 96,
    borderRadius: '50%',
    background: PALETTE.surface,
    border: `1px solid ${PALETTE.border}`,
    color: ball.label === null ? PALETTE.muted : PALETTE.text,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 18,
    fontWeight: 600,
    letterSpacing: 0.5,
    cursor: 'default',
    position: 'relative',
    WebkitAppRegion: 'no-drag',
  } as CSSProperties
  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent' }}>
      <div style={outer}>
        <button
          type="button"
          title={notice ?? '打开 SnapRail 主窗口'}
          onClick={() => present(link, 'main')}
          style={{ ...core, padding: 0, border: `1px solid ${PALETTE.border}` }}
        >
          {ball.label ?? '●'}
          {notice !== undefined
            ? <span style={{ position: 'absolute', top: 6, right: 6, width: 8, height: 8, borderRadius: '50%', background: PALETTE.danger }} />
            : null}
        </button>
      </div>
    </div>
  )
}

/**
 * The panel fallback: a 344×464 card inside the 360×480 transparent window.
 * It names what is missing and offers the two actions that still make sense —
 * open the operator window, or put the panel away.
 */
function PanelFallback({ link, surface, notice }: SurfaceFallbackProps): ReactNode {
  const card: CSSProperties = {
    width: 344,
    height: 464,
    borderRadius: 14,
    background: PALETTE.surface,
    border: `1px solid ${PALETTE.border}`,
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
    color: PALETTE.text,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: 20,
    boxSizing: 'border-box',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  }
  const action: CSSProperties = {
    height: 34,
    padding: '0 14px',
    borderRadius: 8,
    border: `1px solid ${PALETTE.border}`,
    background: PALETTE.raised,
    color: PALETTE.text,
    fontSize: 13,
    cursor: 'pointer',
  }
  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent' }}>
      <div style={card}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>悬浮面板</div>
        <div style={{ fontSize: 13, lineHeight: 1.7, color: PALETTE.muted, flex: 1 }}>
          此窗口暂无插件界面。
          <br />
          安装并启用一个带面板界面的插件后会显示在这里。
        </div>
        {notice !== undefined
          ? (
            <div style={{ fontSize: 12, lineHeight: 1.6, color: PALETTE.danger, whiteSpace: 'pre-wrap', maxHeight: 150, overflow: 'auto' }}>
              {notice}
            </div>
          )
          : null}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" style={action} onClick={() => present(link, 'main')}>打开主窗口</button>
          <button type="button" style={action} onClick={() => hide(link, surface)}>收起</button>
        </div>
      </div>
    </div>
  )
}

/**
 * Render the fallback for one auxiliary surface.
 *
 * @param props - see {@link SurfaceFallbackProps}.
 */
export function SurfaceFallback(props: SurfaceFallbackProps): ReactNode {
  return props.surface === 'ball' ? <BallFallback {...props} /> : <PanelFallback {...props} />
}