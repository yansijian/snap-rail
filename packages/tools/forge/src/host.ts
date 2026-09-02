/**
 * The forge host face: claims the `forge` wire domain, wires the registry,
 * runner, dispatcher, tools, and agent loop over the store-backed tables,
 * remounts enabled generated plugins at boot (renderer halves re-pull via
 * `forge.gen-faces`), and serves the admin/session RPC methods the
 * workbench calls. Every mutation paths through the same `activate`
 * primitive the agent's `rail_run` uses — one activation semantics for the
 * model and the operator alike.
 *
 * @module @snap-rail/forge/host
 */

import { writeFile } from 'node:fs/promises'
import { Context, type Plugin } from '@snap-rail/cordis'
import type { AuditService } from '@snap-rail/audit'
import { RpcBusinessError } from '@snap-rail/protocol'
import type { GatewayService } from '@snap-rail/gateway'
import type { SettingsService } from '@snap-rail/settings'
import { z } from 'zod'
import {
  FORGE_LLM_KEY,
  forgeRequestSchemas,
  genMountedSchema,
  genUnmountedSchema,
  llmConfigSchema,
  sessionDeltaSchema,
} from './contract.ts'
import { createActivator } from './activate.ts'
import { createDispatch } from './dispatch.ts'
import { buildExportZip } from './export.ts'
import { createLoop } from './loop.ts'
import { createRegistry } from './registry.ts'
import { createRunner } from './runner.ts'
import { createTools } from './tools.ts'
import { FORGE_SCHEMA } from './tables.ts'

/** The `forge/plugins-changed` frame carries no payload (a reload nudge). */
const pluginsChangedSchema = z.object({}).strict()

/** The forge host plugin; mount after rpc, settings, store, and audit. */
const forgePlugin: Plugin.Object<void> = {
  name: 'forge',
  inject: ['rpc', 'settings', 'store', 'audit'],
  apply(ctx: Context): void {
    const rpc: GatewayService = ctx.rpc
    const settings: SettingsService = ctx.settings
    const audit: AuditService = ctx.audit

    rpc.claimDomain(ctx, 'forge')
    rpc.frame(ctx, 'forge/session-delta', { payload: sessionDeltaSchema })
    rpc.frame(ctx, 'forge/plugins-changed', { payload: pluginsChangedSchema })
    rpc.frame(ctx, 'forge/gen-mounted', { payload: genMountedSchema })
    rpc.frame(ctx, 'forge/gen-unmounted', { payload: genUnmountedSchema })

    const db = ctx.store.register(ctx, 'forge', FORGE_SCHEMA)
    const registry = createRegistry(db)
    const runner = createRunner(ctx, registry)
    const dispatch = createDispatch(ctx, registry)
    const { activate, deactivate } = createActivator(registry, runner, dispatch)

    const tools = createTools({ ctx, registry, runner, dispatch, activate })
    const readConfig = () => {
      const parsed = llmConfigSchema.safeParse(settings.get(FORGE_LLM_KEY))
      return parsed.success ? parsed.data : null
    }
    const loop = createLoop({ ctx, registry, dispatch, tools, readConfig })

    // ---- boot: remount what the registry says is enabled ----
    for (const entry of registry.remountList()) {
      if (entry.hostSrc !== null) void runner.mountHost(entry.id, entry.currentVersionId, entry.hostSrc)
    }

    // ---- sessions ----
    rpc.method(ctx, 'forge.session.list', { request: forgeRequestSchemas['forge.session.list'] }, () => ({
      sessions: registry.listSessions(),
    }))

    rpc.method(ctx, 'forge.session.messages', { request: forgeRequestSchemas['forge.session.messages'] },
      ({ sessionId }) => {
        if (!registry.sessionExists(sessionId)) {
          throw new RpcBusinessError({ code: 'not-found', details: { what: `会话 ${sessionId} 不存在` } })
        }
        return { messages: registry.listMessages(sessionId) }
      })

    rpc.method(ctx, 'forge.session.send', { request: forgeRequestSchemas['forge.session.send'] },
      ({ sessionId, text, focusPluginId }) => {
        const running = loop.runningSessionId()
        if (running !== null) {
          throw new RpcBusinessError({ code: 'conflict', details: { what: `会话 ${running} 的 Agent 正在运行，请先停止` } })
        }
        const id = sessionId === undefined
          ? registry.createSession(text.slice(0, 40)).id
          : sessionId
        if (!registry.sessionExists(id)) {
          throw new RpcBusinessError({ code: 'not-found', details: { what: `会话 ${id} 不存在` } })
        }
        let focusNote: string | undefined
        if (focusPluginId !== undefined) {
          const record = registry.readPlugin(focusPluginId)
          focusNote = record === undefined
            ? `[关注的插件] ${focusPluginId}（已不存在，可能被删除）`
            : `[关注的插件] ${record.info.id}「${record.info.title}」：${record.info.description}；当前版本 ${record.info.currentVersionId ?? '无'}；状态 ${record.info.status}${record.info.diagnostics !== null ? `；最近诊断：${record.info.diagnostics}` : ''}。用户想针对它提需求。`
        }
        registry.appendMessage(id, 'user', text)
        // The loop owns its own failure surface (state frames + log rows);
        // the send call settles as soon as the turn is accepted.
        void loop.run({ sessionId: id, ...(focusNote !== undefined ? { focusNote } : {}) }).catch(cause => {
          ctx.logger('forge').error?.(cause)
        })
        return { sessionId: id, started: true as const }
      })

    rpc.method(ctx, 'forge.session.stop', { request: forgeRequestSchemas['forge.session.stop'] }, () => ({
      stopped: loop.stop(),
    }))

    rpc.method(ctx, 'forge.session.remove', { request: forgeRequestSchemas['forge.session.remove'] },
      ({ sessionId }) => {
        if (loop.runningSessionId() === sessionId) {
          throw new RpcBusinessError({ code: 'conflict', details: { what: `会话 ${sessionId} 的 Agent 正在运行，请先停止` } })
        }
        if (!registry.removeSession(sessionId)) {
          throw new RpcBusinessError({ code: 'not-found', details: { what: `会话 ${sessionId} 不存在` } })
        }
        audit.record({ actor: 'client', action: 'forge.session.remove', subject: sessionId })
        return { removed: true as const }
      })

    // ---- generated plugins ----
    rpc.method(ctx, 'forge.plugin.list', { request: forgeRequestSchemas['forge.plugin.list'] }, () => ({
      plugins: registry.listPlugins(),
    }))

    rpc.method(ctx, 'forge.plugin.read', { request: forgeRequestSchemas['forge.plugin.read'] },
      ({ id, versionId }) => {
        const record = registry.readPlugin(id)
        if (record === undefined) {
          throw new RpcBusinessError({ code: 'not-found', details: { what: `插件 ${id} 不存在` } })
        }
        const target = versionId ?? record.info.currentVersionId ?? record.versions[0]?.versionId
        if (target === undefined) {
          throw new RpcBusinessError({ code: 'bad-request', details: { issues: [`插件 ${id} 没有任何版本`] } })
        }
        const version = registry.readVersion(id, target)
        if (version === undefined) {
          throw new RpcBusinessError({ code: 'bad-request', details: { issues: [`版本 ${target} 不存在`] } })
        }
        return {
          info: record.info,
          versions: record.versions,
          version: {
            versionId: version.versionId,
            summary: version.summary,
            hostSrc: version.hostSrc,
            clientSrc: version.clientSrc,
          },
        }
      })

    rpc.method(ctx, 'forge.plugin.set-enabled', { request: forgeRequestSchemas['forge.plugin.set-enabled'] },
      async ({ id, enabled }) => {
        const record = registry.readPlugin(id)
        if (record === undefined) {
          throw new RpcBusinessError({ code: 'not-found', details: { what: `插件 ${id} 不存在` } })
        }
        if (enabled) {
          const target = record.info.currentVersionId ?? record.versions[0]?.versionId
          if (target === undefined) {
            throw new RpcBusinessError({ code: 'bad-request', details: { issues: [`插件 ${id} 没有可激活的版本`] } })
          }
          const result = await activate(id, target)
          if (!result.ok) {
            throw new RpcBusinessError({ code: 'bad-request', details: { issues: [result.diagnostics ?? '挂载失败'] } })
          }
        } else {
          await deactivate(id)
        }
        audit.record({
          actor: 'client',
          action: enabled ? 'forge.plugin.enable' : 'forge.plugin.disable',
          subject: id,
        })
        return { applied: true as const }
      })

    rpc.method(ctx, 'forge.plugin.set-version', { request: forgeRequestSchemas['forge.plugin.set-version'] },
      async ({ id, versionId }) => {
        if (registry.readPlugin(id) === undefined) {
          throw new RpcBusinessError({ code: 'not-found', details: { what: `插件 ${id} 不存在` } })
        }
        const result = await activate(id, versionId)
        if (!result.ok) {
          throw new RpcBusinessError({ code: 'bad-request', details: { issues: [result.diagnostics ?? '挂载失败'] } })
        }
        audit.record({
          actor: 'client',
          action: 'forge.plugin.set-version',
          subject: id,
          detail: { versionId },
        })
        return { applied: true as const }
      })

    rpc.method(ctx, 'forge.plugin.remove', { request: forgeRequestSchemas['forge.plugin.remove'] },
      async ({ id }) => {
        if (registry.readPlugin(id) === undefined) {
          throw new RpcBusinessError({ code: 'not-found', details: { what: `插件 ${id} 不存在` } })
        }
        await deactivate(id)
        registry.remove(id)
        audit.record({ actor: 'client', action: 'forge.plugin.remove', subject: id })
        dispatch.notifyPluginsChanged()
        return { removed: true as const }
      })

    rpc.method(ctx, 'forge.plugin.export', { request: forgeRequestSchemas['forge.plugin.export'] },
      async ({ id, versionId, path }) => {
        const record = registry.readPlugin(id)
        if (record === undefined) {
          throw new RpcBusinessError({ code: 'not-found', details: { what: `插件 ${id} 不存在` } })
        }
        const target = versionId ?? record.info.currentVersionId ?? record.versions[0]?.versionId
        if (target === undefined) {
          throw new RpcBusinessError({ code: 'bad-request', details: { issues: [`插件 ${id} 没有任何版本`] } })
        }
        const version = registry.readVersion(id, target)
        if (version === undefined) {
          throw new RpcBusinessError({ code: 'bad-request', details: { issues: [`版本 ${target} 不存在`] } })
        }
        let zipped: Uint8Array
        try {
          zipped = buildExportZip({ version, title: record.info.title, description: record.info.description })
        } catch (cause) {
          throw new RpcBusinessError({ code: 'bad-request', details: { issues: [cause instanceof Error ? cause.message : String(cause)] } })
        }
        await writeFile(path, zipped)
        audit.record({ actor: 'client', action: 'forge.plugin.export', subject: id, detail: { versionId: target, path } })
        return { path }
      })

    // ---- renderer runner channel ----
    rpc.method(ctx, 'forge.client-report', { request: forgeRequestSchemas['forge.client-report'] },
      report => {
        dispatch.handleReport(report)
        return { received: true as const }
      })

    rpc.method(ctx, 'forge.gen-faces', { request: forgeRequestSchemas['forge.gen-faces'] }, () => ({
      faces: dispatch.faces(),
    }))

    // ---- unload: take every generated host half down with us ----
    ctx.effect(() => () => {
      for (const id of runner.mountedIds()) void runner.unmountHost(id)
    })
  },
}

export default forgePlugin
