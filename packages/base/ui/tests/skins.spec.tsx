// @vitest-environment happy-dom
import { Context } from '@snap-rail/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import skinsPlugin, { DEFAULT_SKIN, DEFAULT_SKIN_ID, skinTokenVar } from '../src/skins.tsx'
import type { SkinDefinition } from '../src/skins.tsx'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function makeSkins(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(skinsPlugin)
  return ctx
}

/** A minimal pool skin built from the default token sets. */
function poolSkin(id: string): SkinDefinition {
  return {
    id,
    title: id,
    presentations: { dialog: 'sheet' },
    tokens: DEFAULT_SKIN.tokens,
  }
}

describe('ctx.skins', () => {
  it('starts with the built-in default skin and dark mode', async () => {
    const ctx = await makeSkins()
    expect(ctx.skins.active().id).toBe(DEFAULT_SKIN_ID)
    expect(ctx.skins.mode()).toBe('dark')
    expect(ctx.skins.tokens().colorPrimary).toBe(DEFAULT_SKIN.tokens.dark.colorPrimary)
  })

  it('turns a registered pool skin active and falls back when it unloads', async () => {
    const ctx = await makeSkins()
    const fiber = await ctx.plugin(Object.assign(
      function skin(sub): void {
        sub.skins.register(sub, poolSkin('contrast'))
      },
      { inject: ['skins'] },
    ))
    expect(ctx.skins.active().id).toBe('contrast')
    expect(ctx.skins.presentation('dialog')).toBe('sheet')

    await fiber.dispose()
    expect(ctx.skins.active().id).toBe(DEFAULT_SKIN_ID)
    expect(ctx.skins.presentation('dialog')).toBe('modal')
  })

  it('switches modes and applies tokens to the document root', async () => {
    const ctx = await makeSkins()
    ctx.skins.setMode('light')
    expect(ctx.skins.tokens().colorPrimary).toBe(DEFAULT_SKIN.tokens.light.colorPrimary)
    expect(document.documentElement.dataset['snapSkin']).toBe(DEFAULT_SKIN_ID)
    expect(document.documentElement.dataset['snapMode']).toBe('light')
    expect(document.documentElement.style.getPropertyValue(skinTokenVar('colorPrimary')))
      .toBe(DEFAULT_SKIN.tokens.light.colorPrimary)
  })

  it('injects and removes a skin stylesheet with its lifetime', async () => {
    const ctx = await makeSkins()
    const skin = poolSkin('styled')
    skin.css = ':root[data-snap-skin="styled"] { --snap-test: 1; }'
    const fiber = await ctx.plugin(Object.assign(
      function styledSkin(sub): void {
        sub.skins.register(sub, skin)
      },
      { inject: ['skins'] },
    ))
    expect(document.querySelector('style[data-snap-skin-style="styled"]')).not.toBeNull()
    await fiber.dispose()
    expect(document.querySelector('style[data-snap-skin-style="styled"]')).toBeNull()
  })
})