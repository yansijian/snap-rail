/**
 * The ModbusTCP settings page: devices and their variable mappings, edited
 * through the driver's `modbus.*` methods and persisted in the driver's
 * store tables. Mapped variables come from the variable registry (demand
 * plugins) plus hand debugging variables declared right here — the
 * empty-registry acceptance path for a fresh station. Each mapping row
 * shows its live value (seeded read + updates) so a link can be verified
 * on sight.
 *
 * @module @snap-rail/modbus-station
 */

import { Context, type Plugin } from '@snap-rail/cordis'
import '@snap-rail/client-runtime'
import '@snap-rail/client-settings'
import { usePoint } from '@snap-rail/client-variables'
import {
  Badge, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Dialog, DialogContent, DialogTitle,
  Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@snap-rail/client-ui'
import type { ModbusDeviceConfig, ModbusDevicesDocument, ModbusPointConfig } from '@snap-rail/protocol'
import { useEffect, useState, type ReactNode } from 'react'

type PointType = 'bool' | 'int' | 'float'

/** One variable row: registry or manual origin. */
interface VarRow {
  name: string
  type: PointType
  source: 'plugin' | 'manual'
}

/** V1 mappings carry bool/int/float; string variables have no Modbus encoding. */
function mappableType(type: string): PointType | undefined {
  return type === 'bool' || type === 'int' || type === 'float' ? type : undefined
}

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

/** Two-register encodings carry a word order choice. */
function is32(encoding: ModbusPointConfig['encoding']): boolean {
  return encoding === 'i32' || encoding === 'u32' || encoding === 'f32'
}

const ENCODING_LABEL: Record<string, string> = {
  coil: '线圈', discrete: '离散输入', i16: 'int16', u16: 'uint16',
  i32: 'int32', u32: 'uint32', f32: 'float32',
}

const FC_LABEL: Record<number, string> = { 1: '01 线圈', 2: '02 离散输入', 3: '03 保持寄存器', 4: '04 输入寄存器' }

const TYPE_LABEL: Record<PointType, string> = { bool: '开关 (bool)', int: '整数 (int)', float: '小数 (float)' }

/** The "no device" select value; Radix items reject empty strings. */
const NO_DEVICE = '__none__'

function useDoc(ctx: Context): { doc: ModbusDevicesDocument | null, reload: () => void } {
  const [doc, setDoc] = useState<ModbusDevicesDocument | null>(null)
  const reload = (): void => {
    void ctx.client.link.call('modbus.devices.list', {})
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
      void ctx.client.link.call('connections.list', {})
        .then(result => {
          if (!result.ok) return
          const next: Record<string, string> = {}
          for (const connection of result.value.connections) next[connection.id as string] = connection.status
          setStatus(next)
        })
        .catch(() => {})
    }
    refresh()
    const detach = ctx.client.link.subscribe('connection/status', payload => {
      const frame = payload as { id?: string, status?: string }
      if (frame.id !== undefined && frame.status !== undefined) {
        setStatus(current => ({ ...current, [frame.id as string]: frame.status as string }))
      }
    })
    return () => { detach() }
  }, [ctx])
  return status
}

/** Merged variable rows: registry declarations first, manual vars after. */
function mergeVars(ctx: Context, doc: ModbusDevicesDocument | null): VarRow[] {
  const rows = new Map<string, VarRow>()
  for (const def of ctx.variables.list()) {
    const type = mappableType(def.type)
    if (type !== undefined) rows.set(def.name, { name: def.name, type, source: 'plugin' })
  }
  for (const def of doc?.vars ?? []) {
    if (!rows.has(def.name)) rows.set(def.name, { name: def.name, type: def.type, source: 'manual' })
  }
  return [...rows.values()]
}

function fmtValue(value: unknown): string {
  if (value === undefined) return '—'
  if (value === null) return '异常'
  if (typeof value === 'boolean') return value ? '开' : '关'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return String(Math.round(value * 1000) / 1000)
  return String(value)
}

/** Add-or-edit device form. */
function DeviceDialog(props: { ctx: Context, initial: ModbusDeviceConfig | null, onClose: () => void }): ReactNode {
  const [form, setForm] = useState<ModbusDeviceConfig>(props.initial ?? {
    id: '', title: '', host: '', port: 502, unitId: 1, pollMs: 1000, timeoutMs: 1000, enabled: true,
  })
  const [probe, setProbe] = useState<string | null>(null)
  const set = (patch: Partial<ModbusDeviceConfig>): void => setForm(current => ({ ...current, ...patch }))

  const save = (): void => {
    void props.ctx.client.link.call('modbus.devices.upsert', { device: { ...form, id: form.id.trim() } })
      .then(result => { if (result.ok) props.onClose() })
  }
  const test = (): void => {
    setProbe('测试中…')
    void props.ctx.client.link.call('modbus.devices.test', { device: form })
      .then(result => {
        setProbe(result.ok && result.value.ok ? '连接成功' : `失败：${result.ok ? result.value.error : '请求被拒绝'}`)
      })
      .catch(() => setProbe('失败：请求未送达'))
  }

  return (
    <Dialog open onOpenChange={next => { if (!next) props.onClose() }}>
      <DialogContent data-region="modbus-device-dialog" aria-describedby={undefined}>
        <DialogTitle className="mb-3 text-sm font-medium">{props.initial === null ? '新增设备' : '编辑设备'}</DialogTitle>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>设备 ID</Label>
            <Input aria-label="设备 ID" value={form.id} disabled={props.initial !== null}
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
        </div>
        {probe !== null && <p className="mt-3 text-xs text-muted-foreground">{probe}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={test}>测试连接</Button>
          <Button variant="ghost" size="sm" onClick={props.onClose}>取消</Button>
          <Button size="sm" onClick={save} disabled={form.id.trim() === '' || form.host.trim() === ''}>保存</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** New manual (debugging) variable form. */
function VarDialog(props: { ctx: Context, onClose: () => void }): ReactNode {
  const [name, setName] = useState('')
  const [type, setType] = useState<PointType>('float')
  const save = (): void => {
    void props.ctx.client.link.call('modbus.vars.upsert', { name: name.trim(), type })
      .then(result => { if (result.ok) props.onClose() })
  }
  return (
    <Dialog open onOpenChange={next => { if (!next) props.onClose() }}>
      <DialogContent data-region="modbus-var-dialog" aria-describedby={undefined}>
        <DialogTitle className="mb-3 text-sm font-medium">新增调试变量</DialogTitle>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>变量名</Label>
            <Input aria-label="变量名" value={name} onChange={event => setName(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>数据类型</Label>
            <Select value={type} onValueChange={next => setType(next as PointType)}>
              <SelectTrigger aria-label="数据类型">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(TYPE_LABEL) as PointType[]).map(option => (
                  <SelectItem key={option} value={option}>{TYPE_LABEL[option]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={props.onClose}>取消</Button>
          <Button size="sm" onClick={save} disabled={name.trim() === ''}>保存</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** One mapping row: variable identity on the left, mapping form on the right. */
function MappingRow(props: { ctx: Context, row: VarRow, mapped: ModbusPointConfig | undefined, devices: readonly ModbusDeviceConfig[], onSaved: () => void }): ReactNode {
  const existing = props.mapped
  const [deviceId, setDeviceId] = useState(existing?.deviceId ?? '')
  const [encoding, setEncoding] = useState<ModbusPointConfig['encoding']>(existing?.encoding ?? ENCODINGS_BY_TYPE[props.row.type][0] ?? 'i16')
  const [fc, setFc] = useState<1 | 2 | 3 | 4>(existing?.fc ?? fcOf(encoding, 3))
  const [address, setAddress] = useState(existing?.address ?? 0)
  const [byteOrder, setByteOrder] = useState<'abcd' | 'cdab'>(existing?.byteOrder ?? 'abcd')
  const [scale, setScale] = useState(existing?.scale ?? 1)
  const [writable, setWritable] = useState(existing?.writable ?? false)
  const [saved, setSaved] = useState(false)
  const sample = usePoint(props.ctx, props.row.name)

  // Only offer encodings the declared type can carry.
  const encodings = ENCODINGS_BY_TYPE[props.row.type]
  const isRegister = encoding !== 'coil' && encoding !== 'discrete'
  const floatOnly = encoding === 'f32'
  const canWrite = fc === 1 || fc === 3

  const save = (): void => {
    const point: ModbusPointConfig = {
      var: props.row.name,
      deviceId,
      type: props.row.type,
      fc,
      address,
      encoding,
      byteOrder: is32(encoding) ? byteOrder : 'abcd',
      writable: canWrite ? writable : false,
    }
    if (floatOnly) { point.scale = scale !== 0 ? scale : 1 }
    void props.ctx.client.link.call('modbus.points.upsert', { point })
      .then(result => { if (result.ok) { setSaved(true); props.onSaved() } })
      .catch(() => {})
  }

  return (
    <TableRow data-modbus-var-row={props.row.name}>
      <TableCell className="py-2 pr-2">
        <div className="whitespace-nowrap font-mono text-xs">{props.row.name}</div>
        <div className="mt-1"><Badge variant={props.row.source === 'plugin' ? 'default' : 'outline'}>{props.row.source === 'plugin' ? '插件' : '手动'}</Badge></div>
      </TableCell>
      <TableCell className="whitespace-nowrap px-2 py-2 text-xs">{props.row.type}</TableCell>
      <TableCell className="px-2 py-2">
        <Select value={deviceId === '' ? NO_DEVICE : deviceId}
          onValueChange={next => setDeviceId(next === NO_DEVICE ? '' : next)}>
          <SelectTrigger aria-label={`设备 ${props.row.name}`} className="h-7 text-xs">
            <SelectValue placeholder="未选设备" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_DEVICE}>未选设备</SelectItem>
            {props.devices.map(device => (
              <SelectItem key={device.id} value={device.id}>{device.title}（{device.id}）</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="px-2 py-2">
        {isRegister
          ? (
            <Select value={String(fc)} onValueChange={next => setFc(Number(next) as 1 | 2 | 3 | 4)}>
              <SelectTrigger aria-label={`功能码 ${props.row.name}`} className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="3">03 保持寄存器</SelectItem>
                <SelectItem value="4">04 输入寄存器</SelectItem>
              </SelectContent>
            </Select>
          )
          : <span className="whitespace-nowrap text-xs text-muted-foreground">{FC_LABEL[fc]}</span>}
      </TableCell>
      <TableCell className="px-2 py-2">
        <Input aria-label={`地址 ${props.row.name}`} type="number" className="h-7 w-20 text-xs" value={address}
          onChange={event => setAddress(Number(event.target.value))} />
      </TableCell>
      <TableCell className="px-2 py-2">
        <Select value={encoding}
          onValueChange={next => {
            const chosen = next as ModbusPointConfig['encoding']
            setEncoding(chosen)
            setFc(fcOf(chosen, fc))
          }}>
          <SelectTrigger aria-label={`编码 ${props.row.name}`} className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {encodings.map(option => (
              <SelectItem key={option} value={option}>{ENCODING_LABEL[option]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="px-2 py-2">
        {is32(encoding)
          ? (
            <Select value={byteOrder} onValueChange={next => setByteOrder(next as 'abcd' | 'cdab')}>
              <SelectTrigger aria-label={`字序 ${props.row.name}`} className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="abcd">abcd</SelectItem>
                <SelectItem value="cdab">cdab</SelectItem>
              </SelectContent>
            </Select>
          )
          : <span className="text-xs text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="px-2 py-2">
        {floatOnly
          ? <Input aria-label={`倍率 ${props.row.name}`} type="number" className="h-7 w-16 text-xs" value={scale}
              onChange={event => setScale(Number(event.target.value))} />
          : <span className="text-xs text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="px-2 py-2">
        {canWrite
          ? <Checkbox aria-label={`可写 ${props.row.name}`} checked={writable}
              onCheckedChange={checked => setWritable(checked === true)} />
          : <span className="text-xs text-muted-foreground">只读</span>}
      </TableCell>
      <TableCell className="whitespace-nowrap px-2 py-2 text-right font-mono text-xs" data-cell="value">{fmtValue(sample?.value)}</TableCell>
      <TableCell className="py-2 pl-2 text-right">
        <div className="flex items-center justify-end gap-1">
          {props.row.source === 'manual' && (
            <Button variant="ghost" size="sm" aria-label={`删除变量 ${props.row.name}`}
              onClick={() => { void props.ctx.client.link.call('modbus.vars.remove', { name: props.row.name }).then(() => props.onSaved()) }}>
              删除
            </Button>
          )}
          <Button size="sm" aria-label={`保存映射 ${props.row.name}`} disabled={deviceId === ''} onClick={save}>保存</Button>
        </div>
        {saved && <div className="mt-1 text-right text-[10px] text-muted-foreground">已保存，正在生效</div>}
      </TableCell>
    </TableRow>
  )
}

function ModbusPage(props: { ctx: Context }): ReactNode {
  const { ctx } = props
  const { doc, reload } = useDoc(ctx)
  const status = useConnectionStatus(ctx)
  const [deviceDialog, setDeviceDialog] = useState<ModbusDeviceConfig | null | undefined>(undefined)
  const [varDialog, setVarDialog] = useState(false)

  const [, setTick] = useState(0)
  useEffect(() => {
    const detach = ctx.on('variables/changed', () => setTick(value => value + 1))
    return () => { detach() }
  }, [ctx])

  if (doc === null) return <div className="text-sm text-muted-foreground">Modbus 配置读取中…</div>

  const vars = mergeVars(ctx, doc)
  const pointOf = (name: string): ModbusPointConfig | undefined => doc.points.find(point => point.var === name)

  return (
    <div data-region="modbus-page" className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>设备</CardTitle>
          <Button size="sm" data-testid="add-device" onClick={() => setDeviceDialog(null)}>新增设备</Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {doc.devices.length === 0 && <p className="text-xs text-muted-foreground">还没有设备。输入 IP 与端口即可连接一台 PLC。</p>}
          {doc.devices.map(device => (
            <div key={device.id} data-modbus-device-row={device.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-xs font-medium">{device.title}</span>
                <span className="font-mono text-xs text-muted-foreground">{device.host}:{device.port} · 站 {device.unitId} · {device.pollMs}ms</span>
                <Badge variant={status[device.id] === 'online' ? 'success' : 'destructive'}>{status[device.id] === 'online' ? '在线' : '离线'}</Badge>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => setDeviceDialog(device)}>编辑</Button>
                <Button variant="ghost" size="sm" aria-label={`删除设备 ${device.id}`}
                  onClick={() => { void ctx.client.link.call('modbus.devices.remove', { id: device.id }).then(() => reload()) }}>
                  删除
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>监听变量</CardTitle>
          <Button size="sm" data-testid="add-var" onClick={() => setVarDialog(true)}>新增调试变量</Button>
        </CardHeader>
        <CardContent>
          {/* Column min-widths keep labels on one line; the wrapper scrolls. */}
          <Table className="min-w-[880px]">
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[110px] whitespace-nowrap pr-2">变量</TableHead>
                <TableHead className="whitespace-nowrap">类型</TableHead>
                <TableHead className="min-w-[140px] whitespace-nowrap">设备</TableHead>
                <TableHead className="min-w-[110px] whitespace-nowrap">功能码</TableHead>
                <TableHead className="whitespace-nowrap">地址</TableHead>
                <TableHead className="min-w-[90px] whitespace-nowrap">编码</TableHead>
                <TableHead className="whitespace-nowrap">字序</TableHead>
                <TableHead className="whitespace-nowrap">倍率</TableHead>
                <TableHead className="whitespace-nowrap">可写</TableHead>
                <TableHead className="whitespace-nowrap text-right">当前值</TableHead>
                <TableHead className="whitespace-nowrap" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {vars.map(row => (
                <MappingRow key={`${row.source}-${row.name}`} ctx={ctx} row={row} mapped={pointOf(row.name)} devices={doc.devices} onSaved={reload} />
              ))}
              {vars.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="py-3 text-xs text-muted-foreground">
                    还没有变量。需求插件声明的变量会出现在这里；也可以手动新增调试变量先行接线。
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {deviceDialog !== undefined && (
        <DeviceDialog ctx={ctx} initial={deviceDialog} onClose={() => { setDeviceDialog(undefined); reload() }} />
      )}
      {varDialog && <VarDialog ctx={ctx} onClose={() => { setVarDialog(false); reload() }} />}
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
