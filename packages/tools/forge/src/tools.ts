/**
 * The model's tool set — the forge adaptation of deepseek-harness's
 * cordis_* tools, trimmed to what this closed world needs: an on-demand
 * capability catalog (the skill/api-catalog roles merged), source+diagnostic
 * reads, immutable version defines with pre-flight, activation, and stop.
 * There is deliberately no filesystem/shell/web tool: writing, mounting,
 * and validating are what define/run are.
 *
 * Every execute result is JSON the model reads verbatim; failures carry the
 * pre-flight or mount diagnostics so the repair loop can act on them.
 *
 * @module @snap-rail/forge/tools
 */

import { z } from 'zod'
import type { Context } from '@snap-rail/cordis'
import type { AuditService } from '@snap-rail/audit'
import type { GatewayService } from '@snap-rail/gateway'
import type { LlmToolDef } from './llm.ts'
import { CATALOG_CAPABILITIES, CATALOG_TEMPLATES, CATALOG_TROUBLESHOOTING } from './catalog.ts'
import type { ClientDispatch } from './dispatch.ts'
import type { ForgeRegistry } from './registry.ts'
import type { HostRunner } from './runner.ts'

/** What the tools operate over (all host-side singletons). */
export interface ToolDeps {
  ctx: Context
  registry: ForgeRegistry
  runner: HostRunner
  dispatch: ClientDispatch
  /** Activate one version (pointer + enable + both halves) — the same path
   * the user-facing admin RPCs take; returns mount diagnostics on failure. */
  activate(id: string, versionId: string): Promise<{ ok: boolean, diagnostics?: string }>
}

/** The catalog sections `rail_inspect` serves. */
const INSPECT_CATALOGS = ['rpc', 'capabilities', 'templates', 'troubleshooting', 'plugins'] as const

const pluginIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,38}$/, 'plugin ids are 2-39 char lowercase kebab strings')

const inspectArgs = z.object({
  catalog: z.enum(INSPECT_CATALOGS).describe('要查询的目录：rpc=当前活着的 RPC 方法与帧；capabilities=require 白名单/注册缝签名/UI 原语/主题/持久化规则；templates=可运行代码模板；troubleshooting=故障对照表；plugins=已生成插件清单'),
}).strict()

const readArgs = z.object({
  pluginId: pluginIdSchema,
  versionId: z.string().regex(/^v\d+$/).optional().describe('缺省读当前激活版本'),
}).strict()

const defineArgs = z.object({
  kind: z.enum(['new', 'existing']).describe('new=创建插件；existing=向已有插件追加新版本'),
  id: pluginIdSchema,
  title: z.string().min(1).max(60).describe('给用户看的插件名（中文）'),
  description: z.string().max(400).nullish(),
  summary: z.string().min(1).max(300).describe('这个版本做了什么（一句话）'),
  hostSrc: z.string().max(200_000).nullish().describe('宿主半边：纯 JS 函数体，return 插件对象'),
  clientSrc: z.string().max(200_000).nullish().describe('渲染半边：纯 JS 函数体，return 插件对象'),
}).strict()

const runArgs = z.object({
  pluginId: pluginIdSchema,
  versionId: z.string().regex(/^v\d+$/).optional().describe('要激活的版本；缺省=最新（追加新版本后通常就是它）'),
}).strict()

const stopArgs = z.object({
  pluginId: pluginIdSchema,
}).strict()

/** One tool's declaration: schema, runner, and the loop-facing hooks. */
interface ToolSpec {
  args: z.ZodType
  description: string
  /** Execute; the resolved value is the model-facing JSON. */
  run(args: Record<string, unknown>): Promise<unknown>
}

/** Construct the tool set. */
export function createTools(deps: ToolDeps): ForgeTools {
  const { ctx, registry, runner, dispatch } = deps
  const rpc: GatewayService = ctx.rpc
  const audit: AuditService = ctx.audit

  const specs = new Map<string, ToolSpec>([
    ['rail_inspect', {
      args: inspectArgs,
      description: '查询能力目录。写码前先查：capabilities（缝签名/白名单/UI 原语/主题）、templates（代码模板）、rpc（当前活着的 RPC 域/方法/帧）、troubleshooting（故障对照）、plugins（已生成插件）。',
      async run(args) {
        const catalog = args.catalog as (typeof INSPECT_CATALOGS)[number]
        switch (catalog) {
          case 'rpc': return rpc.describe()
          case 'capabilities': return CATALOG_CAPABILITIES
          case 'templates': return CATALOG_TEMPLATES
          case 'troubleshooting': return CATALOG_TROUBLESHOOTING
          case 'plugins': return { plugins: registry.listPlugins() }
        }
      },
    }],
    ['rail_read', {
      args: readArgs,
      description: '读一个生成插件的源码、版本历史与运行诊断。修改既有插件前必读。',
      async run(args) {
        const id = args.pluginId as string
        const record = registry.readPlugin(id)
        if (record === undefined) return { ok: false, error: `插件 "${id}" 不存在。可用：${registry.listPlugins().map(p => p.id).join('、') || '（无）'}` }
        const versionId = (args.versionId as string | undefined) ?? record.info.currentVersionId
        if (versionId === null) return { ok: true, info: record.info, versions: record.versions, note: '该插件还没有激活过任何版本' }
        const version = registry.readVersion(id, versionId)
        if (version === undefined) return { ok: false, error: `版本 ${versionId} 不存在`, versions: record.versions }
        return {
          ok: true,
          info: record.info,
          versions: record.versions,
          version: {
            versionId: version.versionId,
            summary: version.summary,
            hostSrc: version.hostSrc,
            clientSrc: version.clientSrc,
          },
        }
      },
    }],
    ['rail_define', {
      args: defineArgs,
      description: '提交插件的一个不可变新版本（会做语法/require 白名单/形状预检，错误原文返回）。创建用 kind:"new"；修改既有插件用 kind:"existing" 并只改需要改的半边。',
      async run(args) {
        const hostSrc = typeof args.hostSrc === 'string' ? args.hostSrc : null
        const clientSrc = typeof args.clientSrc === 'string' ? args.clientSrc : null
        if (hostSrc === null && clientSrc === null) {
          return { ok: false, error: 'hostSrc 与 clientSrc 至少要给一个' }
        }        if (hostSrc !== null) {
          const failure = runner.preflight('host', hostSrc)
          if (failure !== null) return { ok: false, stage: 'preflight-host', error: failure }
        }
        if (clientSrc !== null) {
          const failure = runner.preflight('client', clientSrc)
          if (failure !== null) return { ok: false, stage: 'preflight-client', error: failure }
        }
        let defined: { pluginId: string, versionId: string }
        try {
          defined = registry.definePlugin({
            kind: args.kind as 'new' | 'existing',
            id: args.id as string,
            title: args.title as string,
            ...(args.description !== undefined ? { description: args.description as string } : {}),
            summary: args.summary as string,
            hostSrc,
            clientSrc,
          })
        } catch (cause) {
          return { ok: false, stage: 'registry', error: cause instanceof Error ? cause.message : String(cause) }
        }
        audit.record({
          actor: 'forge-agent',
          action: 'forge.plugin.define',
          subject: defined.pluginId,
          detail: { versionId: defined.versionId },
        })
        dispatch.notifyPluginsChanged()
        return { ok: true, ...defined, note: '已落库（未挂载）。用 rail_run 激活。' }
      },
    }],
    ['rail_run', {
      args: runArgs,
      description: '激活一个版本并立即双面挂载（缺省最新版本；指定旧版本即回滚）。宿主半边结果当场返回；渲染半边结果异步送达，不要在本轮等待。',
      async run(args) {
        const id = args.pluginId as string
        const record = registry.readPlugin(id)
        if (record === undefined) return { ok: false, error: `插件 "${id}" 不存在` }
        const requested = args.versionId as string | undefined
        const versionId = requested ?? record.versions[0]?.versionId
        if (versionId === undefined) return { ok: false, error: '该插件没有任何版本' }
        if (registry.readVersion(id, versionId) === undefined) {
          return { ok: false, error: `版本 ${versionId} 不存在`, versions: record.versions }
        }
        const hasClient = registry.readVersion(id, versionId)?.clientSrc !== null
        const result = await deps.activate(id, versionId)
        audit.record({
          actor: 'forge-agent',
          action: 'forge.plugin.run',
          subject: id,
          detail: { versionId },
        })
        dispatch.notifyPluginsChanged()
        if (!result.ok) return { ok: false, stage: 'mount-host', error: result.diagnostics ?? '宿主半边挂载失败' }
        return {
          ok: true,
          pluginId: id,
          versionId,
          host: 'mounted',
          ...(hasClient ? { client: '挂载指令已下发，结果将随后以系统消息送达' } : {}),
        }
      },
    }],
    ['rail_stop', {
      args: stopArgs,
      description: '停止一个插件：双面卸载、停用（boot 不再自动重挂）。版本历史保留，可随时 rail_run 重新激活。',
      async run(args) {
        const id = args.pluginId as string
        if (registry.readPlugin(id) === undefined) return { ok: false, error: `插件 "${id}" 不存在` }
        await runner.unmountHost(id)
        dispatch.unmountClient(id)
        registry.setEnabled(id, false)
        registry.setStatus(id, 'stopped', null)
        audit.record({ actor: 'forge-agent', action: 'forge.plugin.stop', subject: id })
        dispatch.notifyPluginsChanged()
        return { ok: true, pluginId: id, state: 'stopped' }
      },
    }],
  ])

  return {
    defs(): LlmToolDef[] {
      return [...specs.entries()].map(([name, spec]) => ({
        type: 'function' as const,
        function: {
          name,
          description: spec.description,
          parameters: z.toJSONSchema(spec.args as z.ZodType<Record<string, unknown>>),
        },
      }))
    },
    async execute(name: string, args: unknown): Promise<unknown> {
      const spec = specs.get(name)
      if (spec === undefined) return { ok: false, error: `未知工具 ${name}` }
      const parsed = (spec.args as z.ZodType<Record<string, unknown>>).safeParse(args)
      if (!parsed.success) {
        return { ok: false, stage: 'arguments', error: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；') }
      }
      try {
        return await spec.run(parsed.data)
      } catch (cause) {
        return { ok: false, stage: 'execute', error: cause instanceof Error ? cause.message : String(cause) }
      }
    },
  }
}

/** The tool set's public face. */
export interface ForgeTools {
  /** The OpenAI tool definitions for the request. */
  defs(): LlmToolDef[]
  /** Run one tool call; failures resolve (never reject) as model-facing JSON. */
  execute(name: string, args: unknown): Promise<unknown>
}
