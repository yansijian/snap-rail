// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostLink } from '@snap-rail/connection'
import { ClientProvider } from '@snap-rail/ui/runtime'
import { EquipmentPage } from '../src/page.tsx'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<ReturnType<typeof createRoot>> = []

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

function fakeLink(): { link: HostLink, frames: Map<string, (payload: unknown) => void> } {
  const frames = new Map<string, (payload: unknown) => void>()
  const link = {
    call: vi.fn(async (method: string) => {
      if (method === 'equipment.config.list') return { ok: true, value: { config: { devices: [] } } }
      if (method === 'equipment.connections.list') return { ok: true, value: { connections: [] } }
      if (method === 'equipment.drivers.list') {
        return {
          ok: true,
          value: {
            drivers: [{
              id: 'modbus-tcp',
              title: 'Modbus TCP',
              schemas: {
                device: { type: 'object', properties: { host: { type: 'string', title: '主机地址' } } },
                point: { type: 'object', properties: { address: { type: 'number', title: '地址' } } },
              },
            }],
          },
        }
      }
      return { ok: true, value: {} }
    }),
    subscribe: vi.fn((method: string, listener: (payload: unknown) => void) => {
      frames.set(method, listener)
      return (): void => { frames.delete(method) }
    }),
  }
  return { link: link as unknown as HostLink, frames }
}

describe('equipment settings page', () => {
  it('mounts the empty state with a title-side add button and no refresh', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    roots.push(root)
    await act(async () => {
      root.render(
        <ClientProvider service={{ link: fakeLink().link, surface: 'main' }}>
          <EquipmentPage />
        </ClientProvider>,
      )
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain('尚未配置设备')
    expect(document.body.textContent).toContain('设备管理')
    const plus = document.querySelector<HTMLButtonElement>('button[aria-label="新增设备"]')
    expect(plus).toBeDefined()
    expect(plus?.hasAttribute('disabled')).toBe(false)
    const refresh = [...document.querySelectorAll('button')].find(button => button.textContent === '刷新')
    expect(refresh).toBeUndefined()
  })

  it('follows the equipment wire: a structure frame re-pulls the lists', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    roots.push(root)
    const { link, frames } = fakeLink()
    await act(async () => {
      root.render(
        <ClientProvider service={{ link, surface: 'main' }}>
          <EquipmentPage />
        </ClientProvider>,
      )
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const call = link.call as unknown as { mock: { calls: string[][] } }
    const pulls = (): number => call.mock.calls.filter(entry => entry[0] === 'equipment.config.list').length
    expect(pulls()).toBe(1)

    await act(async () => {
      frames.get('equipment/structure-changed')?.({})
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(pulls()).toBe(2)
  })
})