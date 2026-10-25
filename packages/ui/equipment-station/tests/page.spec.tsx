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

function fakeLink(): HostLink {
  return {
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
  } as unknown as HostLink
}

describe('equipment settings page', () => {
  it('mounts the empty state and enables the add-device action with a driver', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    roots.push(root)
    await act(async () => {
      root.render(
        <ClientProvider service={{ link: fakeLink(), surface: 'main' }}>
          <EquipmentPage />
        </ClientProvider>,
      )
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(document.body.textContent).toContain('尚未配置设备')
    expect(document.body.textContent).toContain('设备管理')
    const add = [...document.querySelectorAll('button')].find(button => button.textContent?.includes('新增设备'))
    expect(add).toBeDefined()
    expect(add?.hasAttribute('disabled')).toBe(false)
  })
})