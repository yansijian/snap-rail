/**
 * The app-update channel's state machine, lifted out of the Electron glue so
 * tests drive it with a fake updater: the channel owns the full
 * `update/status` snapshot (rebuilt on every transition, broadcast verbatim)
 * and maps electron-updater's callback events onto it. Feed resolution is
 * injected: the packaged build's publish config is the default seat, and the
 * `update.feedUrl` settings key overrides it per deployment (read live, so a
 * settings write takes effect on the next check).
 *
 * @module @snap-rail/desktop/main/update-machine
 */

import { RpcBusinessError } from '@snap-rail/protocol'
import type { UpdateStatus } from '@snap-rail/app-boot/contract'

/** The slice of electron-updater's autoUpdater this channel drives. */
export interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  setFeedURL(feed: { provider: 'generic', url: string }): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: string, listener: (...args: never[]) => void): unknown
}

/** An updater event's info payload, narrowed to what the snapshots carry. */
interface InfoLike {
  version?: unknown
}

/** A download-progress event's payload, narrowed to the percentage. */
interface ProgressLike {
  percent?: unknown
}

export interface UpdateChannelOptions {
  /** The running app's version — every snapshot carries it. */
  currentVersion: string
  /** Resolve the updater, or null when the channel cannot run (dev builds). */
  load(): Promise<AutoUpdaterLike | null>
  /** Whether the packaged build ships a publish config (app-update.yml). */
  hasPackagedFeed: boolean
  /** The per-deployment source override (`update.feedUrl`), read live. */
  resolveFeedUrl(): string | undefined
  /** Whether to check for updates right after the channel settles. */
  autoCheck: boolean
  /** Every state change lands here (the bridge turns this into the wire frame). */
  broadcast(status: UpdateStatus): void
}

/** The update channel the desktop bridge registers its methods against. */
export interface UpdateChannel {
  /** The current snapshot (`update.state`). */
  status(): UpdateStatus
  /** Check the configured source now; events drive the outcome. */
  check(): Promise<UpdateStatus>
  /** Download a found update (the automatic path already does). */
  download(): Promise<UpdateStatus>
  /** Quit and install a staged update; refuses unless one is staged. */
  install(): void
  /** Settles once the initial status is in (and the auto-check, if any, is underway). */
  ready(): Promise<UpdateStatus>
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

/**
 * Build the update channel. The initial status is `unsupported` until
 * `load()` settles: null keeps it (dev), otherwise the packaged-vs-settings
 * feed seats decide `idle` (with an immediate auto-check when enabled) or
 * `unconfigured`.
 */
export function createUpdateChannel(options: UpdateChannelOptions): UpdateChannel {
  const { currentVersion } = options

  let updater: AutoUpdaterLike | null = null
  let configured = false
  /** The incoming version once one is known; cleared when the check says none. */
  let incoming: string | undefined
  let state: UpdateStatus = {
    phase: 'unsupported',
    currentVersion,
    message: '开发模式下不可检查更新',
  }

  let resolveReady!: (status: UpdateStatus) => void
  const readyPromise = new Promise<UpdateStatus>(resolve => {
    resolveReady = resolve
  })

  /** Rebuild the full snapshot (stale optional fields never linger) and broadcast. */
  const setPhase = (
    phase: UpdateStatus['phase'],
    extra: { version?: string, percent?: number, message?: string } = {},
  ): void => {
    state = {
      phase,
      currentVersion,
      ...(extra.version !== undefined ? { version: extra.version } : {}),
      ...(extra.percent !== undefined ? { percent: extra.percent } : {}),
      ...(extra.message !== undefined ? { message: extra.message } : {}),
    }
    options.broadcast(state)
  }

  const errorPhase = (cause: unknown): void => {
    setPhase('error', {
      message: errorText(cause),
      ...(incoming !== undefined ? { version: incoming } : {}),
    })
  }

  const assertRunnable = (): AutoUpdaterLike => {
    if (updater === null) {
      throw new RpcBusinessError({ code: 'unavailable', details: { what: '开发模式下不可检查更新' } })
    }
    if (!configured) {
      throw new RpcBusinessError({ code: 'unavailable', details: { what: '未配置更新源：请先设置更新服务器地址' } })
    }
    return updater
  }

  const hook = (target: AutoUpdaterLike): void => {
    target.on('checking-for-update', () => {
      setPhase('checking')
    })
    target.on('update-available', (...args: never[]) => {
      const info = args[0] as InfoLike | undefined
      incoming = typeof info?.version === 'string' ? info.version : undefined
      setPhase('available', incoming !== undefined ? { version: incoming } : {})
    })
    target.on('update-not-available', () => {
      incoming = undefined
      setPhase('none')
    })
    target.on('download-progress', (...args: never[]) => {
      const progress = args[0] as ProgressLike | undefined
      const percent = typeof progress?.percent === 'number' ? progress.percent : 0
      setPhase('downloading', { percent, ...(incoming !== undefined ? { version: incoming } : {}) })
    })
    target.on('update-downloaded', (...args: never[]) => {
      const info = args[0] as InfoLike | undefined
      incoming = typeof info?.version === 'string' ? info.version : incoming
      setPhase('ready', incoming !== undefined ? { version: incoming } : {})
    })
    target.on('error', (cause: unknown) => {
      errorPhase(cause)
    })
  }

  const check = async (): Promise<UpdateStatus> => {
    const target = assertRunnable()
    // The settings seat wins per check, so a feed write takes effect without
    // a restart; without it the packaged publish config stands.
    const feedUrl = options.resolveFeedUrl()
    if (feedUrl !== undefined) target.setFeedURL({ provider: 'generic', url: feedUrl })
    setPhase('checking')
    try {
      await target.checkForUpdates()
    } catch (cause) {
      errorPhase(cause)
    }
    return state
  }

  const download = async (): Promise<UpdateStatus> => {
    const target = assertRunnable()
    if (state.phase === 'downloading' || state.phase === 'ready') return state
    if (incoming === undefined) {
      throw new RpcBusinessError({ code: 'unavailable', details: { what: '当前没有待下载的更新' } })
    }
    setPhase('downloading', { percent: 0, version: incoming })
    try {
      await target.downloadUpdate()
    } catch (cause) {
      errorPhase(cause)
    }
    return state
  }

  const install = (): void => {
    const target = assertRunnable()
    if (state.phase !== 'ready') {
      throw new RpcBusinessError({ code: 'unavailable', details: { what: '更新尚未下载完成' } })
    }
    // Assisted NSIS: the installer runs after this process exits and the app
    // starts again afterwards.
    target.quitAndInstall(false, true)
  }

  void (async () => {
    updater = await options.load()
    if (updater === null) {
      resolveReady(state)
      return
    }
    hook(updater)
    configured = options.hasPackagedFeed || options.resolveFeedUrl() !== undefined
    if (!configured) {
      setPhase('unconfigured', { message: '未配置更新源：请先在下方填写更新服务器地址' })
    } else {
      setPhase('idle')
      if (options.autoCheck) void check()
    }
    resolveReady(state)
  })()

  return {
    status: () => state,
    check,
    download,
    install,
    ready: () => readyPromise,
  }
}
