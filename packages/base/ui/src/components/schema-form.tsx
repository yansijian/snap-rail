/**
 * A small JSON-Schema form renderer for driver dialect schemas. It covers the
 * flat object shapes drivers commonly declare: string, number/integer,
 * boolean, enum, and unions of literals. Nested objects/arrays fall back to a
 * JSON textarea; a driver that needs a bespoke interaction should ship a
 * registered component instead of growing this renderer.
 *
 * @module @snap-rail/ui/components/schema-form
 */

import type { ReactNode } from 'react'
import { Field } from './form.tsx'
import { Input, NumberInput, Textarea } from './input.tsx'
import { Switch, TouchSelect } from './controls.tsx'
import type { SelectOption } from './controls.tsx'

/** The JSON-Schema subset a driver dialect form uses. */
export interface JsonSchemaNode {
  type?: string
  title?: string
  description?: string
  properties?: Readonly<Record<string, JsonSchemaNode>>
  required?: readonly string[]
  enum?: readonly unknown[]
  /** `z.toJSONSchema` projects a union of literals (`z.union([z.literal(1), …])`)
   * as an `anyOf` of `const` branches instead of an `enum` — see
   * {@link literalValuesOf}. */
  anyOf?: readonly JsonSchemaNode[]
  const?: unknown
  default?: unknown
  minimum?: number
  maximum?: number
}

/** The closed literal set a property may take: its `enum`, or — for a union of
 * scalar literals — the flattened `const` values of the `anyOf` branches, in
 * declaration order. `undefined` when the property is not a closed literal set
 * (open unions, non-scalar consts, absent both fields). */
export function literalValuesOf(property: JsonSchemaNode): readonly unknown[] | undefined {
  if (Array.isArray(property.enum)) return property.enum
  const branches = property.anyOf
  if (!Array.isArray(branches) || branches.length === 0) return undefined
  const values: unknown[] = []
  for (const branch of branches) {
    if (branch === null || typeof branch !== 'object' || branch.anyOf !== undefined) return undefined
    if (!('const' in branch)) return undefined
    const value = branch.const
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined
    values.push(value)
  }
  return values
}

/** Props of {@link SchemaForm}. */
export interface SchemaFormProps {
  schema: JsonSchemaNode
  value: Readonly<Record<string, unknown>>
  onChange: (value: Record<string, unknown>) => void
  idPrefix?: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** Render a flat JSON-Schema object as semantic fields. */
export function SchemaForm({ schema, value, onChange, idPrefix = 'schema' }: SchemaFormProps): ReactNode {
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const update = (key: string, next: unknown): void => {
    onChange({ ...value, [key]: next })
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--snap-space-md)' }}>
      {Object.entries(properties).map(([key, property]) => {
        const id = `${idPrefix}-${key}`
        const current = value[key] ?? property.default
        const label = property.title ?? key
        const common = {
          label,
          htmlFor: id,
          ...(property.description !== undefined ? { help: property.description } : {}),
          ...(required.has(key) ? { required: true } : {}),
        }
        const values = literalValuesOf(property)
        if (values !== undefined) {
          const options: SelectOption[] = values.map(item => ({ value: String(item), label: String(item) }))
          return (
            <Field key={key} {...common}>
              <TouchSelect
                {...current !== undefined ? { value: String(current) } : {}}
                options={options}
                onValueChange={next => {
                  update(key, values.find(item => String(item) === next) ?? next)
                }}
                aria-label={String(label)}
              />
            </Field>
          )
        }
        if (property.type === 'boolean') {
          return (
            <Field key={key} {...common}>
              <Switch checked={current === true} onCheckedChange={next => update(key, next)} label={current === true ? '开启' : '关闭'} />
            </Field>
          )
        }
        if (property.type === 'number' || property.type === 'integer') {
          return (
            <Field key={key} {...common}>
              <NumberInput
                id={id}
                value={typeof current === 'number' ? current : ''}
                {...property.minimum !== undefined ? { min: property.minimum } : {}}
                {...property.maximum !== undefined ? { max: property.maximum } : {}}
                onChange={event => {
                  const raw = event.target.value
                  update(key, raw === '' ? undefined : Number(raw))
                }}
              />
            </Field>
          )
        }
        if (property.type === 'object' || property.type === 'array') {
          return (
            <Field key={key} {...common} help={property.description ?? 'JSON 值'}>
              <Textarea
                id={id}
                rows={4}
                defaultValue={JSON.stringify(current ?? (property.type === 'array' ? [] : {}), null, 2)}
                onBlur={event => {
                  try {
                    update(key, JSON.parse(event.target.value))
                  } catch {
                    // Keep the invalid draft in the textarea; the driver's
                    // schema rejects it on submit with a readable error.
                  }
                }}
              />
            </Field>
          )
        }
        return (
          <Field key={key} {...common}>
            <Input
              id={id}
              value={typeof current === 'string' || typeof current === 'number' ? String(current) : ''}
              onChange={event => update(key, event.target.value)}
            />
          </Field>
        )
      })}
      {Object.keys(properties).length === 0 && (
        <span style={{ color: 'var(--snap-color-muted)' }}>该驱动没有额外配置项。</span>
      )}
    </div>
  )
}

/** Normalize a driver's JSON Schema (which may carry `$schema`). */
export function schemaNodeOf(value: unknown): JsonSchemaNode {
  return asRecord(value) as JsonSchemaNode
}