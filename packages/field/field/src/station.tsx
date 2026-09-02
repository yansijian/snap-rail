/**
 * 设备管理 (the unified field settings page): every configured device as a
 * tab — its connection LED and one-shot probe, typed group panels with
 * health LEDs, and point tables with live values. Everything is driven by
 * the base's own tables (`field.config.list`) plus each driver's JSON-Schema
 * forms (SchemaForm); drivers ship zero renderer code. The base fields —
 * device name, group name and type, point name — are first-class controls
 * here, the dialect rest rides the driver's schema.
 *
 * @module @snap-rail/field/station
 */

import { Context, type Plugin } from '@snap-rail/cordis'
// The settings-page seam's declaration merging (the inject below needs it).
import '@snap-rail/client-settings'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { rpcErrorText, subscribeFrame, type HostLink } from '@snap-rail/connection'
import {
  Badge,
  Button,
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  Input,
  Label,
  Led,
  SchemaForm,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
  TouchSelect,
  compactSchemaValue,
  schemaDefaults,
  type SchemaFormValue,
} from '@snap-rail/client-ui'
import {
  fieldFrameSchemas,
  type ConfigDevice,
  type ConfigGroup,
  type DriverInfo,
} from './wire.ts'
import type { ConnectionSnapshot, PointRef, PointSample } from './model.ts'

/** The settings page id this face registers under. */
const PAGE_ID = 'field'

/** The tab value reserved for the new-device trigger. */
const NEW_DEVICE_TAB = '__new__'

/**
 * The renderer's host-link service (declared by client-runtime). Reached via
 * `ctx.get` instead of an import: runtime pulls variables which pulls this
 * package, so a source import here would loop the spine's project graph.
 */
interface ClientLinkService {
  link: HostLink
}

/** A pending dialog plus everything its body needs. */
type DialogState =
  | { kind: 'device-create' }
  | { kind: 'device-edit', device: ConfigDevice }
  | { kind: 'group-create', deviceId: string }
  | { kind: 'point-create', deviceId: string, group: ConfigGroup }
  | { kind: 'point-edit', deviceId: string, group: ConfigGroup, name: string, config: Record<string, unknown> }
  | { kind: 'confirm', title: string, message: string, danger: () => Promise<void> | void }
  | undefined

/** Extract a driver's accepted group types (its point schema's type enum). */
function groupTypesOf(driver: DriverInfo | undefined): string[] {
  const properties = (driver?.schemas.point as { properties?: Record<string, unknown> } | undefined)?.properties
  const typeProperty = properties?.['type'] as { enum?: unknown } | undefined
  if (typeProperty !== undefined && Array.isArray(typeProperty.enum)) {
    const values = typeProperty.enum.filter((entry): entry is string => typeof entry === 'string')
    if (values.length > 0) return values
  }
  return ['bool', 'int', 'float', 'string']
}

/** The connection line of one device as the header renders it. */
function DeviceLinkLine(props: { snapshot: ConnectionSnapshot | undefined }): ReactNode {
  const { snapshot } = props
  if (snapshot === undefined) {
    return (
      <span className="flex items-center gap-2 text-sm text-muted-foreground" data-device-status="missing">
        <Led tone="red" />
        驱动未加载
      </span>
    )
  }
  const tone = snapshot.status === 'online' ? 'green' : snapshot.status === 'connecting' ? 'yellow' : 'red'
  const text = snapshot.status === 'online' ? '在线' : snapshot.status === 'connecting' ? '连接中' : '离线'
  return (
    <span className="flex items-center gap-2 text-sm" data-device-status={snapshot.status}>
      <Led tone={tone} />
      {text}
      {snapshot.message !== undefined && (
        <span className="max-w-64 truncate text-xs text-muted-foreground" title={snapshot.message}>{snapshot.message}</span>
      )}
    </span>
  )
}

/** One point's live value cell: subscribe on mount, show the latest sample. */
function PointValueCell(props: {
  link: HostLink
  ref: PointRef
  onSample: (name: string, sample: PointSample) => void
}): ReactNode {
  const { link, ref, onSample } = props
  const [sample, setSample] = useState<PointSample | undefined>(undefined)
  const notify = useRef(onSample)
  notify.current = onSample

  useEffect(() => {
    let alive = true
    void link.call('field.points.read', { points: [ref] }).then(result => {
      if (!alive || !result.ok) return
      const first = result.value.samples[0]
      if (first !== undefined) {
        setSample(first)
        notify.current(ref.name, first)
      }
    })
    void link.call('field.points.subscribe', { points: [ref] }).catch(() => undefined)
    const detach = subscribeFrame(link, 'field/point-updated', fieldFrameSchemas['field/point-updated'], frame => {
      if (frame.device !== ref.device || frame.group !== ref.group || frame.name !== ref.name) return
      setSample(frame)
      notify.current(ref.name, frame)
    })
    return () => {
      alive = false
      detach()
      void link.call('field.points.unsubscribe', { points: [ref] }).catch(() => undefined)
    }
  }, [link, ref.device, ref.group, ref.name])

  if (sample === undefined || sample.time === 0) {
    return <span className="font-mono text-muted-foreground" data-point-value="pending">…</span>
  }
  if (sample.value === null) {
    return <span className="font-mono text-destructive" data-point-value="abnormal">异常</span>
  }
  const text = typeof sample.value === 'boolean' ? (sample.value ? '开' : '关') : String(sample.value)
  return <span className="font-mono tabular-nums" data-point-value="ok">{text}</span>
}

/** One typed group: health LED over its members' live values, point table. */
function GroupPanel(props: {
  link: HostLink
  deviceId: string
  device: string
  group: ConfigGroup
  driver: DriverInfo | undefined
  onDialog: (dialog: DialogState) => void
}): ReactNode {
  const { link, deviceId, device, group, driver, onDialog } = props
  /** Latest sample per member name (undefined = never observed). */
  const [samples, setSamples] = useState<Record<string, PointSample | undefined>>({})
  const onSample = useCallback((name: string, sample: PointSample) => {
    setSamples(previous => ({ ...previous, [name]: sample }))
  }, [])

  let tone: 'green' | 'yellow' | 'red' = 'green'
  if (group.points.length > 0) {
    const values = group.points.map(point => samples[point.name]?.value)
    const abnormal = values.filter(value => value === null).length
    const pending = values.filter(value => value === undefined).length
    tone = abnormal === values.length ? 'red' : abnormal + pending > 0 ? 'yellow' : 'green'
  }

  return (
    <Collapsible defaultOpen className="rounded-lg border border-border" data-group={group.name}>
      <div className="flex items-center gap-2 px-3 py-2">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <span className={group.points.length > 0 ? '' : 'invisible'}><Led tone={tone} data-group-led={group.name} /></span>
          <span className="min-w-0 truncate text-base font-medium">{group.name}</span>
          <Badge variant="secondary">{group.type}</Badge>
          <span className="text-sm text-muted-foreground">{group.points.length} 点</span>
          <CollapsibleChevron />
        </CollapsibleTrigger>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={driver === undefined}
          onClick={() => { onDialog({ kind: 'point-create', deviceId, group }) }}
        >
          加点
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => {
            onDialog({
              kind: 'confirm',
              title: '删除分组',
              message: `删除分组「${device}/${group.name}」及其全部 ${group.points.length} 个点位？`,
              danger: () => { void link.call('field.groups.remove', { device, group: group.name }) },
            })
          }}
        >
          删组
        </Button>
      </div>
      <CollapsibleContent>
        {group.points.length === 0
          ? <div className="border-t border-border px-4 py-3 text-sm text-muted-foreground">暂无点位</div>
          : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-1/3">点位</TableHead>
                    <TableHead>实时值</TableHead>
                    <TableHead className="w-28 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.points.map(point => (
                    <TableRow key={point.name}>
                      <TableCell className="font-medium">{point.name}</TableCell>
                      <TableCell>
                        <PointValueCell
                          link={link}
                          ref={{ device, group: group.name, name: point.name }}
                          onSample={onSample}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            onDialog({
                              kind: 'point-edit',
                              deviceId,
                              group,
                              name: point.name,
                              config: point.config,
                            })
                          }}
                        >
                          编辑
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => {
                            onDialog({
                              kind: 'confirm',
                              title: '删除点位',
                              message: `删除点位「${device}/${group.name}/${point.name}」？`,
                              danger: () => {
                                void link.call('field.points.remove', { device, group: group.name, name: point.name })
                              },
                            })
                          }}
                        >
                          删除
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** One device tab body: link line, probe, groups. */
function DevicePanel(props: {
  link: HostLink
  device: ConfigDevice
  snapshot: ConnectionSnapshot | undefined
  driver: DriverInfo | undefined
  onDialog: (dialog: DialogState) => void
}): ReactNode {
  const { link, device, snapshot, driver, onDialog } = props
  const [probe, setProbe] = useState<{ phase: 'idle' | 'running', ok?: boolean, message?: string }>({ phase: 'idle' })

  const runProbe = (): void => {
    setProbe({ phase: 'running' })
    void link.call('field.devices.test', { device: { driver: device.driver, config: device.config } })
      .then(result => {
        if (result.ok) setProbe({ phase: 'idle', ok: result.value.ok, message: result.value.message })
        else setProbe({ phase: 'idle', ok: false, message: rpcErrorText(result.error) })
      })
  }

  return (
    <div className="grid gap-4" data-device-panel={device.id}>
      <div className="flex flex-wrap items-center gap-3">
        <DeviceLinkLine snapshot={snapshot} />
        <Badge variant="outline">{driver?.title ?? device.driver}</Badge>
        {driver?.canProbe === true && (
          <Button type="button" variant="outline" size="sm" disabled={probe.phase === 'running'} onClick={runProbe}>
            {probe.phase === 'running' ? '测试中…' : '测试连接'}
          </Button>
        )}
        {probe.message !== undefined && (
          <span className={`text-sm ${probe.ok === true ? 'text-success' : 'text-destructive'}`} data-probe-result>
            {probe.ok === true ? '✓' : '✕'} {probe.message}
          </span>
        )}
        <span className="flex-1" />
        <Button type="button" variant="outline" size="sm" onClick={() => { onDialog({ kind: 'device-edit', device }) }}>
          编辑设备
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => {
            onDialog({
              kind: 'confirm',
              title: '删除设备',
              message: `删除设备「${device.name}」及其全部分组与点位？`,
              danger: () => { void link.call('field.devices.remove', { id: device.id }) },
            })
          }}
        >
          删除设备
        </Button>
      </div>

      {device.groups.length === 0
        ? <div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">尚无分组——先建分组，再在组内加点</div>
        : device.groups.map(group => (
            <GroupPanel
              key={group.name}
              link={link}
              deviceId={device.id}
              device={device.id}
              group={group}
              driver={driver}
              onDialog={onDialog}
            />
          ))}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => { onDialog({ kind: 'group-create', deviceId: device.id }) }}>
          新建分组
        </Button>
      </div>
    </div>
  )
}

/** One pending dialog; every submit targets the base's CRUD methods. */
function StationDialog(props: {
  link: HostLink
  dialog: Exclude<DialogState, undefined>
  drivers: readonly DriverInfo[]
  devices: readonly ConfigDevice[]
  onClose: () => void
}): ReactNode {
  const { link, dialog, drivers, devices, onClose } = props

  if (dialog.kind === 'confirm') {
    return (
      <Dialog open onOpenChange={open => { if (!open) onClose() }}>
        <DialogContent aria-describedby={undefined} className="max-w-sm">
          <DialogTitle className="text-base font-medium">{dialog.title}</DialogTitle>
          <p className="text-sm text-muted-foreground">{dialog.message}</p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>取消</Button>
            <Button type="button" variant="destructive" data-confirm-danger onClick={() => { void dialog.danger(); onClose() }}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  if (dialog.kind === 'device-create' || dialog.kind === 'device-edit') {
    return <DeviceDialog link={link} dialog={dialog} drivers={drivers} onClose={onClose} />
  }

  // Group and point dialogs need the owning device's driver (its schemas).
  const ownerDriver = drivers.find(driver => driver.id === devices.find(device => device.id === dialog.deviceId)?.driver)

  if (dialog.kind === 'group-create') {
    return <GroupDialog link={link} deviceId={dialog.deviceId} types={groupTypesOf(ownerDriver)} onClose={onClose} />
  }

  return <PointDialog link={link} dialog={dialog} driver={ownerDriver} onClose={onClose} />
}

/** 新建/编辑设备：名称、驱动（创建时）、方言配置（SchemaForm）。 */
function DeviceDialog(props: {
  link: HostLink
  dialog: { kind: 'device-create' } | { kind: 'device-edit', device: ConfigDevice }
  drivers: readonly DriverInfo[]
  onClose: () => void
}): ReactNode {
  const { link, dialog, drivers, onClose } = props
  const editing = dialog.kind === 'device-edit'
  const [name, setName] = useState(editing ? dialog.device.name : '')
  const [driverId, setDriverId] = useState(editing ? dialog.device.driver : drivers[0]?.id ?? '')
  const driver = drivers.find(entry => entry.id === driverId)
  const [value, setValue] = useState<SchemaFormValue>(
    editing ? dialog.device.config as SchemaFormValue : driver !== undefined ? schemaDefaults(driver.schemas.device) : {},
  )
  const [error, setError] = useState<string | undefined>(undefined)

  const switchDriver = (next: string): void => {
    setDriverId(next)
    const nextDriver = drivers.find(entry => entry.id === next)
    setValue(nextDriver !== undefined ? schemaDefaults(nextDriver.schemas.device) : {})
  }

  const submit = (): void => {
    if (driver === undefined) { setError('请选择驱动'); return }
    void link.call('field.devices.upsert', {
      device: {
        ...(editing ? { id: dialog.device.id } : {}),
        name,
        driver: driverId,
        config: compactSchemaValue(value),
      },
    }).then(result => {
      if (result.ok) onClose()
      else setError(rpcErrorText(result.error))
    })
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent aria-describedby={undefined} className="max-w-lg">
        <DialogTitle className="text-base font-medium">{editing ? '编辑设备' : '新建设备'}</DialogTitle>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="field-device-name">设备名称 <span className="text-destructive">*</span></Label>
            <Input
              id="field-device-name"
              value={name}
              onChange={event => { setName(event.target.value) }}
              placeholder="如 1号炉"
              data-device-name
            />
          </div>
          {!editing && (
            <div className="grid gap-2">
              <Label>通讯驱动 <span className="text-destructive">*</span></Label>
              <TouchSelect
                label="通讯驱动"
                value={driverId}
                onValueChange={switchDriver}
                options={drivers.map(entry => ({ value: entry.id, label: entry.title }))}
              />
            </div>
          )}
          {driver !== undefined && (
            <SchemaForm schema={driver.schemas.device} value={value} onChange={setValue} />
          )}
          {error !== undefined && <p className="text-sm text-destructive" data-dialog-error>{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>取消</Button>
          <Button type="button" disabled={name.trim() === '' || driver === undefined} onClick={submit} data-dialog-submit>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 新建分组：名称 + 类型（驱动 point schema 的 type enum）。 */
function GroupDialog(props: {
  link: HostLink
  deviceId: string
  types: string[]
  onClose: () => void
}): ReactNode {
  const { link, deviceId, types, onClose } = props
  const [name, setName] = useState('')
  const [type, setType] = useState(types[0] ?? 'bool')
  const [error, setError] = useState<string | undefined>(undefined)

  const submit = (): void => {
    void link.call('field.groups.upsert', {
      device: deviceId,
      group: { name, type: type as 'bool' | 'int' | 'float' | 'string' },
    }).then(result => {
      if (result.ok) onClose()
      else setError(rpcErrorText(result.error))
    })
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent aria-describedby={undefined} className="max-w-sm">
        <DialogTitle className="text-base font-medium">新建分组</DialogTitle>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="field-group-name">分组名称 <span className="text-destructive">*</span></Label>
            <Input
              id="field-group-name"
              value={name}
              onChange={event => { setName(event.target.value) }}
              placeholder="如 温度"
              data-group-name
            />
          </div>
          <div className="grid gap-2">
            <Label>数据类型 <span className="text-destructive">*</span></Label>
            <TouchSelect
              label="数据类型"
              value={type}
              onValueChange={setType}
              options={types.map(entry => ({ value: entry, label: entry }))}
            />
          </div>
          {error !== undefined && <p className="text-sm text-destructive" data-dialog-error>{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>取消</Button>
          <Button type="button" disabled={name.trim() === ''} onClick={submit} data-dialog-submit>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 新建/编辑点位：名称 + 方言配置（SchemaForm，type 由分组携带）。 */
function PointDialog(props: {
  link: HostLink
  dialog: { kind: 'point-create', deviceId: string, group: ConfigGroup } | { kind: 'point-edit', deviceId: string, group: ConfigGroup, name: string, config: Record<string, unknown> }
  driver: DriverInfo | undefined
  onClose: () => void
}): ReactNode {
  const { link, dialog, driver, onClose } = props
  const editing = dialog.kind === 'point-edit'
  const [error, setError] = useState<string | undefined>(undefined)
  const [name, setName] = useState(editing ? dialog.name : '')
  const [value, setValue] = useState<SchemaFormValue>(
    editing ? dialog.config as SchemaFormValue : driver !== undefined ? schemaDefaults(driver.schemas.point) : {},
  )

  const submit = (): void => {
    void link.call('field.points.upsert', {
      device: dialog.deviceId,
      group: dialog.group.name,
      point: { name, config: compactSchemaValue(value) },
    }).then(result => {
      if (result.ok) onClose()
      else setError(rpcErrorText(result.error))
    })
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent aria-describedby={undefined} className="max-w-lg">
        <DialogTitle className="text-base font-medium">
          {editing ? '编辑点位' : `在「${dialog.group.name}」加点`}
        </DialogTitle>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="field-point-name">点位名称 <span className="text-destructive">*</span></Label>
            <Input
              id="field-point-name"
              value={name}
              onChange={event => { setName(event.target.value) }}
              placeholder="业务名，如 温度1"
              data-point-name
            />
          </div>
          {driver !== undefined && (
            <SchemaForm
              schema={driver.schemas.point}
              value={value}
              onChange={setValue}
              hidden={['type']}
            />
          )}
          {error !== undefined && <p className="text-sm text-destructive" data-dialog-error>{error}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>取消</Button>
          <Button type="button" disabled={name.trim() === ''} onClick={submit} data-dialog-submit>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The field settings page: device tabs over the base's config tree. */
function FieldStationPage(props: { link: HostLink }): ReactNode {
  const link = props.link
  const [drivers, setDrivers] = useState<readonly DriverInfo[]>([])
  const [devices, setDevices] = useState<readonly ConfigDevice[]>([])
  const [links, setLinks] = useState<readonly ConnectionSnapshot[]>([])
  const [dialog, setDialog] = useState<DialogState>(undefined)
  const [active, setActive] = useState<string | undefined>(undefined)

  const reloadDrivers = useCallback(() => {
    void link.call('field.drivers.list', {}).then(result => {
      if (result.ok) setDrivers(result.value.drivers)
    })
  }, [link])
  const reloadConfig = useCallback(() => {
    void link.call('field.config.list', {}).then(result => {
      if (result.ok) setDevices(result.value.config.devices)
    })
  }, [link])
  const reloadLinks = useCallback(() => {
    void link.call('field.connections.list', {}).then(result => {
      if (result.ok) setLinks(result.value.connections)
    })
  }, [link])

  useEffect(() => {
    reloadDrivers()
    reloadConfig()
    reloadLinks()
    const detachStructure = subscribeFrame(link, 'field/structure-changed', fieldFrameSchemas['field/structure-changed'], () => {
      reloadConfig()
      reloadDrivers()
    })
    const detachStatus = subscribeFrame(link, 'field/connection-status', fieldFrameSchemas['field/connection-status'], reloadLinks)
    const detachAdded = subscribeFrame(link, 'field/connection-added', fieldFrameSchemas['field/connection-added'], reloadLinks)
    const detachRemoved = subscribeFrame(link, 'field/connection-removed', fieldFrameSchemas['field/connection-removed'], reloadLinks)
    return () => {
      detachStructure()
      detachStatus()
      detachAdded()
      detachRemoved()
    }
  }, [link, reloadConfig, reloadDrivers, reloadLinks])

  const onDialog = useCallback((next: DialogState) => { setDialog(next) }, [])
  const currentTab = active !== undefined && devices.some(device => device.id === active)
    ? active
    : devices[0]?.id

  if (devices.length === 0) {
    return (
      <div className="grid gap-4" data-field-page="empty">
        <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          尚未配置设备{drivers.length === 0 ? '——请先在插件管理中启用一个通讯驱动' : ''}
        </div>
        {drivers.length > 0 && (
          <div>
            <Button type="button" onClick={() => { setDialog({ kind: 'device-create' }) }} data-new-device>新建设备</Button>
          </div>
        )}
        {dialog !== undefined && (
          <StationDialog link={link} dialog={dialog} drivers={drivers} devices={devices} onClose={() => { setDialog(undefined) }} />
        )}
      </div>
    )
  }

  return (
    <div className="grid gap-4" data-field-page="devices">
      <Tabs
        value={currentTab ?? ''}
        onValueChange={value => {
          if (value === NEW_DEVICE_TAB) {
            setDialog({ kind: 'device-create' })
            return
          }
          setActive(value)
        }}
      >
        <TabsList className="flex-wrap">
          {devices.map(device => (
            <TabsTrigger key={device.id} value={device.id}>{device.name}</TabsTrigger>
          ))}
          {drivers.length > 0 && (
            <TabsTrigger value={NEW_DEVICE_TAB} data-new-device>＋</TabsTrigger>
          )}
        </TabsList>
      </Tabs>

      {devices
        .filter(device => device.id === currentTab)
        .map(device => (
          <DevicePanel
            key={device.id}
            link={link}
            device={device}
            snapshot={links.find(entry => entry.id === device.id)}
            driver={drivers.find(entry => entry.id === device.driver)}
            onDialog={onDialog}
          />
        ))}

      {dialog !== undefined && (
        <StationDialog link={link} dialog={dialog} drivers={drivers} devices={devices} onClose={() => { setDialog(undefined) }} />
      )}
    </div>
  )
}

/** The unified field settings page (id `field`). */
const fieldStationPlugin: Plugin.Object = {
  name: 'field-station',
  inject: ['settingsPages'],
  apply(ctx: Context): void {
    const client = ctx.get('client') as ClientLinkService
    ctx.settingsPages.register(ctx, {
      id: PAGE_ID,
      title: '设备管理',
      order: 10,
      render: () => <FieldStationPage link={client.link} />,
    })
  },
}

export default fieldStationPlugin
