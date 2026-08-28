import { Context } from '@snap-rail/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import workflowsPlugin from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function makeCtx(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(workflowsPlugin)
  return ctx
}

function registerWorkflow(ctx: Context, id: string, order: number, requires: Parameters<typeof ctx.workflows.register>[2]['requires'] = []): void {
  ctx.workflows.register(ctx, { id, title: id, order, requires, render: () => null })
}

describe('workflows service', () => {
  it('lists workflows ordered by order then registration', async () => {
    const ctx = await makeCtx()
    registerWorkflow(ctx, 'b', 20)
    registerWorkflow(ctx, 'a', 10)
    registerWorkflow(ctx, 'c', 20)
    expect(ctx.workflows.list().map(entry => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps workflows without requirements always unlocked', async () => {
    const ctx = await makeCtx()
    registerWorkflow(ctx, 'free', 10)
    expect(ctx.workflows.list()[0]?.unlocked).toBe(true)
  })

  it('unlocks an operator-day requirement only for the current operator, today', async () => {
    const ctx = await makeCtx()
    registerWorkflow(ctx, 'gated', 10, [{ action: 'maintenance.complete', scope: 'operator-day' }])

    ctx.workflows.setOperator('1001')
    ctx.workflows.feedEvents([{ action: 'maintenance.complete', actor: '1001', time: Date.now() }])
    expect(ctx.workflows.list()[0]?.unlocked).toBe(true)

    // Yesterday's completion never counts.
    ctx.workflows.feedEvents([{ action: 'maintenance.complete', actor: '1001', time: Date.now() - 24 * 3_600_000 }])
    expect(ctx.workflows.list()[0]?.unlocked).toBe(false)

    // Someone else's completion never counts for the operator-day scope.
    ctx.workflows.feedEvents([{ action: 'maintenance.complete', actor: '1002', time: Date.now() }])
    expect(ctx.workflows.list()[0]?.unlocked).toBe(false)

    // A shift change re-evaluates against the same event set.
    ctx.workflows.feedEvents([{ action: 'maintenance.complete', actor: '1001', time: Date.now() }])
    ctx.workflows.setOperator('1002')
    expect(ctx.workflows.list()[0]?.unlocked).toBe(false)
    ctx.workflows.setOperator('1001')
    expect(ctx.workflows.list()[0]?.unlocked).toBe(true)
  })

  it('unlocks a day requirement for any actor today', async () => {
    const ctx = await makeCtx()
    registerWorkflow(ctx, 'sampling', 10, [{ action: 'production.start', scope: 'day' }])
    ctx.workflows.setOperator('1001')
    ctx.workflows.feedEvents([{ action: 'production.start', actor: '1003', time: Date.now() }])
    expect(ctx.workflows.list()[0]?.unlocked).toBe(true)
  })

  it('announce appends an in-session event attributed to the anchor operator', async () => {
    const ctx = await makeCtx()
    registerWorkflow(ctx, 'gated', 10, [{ action: 'maintenance.complete', scope: 'operator-day' }])
    ctx.workflows.setOperator('1001')
    expect(ctx.workflows.list()[0]?.unlocked).toBe(false)
    ctx.workflows.announce('maintenance.complete')
    expect(ctx.workflows.list()[0]?.unlocked).toBe(true)
  })

  it('setActive marks exactly one workflow and feedEvents resets the set', async () => {
    const ctx = await makeCtx()
    registerWorkflow(ctx, 'a', 10)
    registerWorkflow(ctx, 'b', 20)
    ctx.workflows.setActive('b')
    const states = () => ctx.workflows.list().map(entry => entry.active)
    expect(states()).toEqual([false, true])
    ctx.workflows.feedEvents([])
    expect(states()).toEqual([false, true])
  })

  it('clamps halo progress and exposes alerts on the entry', async () => {
    const ctx = await makeCtx()
    registerWorkflow(ctx, 'a', 10)
    ctx.workflows.setAlert('a', { kind: 'halo', progress: 5 })
    expect(ctx.workflows.list()[0]?.alert).toEqual({ kind: 'halo', progress: 1 })
    ctx.workflows.setAlert('a', null)
    expect(ctx.workflows.list()[0]?.alert).toBeNull()
  })

  it('emits workflow/changed on registration and gating transitions', async () => {
    const ctx = await makeCtx()
    const seen: string[] = []
    ctx.on('workflow/changed', () => seen.push('changed'))
    registerWorkflow(ctx, 'a', 10)
    expect(seen.length).toBe(1)
    ctx.workflows.announce('x')
    expect(seen.length).toBe(2)
  })
})
