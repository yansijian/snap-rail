// @vitest-environment happy-dom
import { Context } from '@snap-rail/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import skinsPlugin, {
  DEFAULT_DARK,
  DEFAULT_DARK_ID,
  DEFAULT_LIGHT,
  DEFAULT_LIGHT_ID,
  skinTokenVar,
} from '../src/skins.tsx'
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

/** A minimal pool theme built from the factory night tokens. */
function poolTheme(id: string, css?: string): SkinDefinition {
  return { id, title: id, tokens: { ...DEFAULT_DARK.tokens }, css }
}

interface SkinHolder {
  skins: Context['skins']
}

/** Mount a pool theme from a named plugin so the caller label is the package. */
async function mountTheme(ctx: Context, skin: SkinDefinition, name = '@acme/theme'): Promise<Context> {
  return ctx.plugin({
    name,
    inject: ['skins'],
    apply(sub: SkinHolder): void {
      sub.skins.register(sub, skin)
    },
  })
}

describe('ctx.skins', () => {
  it('registers both factory themes and starts on the night one', async () => {
    const ctx = await makeSkins()
    expect(ctx.skins.active().id).toBe(DEFAULT_DARK_ID)
    expect(ctx.skins.tokens().colorPrimary).toBe(DEFAULT_DARK.tokens.colorPrimary)
    expect(ctx.skins.list().map(row => row.id)).toEqual([DEFAULT_LIGHT_ID, DEFAULT_DARK_ID])
    expect(document.documentElement.dataset['snapSkin']).toBe(DEFAULT_DARK_ID)
    expect(document.documentElement.dataset['snapMode']).toBeUndefined()
  })

  it('activates by id and applies the token set to the document root', async () => {
    const ctx = await makeSkins()
    expect(ctx.skins.activate(DEFAULT_LIGHT_ID)).toBe(true)
    expect(ctx.skins.active().id).toBe(DEFAULT_LIGHT_ID)
    expect(ctx.skins.tokens().colorPrimary).toBe(DEFAULT_LIGHT.tokens.colorPrimary)
    expect(document.documentElement.dataset['snapSkin']).toBe(DEFAULT_LIGHT_ID)
    expect(document.documentElement.style.getPropertyValue(skinTokenVar('colorPrimary')))
      .toBe(DEFAULT_LIGHT.tokens.colorPrimary)
  })

  it('activation stays with the stored selection: registration never steals it', async () => {
    const ctx = await makeSkins()
    await mountTheme(ctx, poolTheme('contrast'))
    expect(ctx.skins.active().id).toBe(DEFAULT_DARK_ID)
    expect(ctx.skins.activate('contrast')).toBe(true)
    expect(ctx.skins.active().id).toBe('contrast')
  })

  it('falls back to the factory night theme when the active theme unloads', async () => {
    const ctx = await makeSkins()
    const fiber = await mountTheme(ctx, poolTheme('contrast'))
    expect(ctx.skins.activate('contrast')).toBe(true)
    await fiber.dispose()
    expect(ctx.skins.active().id).toBe(DEFAULT_DARK_ID)
    expect(document.documentElement.dataset['snapSkin']).toBe(DEFAULT_DARK_ID)
  })

  it('reads a bare package id as that package first theme', async () => {
    const ctx = await makeSkins()
    await mountTheme(ctx, poolTheme('@acme/theme-skin'), '@acme/theme')
    expect(ctx.skins.activate('@acme/theme')).toBe(true)
    expect(ctx.skins.active().id).toBe('@acme/theme-skin')
  })

  it('refuses an unknown selection without touching the active theme', async () => {
    const ctx = await makeSkins()
    expect(ctx.skins.activate('nope')).toBe(false)
    expect(ctx.skins.active().id).toBe(DEFAULT_DARK_ID)
  })

  it('injects and removes a theme stylesheet with its lifetime', async () => {
    const ctx = await makeSkins()
    const fiber = await mountTheme(ctx, poolTheme('styled', ':root[data-snap-skin="styled"] { --snap-test: 1; }'))
    // The stylesheet belongs to the active theme; registration alone is not activation.
    expect(document.querySelector('style[data-snap-skin-style="styled"]')).toBeNull()
    expect(ctx.skins.activate('styled')).toBe(true)
    expect(document.querySelector('style[data-snap-skin-style="styled"]')).not.toBeNull()
    await fiber.dispose()
    expect(document.querySelector('style[data-snap-skin-style="styled"]')).toBeNull()
  })
})
