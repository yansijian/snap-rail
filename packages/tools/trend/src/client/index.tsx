/**
 * The trend renderer face: one settings page (趋势预警) that manages
 * observation profiles — the watched point, the bound topics with their
 * payload conditions (options discovered from the live `topic.list`
 * catalog), the lead time, the threshold, and the watch switch. No charts,
 * no warning display: warnings and series are other packages' subscribers.
 *
 * @module @snap-rail/trend/client
 */

// Wire rows for the trend-domain methods this face calls.
import '../contract.ts'
import { Context, type Plugin } from '@snap-rail/cordis'
import '@snap-rail/client-settings'
import '@snap-rail/station-rpc/contract'
import '@snap-rail/field/contract'
import { Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { rpcErrorText, type HostLink } from '@snap-rail/connection'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  NumberInput,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TouchSelect,
  type TouchSelectOption,
} from '@snap-rail/client-ui'
import {
  trendProfileSchema,
  type TrendBinding,
  type TrendProfile,
} from '../contract.ts'

interface ClientLink {
  link: HostLink
}

/** One declared topic as `topic.list` serves it (typed locally against the
 * platform row's shape; the payload schema is JSON Schema). */
interface TopicEntry {
  name: string
  payloadSchema?: unknown
  filterSchema?: unknown
}

interface DraftCondition {
  field: string
  op: '==' | '!=' | '>' | '<' | '>=' | '<='
  /** The raw editor text; converted by field type on save. */
  valueText: string
  /** Whether the field is boolean (是/否 select), numeric, or free text. */
  kind: 'boolean' | 'number' | 'string'
}

interface DraftBinding {
  topic: string
  conditions: DraftCondition[]
}

interface Draft {
  id: string
  name: string
  device: string
  group: string
  pointName: string
  leadText: string
  thresholdText: string
  watch: boolean
  bindings: DraftBinding[]
}

function emptyDraft(): Draft {
  return {
    id: '',
    name: '',
    device: '',
    group: '',
    pointName: '',
    leadText: '30',
    thresholdText: '0.6',
    watch: true,
    bindings: [],
  }
}

/** Top-level payload properties of a declared topic, from its JSON Schema. */
function payloadFields(topic: TopicEntry | undefined): Array<{ name: string, kind: 'boolean' | 'number' | 'string' }> {
  const schema = topic?.payloadSchema
  if (typeof schema !== 'object' || schema === null) return []
  const properties = (schema as { properties?: Record<string, unknown> }).properties
  if (properties === undefined) return []
  return Object.entries(properties).map(([name, definition]) => {
    const type = typeof definition === 'object' && definition !== null
      ? (definition as { type?: unknown }).type
      : undefined
    const kind = type === 'boolean' ? 'boolean' : type === 'number' || type === 'integer' ? 'number' : 'string'
    return { name, kind } as const
  })
}

function draftFromProfile(profile: TrendProfile): Draft {
  return {
    id: profile.id,
    name: profile.name,
    device: profile.point.device,
    group: profile.point.group,
    pointName: profile.point.name,
    leadText: String(profile.leadMinutes),
    thresholdText: String(profile.alertThreshold),
    watch: profile.watch,
    bindings: profile.bindings.map(binding => ({
      topic: binding.topic,
      conditions: binding.all.map(condition => ({
        field: condition.field,
        op: condition.op,
        valueText: String(condition.value),
        kind: typeof condition.value === 'boolean' ? 'boolean' : typeof condition.value === 'number' ? 'number' : 'string',
      })),
    })),
  }
}

/** Validate and convert the draft into a storable profile, or a readable
 * failure. */
function draftToProfile(draft: Draft): { ok: true, profile: TrendProfile } | { ok: false, why: string } {
  const lead = Number(draft.leadText)
  const threshold = Number(draft.thresholdText)
  const bindings: TrendBinding[] = []
  for (const binding of draft.bindings) {
    if (binding.topic === '') continue
    const all = binding.conditions
      .filter(condition => condition.field !== '')
      .map(condition => {
        let value: boolean | number | string
        if (condition.kind === 'boolean') value = condition.valueText === 'true'
        else if (condition.kind === 'number') value = Number(condition.valueText)
        else value = condition.valueText
        return { field: condition.field, op: condition.op, value } as const
      })
    if (all.length === 0) return { ok: false, why: `绑定 ${binding.topic} 至少需要一个条件` }
    bindings.push({ topic: binding.topic, all })
  }
  if (bindings.length === 0) return { ok: false, why: '至少需要一个话题绑定' }
  const candidate = {
    id: draft.id,
    name: draft.name,
    point: { device: draft.device, group: draft.group, name: draft.pointName },
    leadMinutes: lead,
    alertThreshold: threshold,
    watch: draft.watch,
    bindings,
  }
  const parsed = trendProfileSchema.safeParse(candidate)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, why: `${issue?.path.join('.')}: ${issue?.message ?? '校验失败'}` }
  }
  return { ok: true, profile: parsed.data }
}

const opOptions: readonly TouchSelectOption[] = [
  { value: '==', label: '等于' },
  { value: '!=', label: '不等于' },
  { value: '>', label: '大于' },
  { value: '<', label: '小于' },
  { value: '>=', label: '至少' },
  { value: '<=', label: '至多' },
]

/** The profile editor dialog (create and edit share one draft shape). */
function ProfileEditor(props: {
  draft: Draft
  topics: TopicEntry[]
  onChange: (next: Draft) => void
  onCancel: () => void
  onSave: (draft: Draft) => void
}): ReactNode {
  const { draft, topics, onChange, onCancel, onSave } = props
  const topicOptions: readonly TouchSelectOption[] = [
    { value: '', label: '选择话题…', disabled: true },
    ...topics.map(topic => ({ value: topic.name, label: topic.name })),
  ]
  const set = (patch: Partial<Draft>): void => onChange({ ...draft, ...patch })

  const setBinding = (index: number, patch: Partial<DraftBinding>): void => {
    set({ bindings: draft.bindings.map((binding, at) => at === index ? { ...binding, ...patch } : binding) })
  }

  return (
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{draft.id === '' ? '新建观察档案' : `编辑档案：${draft.name}`}</DialogTitle>
      </DialogHeader>
      <div className="grid max-h-[70vh] gap-4 overflow-y-auto pr-1">
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label>档案 ID（小写字母/数字/短横线）</Label>
            <Input value={draft.id} disabled={draft.id !== ''} onChange={event => set({ id: event.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label>名称</Label>
            <Input value={draft.name} onChange={event => set({ name: event.target.value })} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="grid gap-1.5">
            <Label>观察点 · 设备</Label>
            <Input value={draft.device} onChange={event => set({ device: event.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label>组</Label>
            <Input value={draft.group} onChange={event => set({ group: event.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label>点名</Label>
            <Input value={draft.pointName} onChange={event => set({ pointName: event.target.value })} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label>提前预警时间（分钟）</Label>
            <NumberInput label="" value={draft.leadText} onChange={value => set({ leadText: value })} />
          </div>
          <div className="grid gap-1.5">
            <Label>预警阈值（概率）</Label>
            <NumberInput label="" allowDecimal value={draft.thresholdText} onChange={value => set({ thresholdText: value })} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={draft.watch} onCheckedChange={checked => set({ watch: checked })} />
          <Label>后台持续评估（关闭后仅手动分析）</Label>
        </div>

        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <Label>事件绑定（命中即积累事件语料）</Label>
            <Button type="button" variant="outline" size="sm"
              onClick={() => set({ bindings: [...draft.bindings, { topic: '', conditions: [{ field: '', op: '==', valueText: 'true', kind: 'string' }] }] })}>
              添加绑定
            </Button>
          </div>
          {draft.bindings.length === 0 && (
            <p className="text-sm text-muted-foreground">尚无绑定。绑定形如「话题 field/point-update 且 name 等于 温度1 且 value 等于 是」。</p>
          )}
          {draft.bindings.map((binding, index) => {
            const fields = payloadFields(topics.find(topic => topic.name === binding.topic))
            return (
              <div key={index} className="grid gap-2 rounded-lg border border-border p-3">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <TouchSelect
                      label=""
                      value={binding.topic}
                      options={topicOptions}
                      onValueChange={value => {
                        const kind = payloadFields(topics.find(topic => topic.name === value))[0]?.kind ?? 'string'
                        setBinding(index, {
                          topic: value,
                          conditions: [{ field: fields[0]?.name ?? '', op: '==', valueText: '', kind }],
                        })
                      }}
                    />
                  </div>
                  <Button type="button" variant="ghost" size="icon" aria-label="删除绑定"
                    onClick={() => set({ bindings: draft.bindings.filter((_, at) => at !== index) })}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                {binding.conditions.map((condition, conditionIndex) => (
                  <div key={conditionIndex} className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2">
                    <TouchSelect
                      label=""
                      value={condition.field}
                      options={[{ value: '', label: '字段…', disabled: true }, ...fields.map(field => ({ value: field.name, label: field.name }))]}
                      onValueChange={value => {
                        const kind = fields.find(field => field.name === value)?.kind ?? 'string'
                        setBinding(index, {
                          conditions: binding.conditions.map((current, at) => at === conditionIndex ? { ...current, field: value, kind, valueText: '' } : current),
                        })
                      }}
                    />
                    <TouchSelect
                      label=""
                      value={condition.op}
                      options={opOptions}
                      onValueChange={value => {
                        setBinding(index, {
                          conditions: binding.conditions.map((current, at) => at === conditionIndex ? { ...current, op: value as DraftCondition['op'] } : current),
                        })
                      }}
                    />
                    {condition.kind === 'boolean'
                      ? (
                          <TouchSelect
                            label=""
                            value={condition.valueText}
                            options={[{ value: 'true', label: '是' }, { value: 'false', label: '否' }]}
                            onValueChange={value => {
                              setBinding(index, {
                                conditions: binding.conditions.map((current, at) => at === conditionIndex ? { ...current, valueText: value } : current),
                              })
                            }}
                          />
                        )
                      : condition.kind === 'number'
                        ? <NumberInput label="" allowDecimal value={condition.valueText} onChange={value => {
                            setBinding(index, {
                              conditions: binding.conditions.map((current, at) => at === conditionIndex ? { ...current, valueText: value } : current),
                            })
                          }} />
                        : <Input value={condition.valueText} onChange={event => {
                            setBinding(index, {
                              conditions: binding.conditions.map((current, at) => at === conditionIndex ? { ...current, valueText: event.target.value } : current),
                            })
                          }} />}
                    {binding.conditions.length > 1 && (
                      <Button type="button" variant="ghost" size="icon" aria-label="删除条件"
                        onClick={() => setBinding(index, { conditions: binding.conditions.filter((_, at) => at !== conditionIndex) })}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
                <Button type="button" variant="ghost" size="sm" className="justify-self-start"
                  onClick={() => setBinding(index, {
                    conditions: [...binding.conditions, { field: fields[0]?.name ?? '', op: '==', valueText: '', kind: fields[0]?.kind ?? 'string' }],
                  })}>
                  添加条件（且）
                </Button>
              </div>
            )
          })}
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>取消</Button>
        <Button type="button" onClick={() => onSave(draft)}>保存档案</Button>
      </DialogFooter>
    </DialogContent>
  )
}

/** The 趋势预警 settings page: the profile table and its editor. */
function TrendPage(props: { ctx: Context }): ReactNode {
  const { ctx } = props
  const link = (ctx as Context & { client: ClientLink }).client.link
  const [profiles, setProfiles] = useState<TrendProfile[]>([])
  const [topics, setTopics] = useState<TopicEntry[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)

  const reload = (): void => {
    void link.call('trend.profile.list', {}).then(result => {
      if (result.ok) setProfiles(result.value.profiles)
      else setError(rpcErrorText(result.error))
    }).catch(cause => setError(String(cause)))
    void link.call('topic.list', {}).then(result => {
      if (result.ok) setTopics([...result.value.topics])
    }).catch(() => undefined)
  }

  useEffect(reload, [link])

  const save = (candidate: Draft): void => {
    const converted = draftToProfile(candidate)
    if (!converted.ok) {
      setError(converted.why)
      return
    }
    void link.call('trend.profile.save', { profile: converted.profile }).then(result => {
      if (!result.ok) {
        setError(rpcErrorText(result.error))
        return
      }
      setError(undefined)
      setDraft(null)
      reload()
    }).catch(cause => setError(String(cause)))
  }

  const remove = (id: string): void => {
    void link.call('trend.profile.remove', { id }).then(result => {
      if (!result.ok) {
        setError(rpcErrorText(result.error))
        return
      }
      reload()
    }).catch(cause => setError(String(cause)))
  }

  return (
    <div className="grid gap-4" data-page="trend">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">趋势预警</h2>
          <p className="text-sm text-muted-foreground">
            配置观察点与话题绑定；引擎积累变点历史与事件语料，按提前预警时间发布 trend/warning 话题。展现由订阅方负责。
          </p>
        </div>
        <Button type="button" onClick={() => { setError(undefined); setDraft(emptyDraft()) }}>新建档案</Button>
      </div>

      {error !== undefined && <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>档案</TableHead>
            <TableHead>观察点</TableHead>
            <TableHead>提前预警</TableHead>
            <TableHead>阈值</TableHead>
            <TableHead>绑定</TableHead>
            <TableHead>后台评估</TableHead>
            <TableHead className="w-24 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {profiles.map(profile => (
            <TableRow key={profile.id}>
              <TableCell>
                <span className="font-medium">{profile.name}</span>
                <span className="ml-2 font-mono text-xs text-muted-foreground">{profile.id}</span>
              </TableCell>
              <TableCell className="font-mono text-xs">{profile.point.device}/{profile.point.group}/{profile.point.name}</TableCell>
              <TableCell className="tabular-nums">{profile.leadMinutes} 分钟</TableCell>
              <TableCell className="tabular-nums">{profile.alertThreshold}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {profile.bindings.map((binding, index) => (
                    <Badge key={index} variant="secondary" className="font-mono text-xs">{binding.topic}</Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell><Badge variant={profile.watch ? 'success' : 'outline'}>{profile.watch ? '开启' : '关闭'}</Badge></TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setError(undefined); setDraft(draftFromProfile(profile)) }}>编辑</Button>
                  <Button type="button" variant="ghost" size="icon" aria-label={`删除 ${profile.name}`} onClick={() => remove(profile.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
          {profiles.length === 0 && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">尚无档案。新建一个，绑定话题条件后开始积累事件语料。</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {draft !== null && (
        <Dialog open onOpenChange={open => { if (!open) setDraft(null) }}>
          <ProfileEditor
            draft={draft}
            topics={topics}
            onChange={setDraft}
            onCancel={() => setDraft(null)}
            onSave={save}
          />
        </Dialog>
      )}
    </div>
  )
}

/** The trend client plugin; mount in the client runtime tree. */
const trendClientPlugin: Plugin.Object<void> = {
  name: 'trend-client',
  inject: ['client', 'settingsPages'],
  apply(ctx: Context): void {
    ctx.settingsPages.register(ctx, {
      id: 'trend',
      title: '趋势预警',
      order: 30,
      render(): ReactNode {
        return <TrendPage ctx={ctx} />
      },
    })
  },
}

export default trendClientPlugin
