import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardTitle,
  Field,
  Grid,
  Input,
  Led,
  Progress,
  Row,
  SchemaForm,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TouchSelect,
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
})