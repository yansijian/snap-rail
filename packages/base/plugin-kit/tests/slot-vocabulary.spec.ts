import { describe, expect, it } from 'vitest'
import { CUSTOM_SLOT_PATTERN, defineSlotVocabulary } from '../src/slot-vocabulary.ts'

describe('defineSlotVocabulary', () => {
  const vocabulary = defineSlotVocabulary({ menu: 'shell.menu', titlebar: 'shell.titlebar' })

  it('guards declared ids plus custom seats, rejects near-misses', () => {
    expect(vocabulary.isSlotId('shell.menu')).toBe(true)
    expect(vocabulary.isSlotId('shell.titlebar')).toBe(true)
    expect(vocabulary.isSlotId('custom:acme.charts')).toBe(true)
    expect(vocabulary.isSlotId('shell.mnue')).toBe(false)
    expect(vocabulary.isSlotId('shell')).toBe(false)
    expect(vocabulary.isSlotId('Shell.Menu')).toBe(false)
  })

  it('rejects malformed ids at definition time', () => {
    expect(() => defineSlotVocabulary({ bad: 'Menu' })).toThrow(/插槽 id 不合法/)
    expect(() => defineSlotVocabulary({ bad: 'nodots' })).toThrow()
    expect(() => defineSlotVocabulary({ bad: 'shell.' })).toThrow()
  })

  it('allows a framework-specific custom namespace instead of the default', () => {
    const strict = defineSlotVocabulary({ menu: 'shell.menu' }, { customPattern: /^ext:[a-z-]+$/ })
    expect(strict.isSlotId('ext:thing')).toBe(true)
    expect(strict.isSlotId('custom:acme.charts')).toBe(false)
    expect(CUSTOM_SLOT_PATTERN.test('custom:acme.charts')).toBe(true)
  })
})
