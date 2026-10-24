/**
 * The auxiliary-surface fallback: what the ball window shows when no installed
 * plugin contributes a face for it — and what it keeps showing if the UI
 * framework crashes. The app's promise is that a floating window is never a
 * dead rectangle: the fallback ball is draggable, summons the operator window,
 * parks at a screen edge, and tucks itself into a sliver there.
 *
 * Styling stays local by design, exactly like {@link BootstrapPage}: theme
 * tokens arrive only with an installed framework, and these windows exist
 * precisely when none is loaded. The palette mirrors the framework's dark-mode
 * token values (single source: the framework repo's `src/ui/theme.css`, see
 * docs/theme.md) — change them together.
 *
 * Geometry comes from {@link BALL_SURFACE}: a 128px window, a 112px orb, and
 * an 8px rim that is the only room soft paint gets. The drop shadow is drawn
 * as a radial gradient that fades to zero before the window edge — a CSS
 * `box-shadow` would be clipped into a hard grey band exactly there.
 *
 * @module @snap-rail/client-kernel/SurfaceFallback
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { subscribeFrame, type HostLink } from '@snap-rail/connection'
import {
  BALL_SURFACE,
  ballDockStateSchema,
  ballStateSchema,
  type BallDockState,
  type BallState,
  type BallTone,
} from '@snap-rail/shell/contract'

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

/** The resting dock state: free-floating, fully visible. */
const IDLE_DOCK: BallDockState = {
  edge: null,
  collapsed: false,
  visiblePx: Math.max(1, Math.round(BALL_SURFACE.size * BALL_SURFACE.dockVisibleRatio)),
}

/** Present a surface through the wire; failures are cosmetic here. */
function present(link: HostLink, surface: 'main'): void {
  void link.call('shell.surface.present', { surface })
}

/** The window geometry the ball paints into. */
interface Size {
  width: number
  height: number
}

const WINDOW: Size = { width: BALL_SURFACE.size, height: BALL_SURFACE.size }

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

/**
 * Follow the ball window's dock state: one initial read plus the
 * `shell/ball-dock-changed` push. A face that ignores it renders the full orb
 * and lets the screen edge crop it; this fallback follows it so the
 * no-plugin ball looks deliberate when parked.
 */
function useBallDock(link: HostLink): BallDockState {
  const [state, setState] = useState<BallDockState>(IDLE_DOCK)
  useEffect(() => {
    let live = true
    void link.call('shell.ball.dock', {}).then(result => {
      if (live && result.ok) setState(result.value)
    })
    const drop = subscribeFrame(link, 'shell/ball-dock-changed', ballDockStateSchema, next => { setState(next) })
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
  surface: 'ball'
  /** A failure that brought this window down here (framework crash, refused face). */
  notice?: string | undefined
}

/**
 * The ball fallback: the {@link BALL_SURFACE.orb} orb filling the transparent
 * window, a contained shadow inside the rim, and — while the window is parked
 * and tucked — a compact tab inside the visible strip instead. The whole orb
 * drags the window (`-webkit-app-region: drag`); the core is the click target
 * that summons the operator window.
 */
function BallFallback(props: SurfaceFallbackProps): ReactNode {
  const ball = useBallState(props.link)
  const dock = useBallDock(props.link)
  const parked = dock.edge !== null
  if (parked && dock.collapsed) {
    return <DockTab link={props.link} dock={dock} ball={ball} {...props.notice !== undefined ? { notice: props.notice } : {}} />
  }

  const ring = ball.progress === null
    ? PALETTE.border
    : `conic-gradient(${TONE_COLOR[ball.tone]} ${Math.round(ball.progress * 360)}deg, rgba(148, 163, 184, 0.18) 0deg)`
  // The shadow is painted on the window-sized layer behind the disc and fades
  // to zero before the window edge: a box-shadow here would be clipped into a
  // hard grey band by the transparent window's boundary.
  const shadowLayer: CSSProperties = {
    position: 'relative',
    width: WINDOW.width,
    height: WINDOW.height,
    background: 'radial-gradient(circle at 50% calc(50% + 2px), rgba(0, 0, 0, 0.32) 0 54px, rgba(0, 0, 0, 0) 61px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  }
  const outer: CSSProperties = {
    width: BALL_SURFACE.orb,
    height: BALL_SURFACE.orb,
    borderRadius: '50%',
    background: ring,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    // The ring drags the window; only the core below opts out to stay clickable.
    WebkitAppRegion: 'drag',
  } as CSSProperties
  const core: CSSProperties = {
    width: BALL_SURFACE.orb - 2 * BALL_SURFACE.inset,
    height: BALL_SURFACE.orb - 2 * BALL_SURFACE.inset,
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
      <div style={shadowLayer}>
        <div style={outer}>
          <button
            type="button"
            title={props.notice ?? '打开 SnapRail 主窗口'}
            onClick={() => present(props.link, 'main')}
            style={{ ...core, padding: 0, border: `1px solid ${PALETTE.border}` }}
          >
            {ball.label ?? '●'}
            {props.notice !== undefined
              ? <span style={{ position: 'absolute', top: 6, right: 6, width: 8, height: 8, borderRadius: '50%', background: PALETTE.danger }} />
              : null}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The tucked tab: what the parked ball looks like while only
 * {@link BallDockState.visiblePx} pixels of the window are on screen. A face
 * may render its own tab the same way — the contract is "anchor to the parked
 * edge, fit inside the visible strip, keep a drag region".
 */
function DockTab(props: { link: HostLink, dock: BallDockState, ball: BallState, notice?: string | undefined }): ReactNode {
  const horizontal = props.dock.edge === 'left' || props.dock.edge === 'right'
  const tab: CSSProperties = {
    position: 'absolute',
    ...(props.dock.edge === 'left' ? { left: 0, borderRadius: '0 10px 10px 0' } : {}),
    ...(props.dock.edge === 'right' ? { right: 0, borderRadius: '10px 0 0 10px' } : {}),
    ...(props.dock.edge === 'top' ? { top: 0, borderRadius: '0 0 10px 10px' } : {}),
    ...(props.dock.edge === 'bottom' ? { bottom: 0, borderRadius: '10px 10px 0 0' } : {}),
    width: horizontal ? props.dock.visiblePx : 40,
    height: horizontal ? 96 : props.dock.visiblePx,
    background: PALETTE.raised,
    border: `1px solid ${PALETTE.border}`,
    color: PALETTE.text,
    display: 'flex',
    flexDirection: horizontal ? 'column' : 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
    WebkitAppRegion: 'drag',
  } as CSSProperties
  const button: CSSProperties = {
    width: '100%',
    height: '100%',
    padding: 0,
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    display: 'flex',
    flexDirection: 'inherit',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    cursor: 'default',
    WebkitAppRegion: 'no-drag',
  } as CSSProperties
  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', background: 'transparent' }}>
      <div style={tab}>
        <button
          type="button"
          title={props.notice ?? '打开 SnapRail 主窗口'}
          onClick={() => present(props.link, 'main')}
          style={button}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: TONE_COLOR[props.ball.tone] }} />
          {props.ball.label !== null ? <span style={{ fontSize: 12, fontWeight: 600 }}>{props.ball.label}</span> : null}
        </button>
      </div>
    </div>
  )
}

/**
 * Render the fallback for the auxiliary surface.
 *
 * @param props - see {@link SurfaceFallbackProps}.
 */
export function SurfaceFallback(props: SurfaceFallbackProps): ReactNode {
  return <BallFallback {...props} />
}
