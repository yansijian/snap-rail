import { describe, expect, it } from 'vitest'
import { RpcBusinessError } from '@snap-rail/protocol'
import type { UpdateStatus } from '@snap-rail/app-boot/contract'
import { createUpdateChannel, type AutoUpdaterLike } from '../src-host/main/update-machine.ts'

/** A recording electron-updater stand-in: events are emitted by hand. */
function fakeUpdater(): AutoUpdaterLike & {
  emit(event: string, ...args: unknown[]): void
  feeds: Array<{ provider: string, url: string }>
  installs: Array<[boolean | undefined, boolean | undefined]>
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    feeds: [] as Array<{ provider: string, url: string }>,
    installs: [] as Array<[boolean | undefined, boolean | undefined]>,
    on(event: string, listener: (...args: never[]) => void): unknown {
      const list = listeners.get(event) ?? []
      list.push(listener as (...args: unknown[]) => void)
      listeners.set(event, list)
      return updater
    },
    emit(event: string, ...args: unknown[]): void {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    setFeedURL(feed: { provider: 'generic', url: string }): void {
      updater.feeds.push(feed)
    },
    async checkForUpdates(): Promise<unknown> {
      return null
    },
    async downloadUpdate(): Promise<unknown> {
      return []
    },
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
      updater.installs.push([isSilent, isForceRunAfter])
    },
  }
  return updater
}

function makeChannel(parts: {
  updater: AutoUpdaterLike | null
  hasPackagedFeed?: boolean
  feedUrl?: string
  autoCheck?: boolean
  statuses?: UpdateStatus[]
}): ReturnType<typeof createUpdateChannel> {
  return createUpdateChannel({
    currentVersion: '1.0.0',
    load: async () => parts.updater,
    hasPackagedFeed: parts.hasPackagedFeed ?? false,
    resolveFeedUrl: () => parts.feedUrl,
    autoCheck: parts.autoCheck ?? false,
    broadcast: status => parts.statuses?.push(status),
  })
}

/** Assert a call rejects with an `unavailable` business error. */
async function expectUnavailable(run: () => Promise<unknown> | unknown): Promise<void> {
  await run().catch((cause: unknown) => {
    expect(cause).toBeInstanceOf(RpcBusinessError)
    expect((cause as RpcBusinessError).error.code).toBe('unavailable')
    return undefined
  })
}

describe('update channel', () => {
  it('stays unsupported without an updater (dev) and refuses to act', async () => {
    const channel = makeChannel({ updater: null })
    const initial = await channel.ready()
    expect(initial.phase).toBe('unsupported')
    expect(initial.currentVersion).toBe('1.0.0')

    await expectUnavailable(() => channel.check())
    await expectUnavailable(() => channel.download())
    expect(() => channel.install()).toThrow(RpcBusinessError)
  })

  it('reports unconfigured when neither feed seat is set', async () => {
    const statuses: UpdateStatus[] = []
    const channel = makeChannel({ updater: fakeUpdater(), statuses })
    const initial = await channel.ready()
    expect(initial.phase).toBe('unconfigured')
    await expectUnavailable(() => channel.check())
    // Every transition was broadcast as a full snapshot.
    expect(statuses.at(-1)).toEqual(initial)
  })

  it('rides the updater events through available → downloading → ready', async () => {
    const updater = fakeUpdater()
    const statuses: UpdateStatus[] = []
    const channel = makeChannel({ updater, hasPackagedFeed: true, statuses })
    const initial = await channel.ready()
    expect(initial.phase).toBe('idle')

    updater.emit('checking-for-update')
    expect(channel.status().phase).toBe('checking')

    updater.emit('update-available', { version: '1.1.0' })
    expect(channel.status().phase).toBe('available')
    expect(channel.status().version).toBe('1.1.0')

    updater.emit('download-progress', { percent: 42.5 })
    expect(channel.status().phase).toBe('downloading')
    expect(channel.status().percent).toBeCloseTo(42.5)
    // The incoming version rides the progress snapshots.
    expect(channel.status().version).toBe('1.1.0')

    updater.emit('update-downloaded', { version: '1.1.0' })
    expect(channel.status()).toEqual({ phase: 'ready', currentVersion: '1.0.0', version: '1.1.0' })

    channel.install()
    expect(updater.installs).toEqual([[false, true]])
    // The broadcast trail is full snapshots only.
    expect(statuses.every(status => status.currentVersion === '1.0.0')).toBe(true)
  })

  it('clears the incoming version when the check says none', async () => {
    const updater = fakeUpdater()
    const channel = makeChannel({ updater, hasPackagedFeed: true })
    await channel.ready()

    updater.emit('update-available', { version: '2.0.0' })
    updater.emit('update-not-available', {})
    expect(channel.status()).toEqual({ phase: 'none', currentVersion: '1.0.0' })
    // With nothing incoming, installing would be premature.
    expect(() => channel.install()).toThrow(RpcBusinessError)
    await expectUnavailable(() => channel.download())
  })

  it('applies the settings feed seat on every check and reports errors', async () => {
    const updater = fakeUpdater()
    const channel = makeChannel({ updater, feedUrl: 'https://feed.example.com/terminal/' })
    await channel.ready()

    await channel.check()
    expect(updater.feeds).toEqual([{ provider: 'generic', url: 'https://feed.example.com/terminal/' }])
    // The fake resolves without events, so the snapshot stays at checking.
    expect(channel.status().phase).toBe('checking')
  })

  it('lands a failed check in error with the updater message', async () => {
    const updater = fakeUpdater()
    updater.checkForUpdates = () => Promise.reject(new Error('ENOTFOUND feed.example.com'))
    const channel = makeChannel({ updater, hasPackagedFeed: true })
    await channel.ready()

    const status = await channel.check()
    expect(status.phase).toBe('error')
    expect(status.message).toContain('ENOTFOUND')
  })
})
