/**
 * SSE decoding and the streaming chat client: the parser handles cross-chunk
 * splits, CRLF, multi-line data, and the [DONE] sentinel; streamChat (over a
 * stubbed fetch) turns a chunked OpenAI-shaped stream into text and
 * tool-call events, and surfaces non-2xx bodies as errors.
 *
 * @module snap-rail/forge/tests/llm.spec
 */

import { describe, expect, it, vi } from 'vitest'
import { createSseParser, streamChat } from '../src/llm.ts'
import type { LlmConfig } from '../src/contract.ts'

const CONFIG: LlmConfig = { baseUrl: 'https://gw.local/v1', apiKey: 'sk-test', model: 'test-chat' }

/** Feed a parser in arbitrary chunks; return the collected payloads. */
function parseChunks(chunks: readonly string[]): string[] {
  const payloads: string[] = []
  const feed = createSseParser(data => { payloads.push(data) })
  for (const chunk of chunks) feed(chunk)
  return payloads
}

describe('createSseParser', () => {
  it('splits events on blank lines and strips the data: prefix', () => {
    expect(parseChunks(['data: a\n\ndata: b\n\n'])).toEqual(['a', 'b'])
  })

  it('survives splits inside an event', () => {
    expect(parseChunks(['data: {"x"', ':1}\n', '\ndata: [DONE]\n\n'])).toEqual(['{"x":1}', '[DONE]'])
  })

  it('handles CRLF separators and multi-line data', () => {
    expect(parseChunks(['data: one\r\ndata: two\r\n\r\n'])).toEqual(['one\ntwo'])
  })

  it('ignores comments and non-data lines', () => {
    expect(parseChunks([': keep-alive\nevent: x\ndata: ok\n\n'])).toEqual(['ok'])
  })
})

describe('streamChat', () => {
  it('emits text and finish events from a chunked stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      chunk({ delta: { content: '你' }, finish_reason: null }),
      chunk({ delta: { content: '好' }, finish_reason: null }),
      chunk({ delta: {}, finish_reason: 'stop' }),
    ])))
    const events = []
    for await (const event of streamChat({ config: CONFIG, messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(event)
    }
    expect(events).toEqual([
      { type: 'text', text: '你' },
      { type: 'text', text: '好' },
      { type: 'finish', reason: 'stop' },
    ])
    vi.unstubAllGlobals()
  })

  it('emits incremental tool-call fragments', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      chunk({ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'rail_define', arguments: '{"a"' } }] }, finish_reason: null }),
      chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: null }),
      chunk({ delta: {}, finish_reason: 'tool_calls' }),
    ])))
    const events = []
    for await (const event of streamChat({ config: CONFIG, messages: [{ role: 'user', content: 'go' }] })) {
      events.push(event)
    }
    expect(events).toEqual([
      { type: 'tool-call', index: 0, id: 'call_1', name: 'rail_define', args: '{"a"' },
      { type: 'tool-call', index: 0, args: ':1}' },
      { type: 'finish', reason: 'tool_calls' },
    ])
    vi.unstubAllGlobals()
  })

  it('fails with the status and body on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"bad key"}', { status: 401 })))
    await expect(async () => {
      for await (const _ of streamChat({ config: CONFIG, messages: [{ role: 'user', content: 'x' }] })) { /* drain */ }
    }).rejects.toThrow('401')
    vi.unstubAllGlobals()
  })
})

/** One OpenAI-shaped SSE event line pair as a decoded chunk. */
function chunk(choice: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [choice] })}\n\n`
}

/** A streamed Response whose body delivers the chunks one reader pull at a time. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  let index = 0
  return new Response(
    new ReadableStream({
      pull(controller): void {
        if (index >= chunks.length) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(chunks[index]))
        index += 1
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}
