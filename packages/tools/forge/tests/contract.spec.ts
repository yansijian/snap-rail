/**
 * Wire-contract gates: the forge domain's request schemas reject malformed
 * payloads at the trust boundary (ids are kebab, texts bounded, focus ids
 * validated) and the frame schemas parse exactly the payloads the loop and
 * dispatcher broadcast.
 *
 * @module snap-rail/forge/tests/contract.spec
 */

import { describe, expect, it } from 'vitest'
import {
  forgeRequestSchemas,
  genMountedSchema,
  genUnmountedSchema,
  llmConfigSchema,
  sessionDeltaSchema,
} from '../src/contract.ts'

describe('forge request schemas', () => {
  it('accepts a well-formed send and mints no extra fields', () => {
    expect(forgeRequestSchemas['forge.session.send'].safeParse({
      text: '加一页产量对比',
    }).success).toBe(true)
    expect(forgeRequestSchemas['forge.session.send'].safeParse({
      sessionId: 's1',
      text: '改一下',
      focusPluginId: 'weekly-report',
    }).success).toBe(true)
  })

  it('rejects empty or oversized text, unknown fields, and bad ids', () => {
    expect(forgeRequestSchemas['forge.session.send'].safeParse({ text: '' }).success).toBe(false)
    expect(forgeRequestSchemas['forge.session.send'].safeParse({ text: 'x'.repeat(16_001) }).success).toBe(false)
    expect(forgeRequestSchemas['forge.session.send'].safeParse({ text: 'ok', focusPluginId: 'Bad_Id' }).success).toBe(false)
    expect(forgeRequestSchemas['forge.session.send'].safeParse({ text: 'ok', extra: 1 }).success).toBe(false)
  })

  it('validates plugin admin shapes', () => {
    expect(forgeRequestSchemas['forge.plugin.set-enabled'].safeParse({ id: 'demo', enabled: true }).success).toBe(true)
    expect(forgeRequestSchemas['forge.plugin.set-enabled'].safeParse({ id: 'demo' }).success).toBe(false)
    expect(forgeRequestSchemas['forge.plugin.set-version'].safeParse({ id: 'demo', versionId: 'v2' }).success).toBe(true)
    expect(forgeRequestSchemas['forge.plugin.set-version'].safeParse({ id: 'demo', versionId: '2' }).success).toBe(false)
    expect(forgeRequestSchemas['forge.client-report'].safeParse({
      id: 'demo', versionId: 'v1', stage: 'load', ok: false, message: 'boom',
    }).success).toBe(true)
    expect(forgeRequestSchemas['forge.client-report'].safeParse({
      id: 'demo', versionId: 'v1', stage: 'detach', ok: true,
    }).success).toBe(false)
  })

  it('validates session removal and zip export shapes', () => {
    expect(forgeRequestSchemas['forge.session.remove'].safeParse({ sessionId: 's1' }).success).toBe(true)
    expect(forgeRequestSchemas['forge.session.remove'].safeParse({}).success).toBe(false)
    expect(forgeRequestSchemas['forge.plugin.export'].safeParse({ id: 'demo', path: '/tmp/demo.zip' }).success).toBe(true)
    expect(forgeRequestSchemas['forge.plugin.export'].safeParse({ id: 'demo', versionId: 'v2', path: '/tmp/demo.zip' }).success).toBe(true)
    expect(forgeRequestSchemas['forge.plugin.export'].safeParse({ id: 'demo', versionId: '2', path: '/tmp/demo.zip' }).success).toBe(false)
    expect(forgeRequestSchemas['forge.plugin.export'].safeParse({ id: 'demo' }).success).toBe(false)
    expect(forgeRequestSchemas['forge.plugin.export'].safeParse({ id: 'Bad', path: '/tmp/demo.zip' }).success).toBe(false)
  })

  it('validates the llm config strictly', () => {
    expect(llmConfigSchema.safeParse({
      baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat',
    }).success).toBe(true)
    expect(llmConfigSchema.safeParse({
      baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat', extra: true,
    }).success).toBe(false)
    expect(llmConfigSchema.safeParse({ apiKey: 'sk-x', model: 'm' }).success).toBe(false)
  })
})

describe('forge frame schemas', () => {
  it('parses each session-delta variant and rejects the malformed', () => {
    expect(sessionDeltaSchema.safeParse({ kind: 'text', sessionId: 's1', text: '你好' }).success).toBe(true)
    expect(sessionDeltaSchema.safeParse({
      kind: 'tool', sessionId: 's1', tool: 'rail_define', phase: 'start',
    }).success).toBe(true)
    expect(sessionDeltaSchema.safeParse({ kind: 'state', sessionId: 's1', state: 'idle' }).success).toBe(true)
    expect(sessionDeltaSchema.safeParse({ kind: 'state', sessionId: 's1', state: 'busy' }).success).toBe(false)
    expect(sessionDeltaSchema.safeParse({ kind: 'text', sessionId: 's1' }).success).toBe(false)
  })

  it('validates the generated-face frames', () => {
    expect(genMountedSchema.safeParse({ id: 'demo', versionId: 'v1', src: 'return {}' }).success).toBe(true)
    expect(genMountedSchema.safeParse({ id: 'demo', versionId: 'v1' }).success).toBe(false)
    expect(genUnmountedSchema.safeParse({ id: 'demo' }).success).toBe(true)
    expect(genUnmountedSchema.safeParse({ id: 'Bad' }).success).toBe(false)
  })
})
