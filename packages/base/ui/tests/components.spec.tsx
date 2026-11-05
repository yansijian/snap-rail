import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardTitle,
  Checkbox,
  Field,
  Form,
  Grid,
  Input,
  Led,
  NumberInput,
  Progress,
  RadioGroup,
  RadioGroupItem,
  Row,
  SchemaForm,
  Select,
  SelectItem,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Toolbar,
  TouchSelect,
  cn,
  literalValuesOf,
  part,
  space,
} from '../src/components/index.ts'

describe('schema-driven forms', () => {
  it('renders flat driver schemas as semantic fields', () => {
    const html = renderToStaticMarkup(
      <SchemaForm
        schema={{
          type: 'object',
          required: ['host'],
          properties: {
            host: { type: 'string', title: '主机地址' },
            port: { type: 'number', title: '端口', default: 502 },
            byteOrder: { type: 'string', title: '字序', enum: ['abcd', 'cdab'], default: 'abcd' },
            enabled: { type: 'boolean', title: '启用', default: true },
          },
        }}
        value={{ host: '192.168.1.10' }}
        onChange={() => {}}
      />,
    )
    expect(html).toContain('主机地址')
    expect(html).toContain('端口')
    expect(html).toContain('字序')
    expect(html).toContain('启用')
    expect(html).toContain('data-snap-component="number-input"')
  })

  it('renders a union of literals as a select (the wire shape z.toJSONSchema emits)', () => {
    // z.toJSONSchema projects z.union([z.literal(1), …]) as an anyOf of const
    // branches, not an enum — the modbus 功能码 field is exactly this shape.
    const html = renderToStaticMarkup(
      <SchemaForm
        schema={{
          type: 'object',
          properties: {
            fc: {
              title: '功能码',
              anyOf: [
                { type: 'number', const: 1 },
                { type: 'number', const: 2 },
                { type: 'number', const: 3 },
                { type: 'number', const: 4 },
              ],
            },
          },
        }}
        value={{ fc: 3 }}
        onChange={() => {}}
      />,
    )
    expect(html).toContain('功能码')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('data-snap-component="button"')
    // The select replaces the string-input fallback (which stored raw strings
    // the driver schema then rejected).
    expect(html).not.toContain('data-snap-component="input"')
  })

  it('flattens anyOf const branches into a closed literal set', () => {
    expect(literalValuesOf({ anyOf: [{ type: 'number', const: 1 }, { type: 'number', const: 3 }] })).toEqual([1, 3])
    // Scalar type is preserved so the stored value passes the driver schema.
    expect(literalValuesOf({ anyOf: [{ const: 'a' }, { const: 1 }] })).toEqual(['a', 1])
    expect(literalValuesOf({ enum: ['x', 'y'] })).toEqual(['x', 'y'])
    // Open unions and non-literal branches are not a closed set.
    expect(literalValuesOf({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBeUndefined()
    expect(literalValuesOf({ anyOf: [] })).toBeUndefined()
    expect(literalValuesOf({ type: 'string' })).toBeUndefined()
  })

  it('renders a touch select as a modal list trigger', () => {
    const html = renderToStaticMarkup(
      <TouchSelect value="a" options={[{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }]} onValueChange={() => {}} aria-label="选择" />,
    )
    expect(html).toContain('甲')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('data-snap-component="button"')
  })
})

describe('semantic component anatomy', () => {
  it('renders stable button parts and semantic variant attributes', () => {
    const html = renderToStaticMarkup(
      <Button intent="primary" emphasis="outline" size="lg">保存</Button>,
    )
    expect(html).toContain('data-snap-component="button"')
    expect(html).toContain('data-snap-part="button.root"')
    expect(html).toContain('data-snap-part="button.label"')
    expect(html).toContain('data-intent="primary"')
    expect(html).toContain('data-emphasis="outline"')
    expect(html).toContain('data-size="lg"')
    expect(html).toContain('type="button"')
  })

  it('marks invalid inputs and keeps the native field', () => {
    const html = renderToStaticMarkup(<Input invalid value="abc" onChange={() => {}} />)
    expect(html).toContain('data-snap-component="input"')
    expect(html).toContain('data-snap-part="input.field"')
    expect(html).toContain('data-invalid="true"')
    expect(html).toContain('aria-invalid="true"')
  })

  it('renders card and table anatomy without utility classes', () => {
    const html = renderToStaticMarkup(
      <Card>
        <CardTitle>设备</CardTitle>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>名称</TableHead></TableRow></TableHeader>
            <TableBody><TableRow><TableCell>PLC-1</TableCell></TableRow></TableBody>
          </Table>
        </CardContent>
      </Card>,
    )
    expect(html).toContain('data-snap-part="card.root"')
    expect(html).toContain('data-snap-part="card.title"')
    expect(html).toContain('data-snap-part="table.head"')
    expect(html).toContain('data-snap-part="table.cell"')
    expect(html).not.toMatch(/\bclass="[^"]*bg-/)
  })

  it('keeps layout structural styles on tokens', () => {
    const html = renderToStaticMarkup(
      <Stack gap="lg" padding="md">
        <Row gap="sm"><span>a</span></Row>
        <Grid columns={3} gap="xs"><span>b</span></Grid>
      </Stack>,
    )
    expect(html).toContain('data-snap-part="stack.root"')
    expect(html).toContain('--snap-space-lg')
    expect(html).toContain('grid-template-columns:repeat(3, minmax(0, 1fr))')
  })

  it('renders feedback and field anatomy', () => {
    const html = renderToStaticMarkup(
      <>
        <Badge intent="success">在线</Badge>
        <Led tone="success" label="运行" />
        <Progress value={0.5} label="进度" />
        <Field label="工号" help="请输入工号" required>
          <Input value="" onChange={() => {}} />
        </Field>
      </>,
    )
    expect(html).toContain('data-snap-part="badge.root"')
    expect(html).toContain('data-snap-part="led.halo"')
    expect(html).toContain('aria-valuenow="50"')
    expect(html).toContain('data-snap-part="field.label"')
    expect(html).toContain('data-required="true"')
  })

  it('renders the declared anatomy the contract promises', () => {
    const html = renderToStaticMarkup(
      <>
        <Tabs defaultValue="a">
          <TabsList><TabsTrigger value="a">甲</TabsTrigger></TabsList>
          <TabsContent value="a">内容</TabsContent>
        </Tabs>
        <Select options={[{ value: 'a', label: '甲' }]} aria-label="选择" />
        <TouchSelect value="a" options={[{ value: 'a', label: '甲' }]} onValueChange={() => {}} aria-label="选择" />
        <Switch checked label="启用" />
      </>,
    )
    expect(html).toContain('data-snap-part="tabs.root"')
    expect(html).toContain('data-snap-part="select.root"')
    expect(html).toContain('data-snap-part="touch-select.root"')
    // The modal sheet renders only when open; the trigger carries the anatomy.
    expect(html).toContain('data-snap-part="touch-select.trigger"')
  })

  it('renders number-input steppers clamped by min/max', () => {
    const html = renderToStaticMarkup(
      <NumberInput value={10} min={0} max={10} onChange={() => {}} />,
    )
    expect(html).toContain('data-snap-part="number-input.step-up"')
    expect(html).toContain('data-snap-part="number-input.step-down"')
    // At the upper bound the step-up control is disabled.
    expect(html).toMatch(/data-snap-part="number-input.step-up"[^>]*disabled/)
  })

  it('renders a labelled radio group with the declared label part', () => {
    const html = renderToStaticMarkup(
      <RadioGroup label="采集模式" description="决定轮询的触发方式">
        <RadioGroupItem value="poll" />
      </RadioGroup>,
    )
    expect(html).toContain('data-snap-part="radio-group.block"')
    expect(html).toContain('data-snap-part="radio-group.label"')
    expect(html).toContain('采集模式')
    expect(html).toContain('aria-labelledby')
  })

  it('renders toolbar children between the start and end groups', () => {
    const html = renderToStaticMarkup(
      <Toolbar start={<span>开始</span>} end={<span>结束</span>}>中段</Toolbar>,
    )
    expect(html).toContain('data-snap-part="toolbar.center"')
    expect(html.indexOf('toolbar.center')).toBeGreaterThan(html.indexOf('toolbar.start'))
    expect(html.indexOf('toolbar.center')).toBeLessThan(html.indexOf('toolbar.end'))
    // Without children the DOM stays exactly start + end.
    const bare = renderToStaticMarkup(<Toolbar start={<span>开始</span>} end={<span>结束</span>} />)
    expect(bare).not.toContain('toolbar.center')
  })

  it('renders schema-form anatomy instead of bare layout divs', () => {
    const html = renderToStaticMarkup(
      <SchemaForm
        schema={{ type: 'object', properties: { host: { type: 'string', title: '主机' } } }}
        value={{}}
        onChange={() => {}}
      />,
    )
    expect(html).toContain('data-snap-part="schema-form.root"')
    expect(html).toContain('data-snap-part="schema-form.field"')
  })

  it('leaves the boolean switch unlabeled instead of repeating on/off captions', () => {
    const html = renderToStaticMarkup(
      <SchemaForm
        schema={{ type: 'object', properties: { enabled: { type: 'boolean', title: '启用' } } }}
        value={{ enabled: true }}
        onChange={() => {}}
      />,
    )
    expect(html).toContain('启用')
    expect(html).not.toContain('开启')
    expect(html).not.toContain('关闭')
  })

  it('lays a horizontal field with a fixed label column', () => {
    const html = renderToStaticMarkup(
      <Field label="主机地址" orientation="horizontal" labelWidth={120} labelAlign="end" required>
        <Input value="" onChange={() => {}} />
      </Field>,
    )
    expect(html).toContain('data-orientation="horizontal"')
    expect(html).toContain('width:120px')
    expect(html).toContain('text-align:end')
  })

  it('flows form fields inline or in a column grid', () => {
    const inline = renderToStaticMarkup(
      <Form orientation="inline" actions={<Button>保存</Button>}>
        <Field label="a"><Input value="" onChange={() => {}} /></Field>
      </Form>,
    )
    expect(inline).toContain('data-orientation="inline"')
    expect(inline).toContain('flex-direction:row')
    const grid = renderToStaticMarkup(
      <Form orientation="grid" columns={3}>
        <Field label="a"><Input value="" onChange={() => {}} /></Field>
      </Form>,
    )
    expect(grid).toContain('grid-template-columns:repeat(3, minmax(0, 1fr))')
  })

  it('composes a select from children and wires uncontrolled form fields', () => {
    // Radix mounts the option list in a portal only while open, so static
    // markup covers the closed trigger; composition itself is type-checked.
    const html = renderToStaticMarkup(
      <Select defaultValue="b" name="mode" required>
        <SelectItem value="a">自动</SelectItem>
        <SelectItem value="b">手动</SelectItem>
      </Select>,
    )
    expect(html).toContain('data-snap-part="select.root"')
    expect(html).toContain('data-snap-part="select.trigger"')
    // The hidden native select carries the form-field association.
    expect(html).toContain('name="mode"')
    expect(html).toContain('required')
  })

  it('places checkbox and switch labels on either side with descriptions', () => {
    const html = renderToStaticMarkup(
      <>
        <Switch checked label="自锁" labelPosition="start" description="断电保持" />
        <Checkbox label="记住" description="下次自动填写" />
      </>,
    )
    expect(html).toContain('data-snap-part="switch.field"')
    expect(html).toContain('data-snap-part="switch.description"')
    expect(html).toContain('断电保持')
    expect(html.indexOf('switch.label')).toBeLessThan(html.indexOf('switch.root'))
    expect(html).toContain('data-snap-part="checkbox.description"')
    // Without a description the DOM keeps the bare label row.
    const bare = renderToStaticMarkup(<Switch checked label="自锁" />)
    expect(bare).not.toContain('switch.field')
  })

  it('arranges schema-form fields in a grid when columns is set', () => {
    const html = renderToStaticMarkup(
      <SchemaForm
        schema={{ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } }}
        value={{}}
        onChange={() => {}}
        columns={2}
      />,
    )
    expect(html).toContain('grid-template-columns:repeat(2, minmax(0, 1fr))')
  })

  it('exposes the anatomy helpers so extension components align with skins', () => {
    const html = renderToStaticMarkup(
      <div {...part('widget', 'root')} className={cn('snap-widget')}>
        <span {...part('widget', 'title')}>标题</span>
      </div>,
    )
    expect(html).toContain('data-snap-component="widget"')
    expect(html).toContain('data-snap-part="widget.title"')
    expect(space('md')).toBe('var(--snap-space-md)')
  })
})