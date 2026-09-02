/**
 * SchemaForm: the settings vocabulary's generic form engine. It renders one
 * labeled control per property of a JSON Schema (the input-form projection
 * drivers register with the field base — zod's `toJSONSchema`), on the touch
 * baseline: enums and literal unions become TouchSelect rows (committing the
 * literal's own type — a number const rides back as a number), numbers open
 * the NumberPad, booleans ride a Switch. Property `title`s (zod
 * `.meta({ title })`) label the fields; the host's zod schemas remain the
 * only validator — this form shapes input, it does not judge it.
 *
 * The vocabulary is meant to grow (discovery pickers, repeatable groups);
 * what a schema expresses beyond today's subset renders as a plain text
 * field and still round-trips through the host's validation.
 *
 * @module @snap-rail/client-ui/schema-form
 */

import { type ReactNode } from 'react'
import { Input } from './input.tsx'
import { Label } from './label.tsx'
import { NumberInput } from './number-input.tsx'
import { Switch } from './switch.tsx'
import { TouchSelect, type TouchSelectOption } from './touch-select.tsx'
import { cn } from './utils.ts'

/** One form value per schema property: schema-native types, absent = unset. */
export type SchemaFormValue = Record<string, string | number | boolean | undefined>

/** A JSON Schema property descriptor as zod's `toJSONSchema` emits it. */
interface PropertySchema {
  type?: unknown
  enum?: unknown
  anyOf?: unknown
  title?: unknown
  description?: unknown
  default?: unknown
  minimum?: unknown
  maximum?: unknown
}

function isPropertySchema(raw: unknown): raw is PropertySchema {
  return typeof raw === 'object' && raw !== null
}

/** The schema subset one field renders from. */
interface FieldPlan {
  name: string
  label: string
  required: boolean
  kind: 'enum' | 'string' | 'integer' | 'number' | 'boolean' | 'text'
  options?: TouchSelectOption[]
  /** option value → the schema-native value to commit — number literals stay
   * numbers (a union of `z.literal(1)`s must round-trip as 1, never "1"). */
  literalOf?: Record<string, string | number | boolean>
  placeholder?: string
}

/** Plan the renderable fields of an object schema (property order kept). */
export function planSchemaFields(
  schema: Record<string, unknown>,
  hidden: readonly string[] = [],
): FieldPlan[] {
  const properties = schema.properties
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === 'string') : [],
  )
  const fields: FieldPlan[] = []
  if (!isPropertySchema(properties)) return fields
  for (const [name, rawProperty] of Object.entries(properties)) {
    if (hidden.includes(name)) continue
    const property = rawProperty as PropertySchema
    const label = typeof property.title === 'string' && property.title !== '' ? property.title : name
    const field: FieldPlan = { name, label, required: required.has(name), kind: 'string' }
    // zod emits a union of literals either way: plain enums as `enum`, and
    // `z.union([z.literal(1), …])` as `anyOf: [{const: 1}, …]`.
    const literals = Array.isArray(property.enum) ? property.enum
      : Array.isArray(property.anyOf)
        ? property.anyOf.map(entry => isPropertySchema(entry) && 'const' in entry
          ? (entry as { const: unknown }).const
          : undefined)
        : undefined
    const typed = literals?.filter((value): value is string | number | boolean =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    if (literals !== undefined && typed !== undefined && typed.length > 0 && typed.length === literals.length) {
      const valueOf: Record<string, string | number | boolean> = {}
      field.kind = 'enum'
      field.options = typed.map(value => {
        const key = String(value)
        valueOf[key] = value
        return { value: key, label: key }
      })
      field.literalOf = valueOf
    } else {
      switch (property.type) {
        case 'integer': field.kind = 'integer'; break
        case 'number': field.kind = 'number'; break
        case 'boolean': field.kind = 'boolean'; break
        case 'string': field.kind = 'string'; break
        default: field.kind = 'text'
      }
    }
    if (typeof property.description === 'string') field.placeholder = property.description
    fields.push(field)
  }
  return fields
}

/** Initial values from an object schema's `default`s (create dialogs). */
export function schemaDefaults(schema: Record<string, unknown>): SchemaFormValue {
  const value: SchemaFormValue = {}
  const properties = schema.properties
  if (!isPropertySchema(properties)) return value
  for (const [name, rawProperty] of Object.entries(properties)) {
    const fallback = (rawProperty as PropertySchema).default
    if (typeof fallback === 'string' || typeof fallback === 'number' || typeof fallback === 'boolean') {
      value[name] = fallback
    }
  }
  return value
}

/** Strip keys whose value is `undefined` so unset optionals ride clean. */
export function compactSchemaValue(value: SchemaFormValue): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry
  }
  return out
}

/** One labeled control. */
function SchemaField(props: {
  field: FieldPlan
  value: string | number | boolean | undefined
  onChange: (value: string | number | boolean | undefined) => void
  disabled?: boolean
}): ReactNode {
  const { field, value, onChange, disabled = false } = props
  const setString = (next: string): void => { onChange(next === '' ? undefined : next) }
  return (
    <div className="grid gap-2" data-schema-field={field.name}>
      <Label htmlFor={`schema-${field.name}`}>
        {field.label}
        {field.required && <span className="ml-1 text-destructive">*</span>}
      </Label>
      {field.kind === 'enum' && field.options !== undefined && (
        <TouchSelect
          label={field.label}
          value={value === undefined ? '' : String(value)}
          options={field.options}
          onValueChange={next => { onChange(field.literalOf?.[next] ?? next) }}
          disabled={disabled}
        />
      )}
      {(field.kind === 'integer' || field.kind === 'number') && (
        <NumberInput
          label={field.label}
          value={value === undefined ? '' : String(value)}
          onChange={text => {
            if (text === '') { onChange(undefined); return }
            const parsed = field.kind === 'integer' ? Number.parseInt(text, 10) : Number.parseFloat(text)
            onChange(Number.isNaN(parsed) ? undefined : parsed)
          }}
          allowDecimal={field.kind === 'number'}
          placeholder={field.placeholder ?? '—'}
          disabled={disabled}
        />
      )}
      {field.kind === 'boolean' && (
        <div className="flex h-12 items-center">
          <Switch
            id={`schema-${field.name}`}
            checked={value === true}
            onCheckedChange={onChange}
            disabled={disabled}
          />
        </div>
      )}
      {(field.kind === 'string' || field.kind === 'text') && (
        <Input
          id={`schema-${field.name}`}
          value={value === undefined ? '' : String(value)}
          onChange={event => { setString(event.target.value) }}
          placeholder={field.placeholder}
          disabled={disabled}
        />
      )}
    </div>
  )
}

/** A controlled, schema-driven form body (labels + controls, no buttons). */
export function SchemaForm(props: {
  /** The object schema driving the fields (input form, zod-projected). */
  schema: Record<string, unknown>
  /** Current values keyed by property name; absent = unset. */
  value: SchemaFormValue
  onChange: (value: SchemaFormValue) => void
  /** Property names the caller owns and renders itself (e.g. `type`). */
  hidden?: readonly string[]
  disabled?: boolean
  className?: string
}): ReactNode {
  const { schema, value, onChange, hidden = [], disabled = false, className } = props
  const fields = planSchemaFields(schema, hidden)
  return (
    <div className={cn('grid gap-5', className)} data-schema-form>
      {fields.map(field => (
        <SchemaField
          key={field.name}
          field={field}
          value={value[field.name]}
          disabled={disabled}
          onChange={next => { onChange({ ...value, [field.name]: next }) }}
        />
      ))}
      {fields.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          此驱动无额外配置项
        </div>
      )}
    </div>
  )
}
