/**
 * The built-in 设备管理 settings page: devices, groups and points over the
 * equipment base. The page is a projection plus a small editor over the
 * equipment CRUD contract; driver dialect forms are rendered by the shared
 * SchemaForm, so a new driver needs no page changes.
 *
 * @module @snap-rail/equipment-station/page
 */

import type {
  ConfigDevice,
  ConfigDocument,
  ConfigGroup,
  ConfigPoint,
  ConnectionSnapshot,
  DriverInfo,
  PointType,
} from '@snap-rail/equipment/contract'
import { rpcErrorText } from '@snap-rail/connection'
import '@snap-rail/equipment/contract'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Grid,
  Input,
  Led,
  Page,
  SchemaForm,
  Section,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TouchSelect,
  schemaNodeOf,
  type JsonSchemaNode,
} from '@snap-rail/ui/components'
import { useClient } from '@snap-rail/ui/runtime'
import { useEffect, useState, type ReactNode } from 'react'

/** Connection status → LED tone. */
function toneOf(status: ConnectionSnapshot['status'] | undefined): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status === 'online') return 'success'
  if (status === 'connecting') return 'warning'
  if (status === 'offline') return 'danger'
  return 'neutral'
}

const POINT_TYPES: readonly { value: PointType, label: string }[] = [
  { value: 'bool', label: '开关量 (bool)' },
  { value: 'int', label: '整数 (int)' },
  { value: 'float', label: '浮点 (float)' },
  { value: 'string', label: '字符串 (string)' },
]

function defaultsOf(schema: JsonSchemaNode): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (property.default !== undefined) values[key] = property.default
  }
  return values
}

/** Strip the group-derived `type` field from a driver point schema. */
function pointSchemaOf(schema: JsonSchemaNode): JsonSchemaNode {
  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([key]) => key !== 'type'))
  return { ...schema, properties, required: (schema.required ?? []).filter(key => key !== 'type') }
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

interface DeviceDraft {
  id?: string
  name: string
  driver: string
  config: Record<string, unknown>
}

interface GroupDraft {
  device: ConfigDevice
  name: string
  type: PointType
  existing: boolean
}

interface PointDraft {
  device: ConfigDevice
  group: ConfigGroup
  name: string
  config: Record<string, unknown>
  existing: boolean
}

/** One device card plus its group/point actions. */
function DeviceCard(props: {
  device: ConfigDevice
  connection: ConnectionSnapshot | undefined
  driver: DriverInfo | undefined
  onEdit: () => void
  onRemove: () => void
  onAddGroup: () => void
  onEditGroup: (group: ConfigGroup) => void
  onRemoveGroup: (group: ConfigGroup) => void
  onAddPoint: (group: ConfigGroup) => void
  onEditPoint: (group: ConfigGroup, point: ConfigPoint) => void
  onRemovePoint: (group: ConfigGroup, point: ConfigPoint) => void
}): ReactNode {
  const { device, connection, driver } = props
  const pointCount = device.groups.reduce((total, group) => total + group.points.length, 0)
  return (
    <Card>
      <CardHeader>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--snap-space-sm)' }}>
          <CardTitle>{device.name}</CardTitle>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--snap-space-sm)' }}>
            <Led tone={toneOf(connection?.status)} label={connection?.status ?? '未知'} />
            <Badge intent={connection?.status === 'online' ? 'success' : connection?.status === 'offline' ? 'danger' : 'warning'}>
              {connection?.status === 'online' ? '在线' : connection?.status === 'offline' ? '离线' : '连接中'}
            </Badge>
            <Button size="sm" emphasis="outline" onClick={props.onEdit}>编辑</Button>
            <Button size="sm" intent="danger" emphasis="ghost" onClick={props.onRemove}>删除</Button>
          </div>
        </div>
        <div style={{ color: 'var(--snap-color-muted)', fontSize: 'var(--snap-text-sm)' }}>
          {driver?.title ?? device.driver} · {device.groups.length} 组 · {pointCount} 点
        </div>
      </CardHeader>
      <CardContent>
        <Stack gap="md">
          {device.groups.length === 0
            ? <EmptyState title="尚无分组" description="先创建一个分组，再添加点位。" />
            : device.groups.map(group => (
                <Section
                  key={group.name}
                  title={`${group.name} · ${group.type}`}
                  actions={(
                    <div style={{ display: 'flex', gap: 'var(--snap-space-xs)' }}>
                      <Button size="sm" emphasis="outline" onClick={() => props.onAddPoint(group)}>添加点位</Button>
                      <Button size="sm" emphasis="outline" onClick={() => props.onEditGroup(group)}>编辑分组</Button>
                      <Button size="sm" intent="danger" emphasis="ghost" onClick={() => props.onRemoveGroup(group)}>删除分组</Button>
                    </div>
                  )}
                >
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>点位</TableHead>
                        <TableHead>类型</TableHead>
                        <TableHead>地址配置</TableHead>
                        <TableHead>操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.points.map(point => (
                        <TableRow key={point.name}>
                          <TableCell>{point.name}</TableCell>
                          <TableCell>{group.type}</TableCell>
                          <TableCell>
                            <code style={{ fontFamily: 'var(--snap-font-mono)', fontSize: 'var(--snap-text-xs)' }}>
                              {JSON.stringify(point.config)}
                            </code>
                          </TableCell>
                          <TableCell>
                            <div style={{ display: 'flex', gap: 'var(--snap-space-xs)' }}>
                              <Button size="sm" emphasis="ghost" onClick={() => props.onEditPoint(group, point)}>编辑</Button>
                              <Button size="sm" intent="danger" emphasis="ghost" onClick={() => props.onRemovePoint(group, point)}>删除</Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                      {group.points.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={4}>
                            <span style={{ color: 'var(--snap-color-muted)' }}>该分组暂无点位</span>
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </Section>
              ))}
          <div>
            <Button size="sm" emphasis="outline" onClick={props.onAddGroup}>新增分组</Button>
          </div>
        </Stack>
      </CardContent>
    </Card>
  )
}

/** The equipment settings page. */
export function EquipmentPage(): ReactNode {
  const { link } = useClient()
  const [config, setConfig] = useState<ConfigDocument | undefined>(undefined)
  const [connections, setConnections] = useState<readonly ConnectionSnapshot[]>([])
  const [drivers, setDrivers] = useState<readonly DriverInfo[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [deviceDraft, setDeviceDraft] = useState<DeviceDraft | undefined>(undefined)
  const [groupDraft, setGroupDraft] = useState<GroupDraft | undefined>(undefined)
  const [pointDraft, setPointDraft] = useState<PointDraft | undefined>(undefined)
  const [saving, setSaving] = useState(false)

  const load = (): void => {
    setBusy(true)
    setError(undefined)
    void Promise.all([
      link.call('equipment.config.list', {}),
      link.call('equipment.connections.list', {}),
      link.call('equipment.drivers.list', {}),
    ]).then(([configResult, connectionsResult, driversResult]) => {
      if (!configResult.ok) {
        setError(rpcErrorText(configResult.error))
        return
      }
      setConfig(configResult.value.config)
      setConnections(connectionsResult.ok ? connectionsResult.value.connections : [])
      setDrivers(driversResult.ok ? driversResult.value.drivers : [])
    }).catch(cause => {
      setError(errorText(cause))
    }).finally(() => { setBusy(false) })
  }

  useEffect(load, [])

  const connectionOf = (device: ConfigDevice): ConnectionSnapshot | undefined =>
    connections.find(connection => connection.id === device.id)
  const driverOf = (device: ConfigDevice): DriverInfo | undefined =>
    drivers.find(driver => driver.id === device.driver)

  const openDevice = (device?: ConfigDevice): void => {
    const driver = device?.driver ?? drivers[0]?.id ?? ''
    const schema = schemaNodeOf(drivers.find(item => item.id === driver)?.schemas.device)
    setDeviceDraft({
      ...device !== undefined ? { id: device.id } : {},
      name: device?.name ?? '',
      driver,
      config: device?.config ?? defaultsOf(schema),
    })
  }

  const openGroup = (device: ConfigDevice, group?: ConfigGroup): void => {
    setGroupDraft({
      device,
      name: group?.name ?? '',
      type: group?.type ?? 'bool',
      existing: group !== undefined,
    })
  }

  const openPoint = (device: ConfigDevice, group: ConfigGroup, point?: ConfigPoint): void => {
    const schema = pointSchemaOf(schemaNodeOf(driverOf(device)?.schemas.point))
    setPointDraft({
      device,
      group,
      name: point?.name ?? '',
      config: point?.config ?? defaultsOf(schema),
      existing: point !== undefined,
    })
  }

  const saveDevice = (): void => {
    if (deviceDraft === undefined) return
    setSaving(true)
    setError(undefined)
    void link.call('equipment.devices.upsert', {
      device: {
        ...deviceDraft.id !== undefined ? { id: deviceDraft.id } : {},
        name: deviceDraft.name,
        driver: deviceDraft.driver,
        config: deviceDraft.config,
      },
    }).then(result => {
      if (!result.ok) {
        setError(rpcErrorText(result.error))
        return
      }
      setDeviceDraft(undefined)
      load()
    }).catch(cause => { setError(errorText(cause)) }).finally(() => { setSaving(false) })
  }

  const saveGroup = (): void => {
    if (groupDraft === undefined) return
    setSaving(true)
    setError(undefined)
    void link.call('equipment.groups.upsert', {
      device: groupDraft.device.name,
      group: { name: groupDraft.name, type: groupDraft.type },
    }).then(result => {
      if (!result.ok) {
        setError(rpcErrorText(result.error))
        return
      }
      setGroupDraft(undefined)
      load()
    }).catch(cause => { setError(errorText(cause)) }).finally(() => { setSaving(false) })
  }

  const savePoint = (): void => {
    if (pointDraft === undefined) return
    const { type: _type, ...config } = pointDraft.config
    setSaving(true)
    setError(undefined)
    void link.call('equipment.points.upsert', {
      device: pointDraft.device.name,
      group: pointDraft.group.name,
      point: { name: pointDraft.name, config },
    }).then(result => {
      if (!result.ok) {
        setError(rpcErrorText(result.error))
        return
      }
      setPointDraft(undefined)
      load()
    }).catch(cause => { setError(errorText(cause)) }).finally(() => { setSaving(false) })
  }

  const removeDevice = (device: ConfigDevice): void => {
    if (!window.confirm(`删除设备「${device.name}」？其分组与点位会一并删除。`)) return
    void link.call('equipment.devices.remove', { id: device.id }).then(result => {
      if (!result.ok) setError(rpcErrorText(result.error))
      else load()
    })
  }

  const removeGroup = (device: ConfigDevice, group: ConfigGroup): void => {
    if (!window.confirm(`删除分组「${group.name}」？`)) return
    void link.call('equipment.groups.remove', { device: device.name, group: group.name }).then(result => {
      if (!result.ok) setError(rpcErrorText(result.error))
      else load()
    })
  }

  const removePoint = (device: ConfigDevice, group: ConfigGroup, point: ConfigPoint): void => {
    if (!window.confirm(`删除点位「${point.name}」？`)) return
    void link.call('equipment.points.remove', { device: device.name, group: group.name, name: point.name }).then(result => {
      if (!result.ok) setError(rpcErrorText(result.error))
      else load()
    })
  }

  const deviceConfigSchema = deviceDraft === undefined
    ? undefined
    : schemaNodeOf(drivers.find(driver => driver.id === deviceDraft.driver)?.schemas.device)
  const pointConfigSchema = pointDraft === undefined
    ? undefined
    : pointSchemaOf(schemaNodeOf(driverOf(pointDraft.device)?.schemas.point))

  return (
    <Page
      title="设备管理"
      description="设备、分组与点位来自 equipment 底座；驱动安装后即可建立连接。"
      actions={(
        <div style={{ display: 'flex', gap: 'var(--snap-space-sm)' }}>
          <Button intent="neutral" emphasis="outline" loading={busy} onClick={load}>刷新</Button>
          <Button intent="primary" disabled={drivers.length === 0} onClick={() => openDevice()}>新增设备</Button>
        </div>
      )}
    >
      <Stack gap="lg">
        {error !== undefined && <div role="alert" style={{ color: 'var(--snap-color-danger)' }}>{error}</div>}
        {config === undefined
          ? <EmptyState title="正在读取设备配置…" />
          : config.devices.length === 0
            ? <EmptyState title="尚未配置设备" description={drivers.length === 0 ? '先安装一个通讯驱动，再新增设备。' : '点击「新增设备」选择驱动并填写连接参数。'} />
            : (
                <Grid columns={1} gap="lg">
                  {config.devices.map(device => (
                    <DeviceCard
                      key={device.id}
                      device={device}
                      connection={connectionOf(device)}
                      driver={driverOf(device)}
                      onEdit={() => openDevice(device)}
                      onRemove={() => removeDevice(device)}
                      onAddGroup={() => openGroup(device)}
                      onEditGroup={group => openGroup(device, group)}
                      onRemoveGroup={group => removeGroup(device, group)}
                      onAddPoint={group => openPoint(device, group)}
                      onEditPoint={(group, point) => openPoint(device, group, point)}
                      onRemovePoint={(group, point) => removePoint(device, group, point)}
                    />
                  ))}
                </Grid>
              )}
      </Stack>

      <Dialog open={deviceDraft !== undefined} onOpenChange={open => { if (!open) setDeviceDraft(undefined) }}>
        <DialogContent presentation="modal" size="lg">
          <DialogHeader><DialogTitle>{deviceDraft?.id === undefined ? '新增设备' : '编辑设备'}</DialogTitle></DialogHeader>
          <DialogBody>
            <Stack gap="md">
              <Field label="设备名称" htmlFor="equipment-device-name" required>
                <Input
                  id="equipment-device-name"
                  value={deviceDraft?.name ?? ''}
                  onChange={event => setDeviceDraft(draft => draft === undefined ? draft : { ...draft, name: event.target.value })}
                />
              </Field>
              <Field label="驱动" required>
                <TouchSelect
                  {...deviceDraft?.driver !== undefined ? { value: deviceDraft.driver } : {}}
                  options={drivers.map(driver => ({ value: driver.id, label: driver.title }))}
                  onValueChange={driverId => {
                    const schema = schemaNodeOf(drivers.find(driver => driver.id === driverId)?.schemas.device)
                    setDeviceDraft(draft => draft === undefined ? draft : { ...draft, driver: driverId, config: defaultsOf(schema) })
                  }}
                  aria-label="驱动"
                />
              </Field>
              {deviceConfigSchema !== undefined && deviceDraft !== undefined && (
                <SchemaForm
                  schema={deviceConfigSchema}
                  value={deviceDraft.config}
                  onChange={configValue => setDeviceDraft(draft => draft === undefined ? draft : { ...draft, config: configValue })}
                  idPrefix="equipment-device"
                />
              )}
            </Stack>
          </DialogBody>
          <DialogFooter>
            <Button emphasis="ghost" onClick={() => setDeviceDraft(undefined)}>取消</Button>
            <Button intent="primary" loading={saving} disabled={deviceDraft?.name.trim() === '' || deviceDraft?.driver === ''} onClick={saveDevice}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={groupDraft !== undefined} onOpenChange={open => { if (!open) setGroupDraft(undefined) }}>
        <DialogContent presentation="modal" size="md">
          <DialogHeader><DialogTitle>{groupDraft?.existing === true ? '编辑分组' : '新增分组'}</DialogTitle></DialogHeader>
          <DialogBody>
            <Stack gap="md">
              <Field label="分组名称" htmlFor="equipment-group-name" required>
                <Input
                  id="equipment-group-name"
                  value={groupDraft?.name ?? ''}
                  onChange={event => setGroupDraft(draft => draft === undefined ? draft : { ...draft, name: event.target.value })}
                />
              </Field>
              <Field label="点位类型" help="分组创建后，类型只能在没有点位时修改。" required>
                <TouchSelect
                  {...groupDraft !== undefined ? { value: groupDraft.type } : {}}
                  options={POINT_TYPES.map(type => ({ value: type.value, label: type.label }))}
                  onValueChange={type => setGroupDraft(draft => draft === undefined ? draft : { ...draft, type: type as PointType })}
                  aria-label="点位类型"
                />
              </Field>
            </Stack>
          </DialogBody>
          <DialogFooter>
            <Button emphasis="ghost" onClick={() => setGroupDraft(undefined)}>取消</Button>
            <Button intent="primary" loading={saving} disabled={groupDraft?.name.trim() === ''} onClick={saveGroup}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pointDraft !== undefined} onOpenChange={open => { if (!open) setPointDraft(undefined) }}>
        <DialogContent presentation="modal" size="lg">
          <DialogHeader><DialogTitle>{pointDraft?.existing === true ? '编辑点位' : '新增点位'}</DialogTitle></DialogHeader>
          <DialogBody>
            <Stack gap="md">
              <Field label="点位名称" htmlFor="equipment-point-name" required>
                <Input
                  id="equipment-point-name"
                  value={pointDraft?.name ?? ''}
                  onChange={event => setPointDraft(draft => draft === undefined ? draft : { ...draft, name: event.target.value })}
                />
              </Field>
              <div style={{ color: 'var(--snap-color-muted)', fontSize: 'var(--snap-text-sm)' }}>
                分组 {pointDraft?.group.name} · 类型 {pointDraft?.group.type}
              </div>
              {pointConfigSchema !== undefined && pointDraft !== undefined && (
                <SchemaForm
                  schema={pointConfigSchema}
                  value={pointDraft.config}
                  onChange={configValue => setPointDraft(draft => draft === undefined ? draft : { ...draft, config: configValue })}
                  idPrefix="equipment-point"
                />
              )}
            </Stack>
          </DialogBody>
          <DialogFooter>
            <Button emphasis="ghost" onClick={() => setPointDraft(undefined)}>取消</Button>
            <Button intent="primary" loading={saving} disabled={pointDraft?.name.trim() === ''} onClick={savePoint}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  )
}

export default EquipmentPage