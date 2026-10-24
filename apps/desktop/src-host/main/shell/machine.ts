/**
 * The Shell adapter's Electron-free core: the tray contribution registry, the
 * notification ledger (caps, coalescing, throttling), the host-aggregated
 * ball state, the exit policy fold, and the main-window/ball exclusivity rule.
 * Everything here is plain data and decisions, so the tests drive
 * the exact rules the adapter enforces without ever opening a window — the
 * same split `update-machine.ts` uses for the update channel.
 *
 * Two rules shape the whole module:
 *
 * - **The host face is the trust boundary.** A host-face plugin calls
 *   `ctx.shell` directly, so no wire schema stands between it and these
 *   caps: the machine validates instead of trusting, and answers with a
 *   {@link ShellResult} refusal rather than throwing into the caller's fiber.
 * - **A contribution is owned by the plugin that made it.** Tray ids are
 *   namespaced `<plugin>:<id>` and the click event carries that key, so two
 *   plugins may both contribute `pause` and neither can update or remove the
 *   other's row; an exit policy declaration reverts to the defaults when its
 *   declaring fiber goes away.
 *
 * @module @snap-rail/desktop/main/shell/machine
 */

import {
  BALL_TONES,
  EXIT_DECISIONS,
  SHELL_LIMITS,
  type BallPatch,
  type BallState,
  type ShellExitAction,
  type ShellExitDecision,
  type ShellExitPolicy,
  type ShellExitSource,
  type ShellNotificationInput,
  type ShellRefusalReason,
  type ShellResult,
  type ShellTrayEntry,
  type ShellTrayItem,
  type ShellTrayItemPatch,
} from '@snap-rail/shell'
import { AUX_SURFACE_IDS, type SurfaceId } from '@snap-rail/protocol'

/** One accepted notification, kept until the record cap evicts it. */
export interface NotificationRecord {
  /** The id the plugin got back. */
  id: string
  /** Coalescing tag, when the request carried one. */
  tag?: string | undefined
  /** The action ids this notification offers (the click router validates against them). */
  actions: readonly string[]
  /** When the toast was accepted (epoch milliseconds). */
  time: number
}

/** A decided notification: the caller raises it, then reports clicks back. */
export type NotificationPlan =
  | { readonly applied: true, readonly id: string, readonly record: NotificationRecord }
  | { readonly applied: false, readonly reason: ShellRefusalReason, readonly message: string }

/** The options the machine is built with. */
export interface ShellMachineOptions {
  /** Clock override for the throttle window (tests drive it). */
  now?: (() => number) | undefined
}

/**
 * The exit policy every installation starts with: closing the operator window
 * and quitting from the tray both end the app — exactly the pre-policy
 * behavior, so a base upgrade never changes what an operator's X does until a
 * plugin declares otherwise.
 */
export const DEFAULT_EXIT_POLICY: Readonly<ShellExitPolicy> = { close: 'quit', quit: 'quit' }

/** The Shell adapter's state, minus the OS. */
export interface ShellMachine {
  /** Contributed tray menu items, in contribution order. */
  trayEntries(): readonly ShellTrayEntry[]
  /** Contribute one item; the answer names the refusal when it cannot. */
  addTrayItem(plugin: string, item: ShellTrayItem): ShellResult
  /** Update one of the caller's items in place. */
  updateTrayItem(plugin: string, id: string, patch: ShellTrayItemPatch): ShellResult
  /** Withdraw one of the caller's items. */
  removeTrayItem(plugin: string, id: string): ShellResult
  /** Drop every item a plugin contributed (its fiber went away). */
  removeTrayOwner(plugin: string): number
  /**
   * Decide one notification: caps, throttling, tag coalescing, id allocation.
   * The caller raises the toast when `applied`; the record stays here so a
   * click can be routed back.
   */
  planNotification(input: ShellNotificationInput): NotificationPlan
  /** The record behind an id, until the cap evicts it. */
  notification(id: string): NotificationRecord | undefined
  /** The live ball state. */
  ballState(): BallState
  /** Merge a patch into the ball state; out-of-range values are clamped. */
  setBallState(patch: BallPatch): BallState
  /**
   * Declare (part of) the exit policy. A plugin's later declaration replaces
   * its earlier one and moves to the back of the line (last declaration wins
   * per field); an unknown decision value is refused.
   */
  setExitPolicy(plugin: string, policy: Partial<ShellExitPolicy>): ShellResult
  /** The folded policy in force (defaults underneath every declaration). */
  exitPolicy(): Readonly<ShellExitPolicy>
  /** Drop one plugin's declaration (its fiber went away). */
  removeExitPolicyOwner(plugin: string): void
  /** The decision the live policy makes for one exit source. */
  exitDecision(source: ShellExitSource): ShellExitDecision
  /**
   * Hold the one open exit request (`hold` in the policy). A second request
   * while one is pending is refused — the declaring plugin's dialog is already
   * on the table.
   */
  holdExit(source: ShellExitSource): ShellResult
  /** The source whose exit request is being held, when one is. */
  pendingExit(): ShellExitSource | undefined
  /**
   * Answer the held request; `undefined` when nothing is held (the caller
   * turns that into a `not-found` refusal).
   */
  resolveExit(action: ShellExitAction): { source: ShellExitSource, action: ShellExitAction } | undefined
  /** Drop a stale hold (the hold timeout fired); false when it was already answered. */
  expireExit(source: ShellExitSource): boolean
  /**
   * Which surfaces a `present` must hide first: the operator window and the
   * floating ball exclude each other, and the rule lives here so tests — not
   * the Electron glue — own it.
   */
  exclusivityHides(target: SurfaceId): readonly SurfaceId[]
}

/** A refusal answer. */
function refuse(reason: ShellRefusalReason, message: string): { readonly applied: false, readonly reason: ShellRefusalReason, readonly message: string } {
  return { applied: false, reason, message }
}

/** The applied answer. */
const APPLIED: ShellResult = { applied: true }

/** Clamp a ball ring value into `0..1`. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Create the Shell adapter's core.
 *
 * @param options - see {@link ShellMachineOptions}.
 * @returns the machine the adapter drives.
 */
export function createShellMachine(options: ShellMachineOptions = {}): ShellMachine {
  const now = options.now ?? Date.now

  const tray: ShellTrayEntry[] = []
  const notifications = new Map<string, NotificationRecord>()
  /** Acceptance timestamps inside the throttle window, oldest first. */
  const recent: number[] = []
  /** Tag → the id a repeat replaces (the OS coalesces by tag). */
  const tagIndex = new Map<string, string>()
  let notificationCounter = 0
  let ball: BallState = { progress: null, label: null, tone: 'neutral' }
  /** Exit policy declarations by plugin, in declaration order (later wins per field). */
  const exitPolicies = new Map<string, Partial<ShellExitPolicy>>()
  /** The exit request currently on hold, when one is. */
  let heldExit: ShellExitSource | undefined

  const keyOf = (plugin: string, id: string): string => `${plugin}:${id}`

  function trayRefusal(plugin: string, item: ShellTrayItem): ShellResult | undefined {
    if (item.id === '' || item.id.length > SHELL_LIMITS.trayItemId) {
      return refuse('limit-reached', `托盘项 id 需为 1..${SHELL_LIMITS.trayItemId} 个字符`)
    }
    if (item.label === '' || item.label.length > SHELL_LIMITS.trayLabel) {
      return refuse('limit-reached', `托盘项标题需为 1..${SHELL_LIMITS.trayLabel} 个字符`)
    }
    if (tray.some(entry => entry.key === keyOf(plugin, item.id))) {
      return refuse('duplicate', `托盘项 ${item.id} 已存在`)
    }
    const owned = tray.filter(entry => entry.plugin === plugin).length
    if (owned >= SHELL_LIMITS.trayItemsPerPlugin) {
      return refuse('limit-reached', `单个插件最多贡献 ${SHELL_LIMITS.trayItemsPerPlugin} 个托盘项`)
    }
    if (tray.length >= SHELL_LIMITS.trayItems) {
      return refuse('limit-reached', `托盘项总数上限 ${SHELL_LIMITS.trayItems}`)
    }
    return undefined
  }

  function pruneThrottle(at: number): void {
    while (recent.length > 0 && at - recent[0]! >= SHELL_LIMITS.notificationWindowMs) recent.shift()
  }

  /** Fold every live declaration over the defaults, in declaration order. */
  function foldExitPolicy(): ShellExitPolicy {
    const folded: Partial<ShellExitPolicy> = {}
    for (const patch of exitPolicies.values()) {
      if (patch.close !== undefined) folded.close = patch.close
      if (patch.quit !== undefined) folded.quit = patch.quit
    }
    return {
      close: folded.close ?? DEFAULT_EXIT_POLICY.close,
      quit: folded.quit ?? DEFAULT_EXIT_POLICY.quit,
    }
  }

  return {
    trayEntries: () => tray,

    addTrayItem(plugin, item) {
      const refusal = trayRefusal(plugin, item)
      if (refusal !== undefined) return refusal
      tray.push({
        key: keyOf(plugin, item.id),
        plugin,
        id: item.id,
        label: item.label,
        ...item.enabled !== undefined ? { enabled: item.enabled } : {},
        ...item.checked !== undefined ? { checked: item.checked } : {},
      })
      return APPLIED
    },

    updateTrayItem(plugin, id, patch) {
      const key = keyOf(plugin, id)
      const entry = tray.find(candidate => candidate.key === key)
      if (entry === undefined) return refuse('not-found', `托盘项 ${id} 不存在`)
      if (patch.label !== undefined) {
        if (patch.label === '' || patch.label.length > SHELL_LIMITS.trayLabel) {
          return refuse('limit-reached', `托盘项标题需为 1..${SHELL_LIMITS.trayLabel} 个字符`)
        }
        entry.label = patch.label
      }
      if (patch.enabled !== undefined) entry.enabled = patch.enabled
      // `null` turns a toggle back into a plain item; `undefined` leaves it.
      if (patch.checked === null) delete entry.checked
      else if (patch.checked !== undefined) entry.checked = patch.checked
      return APPLIED
    },

    removeTrayItem(plugin, id) {
      const key = keyOf(plugin, id)
      const index = tray.findIndex(candidate => candidate.key === key)
      if (index < 0) return refuse('not-found', `托盘项 ${id} 不存在`)
      tray.splice(index, 1)
      return APPLIED
    },

    removeTrayOwner(plugin) {
      const before = tray.length
      for (let index = tray.length - 1; index >= 0; index--) {
        if (tray[index]!.plugin === plugin) tray.splice(index, 1)
      }
      return before - tray.length
    },

    planNotification(input) {
      if (input.title === '' || input.title.length > SHELL_LIMITS.title) {
        return refuse('limit-reached', `通知标题需为 1..${SHELL_LIMITS.title} 个字符`)
      }
      if (input.body !== undefined && (input.body === '' || input.body.length > SHELL_LIMITS.body)) {
        return refuse('limit-reached', `通知正文需为 1..${SHELL_LIMITS.body} 个字符`)
      }
      const actions = input.actions ?? []
      if (actions.length > SHELL_LIMITS.notificationActions) {
        return refuse('limit-reached', `一条通知最多 ${SHELL_LIMITS.notificationActions} 个动作按钮`)
      }
      for (const action of actions) {
        if (action.id === '' || action.id.length > SHELL_LIMITS.actionId) {
          return refuse('limit-reached', `通知动作 id 需为 1..${SHELL_LIMITS.actionId} 个字符`)
        }
        if (action.label === '' || action.label.length > SHELL_LIMITS.actionLabel) {
          return refuse('limit-reached', `通知动作标题需为 1..${SHELL_LIMITS.actionLabel} 个字符`)
        }
      }
      if (input.tag !== undefined && (input.tag === '' || input.tag.length > SHELL_LIMITS.tag)) {
        return refuse('limit-reached', `通知合并标签需为 1..${SHELL_LIMITS.tag} 个字符`)
      }

      const at = now()
      pruneThrottle(at)
      // A coalescing tag replaces its own earlier toast, so it must not be
      // throttled away — the operator would keep a stale count on screen.
      const replacing = input.tag !== undefined ? tagIndex.get(input.tag) : undefined
      if (replacing === undefined && recent.length >= SHELL_LIMITS.notificationsPerWindow) {
        return refuse('limit-reached', `${SHELL_LIMITS.notificationWindowMs / 1000} 秒内最多 ${SHELL_LIMITS.notificationsPerWindow} 条通知`)
      }

      const id = replacing ?? `shell-${++notificationCounter}`
      recent.push(at)
      const record: NotificationRecord = {
        id,
        ...input.tag !== undefined ? { tag: input.tag } : {},
        actions: actions.map(action => action.id),
        time: at,
      }
      notifications.delete(id)
      notifications.set(id, record)
      if (input.tag !== undefined) tagIndex.set(input.tag, id)
      // Oldest-first eviction: a click may arrive minutes later, but the
      // ledger only keeps what can plausibly still be on screen.
      for (const stale of notifications.keys()) {
        if (notifications.size <= SHELL_LIMITS.notificationRecords) break
        notifications.delete(stale)
      }
      return { applied: true, id, record }
    },

    notification: id => notifications.get(id),

    ballState: () => ball,

    setBallState(patch) {
      const next: BallState = { ...ball }
      if (patch.progress !== undefined) next.progress = patch.progress === null ? null : clamp01(patch.progress)
      if (patch.label !== undefined) {
        next.label = patch.label === null ? null : patch.label.slice(0, SHELL_LIMITS.ballLabel)
      }
      if (patch.tone !== undefined && BALL_TONES.includes(patch.tone)) next.tone = patch.tone
      ball = next
      return next
    },

    setExitPolicy(plugin, policy) {
      const patch: Partial<ShellExitPolicy> = {}
      for (const key of ['close', 'quit'] as const) {
        const value = policy[key]
        if (value === undefined) continue
        if (!EXIT_DECISIONS.includes(value)) {
          return refuse('limit-reached', `退出策略 ${key} 不合法：${String(value)}`)
        }
        patch[key] = value
      }
      if (patch.close === undefined && patch.quit === undefined) {
        return refuse('limit-reached', '退出策略声明为空')
      }
      // Re-insert so the newest declaration of a returning plugin wins the fold.
      exitPolicies.delete(plugin)
      exitPolicies.set(plugin, patch)
      return APPLIED
    },

    exitPolicy: () => foldExitPolicy(),

    removeExitPolicyOwner(plugin) {
      exitPolicies.delete(plugin)
    },

    exitDecision: source => foldExitPolicy()[source === 'window' ? 'close' : 'quit'],

    holdExit(source) {
      if (heldExit !== undefined) return refuse('duplicate', '已有一个挂起的退出请求')
      heldExit = source
      return APPLIED
    },

    pendingExit: () => heldExit,

    resolveExit(action) {
      const source = heldExit
      heldExit = undefined
      return source === undefined ? undefined : { source, action }
    },

    expireExit(source) {
      if (heldExit !== source) return false
      heldExit = undefined
      return true
    },

    exclusivityHides(target) {
      // The operator window and the ball exclude each other, whatever path
      // made one of them visible.
      return target === 'main' ? [...AUX_SURFACE_IDS] : ['main']
    },
  }
}