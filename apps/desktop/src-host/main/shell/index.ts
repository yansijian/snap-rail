/**
 * The desktop Shell adapter: the one place in the repository where OS
 * integration lives. It implements the `@snap-rail/shell` service on
 * `ctx.shell`, serves the Shell wire contract, and owns the OS-facing
 * artifacts — notifications, the tray icon, the floating ball (docking
 * included), and the operator window's exit policy.
 *
 * Why a plugin and not app code: everything a plugin may ask of the OS has to
 * cross one seam, so that a headless host, a test boot, or a future
 * utility-process host swaps this module and nothing else. Pool plugins never
 * see Electron; they see `ctx.shell`.
 *
 * The decisions (caps, throttling, ownership, coalescing, the exit policy
 * fold, the exclusivity rule) live in `./machine`, and the dock math in
 * `./dock` — both Electron-free and tested. This module is the glue: it turns
 * decisions into `Notification`/`Tray`/`BrowserWindow` calls and OS callbacks
 * back into context events. It never paints a prompt: a `hold` in the exit
 * policy freezes the request and hands the decision to the declaring plugin.
 *
 * @module @snap-rail/desktop/main/shell
 */

import { app, BrowserWindow, Notification } from 'electron'
import { Context, type Plugin } from '@snap-rail/cordis'
import type { GatewayService } from '@snap-rail/gateway'
import type { SettingsService } from '@snap-rail/settings'
import type { AuxSurfaceId, SurfaceId } from '@snap-rail/protocol'
import {
  EXIT_DECISIONS,
  SHELL_LIMITS,
  shellContract,
  type BallDockEdge,
  type BallDockState,
  type BallPatch,
  type BallState,
  type ShellExitAction,
  type ShellExitDecision,
  type ShellExitDisposition,
  type ShellExitRequest,
  type ShellExitSource,
  type ShellNotificationInput,
  type ShellNotificationResult,
  type ShellResult,
  type ShellService,
  type SurfaceState,
} from '@snap-rail/shell'
import { createShellMachine } from './machine.ts'
import { createTrayHost } from './tray.ts'
import { createSurfaceHost, type SurfaceHostOptions } from './surfaces.ts'

/** Settings key remembering where the ball was left. */
export const BALL_POSITION_KEY = 'shell.ballPosition'

/** What the desktop entry hands the adapter. */
export interface DesktopShellOptions {
  /**
   * The operator window, resolved by the app entry once it has created it
   * (boot ordering and the no-shell fallback stay in the app entry).
   */
  operatorWindow: Promise<BrowserWindow>
  /**
   * End the application: dispose the host tree, then quit. The `quit`
   * disposition and the hold timeout both land here — the Shell decides
   * *when*, the app entry owns *how*.
   */
  requestQuit(): void
  /** How the renderer is reached (dev server or built files) and what preload it mounts. */
  renderer: Pick<SurfaceHostOptions, 'preloadPath' | 'devUrl' | 'clientRoot'>
  /** The tray glyph path. */
  trayIconPath: string
}

/** Map a boolean action onto the seam's uniform answer. */
function resultOf(ok: boolean, message: string): ShellResult {
  return ok ? { applied: true } : { applied: false, reason: 'unavailable', message }
}

/** Map a refusal onto the client contract's answer shape. */
function outcomeOf(outcome: ShellResult): { applied: boolean, reason?: string } {
  return outcome.applied ? { applied: true } : { applied: false, reason: outcome.message }
}

/** The Shell adapter plugin; mounted by the desktop main process in `prepare`. */
const desktopShellPlugin: Plugin.Object<DesktopShellOptions> = {
  name: 'desktop-shell',
  inject: ['rpc', 'settings'],
  apply(ctx: Context, options: DesktopShellOptions): void {
    const rpc: GatewayService = ctx.rpc
    const settings: SettingsService = ctx.settings
    const logger = ctx.logger('desktop-shell')
    const machine = createShellMachine()

    /**
     * The app is leaving through the front door (a `quit` disposition, the
     * hold timeout, or Electron's own quit): once set, the close interceptor
     * stands down so `app.quit()` can actually close windows.
     */
    let leaving = false
    const onBeforeQuit = (): void => {
      leaving = true
    }
    app.on('before-quit', onBeforeQuit)

    const surfaces = createSurfaceHost({
      ...options.renderer,
      operatorWindow: options.operatorWindow,
      loadBallPosition: () => {
        const saved = settings.get<Record<string, unknown>>(BALL_POSITION_KEY)
        if (saved === undefined || typeof saved !== 'object' || saved === null) return undefined
        if (saved.kind === 'docked') {
          const edge = saved.edge
          const offset = saved.offset
          if (typeof edge === 'string' && typeof offset === 'number') {
            return { kind: 'docked', edge: edge as BallDockEdge, offset }
          }
          return undefined
        }
        if (typeof saved.x === 'number' && typeof saved.y === 'number') {
          return { kind: 'free', x: saved.x, y: saved.y }
        }
        return undefined
      },
      saveBallPosition: position => {
        settings.set(BALL_POSITION_KEY, position)
      },
      onVisibilityChanged: surface => {
        // The surface host reports the window's own show/hide events; the
        // state frame follows from the same publisher.
        ctx.emit('shell/surface-changed', surfaces.stateOf(surface))
      },
      onDockChanged: state => {
        ctx.emit('shell/ball-dock-changed', state)
      },
      onMainWindowAttached: win => {
        // The operator window's close is the exit policy's to decide: hold
        // the window open, park it, or end the app.
        win.on('close', event => {
          if (leaving) return
          event.preventDefault()
          applyExit('window', machine.exitDecision('window'))
        })
        // A show from outside the Shell (taskbar restore, a stray `show`)
        // re-asserts exclusivity: the operator window takes the screen.
        win.on('show', () => hideAuxSurfaces())
      },
    })

    /** Tell every surface (and every host plugin) that a window changed. */
    const publishSurface = (surface: SurfaceId): void => {
      ctx.emit('shell/surface-changed', surfaces.stateOf(surface))
    }

    /**
     * The exclusivity invariant: presenting the operator window hides every
     * auxiliary surface, and presenting an auxiliary surface hides the
     * operator window. Whichever path made a window visible, exactly one of
     * the two is on screen.
     */
    const hideAuxSurfaces = (): void => {
      for (const surface of machine.exclusivityHides('main')) {
        if (surfaces.stateOf(surface).visible && surfaces.hide(surface as AuxSurfaceId)) {
          publishSurface(surface)
        }
      }
    }

    const tray = createTrayHost(options.trayIconPath, {
      showMain: () => {
        present('main')
      },
      hideMain: () => {
        const win = surfaces.windowOf('main')
        if (win !== undefined && !win.isDestroyed() && win.isVisible()) win.hide()
        publishSurface('main')
      },
      toggleMain: () => {
        // The tray icon is the quick toggle: the operator window and "out of
        // sight" (the tray holds the app) flip on every click.
        const win = surfaces.windowOf('main')
        if (win !== undefined && !win.isDestroyed() && win.isVisible()) {
          win.hide()
          publishSurface('main')
        } else {
          present('main')
        }
      },
      quit: () => {
        applyExit('tray', machine.exitDecision('tray'))
      },
      pick: key => {
        ctx.emit('shell/tray-clicked', key)
      },
    })

    /**
     * Present a surface: enforce exclusivity, create it if needed, show it,
     * and publish the change. Presenting an auxiliary surface is also what
     * brings the tray icon into being — a floating ball with no way to reach
     * the operator window would be a trap.
     */
    const present = (surface: SurfaceId): ShellResult => {
      if (surface === 'main') {
        hideAuxSurfaces()
        const ok = surfaces.present(surface)
        if (ok) publishSurface(surface)
        return resultOf(ok, `无法显示窗口 ${surface}`)
      }
      const mainWin = surfaces.windowOf('main')
      const mainVisible = mainWin !== undefined && !mainWin.isDestroyed() && mainWin.isVisible()
      if (mainVisible) mainWin.hide()
      tray.ensure()
      const ok = surfaces.present(surface)
      if (mainVisible) publishSurface('main')
      if (ok) publishSurface(surface)
      return resultOf(ok, `无法显示窗口 ${surface}`)
    }

    const hide = (surface: AuxSurfaceId): ShellResult => {
      const ok = surfaces.hide(surface)
      if (!ok) return { applied: false, reason: 'unavailable', message: `窗口 ${surface} 尚未创建` }
      publishSurface(surface)
      return { applied: true }
    }

    /** Apply one immediate disposition. Returns false when nothing could be done. */
    const performExit = (source: ShellExitSource, action: ShellExitDisposition): void => {
      if (action === 'quit') {
        leaving = true
        options.requestQuit()
        return
      }
      if (action === 'ball' && present('ball').applied) return
      // `tray`, or a ball that could not be shown: park behind the tray icon.
      if (!tray.ensure()) {
        logger.error(`退出处置 ${action}（来源 ${source}）失败：托盘图标创建失败，主窗口保持可见`)
        return
      }
      const win = surfaces.windowOf('main')
      if (win !== undefined && !win.isDestroyed() && win.isVisible()) {
        win.hide()
        publishSurface('main')
      }
    }

    /** The exit request currently on hold, with its timeout. */
    let pendingExit: { source: ShellExitSource, timer: ReturnType<typeof setTimeout> } | undefined

    /**
     * Hold an exit request: nothing happens until the declaring plugin
     * answers through `resolve` — or the hold times out and the operator's
     * original intent (`quit`) is applied anyway, because a hung renderer
     * must never make the app unkillable.
     */
    const holdExit = (source: ShellExitSource): void => {
      const held = machine.holdExit(source)
      if (!held.applied) {
        logger.warn(`退出请求（来源 ${source}）被忽略：已有一个挂起的请求`)
        return
      }
      const request: ShellExitRequest = { source }
      const timer = setTimeout(() => {
        if (!machine.expireExit(source)) return
        pendingExit = undefined
        logger.error(`挂起的退出请求（来源 ${source}）超过 ${SHELL_LIMITS.exitHoldMs}ms 未应答，按退出处理`)
        ctx.emit('shell/exit-resolved', request, 'quit')
        performExit(source, 'quit')
      }, SHELL_LIMITS.exitHoldMs)
      pendingExit = { source, timer }
      ctx.emit('shell/exit-requested', request)
    }

    const applyExit = (source: ShellExitSource, decision: ShellExitDecision): void => {
      if (decision === 'hold') holdExit(source)
      else performExit(source, decision)
    }

    const resolveExit = (action: ShellExitAction): ShellResult => {
      const answered = machine.resolveExit(action)
      if (answered === undefined) return { applied: false, reason: 'not-found', message: '没有挂起的退出请求' }
      const pending = pendingExit
      if (pending !== undefined && pending.source === answered.source) {
        clearTimeout(pending.timer)
        pendingExit = undefined
      }
      ctx.emit('shell/exit-resolved', { source: answered.source }, action)
      if (action !== 'cancel') performExit(answered.source, action)
      return { applied: true }
    }

    /**
     * Raise one notification. The machine decided the caps and allocated the
     * id; this is only the OS call plus the click wiring. A click always
     * focuses the operator window — a toast whose subject vanished must still
     * leave the operator somewhere useful.
     */
    const notify = (_caller: Context | null, input: ShellNotificationInput): ShellNotificationResult => {
      if (!Notification.isSupported()) {
        return { applied: false, reason: 'no-shell', message: '当前系统不支持桌面通知' }
      }
      const plan = machine.planNotification(input)
      if (!plan.applied) return plan
      const actions = input.actions ?? []
      try {
        const notification = new Notification({
          title: input.title,
          ...input.body !== undefined ? { body: input.body } : {},
          ...input.silent === true ? { silent: true } : {},
          ...actions.length > 0
            ? { actions: actions.map(action => ({ type: 'button' as const, text: action.label })) }
            : {},
        })
        notification.on('click', () => {
          present('main')
          ctx.emit('shell/notification-clicked', plan.id)
        })
        notification.on('action', (details) => {
          const actionId = plan.record.actions[details.actionIndex]
          if (actionId === undefined) return
          present('main')
          ctx.emit('shell/notification-action', plan.id, actionId)
        })
        notification.on('failed', (_event, error) => {
          logger.error(`通知投递失败（${plan.id}）：${error}`)
        })
        notification.show()
        return { applied: true, id: plan.id }
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        return { applied: false, reason: 'unavailable', message: `通知投递失败：${detail}` }
      }
    }

    const service: ShellService = {
      get available() {
        return true
      },
      notify: (caller, input) => notify(caller, input),
      tray: {
        get available() {
          return tray.available
        },
        addItem: (caller, item) => {
          // The tray is created for the first contribution: the icon is the
          // plugins' affordance, not the app's default chrome.
          tray.ensure()
          if (!tray.available) return { applied: false, reason: 'no-tray', message: '当前环境无法创建托盘图标' }
          const added = machine.addTrayItem(caller.fiber.name, item)
          if (added.applied) {
            tray.update(machine.trayEntries())
            // A contribution belongs to the caller's fiber: reloading or
            // disabling that plugin must not leave an orphan menu row.
            caller.effect(() => () => {
              if (machine.removeTrayItem(caller.fiber.name, item.id).applied) tray.update(machine.trayEntries())
            })
          }
          return added
        },
        updateItem: (caller, id, patch) => {
          const updated = machine.updateTrayItem(caller.fiber.name, id, patch)
          if (updated.applied) tray.update(machine.trayEntries())
          return updated
        },
        removeItem: (caller, id) => {
          const removed = machine.removeTrayItem(caller.fiber.name, id)
          if (removed.applied) tray.update(machine.trayEntries())
          return removed
        },
        entries: () => machine.trayEntries(),
      },
      surface: {
        state: () => surfaces.states(),
        present: (_caller, surface) => present(surface),
        hide: (_caller, surface) => hide(surface),
      },
      ball: {
        state: () => machine.ballState(),
        setState: (_caller, patch: BallPatch) => {
          const next = machine.setBallState(patch)
          ctx.emit('shell/ball-changed', next)
          return next
        },
      },
      window: {
        setExitPolicy: (caller, policy) => {
          for (const key of ['close', 'quit'] as const) {
            const value = policy[key]
            if (value !== undefined && !EXIT_DECISIONS.includes(value)) {
              return { applied: false, reason: 'limit-reached', message: `退出策略 ${key} 不合法：${String(value)}` }
            }
          }
          const declared = machine.setExitPolicy(caller.fiber.name, policy)
          if (declared.applied) {
            // The declaration lives exactly as long as its fiber: disabling
            // the scenario reverts the app to the default (quit) policy.
            caller.effect(() => () => {
              machine.removeExitPolicyOwner(caller.fiber.name)
            })
          }
          return declared
        },
        exitPolicy: () => machine.exitPolicy(),
        resolve: (_caller, action) => resolveExit(action),
      },
    }
    ctx.provide('shell', service)

    // The Shell domain is this plugin's wire identity; every method and frame
    // below rides it (serveContract asserts the claim and refuses otherwise).
    rpc.claimDomain(ctx, 'shell')

    // Every surface, ball, dock, and exit change reaches the renderer over
    // the wire as a frame; the bridge keeps the host-side event and the wire
    // frame on one path so a host plugin and a renderer see the same sequence.
    rpc.bridgeEvent(ctx, 'shell/surface-changed', 'shell/surface-changed', (state: SurfaceState) => state)
    rpc.bridgeEvent(ctx, 'shell/ball-changed', 'shell/ball-changed', (state: BallState) => state)
    rpc.bridgeEvent(ctx, 'shell/ball-dock-changed', 'shell/ball-dock-changed', (state: BallDockState) => state)
    rpc.bridgeEvent(ctx, 'shell/exit-requested', 'shell/exit-requested', (request: ShellExitRequest) => request)

    // Client-face calls: a one-way toast, the surface controls, the ball
    // read, and the one-way answer to a held exit request. No caller identity
    // is needed — the payload names what it wants, and the actionable half
    // (policy declaration, tray, actionable notifications) is absent from
    // this contract on purpose.
    rpc.serveContract(ctx, shellContract, {
      'shell.toast': ({ title, body, tag, silent }) => {
        const outcome = notify(null, {
          title,
          ...body !== undefined ? { body } : {},
          ...tag !== undefined ? { tag } : {},
          ...silent !== undefined ? { silent } : {},
        })
        return outcome.applied
          ? { applied: true }
          : { applied: false, reason: outcome.message }
      },
      'shell.surface.present': ({ surface }) => outcomeOf(present(surface)),
      'shell.surface.hide': ({ surface }) => outcomeOf(hide(surface)),
      'shell.surface.state': () => surfaces.states(),
      'shell.ball.state': () => machine.ballState(),
      'shell.ball.dock': () => surfaces.dockState(),
      'shell.exit.resolve': ({ action }) => outcomeOf(resolveExit(action)),
    })

    // A notification that starts the app (clicked while it was closed) cannot
    // reach its own record — the generic landing is the operator window.
    Notification.handleActivation(() => {
      present('main')
    })

    ctx.effect(() => () => {
      app.removeListener('before-quit', onBeforeQuit)
      if (pendingExit !== undefined) clearTimeout(pendingExit.timer)
      tray.dispose()
      surfaces.dispose()
    })
  },
}

export default desktopShellPlugin
