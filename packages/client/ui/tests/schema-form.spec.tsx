// @vitest-environment happy-dom
/**
 * SchemaForm: one control per schema property on the touch baseline — enums
 * become TouchSelect rows, numbers ride the NumberPad, booleans a Switch;
 * hidden properties (the caller owns them) never render, and schema
 * defaults seed create dialogs.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SchemaForm,
  compactSchemaValue,
  planSchemaFields,
  schemaDefaults,
  type SchemaFormValue,
} from '../src/schema-form.tsx'

afterEach(cleanup)

/** A stateful wrapper: the form is controlled, so edits must flow back in. */
function Harness(props: { initial: SchemaFormValue, onChange: (value: SchemaFormValue) => void }): ReactNode {
  const [value, setValue] = useState(props.initial)
  return (
    <SchemaForm
      schema={SCHEMA}
      value={value}
      onChange={next => {
        setValue(next)
        props.onChange(next)
      }}
    />
  )
}

/** The schema shape zod's `toJSONSchema` emits for a driver dialect config. */
const SCHEMA = {
  type: 'object',
  properties: {
    host: { type: 'string', title: '主机地址', minLength: 1 },
    port: { type: 'integer', title: '端口', default: 502 },
    unitId: { type: 'integer', title: '单元号', default: 1 },
    scale: { type: 'number', title: '缩放' },
    byteOrder: { type: 'string', title: '字序', enum: ['abcd', 'cdab'], default: 'abcd' },
    enabled: { type: 'boolean', title: '启用', default: true },
  },
  required: ['host'],
  additionalProperties: false,
} as const

describe('planSchemaFields', () => {
  it('plans one field per property in schema order, honoring titles and hidden', () => {
    const fields = planSchemaFields(SCHEMA, ['unitId'])
    expect(fields.map(field => [field.name, field.label, field.kind, field.required])).toEqual([
      ['host', '主机地址', 'string', true],
      ['port', '端口', 'integer', false],
      ['scale', '缩放', 'number', false],
      ['byteOrder', '字序', 'enum', false],
      ['enabled', '启用', 'boolean', false],
    ])
    expect(fields[3]?.options?.map(option => option.value)).toEqual(['abcd', 'cdab'])
  })

  it('falls back to the property name when no title rides along', () => {
    const fields = planSchemaFields({ type: 'object', properties: { host: { type: 'string' } } })
    expect(fields[0]?.label).toBe('host')
  })
})

describe('schemaDefaults', () => {
  it('seeds values from schema defaults only', () => {
    expect(schemaDefaults(SCHEMA)).toEqual({ port: 502, unitId: 1, byteOrder: 'abcd', enabled: true })
  })
})

describe('SchemaForm', () => {
  it('renders enum fields as touch selects and commits typed strings', () => {
    const onChange = vi.fn()
    render(<SchemaForm schema={SCHEMA} value={{ byteOrder: 'abcd' }} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: '字序' }))
    fireEvent.click(screen.getByRole('button', { name: 'cdab' }).closest('button') ?? document.body)
    expect(onChange).toHaveBeenCalledWith({ byteOrder: 'cdab' })
  })

  it('commits numeric edits as numbers and empty text as unset', () => {
    const onChange = vi.fn()
    render(<Harness initial={{}} onChange={onChange} />)

    // Port opens the NumberPad; typing 5,0,2 then 确定 commits the number.
    fireEvent.click(screen.getByRole('button', { name: '端口' }))
    for (const key of ['5', '0', '2']) fireEvent.click(screen.getByRole('button', { name: key }))
    fireEvent.click(screen.getByRole('button', { name: '确定' }))
    expect(onChange).toHaveBeenLastCalledWith({ port: 502 })

    // Host is a plain text input; clearing it reports the key as unset.
    const host = screen.getByLabelText(/主机地址/) as HTMLInputElement
    fireEvent.change(host, { target: { value: '10.0.0.1' } })
    expect(onChange).toHaveBeenLastCalledWith({ port: 502, host: '10.0.0.1' })
    fireEvent.change(host, { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({ port: 502, host: undefined })
  })

  it('toggles booleans through the switch', () => {
    const onChange = vi.fn()
    render(<SchemaForm schema={SCHEMA} value={{ enabled: false }} onChange={onChange} />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith({ enabled: true })
  })

  it('never renders hidden properties', () => {
    render(<SchemaForm schema={SCHEMA} value={{}} onChange={() => undefined} hidden={['host', 'unitId']} />)
    expect(screen.queryByLabelText(/主机地址/)).toBeNull()
    expect(screen.queryByRole('button', { name: '端口' })).not.toBeNull()
  })

  it('shows the empty note for schemas without visible properties', () => {
    render(<SchemaForm schema={{ type: 'object', properties: { type: { type: 'string' } } }} value={{}} onChange={() => undefined} hidden={['type']} />)
    expect(screen.getByText('此驱动无额外配置项')).not.toBeNull()
  })
})

describe('compactSchemaValue', () => {
  it('drops unset keys', () => {
    const value: SchemaFormValue = { host: '10.0.0.1', port: undefined, scale: 0.5 }
    expect(compactSchemaValue(value)).toEqual({ host: '10.0.0.1', scale: 0.5 })
  })
})
