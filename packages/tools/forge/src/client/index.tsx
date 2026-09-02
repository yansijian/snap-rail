/**
 * The forge renderer face: the generated-plugin runner (host-pushed client
 * halves mounted as this plugin's child fibers), the AI 创造 workbench (a
 * workflow page inside the active scenario), and the LLM endpoint config
 * page (a settings page). One plugin, three registrations — the studio is a
 * resident tool, deliberately not a suite, so it coexists with whatever
 * scenario the terminal is serving.
 *
 * @module @snap-rail/forge/client
 */

// Wire rows for the forge-domain methods this face calls.
import '../contract.ts'
import { Context, type Plugin } from '@snap-rail/cordis'
import type { ReactNode } from 'react'
import '@snap-rail/client-session'
import '@snap-rail/client-settings'
import '@snap-rail/client-workflows'
import { ForgeConfigPage } from './config-page.tsx'
import { startGenRunner } from './runner.ts'
import { ForgeWorkbenchPage } from './workbench.tsx'

/** The forge client plugin; mount in the client runtime tree. */
const forgeClientPlugin: Plugin.Object<void> = {
  name: 'forge-client',
  inject: ['client', 'settingsPages', 'workflows'],
  apply(ctx: Context): void {
    startGenRunner(ctx)
    ctx.workflows.register(ctx, {
      id: 'forge-studio',
      title: 'AI 创造',
      order: 95,
      requires: [],
      render(): ReactNode {
        return <ForgeWorkbenchPage ctx={ctx} />
      },
    })
    ctx.settingsPages.register(ctx, {
      id: 'forge-studio',
      title: 'AI 创造',
      order: 60,
      render(): ReactNode {
        return <ForgeWorkbenchPage ctx={ctx} />
      },
    })
    ctx.settingsPages.register(ctx, {
      id: 'forge-config',
      title: 'AI 创造 · 模型接口',
      order: 61,
      render(): ReactNode {
        return <ForgeConfigPage ctx={ctx} />
      },
    })
  },
}

export default forgeClientPlugin
