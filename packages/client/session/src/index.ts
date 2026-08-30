/**
 * The operator session seam: `ctx.session` mirrors the host-side session
 * (persisted to settings, so a restart keeps the operator signed on) and
 * re-emits `session/changed` on every transition — its own writes and any
 * host-side change that rides the `settings/changed` frame. The login page
 * writes it; every workflow consumer reads it for gating and audit
 * attribution.
 *
 * @module @snap-rail/client-session
 */

// Wire rows for the station-domain methods this resident calls.
import '@snap-rail/station-rpc/contract'
import { Context, type Plugin } from '@snap-rail/cordis'
import { subscribeFrame, type HostLink } from '@snap-rail/connection'
import { SESSION_OPERATOR_KEY, settingsChangedSchema } from '@snap-rail/station-rpc/contract'

/** The slice of `ctx.client` this service needs; typed locally so the
 * session package never references the runtime project (a reference cycle:
 * the runtime mounts this plugin). */
interface ClientLink {
  link: HostLink
}

declare module '@snap-rail/cordis' {
  interface Context {
    session: SessionService
  }

  interface Events {
    /** The signed-on operator changed (login, logout, or boot restore).
     * @param operator - the new operator id, or `null` when signed off.
     */
    'session/changed'(operator: string | null): void
  }
}

/** Operator session exposed on `ctx.session`. */
export interface SessionService {
  /** The signed-on operator id, or `null` while the login page shows. */
  current(): string | null
  /** Sign an operator on; trims the id and rejects empty input. */
  login(operator: string): Promise<void>
  /** Sign the current operator off (back to the login page). */
  logout(): Promise<void>
}

/** Mounts the `ctx.session` mirror; state lives in the apply closure. */
const sessionPlugin: Plugin.Object<void> = {
  name: 'client-session',
  inject: ['client'],
  apply(ctx: Context): void {
    const { link } = (ctx as Context & { client: ClientLink }).client
    let operator: string | null = null
    const sync = (next: string | null): void => {
      operator = next
      ctx.emit('session/changed', operator)
    }

    // Restore the persisted operator; a failed probe leaves the login page up.
    void link.call('session.current', {}).then(result => {
      if (result.ok) sync(result.value.operator)
    })

    // Hot-follow host-side session changes (another surface signed in or
    // out — the titlebar's 换人, or the host restarting with a different
    // persisted operator): re-pull the truth and re-emit on any drift.
    ctx.effect(() => subscribeFrame(link, 'settings/changed', settingsChangedSchema, change => {
      if (change.key !== SESSION_OPERATOR_KEY) return
      void link.call('session.current', {})
        .then(result => {
          if (result.ok && result.value.operator !== operator) sync(result.value.operator)
        })
        .catch(() => {})
    }))

    ctx.provide('session', {
      current: (): string | null => operator,
      async login(raw: string): Promise<void> {
        const trimmed = raw.trim()
        if (trimmed === '') throw new Error('工号不能为空')
        const result = await link.call('session.login', { operator: trimmed })
        if (!result.ok) throw new Error(`登录失败（${result.error.code}）`)
        sync(trimmed)
      },
      async logout(): Promise<void> {
        const result = await link.call('session.logout', {})
        if (!result.ok) throw new Error(`退出失败（${result.error.code}）`)
        sync(null)
      },
    })
  },
}

export default sessionPlugin
