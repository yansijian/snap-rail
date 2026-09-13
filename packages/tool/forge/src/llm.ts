/**
 * The OpenAI-compatible streaming chat client: one `fetch` per run against
 * `<baseUrl>/chat/completions` with `stream: true`, SSE parsed by a small
 * hand-written incremental decoder (no dependency — the wire shape is three
 * rules: events split on blank lines, `data:` lines join, `[DONE]` ends).
 * Any vendor speaking the OpenAI shape works: DeepSeek, GLM, OpenAI, or an
 * on-site gateway.
 *
 * @module @snap-rail/forge/llm
 */

import type { LlmConfig } from './contract.ts'

/** One conversation turn in the OpenAI message shape. */
export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Assistant turns only: the tool calls the model issued. */
  tool_calls?: LlmToolCall[]
  /** Tool turns only: which call this answers. */
  tool_call_id?: string
}

/** One tool call as the wire carries it (arguments is a JSON string). */
export interface LlmToolCall {
  id: string
  type: 'function'
  function: { name: string, arguments: string }
}

/** One tool definition in the OpenAI `tools` shape. */
export interface LlmToolDef {
  type: 'function'
  function: { name: string, description: string, parameters: unknown }
}

/** What the stream yields as it arrives. */
export type LlmStreamEvent =
  | { type: 'text', text: string }
  | { type: 'tool-call', index: number, id?: string, name?: string, args?: string }
  | { type: 'finish', reason: string }

/**
 * Incremental SSE decoding: feed decoded text chunks, receive complete
 * `data:` payloads. Handles CRLF, LF, multi-line data, and cross-chunk
 * splits; the `[DONE]` sentinel arrives as a normal payload the caller
 * matches on.
 */
export function createSseParser(onData: (data: string) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk: string): void => {
    buffer += chunk
    // Split on blank lines (LF or CRLF); keep the trailing partial in buffer.
    for (;;) {
      const lf = buffer.indexOf('\n\n')
      const crlf = buffer.indexOf('\r\n\r\n')
      const at = crlf !== -1 && (lf === -1 || crlf < lf) ? crlf : lf
      if (at === -1) break
      const rawEvent = buffer.slice(0, at)
      buffer = buffer.slice(at + (at === crlf ? 4 : 2))
      const data = rawEvent.split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data !== '') onData(data)
    }
  }
}

/** One streaming request. Yields events until the stream ends or aborts. */
export async function* streamChat(options: {
  config: LlmConfig
  messages: readonly LlmChatMessage[]
  tools?: readonly LlmToolDef[] | undefined
  signal?: AbortSignal | undefined
}): AsyncGenerator<LlmStreamEvent> {
  const { config, messages, tools, signal } = options
  const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      ...(tools !== undefined && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      stream: true,
    }),
    ...(signal !== undefined ? { signal } : {}),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`LLM 接口返回 ${response.status}：${body.slice(0, 500)}`)
  }
  if (response.body === null) throw new Error('LLM 接口未返回流式响应体')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events: LlmStreamEvent[] = []
  let done = false
  const feed = createSseParser(data => {
    if (data === '[DONE]') {
      done = true
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return // keep-alive comments and unknown events pass through
    }
    const choice = (parsed as { choices?: Array<Record<string, unknown>> }).choices?.[0]
    if (choice === undefined) return
    const delta = choice.delta as { content?: unknown, tool_calls?: Array<Record<string, unknown>> } | undefined
    if (delta?.content !== undefined && delta.content !== null && delta.content !== '') {
      events.push({ type: 'text', text: String(delta.content) })
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const call of delta.tool_calls) {
        const fn = (call as { function?: { name?: unknown, arguments?: unknown } | null }).function
        events.push({
          type: 'tool-call',
          index: Number(call.index ?? 0),
          ...(call.id !== undefined ? { id: String(call.id) } : {}),
          ...(fn !== undefined && fn !== null
            ? {
                ...(fn.name !== undefined ? { name: String(fn.name) } : {}),
                ...(fn.arguments !== undefined ? { args: String(fn.arguments) } : {}),
              }
            : {}),
        })
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      events.push({ type: 'finish', reason: String(choice.finish_reason) })
    }
  })

  try {
    for (;;) {
      const { value, done: finished } = await reader.read()
      if (finished) break
      const decoded = decoder.decode(value, { stream: true })
      feed(decoded)
      // Yield what this chunk produced, then clear — a generator cannot
      // yield from inside the parser callback.
      while (events.length > 0) yield events.shift() as LlmStreamEvent
      if (done) break
    }
  } finally {
    reader.releaseLock()
  }
  const tail = decoder.decode()
  if (tail !== '') feed(tail)
  while (events.length > 0) yield events.shift() as LlmStreamEvent
}
