/**
 * The ModbusTCP settings page: one tab per device (the + button on the right
 * of the tab strip adds one), and inside a device one collapsible panel per
 * business group. Groups are explicit, typed entities — a device needs its
 * first group before points can exist, and every point of a group carries
 * the group's data type. A point's identity is the triple
 * (device, group, name); demand plugins declare variables by the same
 * triple, and the point dialog's name suggestions are the declarations of
 * that exact group. Connection health renders as breathing LEDs — green
 * when everything reads, yellow when part of a group fails, red when
 * everything is down.
 *
 * @module @snap-rail/modbus-station
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import { rpcErrorText, subscribeFrame } from '@snap-rail/connection'
import { fieldFrameSchemas } from '@snap-rail/field'
import '@snap-rail/client-runtime'
import '@snap-rail/client-settings'
import { useBinding, usePoint, type VariableEntry } from '@snap-rail/client-variables'
import {
  Badge, Button, Checkbox, Collapsible, CollapsibleChevron, CollapsibleContent, CollapsibleTrigger, Dialog, DialogContent,
  DialogTitle, Input, Label, Led, type LedTone, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tabs, TabsContent, TabsList, TabsTrigger,
} from '@snap-rail/client-ui'
import type {
  ModbusDeviceConfig, ModbusDevicesDocument, ModbusGroupConfig, ModbusPointConfig,
} from '@snap-rail/driver-modbus/contract'
import { useEffect, useRef, useState, type ReactNode } from 'react'

type PointType = ModbusGroupConfig['type']

const ENCODINGS_BY_TYPE: Record<PointType, ModbusPointConfig['encoding'][]> = {
  bool: ['coil', 'discrete'],
  int: ['i16', 'u16', 'i32', 'u32'],
  float: ['f32'],
}

/** Fixed fc per encoding; register encodings leave 03/04 to the operator. */
function fcOf(encoding: ModbusPointConfig['encoding'], current: 1 | 2 | 3 | 4): 1 | 2 | 3 | 4 {
  if (encoding === 'coil') return 1
  if (encoding === 'discrete') return 2
  return current === 4 ? 4 : 3
}

const ENCODING_LABEL: Record<string, string> = {
  coil: '线圈', discrete: '离散输入', i16: 'int16', u16: 'uint16',
  i32: 'int32', u32: 'uint32', f32: 'float32',
}

const FC_LABEL: Record<number, string> = { 1: '01 线圈', 2: '02 离散输入', 3: '03 保持寄存器', 4: '04 输入寄存器' }

const TYPE_LABEL: Record<PointType, string> = { bool: '开关 (bool)', int: '整数 (int)', float: '小数 (float)' }

/** Color-coded type chip: green bool, blue int, amber float. */
const TYPE_VARIANT: Record<PointType, 'success' | 'default' | 'warning'> = {
  bool: 'success', int: 'default', float: 'warning',
}

/** Shared datalist id offering this group's declared-but-unmapped names. */
const UNMAPPED_DATALIST = 'modbus-unmapped-options'

/* Inline icon strokes (12×12) so the page needs no icon dependency. */
function IconPlus(): ReactNode {
  return <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden="true"><path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
}

function IconPencil(): ReactNode {
  return <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden="true"><path d="m8.5 1.5 2 2L4 10H2V8z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
}

function IconCheck(): ReactNode {
  return <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden="true"><path d="M2 6.5 4.8 9 10 3.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function IconTrash(): ReactNode {
  return <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden="true"><path d="M2 3h8M4.5 3V1.5h3V3M3 3l.5 7.5h5L9 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function IconX(): ReactNode {
  return <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden="true"><path d="m3 3 6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
}

function useDoc(ctx: Context): { doc: ModbusDevicesDocument | null, reload: () => void } {
  const [doc, setDoc] = useState<ModbusDevicesDocument | null>(null)
  const reload = (): void => {
    void ctx.client.link.call('field.modbus.devices.list', {})
      .then(result => { if (result.ok) setDoc(result.value) })
      .catch(() => {})
  }
  useEffect(() => { reload() }, [ctx])
  return { doc, reload }
}

/** Live connection status per device id (pull once, then follow status frames). */
function useConnectionStatus(ctx: Context): Record<string, string> {
  const [status, setStatus] = useState<Record<string, string>>({})
  useEffect(() => {
    const refresh = (): void => {
      void ctx.client.link.call('field.connections.list', {})
        .then(result => {
          if (!result.ok) return
          const next: Record<string, string> = {}
          for (const connection of result.value.connections) next[connection.id as string] = connection.status
          setStatus(next)
        })
        .catch(() => {})
    }
    refresh()
    const detach = subscribeFrame(ctx.client.link, 'field/connection-status', fieldFrameSchemas['field/connection-status'], frame => {
      setStatus(current => ({ ...current, [frame.id]: frame.status }))
    })
    return () => { detach() }
  }, [ctx])
  return status
}

/** Declarations of one exact group — the name suggestions and the plugin
 * badge source. */
function declaredFor(ctx: Context, deviceId: string, group: string): readonly VariableEntry[] {
  return ctx.variables.list().filter(def => def.device === deviceId && def.group === group)
}

function fmtValue(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return String(Math.round(value * 1000) / 1000)
  return String(value)
}

/** The live value cell: bools as colored tags, numbers as mono text. */
function ValueCell(props: { sample: { value: unknown } | undefined }): ReactNode {
  const value = props.sample?.value
  if (value === undefined) return <span className="text-xs text-muted-foreground">—</span>
  if (value === null) return <Badge variant="destructive">异常</Badge>
  if (typeof value === 'boolean') return <Badge variant={value ? 'success' : 'secondary'}>{String(value)}</Badge>
  return <span className="whitespace-nowrap font-mono text-xs">{fmtValue(value)}</span>
}

/** The create-device form (the + button). Editing happens inline on the
 * device's description list. */
function DeviceDialog(props: { ctx: Context, onClose: () => void, onSaved: (id: string) => void }): ReactNode {
  const [form, setForm] = useState<ModbusDeviceConfig>({
    id: '', title: '', host: '', port: 502, unitId: 1, pollMs: 1000, timeoutMs: 1000,
    byteOrder: 'abcd', enabled: true,
  })
  const [probe, setProbe] = useState<string | null>(null)
  const set = (patch: Partial<ModbusDeviceConfig>): void => setForm(current => ({ ...current, ...patch }))

  const save = (): void => {
    void props.ctx.client.link.call('field.modbus.devices.upsert', { device: { ...form, id: form.id.trim() } })
      .then(result => { if (result.ok) { props.onSaved(form.id.trim()); props.onClose() } })
  }
  const test = (): void => {
    setProbe('测试中…')
    void props.ctx.client.link.call('field.modbus.devices.test', { device: form })
      .then(result => {
        setProbe(result.ok && result.value.ok ? '连接成功' : `失败：${result.ok ? result.value.error : '请求被拒绝'}`)
      })
      .catch(() => setProbe('失败：请求未送达'))
  }

  return (
    <Dialog open onOpenChange={next => { if (!next) props.onClose() }}>
      <DialogContent data-region="modbus-device-dialog" aria-describedby={undefined}>
        <DialogTitle className="mb-3 text-sm font-medium">新增设备</DialogTitle>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>设备 ID</Label>
            <Input aria-label="设备 ID" value={form.id}
              onChange={event => set({ id: event.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>名称</Label>
            <Input aria-label="设备名称" value={form.title} onChange={event => set({ title: event.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>IP 地址</Label>
            <Input aria-label="IP 地址" value={form.host} onChange={event => set({ host: event.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>端口</Label>
            <Input aria-label="端口" type="number" value={form.port} onChange={event => set({ port: Number(event.target.value) })} />
          </div>
          <div className="space-y-1">
            <Label>从站号</Label>
            <Input aria-label="从站号" type="number" value={form.unitId} onChange={event => set({ unitId: Number(event.target.value) })} />
          </div>
          <div className="space-y-1">
            <Label>轮询周期 (ms)</Label>
            <Input aria-label="轮询周期" type="number" value={form.pollMs} onChange={event => set({ pollMs: Number(event.target.value) })} />
          </div>
          <div className="space-y-1">
            <Label>字序</Label>
            <Select value={form.byteOrder} onValueChange={next => set({ byteOrder: next as ModbusDeviceConfig['byteOrder'] })}>
              <SelectTrigger aria-label="字序"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="abcd">abcd</SelectItem>
                <SelectItem value="cdab">cdab</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {probe !== null && <p className="mt-3 text-xs text-muted-foreground">{probe}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={test}>测试连接</Button>
          <Button variant="ghost" size="sm" onClick={props.onClose}>取消</Button>
          <Button size="sm" disabled={form.id.trim() === '' || form.host.trim() === ''} onClick={save}>保存</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** New group form: the name plus the one data type its points will share. */
function GroupDialog(props: { ctx: Context, device: ModbusDeviceConfig, onClose: () => void }): ReactNode {
  const [name, setName] = useState('')
  const [type, setType] = useState<PointType>('bool')
  const [error, setError] = useState<string | null>(null)

  const save = (): void => {
    const group: ModbusGroupConfig = { deviceId: props.device.id, name: name.trim(), type }
    void props.ctx.client.link.call('field.modbus.groups.upsert', { group })
      .then(result => { if (result.ok) props.onClose(); else setError(rpcErrorText(result.error)) })
      .catch(() => setError('请求未送达'))
  }

  return (
    <Dialog open onOpenChange={next => { if (!next) props.onClose() }}>
      <DialogContent data-region="modbus-group-dialog" aria-describedby={undefined}>
        <DialogTitle className="mb-3 text-sm font-medium">在 {props.device.title} 新增分组</DialogTitle>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>分组名称</Label>
            <Input aria-label="分组名称" autoFocus value={name}
              onChange={event => { setName(event.target.value) }} placeholder="如：故障报警" />
          </div>
          <div className="space-y-1">
            <Label>数据类型</Label>
            <Select value={type} onValueChange={next => setType(next as PointType)}>
              <SelectTrigger aria-label="分组数据类型"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(TYPE_LABEL) as PointType[]).map(option => (
                  <SelectItem key={option} value={option}>{TYPE_LABEL[option]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">分组内的点位都使用这一数据类型；之后在此分组下新增点位。</p>
        {error !== null && <p className="mt-2 text-xs text-destructive" data-cell="dialog-error">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={props.onClose}>取消</Button>
          <Button size="sm" onClick={save} disabled={name.trim() === ''}>保存</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** New point form inside one group: device, group, and type are locked to
 * the panel the dialog opened from; only the mapping itself is entered.
 * The name input suggests the group's declared-but-unmapped variables so
 * demand-plugin wiring stays a one-dialog step. Word order is a device
 * property; scale stays at its default here. */
function PointDialog(props: {
  ctx: Context
  device: ModbusDeviceConfig
  group: ModbusGroupConfig
  unmapped: readonly string[]
  onClose: () => void
}): ReactNode {
  const { type } = props.group
  const [name, setName] = useState('')
  const [encoding, setEncoding] = useState<ModbusPointConfig['encoding']>(ENCODINGS_BY_TYPE[type][0] ?? 'i16')
  const [fc, setFc] = useState<1 | 2 | 3 | 4>(fcOf(ENCODINGS_BY_TYPE[type][0] ?? 'i16', 3))
  const [address, setAddress] = useState(0)
  const [writable, setWritable] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isRegister = encoding !== 'coil' && encoding !== 'discrete'
  const canWrite = fc === 1 || fc === 3

  const save = (): void => {
    const point: ModbusPointConfig = {
      var: name.trim(),
      deviceId: props.device.id,
      type,
      fc,
      address,
      encoding,
      writable: canWrite ? writable : false,
      group: props.group.name,
    }
    void props.ctx.client.link.call('field.modbus.points.upsert', { point })
      .then(result => { if (result.ok) props.onClose(); else setError(rpcErrorText(result.error)) })
      .catch(() => setError('请求未送达'))
  }

  return (
    <Dialog open onOpenChange={next => { if (!next) props.onClose() }}>
      <DialogContent data-region="modbus-point-dialog" aria-describedby={undefined}>
        <DialogTitle className="mb-1 text-sm font-medium">在分组 {props.group.name} 新增点位</DialogTitle>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{props.device.title}（{props.device.id}）</span>
          <Badge variant={TYPE_VARIANT[type]}>{TYPE_LABEL[type]}</Badge>
          <span>类型随分组固定</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>点位名称</Label>
            <Input aria-label="点位名称" autoFocus value={name} list={UNMAPPED_DATALIST}
              onChange={event => { setName(event.target.value) }} placeholder="如：主轴过载" />
          </div>
          <div className="space-y-1">
            <Label>编码</Label>
            <Select value={encoding} onValueChange={next => {
              const chosen = next as ModbusPointConfig['encoding']
              setEncoding(chosen)
              setFc(fcOf(chosen, fc))
            }}>
              <SelectTrigger aria-label="编码"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ENCODINGS_BY_TYPE[type].map(option => (
                  <SelectItem key={option} value={option}>{ENCODING_LABEL[option]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>功能码</Label>
            {isRegister
              ? (
                <Select value={String(fc)} onValueChange={next => setFc(Number(next) as 1 | 2 | 3 | 4)}>
                  <SelectTrigger aria-label="功能码"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="3">03 保持寄存器</SelectItem>
                    <SelectItem value="4">04 输入寄存器</SelectItem>
                  </SelectContent>
                </Select>
              )
              : <Input aria-label="功能码" disabled value={FC_LABEL[fc]} />}
          </div>
          <div className="space-y-1">
            <Label>地址</Label>
            <Input aria-label="地址" type="number" value={address}
              onChange={event => { setAddress(Number(event.target.value)) }} />
          </div>
          {canWrite && (
            <div className="flex items-center gap-2 pt-5">
              <Checkbox id="new-point-writable" checked={writable}
                onCheckedChange={checked => setWritable(checked === true)} />
              <Label htmlFor="new-point-writable">可写</Label>
            </div>
          )}
        </div>
        <datalist id={UNMAPPED_DATALIST}>
          {props.unmapped.map(option => <option key={option} value={option} />)}
        </datalist>
        {error !== null && <p className="mt-2 text-xs text-destructive" data-cell="dialog-error">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={props.onClose}>取消</Button>
          <Button size="sm" onClick={save} disabled={name.trim() === ''}>保存</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** One mapped point row: read-only until 编辑, then the mapping form. The
 * save action leads; delete (refused for plugin-declared points) sits a
 * gap behind it in the destructive tone. */
function MappingRow(props: {
  ctx: Context
  device: ModbusDeviceConfig
  group: ModbusGroupConfig
  point: ModbusPointConfig
  declared: boolean
  onSaved: () => void
}): ReactNode {
  const { ctx } = props
  const [editing, setEditing] = useState(false)
  const [encoding, setEncoding] = useState(props.point.encoding)
  const [fc, setFc] = useState<1 | 2 | 3 | 4>(props.point.fc)
  const [address, setAddress] = useState(props.point.address)
  const [writable, setWritable] = useState(props.point.writable)
  const [error, setError] = useState<string | null>(null)
  const sample = usePoint(ctx, { device: props.device.id, group: props.group.name, name: props.point.var })

  const isRegister = encoding !== 'coil' && encoding !== 'discrete'
  const canWrite = fc === 1 || fc === 3

  const save = (): void => {
    const point: ModbusPointConfig = {
      var: props.point.var,
      deviceId: props.device.id,
      type: props.group.type,
      fc,
      address,
      encoding,
      writable: canWrite ? writable : false,
      group: props.group.name,
    }
    void ctx.client.link.call('field.modbus.points.upsert', { point })
      .then(result => {
        if (result.ok) { setEditing(false); setError(null); props.onSaved() }
        else setError(rpcErrorText(result.error))
      })
      .catch(() => setError('请求未送达'))
  }

  const cancel = (): void => {
    setEncoding(props.point.encoding)
    setFc(props.point.fc)
    setAddress(props.point.address)
    setWritable(props.point.writable)
    setEditing(false)
    setError(null)
  }

  const remove = (): void => {
    void ctx.client.link.call('field.modbus.points.remove',
      { deviceId: props.device.id, group: props.group.name, name: props.point.var })
      .then(() => props.onSaved())
  }

  return (
    <TableRow data-modbus-var-row={props.point.var}>
      <TableCell className="py-2 pr-2">
        <div className="flex items-center gap-1.5">
          <span className="whitespace-nowrap font-mono text-xs">{props.point.var}</span>
          {props.declared && <Badge variant="default">插件</Badge>}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap px-2 py-2">
        {editing
          ? (isRegister
              ? (
                <Select value={String(fc)} onValueChange={next => setFc(Number(next) as 1 | 2 | 3 | 4)}>
                  <SelectTrigger aria-label={`功能码 ${props.point.var}`} className="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="3">03 保持寄存器</SelectItem>
                    <SelectItem value="4">04 输入寄存器</SelectItem>
                  </SelectContent>
                </Select>
              )
              : <span className="whitespace-nowrap text-xs text-muted-foreground">{FC_LABEL[fc]}</span>)
          : <span className="whitespace-nowrap text-xs">{FC_LABEL[props.point.fc]}</span>}
      </TableCell>
      <TableCell className="px-2 py-2">
        {editing
          ? <Input aria-label={`地址 ${props.point.var}`} type="number" className="h-7 w-20 text-xs" value={address}
            onChange={event => setAddress(Number(event.target.value))} />
          : <span className="whitespace-nowrap font-mono text-xs">{props.point.address}</span>}
      </TableCell>
      <TableCell className="whitespace-nowrap px-2 py-2">
        {editing
          ? (
            <Select value={encoding}
              onValueChange={next => {
                const chosen = next as ModbusPointConfig['encoding']
                setEncoding(chosen)
                setFc(fcOf(chosen, fc))
              }}>
              <SelectTrigger aria-label={`编码 ${props.point.var}`} className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENCODINGS_BY_TYPE[props.group.type].map(option => (
                  <SelectItem key={option} value={option}>{ENCODING_LABEL[option]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )
          : <span className="whitespace-nowrap text-xs">{ENCODING_LABEL[props.point.encoding]}</span>}
      </TableCell>
      <TableCell className="px-2 py-2">
        {editing
          ? (canWrite
              ? <Checkbox aria-label={`可写 ${props.point.var}`} checked={writable}
                onCheckedChange={checked => setWritable(checked === true)} />
              : <span className="text-xs text-muted-foreground">只读</span>)
          : <span className="text-xs text-muted-foreground">{props.point.writable ? '可写' : '只读'}</span>}
      </TableCell>
      <TableCell className="whitespace-nowrap px-2 py-2 text-right" data-cell="value">
        <ValueCell sample={sample} />
      </TableCell>
      <TableCell className="py-2 pl-2 text-right">
        <div className="flex items-center justify-end gap-2">
          {editing
            ? (
              <>
                <Button variant="outline" size="sm" aria-label={`保存映射 ${props.point.var}`} onClick={save}>
                  <IconCheck />
                </Button>
                <Button variant="outline" size="sm" aria-label={`取消编辑 ${props.point.var}`} onClick={cancel}>
                  <IconX />
                </Button>
              </>
            )
            : (
              <>
                <Button variant="outline" size="sm" aria-label={`编辑映射 ${props.point.var}`} onClick={() => setEditing(true)}>
                  <IconPencil />
                </Button>
                {!props.declared && (
                  <Button variant="outline" size="sm" className="border-destructive/50 text-destructive hover:bg-destructive/10"
                    aria-label={`删除点位 ${props.point.var}`} onClick={remove}>
                    <IconTrash />
                  </Button>
                )}
              </>
            )}
        </div>
        {error !== null && <div className="mt-1 text-right text-[10px] text-destructive" data-cell="row-error">{error}</div>}
      </TableCell>
    </TableRow>
  )
}

/** One group panel: header (LED, name, type tag, count) and the member
 * table. The LED reads member health — green when every point observes a
 * value, yellow while part fails, red when none does. */
function GroupPanel(props: {
  ctx: Context
  device: ModbusDeviceConfig
  group: ModbusGroupConfig
  doc: ModbusDevicesDocument
  points: readonly ModbusPointConfig[]
  open: boolean
  onToggle: (open: boolean) => void
  onAddPoint: () => void
  onSaved: () => void
}): ReactNode {
  const { ctx } = props
  const view = useBinding(ctx, { device: props.device.id, group: props.group.name })
  const total = props.points.length
  let tone: LedTone
  if (total === 0) tone = 'green'
  else if (view.kind !== 'group') tone = 'yellow'
  else {
    const failures = view.abnormal.length + view.pending.length
    tone = failures === 0 ? 'green' : failures === total ? 'red' : 'yellow'
  }

  const removeGroup = (): void => {
    void ctx.client.link.call('field.modbus.groups.remove', { deviceId: props.device.id, name: props.group.name })
      .then(() => props.onSaved())
  }

  const declaredNames = new Set(declaredFor(ctx, props.device.id, props.group.name).map(def => def.name))

  return (
    <Collapsible open={props.open} onOpenChange={props.onToggle} data-group-row={`${props.device.id}:${props.group.name}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        {/* The title zone stretches: its whitespace toggles the panel too. */}
        <CollapsibleTrigger className="w-auto min-w-0 flex-1">
          <Led tone={tone} aria-label={`分组状态 ${props.group.name}`} />
          <span className="max-w-[200px] truncate text-left font-medium">{props.group.name}</span>
          <span className="whitespace-nowrap text-xs text-muted-foreground">{total} 个点位</span>
          <Badge variant={TYPE_VARIANT[props.group.type]}>{TYPE_LABEL[props.group.type]}</Badge>
        </CollapsibleTrigger>
        <Button variant="ghost" size="icon" data-testid="add-point" aria-label={`在分组 ${props.group.name} 新增点位`} onClick={props.onAddPoint}>
          <IconPlus />
        </Button>
        <Button variant="ghost" size="icon" className="border-destructive/50 text-destructive hover:bg-destructive/10"
          aria-label={`删除分组 ${props.group.name}`} onClick={removeGroup}>
          <IconTrash />
        </Button>
        <CollapsibleTrigger className="h-8 w-8 shrink-0 justify-center" aria-label={`展开或收起分组 ${props.group.name}`}>
          <CollapsibleChevron />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="pb-3">
        {total === 0 && (
          <p className="px-3 pb-2 text-xs text-muted-foreground">
            还没有点位。分组是点位的容器——点右上角"新增点位"加入第一个。
          </p>
        )}
        {total > 0 && (
          <div className="overflow-x-auto px-3">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[110px] whitespace-nowrap pr-2">点位</TableHead>
                  <TableHead className="min-w-[110px] whitespace-nowrap">功能码</TableHead>
                  <TableHead className="whitespace-nowrap">地址</TableHead>
                  <TableHead className="min-w-[90px] whitespace-nowrap">编码</TableHead>
                  <TableHead className="whitespace-nowrap">可写</TableHead>
                  <TableHead className="whitespace-nowrap text-right">当前值</TableHead>
                  <TableHead className="whitespace-nowrap" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {props.points.map(point => (
                  <MappingRow key={point.var} ctx={ctx} device={props.device} group={props.group} point={point}
                    declared={declaredNames.has(point.var)} onSaved={props.onSaved} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** One device's link parameters as a description list; the 编辑 button
 * turns the read-only list into the inline edit form (保存/取消). Word
 * order is one of the fields — it is a device-wide link property. */
function DeviceDescriptions(props: {
  ctx: Context
  device: ModbusDeviceConfig
  status: string | undefined
  onAddGroup: () => void
  onSaved: () => void
}): ReactNode {
  const { ctx } = props
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<ModbusDeviceConfig>(props.device)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setForm(props.device) }, [props.device])

  const online = props.status === 'online'
  const set = (patch: Partial<ModbusDeviceConfig>): void => setForm(current => ({ ...current, ...patch }))

  const save = (): void => {
    void ctx.client.link.call('field.modbus.devices.upsert', { device: form })
      .then(result => {
        if (result.ok) { setEditing(false); setError(null); props.onSaved() }
        else setError(rpcErrorText(result.error))
      })
      .catch(() => setError('请求未送达'))
  }

  const remove = (): void => {
    void ctx.client.link.call('field.modbus.devices.remove', { id: props.device.id }).then(() => props.onSaved())
  }

  return (
    <div data-modbus-device-row={props.device.id} className="rounded-md border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Led tone={online ? 'green' : 'red'} aria-label={`设备状态 ${props.device.title}`} />
          <span className="truncate text-xs font-medium">{props.device.title}</span>
          <span className="whitespace-nowrap text-xs text-muted-foreground">{online ? '在线' : '离线'}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" data-testid="add-group" onClick={props.onAddGroup}>
            <IconPlus />
          </Button>
          {editing
            ? (
              <>
                <Button size="sm" aria-label={`保存设备 ${props.device.id}`} onClick={save}>
                  <IconCheck />保存
                </Button>
                <Button variant="ghost" size="sm" aria-label={`取消编辑设备 ${props.device.id}`}
                  onClick={() => { setForm(props.device); setEditing(false); setError(null) }}>
                  <IconX />取消
                </Button>
              </>
            )
            : (
              <>
                <Button variant="ghost" size="sm" aria-label={`编辑设备 ${props.device.id}`} onClick={() => setEditing(true)}>
                  <IconPencil />
                </Button>
                <Button variant="ghost" size="sm" className="border-destructive/50 text-destructive hover:bg-destructive/10"
                  aria-label={`删除设备 ${props.device.id}`} onClick={remove}>
                  <IconTrash />
                </Button>
              </>
            )}
        </div>
      </div>
      {editing
        ? (
          <div className="mt-3 grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label>名称</Label>
              <Input aria-label="设备名称" value={form.title} onChange={event => set({ title: event.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>IP 地址</Label>
              <Input aria-label="IP 地址" value={form.host} onChange={event => set({ host: event.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>端口</Label>
              <Input aria-label="端口" type="number" value={form.port} onChange={event => set({ port: Number(event.target.value) })} />
            </div>
            <div className="space-y-1">
              <Label>从站号</Label>
              <Input aria-label="从站号" type="number" value={form.unitId} onChange={event => set({ unitId: Number(event.target.value) })} />
            </div>
            <div className="space-y-1">
              <Label>轮询周期 (ms)</Label>
              <Input aria-label="轮询周期" type="number" value={form.pollMs} onChange={event => set({ pollMs: Number(event.target.value) })} />
            </div>
            <div className="space-y-1">
              <Label>字序</Label>
              <Select value={form.byteOrder} onValueChange={next => set({ byteOrder: next as ModbusDeviceConfig['byteOrder'] })}>
                <SelectTrigger aria-label="字序"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="abcd">abcd</SelectItem>
                  <SelectItem value="cdab">cdab</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )
        : (
          <dl className="mt-3 grid grid-cols-3 gap-x-6 gap-y-2">
            <div>
              <dt className="text-[10px] text-muted-foreground">设备 ID</dt>
              <dd className="truncate font-mono text-xs">{props.device.id}</dd>
            </div>
            <div>
              <dt className="text-[10px] text-muted-foreground">IP 地址</dt>
              <dd className="truncate font-mono text-xs">{props.device.host}</dd>
            </div>
            <div>
              <dt className="text-[10px] text-muted-foreground">端口 / 从站号</dt>
              <dd className="font-mono text-xs">{props.device.port} / {props.device.unitId}</dd>
            </div>
            <div>
              <dt className="text-[10px] text-muted-foreground">轮询周期</dt>
              <dd className="font-mono text-xs">{props.device.pollMs}ms</dd>
            </div>
            <div>
              <dt className="text-[10px] text-muted-foreground">字序</dt>
              <dd className="font-mono text-xs">{props.device.byteOrder}</dd>
            </div>
          </dl>
        )}
      {error !== null && <p className="mt-2 text-xs text-destructive" data-cell="row-error">{error}</p>}
    </div>
  )
}

/** One device tab: the description list above the collapsible group panels.
 * New groups open themselves; collapsed ones stay collapsed across
 * document reloads. */
function DevicePanel(props: {
  ctx: Context
  device: ModbusDeviceConfig
  doc: ModbusDevicesDocument
  status: string | undefined
  onAddGroup: () => void
  onAddPoint: (group: ModbusGroupConfig) => void
  onSaved: () => void
}): ReactNode {
  const { ctx, device, doc } = props
  const groups = doc.groups
    .filter(group => group.deviceId === device.id)
    .sort((a, b) => a.name.localeCompare(b.name))
  const names = groups.map(group => group.name)
  const [open, setOpen] = useState<string[]>(names)
  const seen = useRef<string[]>(names)
  const signature = names.join('|')
  useEffect(() => {
    const previous = seen.current
    setOpen(current => names.filter(name => current.includes(name) || !previous.includes(name)))
    seen.current = names
    // The signature pin makes the effect run exactly when the group set
    // changes, not on every render.
  }, [signature])

  return (
    <div className="flex flex-col gap-3" data-region="modbus-device-panel">
      <DeviceDescriptions ctx={ctx} device={device} status={props.status}
        onAddGroup={props.onAddGroup} onSaved={props.onSaved} />

      {groups.length === 0
        ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            还没有分组。先点上方"新增分组"，再在分组里新增点位。
          </p>
        )
        : (
          <div className="flex flex-col gap-2">
            {groups.map(group => (
              <GroupPanel key={group.name} ctx={ctx} device={device} group={group} doc={doc}
                points={doc.points.filter(point => point.deviceId === device.id && point.group === group.name)}
                open={open.includes(group.name)}
                onToggle={next => setOpen(current =>
                  next ? [...current, group.name] : current.filter(name => name !== group.name))}
                onAddPoint={() => props.onAddPoint(group)} onSaved={props.onSaved} />
            ))}
          </div>
        )}
    </div>
  )
}

function ModbusPage(props: { ctx: Context }): ReactNode {
  const { ctx } = props
  const { doc, reload } = useDoc(ctx)
  const status = useConnectionStatus(ctx)
  const [activeDevice, setActiveDevice] = useState<string>('')
  const [deviceDialog, setDeviceDialog] = useState(false)
  const [groupDialogFor, setGroupDialogFor] = useState<ModbusDeviceConfig | undefined>(undefined)
  const [pointDialogFor, setPointDialogFor] = useState<{ device: ModbusDeviceConfig, group: ModbusGroupConfig } | undefined>(undefined)

  const [, setTick] = useState(0)
  useEffect(() => {
    const detach = ctx.on('variables/changed', () => setTick(value => value + 1))
    return () => { detach() }
  }, [ctx])

  if (doc === null) return <div className="text-sm text-muted-foreground">Modbus 配置读取中…</div>

  // The controlled tab value must name an existing trigger; deleting the
  // active device falls back to the first survivor.
  const active = doc.devices.some(device => device.id === activeDevice)
    ? activeDevice
    : doc.devices[0]?.id ?? ''

  return (
    <div data-region="modbus-page" className="flex flex-col gap-4">
      {/* The Tabs root must own the full row: panels live inside it, so a
        shrink-to-fit wrapper here would resize every panel with its own
        content (narrow when collapsed, overflowing when open). */}
      <Tabs value={active} onValueChange={setActiveDevice} className="flex w-full flex-col">
        <div className="flex items-center justify-between gap-2">
          <TabsList data-region="modbus-device-tabs">
            {doc.devices.map(device => (
              <TabsTrigger key={device.id} value={device.id} data-modbus-device-tab={device.id}>
                <Led tone={status[device.id] === 'online' ? 'green' : 'red'} aria-label={`设备状态 ${device.title}`} />
                {device.title}
              </TabsTrigger>
            ))}
          </TabsList>
          <Button data-testid="add-device" onClick={() => setDeviceDialog(true)}>
            <IconPlus />新增设备
          </Button>
        </div>
        {doc.devices.map(device => (
          <TabsContent key={device.id} value={device.id} className="w-full">
            <DevicePanel ctx={ctx} device={device} doc={doc} status={status[device.id]}
              onAddGroup={() => setGroupDialogFor(device)}
              onAddPoint={group => setPointDialogFor({ device, group })}
              onSaved={reload} />
          </TabsContent>
        ))}
      </Tabs>

      {doc.devices.length === 0 && (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          还没有设备。点击右上角 + 连接一台 PLC。
        </p>
      )}

      {deviceDialog && (
        <DeviceDialog ctx={ctx} onClose={() => { setDeviceDialog(false); reload() }}
          onSaved={id => setActiveDevice(id)} />
      )}
      {groupDialogFor !== undefined && (
        <GroupDialog ctx={ctx} device={groupDialogFor} onClose={() => { setGroupDialogFor(undefined); reload() }} />
      )}
      {pointDialogFor !== undefined && (
        <PointDialog ctx={ctx} device={pointDialogFor.device} group={pointDialogFor.group}
          unmapped={declaredFor(ctx, pointDialogFor.device.id, pointDialogFor.group.name)
            .filter(def => !doc.points.some(point =>
              point.deviceId === def.device && point.group === def.group && point.var === def.name))
            .map(def => def.name)}
          onClose={() => { setPointDialogFor(undefined); reload() }} />
      )}
    </div>
  )
}

/** The ModbusTCP settings-page occupant. */
const modbusStationPlugin: Plugin.Object<void> = {
  name: 'modbus-station',
  inject: ['settingsPages', 'variables', 'client'],
  apply(ctx: Context): void {
    ctx.settingsPages.register(ctx, {
      id: 'modbus',
      title: 'ModbusTCP',
      order: 10,
      render(): ReactNode {
        return <ModbusPage ctx={ctx} />
      },
    })
  },
}

export default modbusStationPlugin
