/**
 * The agent loop: one user turn becomes a bounded sequence of model steps —
 * stream a completion, broadcast text deltas as `forge/session-delta` frames,
 * execute the model's `rail_*` tool calls, append their results, and repeat
 * until the model answers without tools or the step budget runs out. The
 * conversation log in the registry is the replay source (every turn lands
 * there), so a restart resumes mid-history cleanly.
 *
 * Renderer-half outcomes steer the loop: while a run is active, the
 * dispatcher hands `forge.client-report` diagnostics about plugins this run
 * activated back as an injected user note — persisted for replay and pushed
 * into the live message array — closing the renderer leg of the repair loop
 * without the model polling.
 *
 * @module @snap-rail/forge/loop
 */

import type { Context } from '@snap-rail/cordis'
import type { GatewayService } from '@snap-rail/gateway'
import type { ClientDispatch } from './dispatch.ts'
import { streamChat, type LlmChatMessage, type LlmToolCall } from './llm.ts'
import { SYSTEM_PROMPT } from './prompt.ts'
import type { ForgeRegistry } from './registry.ts'
import type { ForgeTools } from './tools.ts'
import type { LlmConfig, SessionMessage } from './contract.ts'

/** How many model steps one run may take (tool rounds included). */
const MAX_STEPS = 24

/** What the loop needs from its host. */
export interface LoopDeps {
  ctx: Context
  registry: ForgeRegistry
  dispatch: ClientDispatch
  tools: ForgeTools
  /** Read the validated LLM config; `null` when unset or malformed. */
  readConfig(): LlmConfig | null
  /** The streaming call (injectable for tests; defaults to streamChat). */
  stream?: typeof streamChat
}

/** One in-flight run's bookkeeping. */
interface RunState {
  sessionId: string
  abort: AbortController
  /** Plugin ids this run has rail_run — steering only consumes those. */
  touched: Set<string>
  /** Steering notes waiting to join the live message array. */
  pending: string[]
}

/** The loop's public face. */
export interface AgentLoop {
  /** Run one turn to completion (idle/error). The user row must already be
   * appended; the focus note rides only the wire copy of that row. */
  run(options: { sessionId: string, focusNote?: string | undefined }): Promise<void>
  /** Abort the running turn; whether one was running. */
  stop(): boolean
  /** The running session id, if any. */
  runningSessionId(): string | null
}

/** Construct the loop. */
export function createLoop(deps: LoopDeps): AgentLoop {
  const { ctx, registry, dispatch, tools, readConfig } = deps
  const stream = deps.stream ?? streamChat
  const rpc: GatewayService = ctx.rpc
  let runState: RunState | null = null

  const delta = (payload: Record<string, unknown>): void => {
    rpc.broadcast('forge/session-delta', payload)
  }

  const state = (sessionId: string, run: 'running' | 'idle' | 'error', message?: string): void => {
    delta({ kind: 'state', sessionId, state: run, ...(message !== undefined ? { message } : {}) })
  }

  /** Rebuild the LLM message array from the persisted log. */
  const replay = (rows: readonly SessionMessage[]): LlmChatMessage[] => {
    const messages: LlmChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }]
    for (const row of rows) {
      if (row.role === 'user') {
        messages.push({ role: 'user', content: row.text })
      } else if (row.role === 'assistant') {
        const meta = row.meta as { toolCalls?: Array<{ id: string, name: string, arguments: string }> } | undefined
        const toolCalls = meta?.toolCalls
        messages.push({
          role: 'assistant',
          content: row.text,
          ...(Array.isArray(toolCalls) && toolCalls.length > 0
            ? { tool_calls: toolCalls.map(call => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.arguments } })) }
            : {}),
        })
      } else {
        const meta = row.meta as { toolCallId?: string } | undefined
        messages.push({
          role: 'tool',
          content: row.text,
          tool_call_id: meta?.toolCallId ?? 'orphan',
        })
      }
    }
    return messages
  }

  /** Append an assistant turn and its persistence meta. */
  const persistAssistant = (sessionId: string, text: string, toolCalls: readonly LlmToolCall[]): void => {
    registry.appendMessage(sessionId, 'assistant', text, toolCalls.length > 0
      ? { toolCalls: toolCalls.map(call => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })) }
      : undefined)
  }

  /** OpenAI rejects a dangling tool_calls turn; close it after an abort. */
  const closeDanglingToolCalls = (sessionId: string, last: LlmChatMessage | undefined): void => {
    if (last?.role !== 'assistant' || last.tool_calls === undefined) return
    for (const call of last.tool_calls) {
      registry.appendMessage(sessionId, 'tool', '[已中断]', { toolCallId: call.id })
    }
  }

  return {
    async run(options: { sessionId: string, focusNote?: string | undefined }): Promise<void> {
      if (runState !== null) throw new Error(`会话 ${runState.sessionId} 的 Agent 正在运行，请先停止或等待完成`)
      const history = registry.listMessages(options.sessionId)
      const lastUser = history.at(-1)
      if (lastUser === undefined || lastUser.role !== 'user') {
        throw new Error('run 要求最后一条是刚写入的用户消息')
      }
      const config = readConfig()
      if (config === null) {
        const hint = '尚未配置 LLM 接口：请先在 设置 → AI 创造 填写服务地址、密钥与模型。'
        registry.appendMessage(options.sessionId, 'assistant', hint)
        state(options.sessionId, 'error', hint)
        return
      }
      const abort = new AbortController()
      runState = { sessionId: options.sessionId, abort, touched: new Set(), pending: [] }
      dispatch.setSteering(report => {
        if (runState === null || !runState.touched.has(report.id)) return false
        const note = `[系统回报] 插件 ${report.id}（${report.versionId}）渲染半边${report.stage === 'load' ? '加载' : '渲染'}${report.ok ? '成功' : `失败：${report.message ?? ''}`}${report.ok ? '' : '。请读诊断修复：rail_read → rail_define(existing) → rail_run 切新版本'}`
        registry.appendMessage(runState.sessionId, 'user', note)
        runState.pending.push(note)
        return true
      })
      state(options.sessionId, 'running')

      let messages: LlmChatMessage[] | undefined
      try {
        messages = replay(history.slice(0, -1))
        messages.push({
          role: 'user',
          content: options.focusNote !== undefined ? `${options.focusNote}\n\n${lastUser.text}` : lastUser.text,
        })

        for (let step = 0; step < MAX_STEPS; step++) {
          const draft = { text: '', toolCalls: [] as LlmToolCall[] }
          for await (const event of stream({
            config,
            messages,
            tools: tools.defs(),
            signal: abort.signal,
          })) {
            if (event.type === 'text') {
              draft.text += event.text
              delta({ kind: 'text', sessionId: options.sessionId, text: event.text })
            } else if (event.type === 'tool-call') {
              const existing = draft.toolCalls[event.index]
              if (existing === undefined) {
                draft.toolCalls[event.index] = {
                  id: event.id ?? '',
                  type: 'function',
                  function: { name: event.name ?? '', arguments: event.args ?? '' },
                }
              } else {
                if (event.id !== undefined) existing.id = event.id
                if (event.name !== undefined) existing.function.name = event.name
                if (event.args !== undefined) existing.function.arguments += event.args
              }
            }
          }
          draft.toolCalls = draft.toolCalls.filter(call => call.id !== '' || call.function.name !== '')
          persistAssistant(options.sessionId, draft.text, draft.toolCalls)
          messages.push({
            role: 'assistant',
            content: draft.text,
            ...(draft.toolCalls.length > 0 ? { tool_calls: draft.toolCalls } : {}),
          })

          if (draft.toolCalls.length === 0) {
            // Renderer reports that land after the final answer stay on the
            // plugin card (board); the next turn's focus note picks them up.
            state(options.sessionId, 'idle')
            return
          }
          if (step === MAX_STEPS - 1) {
            const note = '[系统] 已达到本轮最大步数上限，先停在这里；请用户确认下一步。'
            registry.appendMessage(options.sessionId, 'user', note)
            messages.push({ role: 'user', content: note })
          }

          for (const call of draft.toolCalls) {
            delta({ kind: 'tool', sessionId: options.sessionId, tool: call.function.name, phase: 'start', input: call.function.arguments })
            let parsedInput: unknown
            try {
              parsedInput = JSON.parse(call.function.arguments)
            } catch {
              parsedInput = {}
            }
            const output = await tools.execute(call.function.name, parsedInput)
            if (call.function.name === 'rail_run' && output !== null && typeof output === 'object') {
              const record = output as { ok?: boolean, pluginId?: string }
              if (record.ok === true && typeof record.pluginId === 'string') runState.touched.add(record.pluginId)
            }
            const text = JSON.stringify(output)
            const ok = output !== null && typeof output === 'object' && (output as { ok?: boolean }).ok === true
            delta({ kind: 'tool', sessionId: options.sessionId, tool: call.function.name, phase: 'end', output, ok })
            registry.appendMessage(options.sessionId, 'tool', text, { toolCallId: call.id, toolName: call.function.name })
            messages.push({ role: 'tool', content: text, tool_call_id: call.id })
          }
          // Steering notes that arrived during the tool round join now.
          while (runState.pending.length > 0) {
            const note = runState.pending.shift() as string
            messages.push({ role: 'user', content: note })
          }
        }
        state(options.sessionId, 'idle')
      } catch (cause) {
        if (abort.signal.aborted) {
          closeDanglingToolCalls(options.sessionId, messages?.at(-1))
          state(options.sessionId, 'idle', '已停止')
          return
        }
        const message = cause instanceof Error ? cause.message : String(cause)
        registry.appendMessage(options.sessionId, 'assistant', `（运行出错：${message}）`)
        state(options.sessionId, 'error', message)
      } finally {
        dispatch.setSteering(null)
        runState = null
      }
    },

    stop(): boolean {
      if (runState === null) return false
      runState.abort.abort()
      return true
    },

    runningSessionId(): string | null {
      return runState?.sessionId ?? null
    },
  }
}
