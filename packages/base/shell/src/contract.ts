/**
 * The Shell seam's wire contract: what a renderer surface may ask of the OS
 * integration, and what the host pushes back. This is the **pure** half —
 * zod schemas and types only, no Electron, no cordis service — so a client
 * face can import it as a base seed while the host-side service definition
 * (`@snap-rail/shell`) stays out of the renderer graph.
 *
 * The actionable half of the seam lives on the host face only. A toast's
 * action button is clicked minutes after the client face that raised it is
 * gone, so notifications with buttons, tray titles, and window lifetime are
 * host-face capabilities (`ctx.shell`); a client gets the one-way
 * {@link shellContract} `shell.toast` plus control over the surfaces it can
 * see. That split is the point of the seam: the renderer never touches an OS
 * API, and the host never needs a renderer alive to honour a click.
 *
 * @module @snap-rail/shell/contract
 */

import { z } from 'zod'
import { AUX_SURFACE_IDS, SURFACE_IDS, defineContract, method } from '@snap-rail/protocol'
import type { FrameRows, MethodRows, SurfaceId } from '@snap-rail/protocol'

/**
 * Every cap the Shell enforces, in one table: the host adapter refuses
 * over-limit contributions with `limit-reached`, the renderer surfaces clamp
 * their own input with the same numbers, and tests assert against them
 * instead of restating magic values.
 */
export const SHELL_LIMITS = {
  /** Notification title (characters). */
  title: 120,
  /** Notification body (characters). */
  body: 512,
  /** Notification action-button caption (characters). */
  actionLabel: 20,
  /** Notification action id (characters). */
  actionId: 64,
  /** Notification coalescing tag (characters). */
  tag: 64,
  /** Notification record id (characters). */
  notificationId: 64,
  /** Tray item id (characters). */
  trayItemId: 64,
  /** Tray item caption (characters). */
  trayLabel: 40,
  /** Contributed tray items per plugin. */
  trayItemsPerPlugin: 12,
  /** Contributed tray items across every plugin (the fixed items are extra). */
  trayItems: 24,
  /** Action buttons rendered per notification — the Windows toast limit. */
  notificationActions: 3,
  /** Toasts accepted inside one throttle window before the Shell refuses. */
  notificationsPerWindow: 5,
  /** The notification throttle window (milliseconds). */
  notificationWindowMs: 10_000,
  /** Notification records kept for click correlation (oldest evicted). */
  notificationRecords: 50,
  /** Ball caption (characters). */
  ballLabel: 8,
  /**
   * How long a held exit request (`close: 'hold'` / `quit: 'hold'`) may stay
   * unanswered before the Shell applies the operator's original intent
   * (`quit`) anyway — a hung renderer must never make the app unkillable.
   */
  exitHoldMs: 10_000,
} as const

/**
 * The ball window's geometry, single-sourced so the host's window bounds and
 * every face's layout agree: a 128px transparent window, a 112px orb, and an
 * 8px rim that is the **only** room a face has for soft paint. A CSS
 * `box-shadow` is clipped at the window edge — a shadow must be drawn
 * contained inside the inset (a radial gradient fading to zero), which is why
 * {@link BALL_SURFACE.inset} exists as a contract and not a suggestion.
 */
export const BALL_SURFACE = {
  /** The ball window's edge length (square). */
  size: 128,
  /** The recommended orb diameter (`size - 2 * inset`). */
  orb: 112,
  /** The paint-free rim on every side; shadows live here, faded to zero. */
  inset: 8,
  /** How much of the window stays on screen when the ball parks at an edge. */
  dockVisibleRatio: 1 / 3,
} as const

/** The edges a ball may park against. */
export const BALL_DOCK_EDGES = ['left', 'right', 'top', 'bottom'] as const

/** One ball dock edge. */
export type BallDockEdge = (typeof BALL_DOCK_EDGES)[number]

/** The ball's semantic tone; the theme's tokens pick the color. */
export const BALL_TONES = ['neutral', 'accent', 'warning', 'danger'] as const

/** One ball tone. */
export type BallTone = (typeof BALL_TONES)[number]

/**
 * The host-aggregated ball state: what the floating ball renders. A ball
 * surface face may render its own visual, but this is the state every
 * surface sees — a host-face plugin (production counters, connection health)
 * writes it without needing the ball window to exist.
 */
export interface BallState {
  /** Ring fill in `0..1`; `null` hides the ring. */
  progress: number | null
  /** Short caption inside the orb (at most {@link SHELL_LIMITS.ballLabel} characters); `null` shows none. */
  label: string | null
  /** Semantic tone of the ring and caption. */
  tone: BallTone
}

/** A merge patch for {@link BallState}: omitted fields keep their value. */
export interface BallPatch {
  progress?: number | null | undefined
  label?: string | null | undefined
  tone?: BallTone | undefined
}

/** One surface's live state, as the Shell reports it. */
export interface SurfaceState {
  /** Which surface this reports. */
  surface: SurfaceId
  /** Whether the surface's window currently exists (auxiliary windows are created lazily). */
  available: boolean
  /** Whether the surface is on screen. */
  visible: boolean
}

/**
 * The ball window's dock state: where it is parked and whether it is tucked
 * into that edge. Purely window geometry — the content half of the ball lives
 * in {@link BallState}. A face that ignores this state simply renders the full
 * orb and lets the screen edge crop it; a face that follows it draws its own
 * collapsed look inside the visible strip.
 */
export interface BallDockState {
  /** The parked edge, or `null` while the ball floats freely. */
  edge: BallDockEdge | null
  /** Whether the ball is tucked into the edge (only `visiblePx` is on screen). */
  collapsed: boolean
  /** How many pixels of the window stay inside the work area while collapsed. */
  visiblePx: number
}

/** Payload schema of the `shell/ball-dock-changed` frame. */
export const ballDockStateSchema = z.object({
  edge: z.enum(BALL_DOCK_EDGES).nullable(),
  collapsed: z.boolean(),
  visiblePx: z.number().int().min(1).max(BALL_SURFACE.size),
}).strict()

/**
 * What resolving a held exit request (or answering for it) does. `ball` parks
 * the app into the floating ball, `tray` hides the window behind the tray
 * icon, `quit` ends the app, `cancel` keeps everything as it was.
 */
export const EXIT_ACTIONS = ['ball', 'tray', 'quit', 'cancel'] as const

/** One exit resolution. */
export type ShellExitAction = (typeof EXIT_ACTIONS)[number]

/** Where an exit request came from. */
export const EXIT_SOURCES = ['window', 'tray'] as const

/** One exit request source (`window` = the operator window's close, `tray` = the tray's 退出 row). */
export type ShellExitSource = (typeof EXIT_SOURCES)[number]

/** Payload schema of the `shell/ball-changed` frame. */
export const ballStateSchema = z.object({
  progress: z.number().min(0).max(1).nullable(),
  label: z.string().max(SHELL_LIMITS.ballLabel).nullable(),
  tone: z.enum(BALL_TONES),
}).strict()

/** Payload schema of the `shell/surface-changed` frame. */
export const surfaceStateSchema = z.object({
  surface: z.enum(SURFACE_IDS),
  available: z.boolean(),
  visible: z.boolean(),
}).strict()

const emptyRequest = z.object({}).strict()

/** The auxiliary surfaces a client may hide (`main` is the Shell's own — a
 * renderer may ask for the operator window, never send it away). */
const auxSurfaceSchema = z.enum(AUX_SURFACE_IDS)

/** Every surface a client may ask the Shell to bring up. */
const anySurfaceSchema = z.enum(SURFACE_IDS)

/** The uniform answer of a client-driven capability call. */
export interface SurfaceActionResult {
  /** Whether the Shell acted. */
  applied: boolean
  /** Why it refused, when it did (operator-facing). */
  reason?: string | undefined
}

/** The answer of a client toast. */
export interface ToastResult {
  /** Whether the Shell accepted the toast. */
  applied: boolean
  /** Why it refused, when it did (operator-facing) — throttling, limits, no OS integration. */
  reason?: string | undefined
}

/**
 * The Shell wire surface. Clients may raise a plain toast (no buttons, no
 * callback — clicking it focuses the main window), bring a surface up (the
 * operator window included: that is how the fallback ball summons it), hide
 * an auxiliary one, and read the ball state they render.
 */
export const shellContract = defineContract('shell', {
  methods: {
    /** Raise a plain OS notification; clicking it focuses the main window. */
    'shell.toast': method(z.object({
      title: z.string().min(1).max(SHELL_LIMITS.title),
      body: z.string().min(1).max(SHELL_LIMITS.body).optional(),
      tag: z.string().min(1).max(SHELL_LIMITS.tag).optional(),
      silent: z.boolean().optional(),
    }).strict()).ret<ToastResult>(),
    /** Create the surface's window if needed and show it. `main` is allowed and
     * means "bring the operator window up and focus it" — the fallback ball's
     * only useful action when no plugin face is installed. */
    'shell.surface.present': method(z.object({ surface: anySurfaceSchema }).strict())
      .ret<SurfaceActionResult>(),
    /** Hide the auxiliary surface's window (the window is kept for the next present). */
    'shell.surface.hide': method(z.object({ surface: auxSurfaceSchema }).strict())
      .ret<SurfaceActionResult>(),
    /** Read every surface's live state, `main` first — the read half of the
     * `shell/surface-changed` push, so a freshly created window starts from
     * truth instead of guessing (a ball born while the operator window is
     * hidden must not believe the opposite). */
    'shell.surface.state': method(emptyRequest).ret<readonly SurfaceState[]>(),
    /** Read the host-aggregated ball state this surface renders. */
    'shell.ball.state': method(emptyRequest).ret<BallState>(),
    /** Read the ball window's dock state (parked edge and collapsed flag). */
    'shell.ball.dock': method(emptyRequest).ret<BallDockState>(),
    /**
     * Answer a held exit request (`shell/exit-requested`). A renderer may only
     * ever resolve — raising the request is the host's (the window's close or
     * the tray's 退出), and the actual OS act stays on the host face.
     */
    'shell.exit.resolve': method(z.object({ action: z.enum(EXIT_ACTIONS) }).strict())
      .ret<SurfaceActionResult>(),
  },
  frames: {
    /** A surface appeared, disappeared, or was created — pushed to every surface. */
    'shell/surface-changed': surfaceStateSchema,
    /** The host-aggregated ball state changed; the ball surface repaints. */
    'shell/ball-changed': ballStateSchema,
    /** The ball parked at, left, tucked into, or slid out of an edge. */
    'shell/ball-dock-changed': ballDockStateSchema,
    /**
     * An exit was requested and held (`close: 'hold'` / `quit: 'hold'`): the
     * window stays exactly as it is until `shell.exit.resolve` answers, or the
     * hold times out and the Shell applies `quit` itself.
     */
    'shell/exit-requested': z.object({ source: z.enum(EXIT_SOURCES) }).strict(),
  },
})

declare module '@snap-rail/protocol' {
  interface RpcMethodMap extends MethodRows<typeof shellContract> {}
  interface FrameMap extends FrameRows<typeof shellContract> {}
}
