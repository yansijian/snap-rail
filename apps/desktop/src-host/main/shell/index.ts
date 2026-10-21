/**
 * The desktop Shell adapter: the one place in the repository where OS
 * integration lives. It implements the `@snap-rail/shell` service on
 * `ctx.shell`, serves the Shell wire contract, and owns the three OS-facing
 * artifacts — notifications, the tray icon, and the auxiliary windows.
 *
 * Why a plugin and not app code: everything a plugin may ask of the OS has to
 * cross one seam, so that a headless host, a test boot, or a future
 * utility-process host swaps this module and nothing else. Pool plugins never
 * see Electron; they see `ctx.shell`.
 *
 * The decisions (caps, throttling, ownership, coalescing) live in
 * `./machine` — Electron-free and tested. This module is the glue: it turns
 * decisions into `Notification`/`Tray`/`BrowserWindow` calls and OS callbacks
 * back into context events.
 *
 * @module @snap-rail/desktop/main/shell
 */

import { app, BrowserWindow, Notification } from 'electron'
import { Context, type Plugin } from '@snap-rail/cordis'
import type { GatewayService } from '@snap-rail/gateway'
import type { SettingsService } from '@snap-rail/settings'
import type { AuxSurfaceId, SurfaceId } from '@snap-rail/protocol'
import {
  shellContract,
  type BallPatch,
  type BallState,
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
  /** The operator window, once the app has opened it (may be `undefined` during boot). */
  mainWindow(): BrowserWindow | undefined
  /** How the renderer is reached (dev server or built files) and what preload it mounts. */
  renderer: Pick<SurfaceHostOptions, 'preloadPath' | 'devUrl' | 'clientRoot'>
  /** The tray glyph path. */
  trayIconPath: string
}

/** Map a boolean action onto the seam's uniform answer. */
function resultOf(ok: boolean, message: string): ShellResult {
  return ok ? { applied: true } : { applied: false, reason: 'unavailable', message }
}

/** The Shell adapter plugin; mounted by the desktop main process in `prepare`. */
const desktopShellPlugin: Plugin.Object<DesktopShellOptions> = {
  name: 'desktop-shell',
  inject: ['rpc', 'settings'],
  apply(ctx: Context, options: DesktopShellOptions): void {
    const rpc: GatewayService = ctx.rpc
    const settings: SettingsService = ctx.settings
    const machine = createShellMachine()

    const surfaces = createSurfaceHost(options.mainWindow, {
      ...options.renderer,
      loadBallPosition: () => {
        const saved = settings.get<{ x?: unknown, y?: unknown }>(BALL_POSITION_KEY)
        if (saved === undefined || typeof saved !== 'object' || saved === null) return undefined
        if (typeof saved.x !== 'number' || typeof saved.y !== 'number') return undefined
        return { x: saved.x, y: saved.y }
      },
      saveBallPosition: position => {
        settings.set(BALL_POSITION_KEY, position)
      },
      onVisibilityChanged: surface => {
        // The surface host reports the window's own show/hide events (blur,
        // OS-side hide); the state frame follows from the same publisher.
        ctx.emit('shell/surface-changed', surfaces.stateOf(surface))
      },
    })

    /** Tell every surface (and every host plugin) that a window changed. */
    const publishSurface = (surface: SurfaceId): void => {
      ctx.emit('shell/surface-changed', surfaces.stateOf(surface))
    }

    /** Tell every surface that the ball changed. */
    const publishBall = (state: BallState): void => {
      ctx.emit('shell/ball-changed', state)
    }

    const tray = createTrayHost(options.trayIconPath, {
      showMain: () => {
        surfaces.present('main')
      },
      hideMain: () => {
        const win = options.mainWindow()
        if (win !== undefined && !win.isDestroyed()) win.hide()
        publishSurface('main')
      },
      toggleMain: () => {
        const win = options.mainWindow()
        if (win !== undefined && !win.isDestroyed() && win.isVisible()) win.hide()
        else surfaces.present('main')
        publishSurface('main')
      },
      quit: () => {
        app.quit()
      },
      pick: key => {
        ctx.emit('shell/tray-clicked', key)
      },
    })

    /**
     * Present a surface: create it if needed, show it, and publish the change.
     * Presenting an auxiliary surface is also what brings the tray icon into
     * being — a floating ball with no way to reach the operator window would
     * be a trap.
     */
    const present = (surface: SurfaceId): ShellResult => {
      if (surface !== 'main') tray.ensure()
      const ok = surfaces.present(surface)
      if (ok) publishSurface(surface)
      return resultOf(ok, `无法显示窗口 ${surface}`)
    }

    const hide = (surface: AuxSurfaceId): ShellResult => {
      const ok = surfaces.hide(surface)
      if (!ok) return { applied: false, reason: 'unavailable', message: `窗口 ${surface} 尚未创建` }
      publishSurface(surface)
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
          surfaces.present('main')
          ctx.emit('shell/notification-clicked', plan.id)
        })
        notification.on('action', (details) => {
          const actionId = plan.record.actions[details.actionIndex]
          if (actionId === undefined) return
          surfaces.present('main')
          ctx.emit('shell/notification-action', plan.id, actionId)
        })
        notification.on('failed', (_event, error) => {
          console.error(`shell: 通知投递失败（${plan.id}）：${error}`)
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
          publishBall(next)
          return next
        },
      },
    }
    ctx.provide('shell', service)

    // The Shell domain is this plugin's wire identity; every method and frame
    // below rides it (serveContract asserts the claim and refuses otherwise).
    rpc.claimDomain(ctx, 'shell')

    // Every surface change and ball change reaches the renderer over the wire
    // as a frame; the bridge keeps the host-side event and the wire frame on
    // one path so a host plugin and a renderer see the same sequence.
    rpc.bridgeEvent(ctx, 'shell/surface-changed', 'shell/surface-changed', (state: SurfaceState) => state)
    rpc.bridgeEvent(ctx, 'shell/ball-changed', 'shell/ball-changed', (state: BallState) => state)

    // Client-face calls: a one-way toast, the surface controls, and the ball
    // read. No caller identity is needed — the payload names what it wants,
    // and the actionable half is simply absent from this contract.
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
      'shell.surface.present': ({ surface }) => {
        const outcome = present(surface)
        return outcome.applied ? { applied: true } : { applied: false, reason: outcome.message }
      },
      'shell.surface.hide': ({ surface }) => {
        const outcome = hide(surface)
        return outcome.applied ? { applied: true } : { applied: false, reason: outcome.message }
      },
      'shell.ball.state': () => machine.ballState(),
    })

    // A notification that starts the app (clicked while it was closed) cannot
    // reach its own record — the generic landing is the operator window.
    Notification.handleActivation(() => {
      surfaces.present('main')
    })

    ctx.effect(() => () => {
      tray.dispose()
      surfaces.dispose()
    })
  },
}

export default desktopShellPlugin