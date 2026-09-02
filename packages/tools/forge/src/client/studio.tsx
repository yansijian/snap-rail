/**
 * The AI 创造 studio: the forge window's whole layout — its own frameless
 * titlebar (settings / minimize / maximize / close, window controls routed
 * with `target: 'forge'`), a session-history sidebar on the left, and the
 * conversation + generated-plugin panes on the right. Streaming deltas, tool
 * cards, stop control, version rollback, source view, zip export, and
 * removal all ride the forge RPC domain; frames (`forge/session-delta`,
 * `forge/plugins-changed`) drive the live updates.
 *
 * @module @snap-rail/forge/client/studio
 */

import type { Context } from '@snap-rail/cordis'
import type { ClientHandle } from '@snap-rail/client-runtime'
import type { HostLink } from '@snap-rail/connection'
import { Minus, Plus, Send, Settings, Sparkles, Square, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { formatClock } from '@snap-rail/util'
import { rpcErrorText, subscribeFrame } from '@snap-rail/connection'
import {
  Badge, Button, Card, CardContent, cn, Collapsible, CollapsibleChevron, CollapsibleContent, CollapsibleTrigger,
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DragScroll,
  Switch, Tabs, TabsContent, TabsList, TabsTrigger, Textarea,
} from '@snap-rail/client-ui'
import {
  pluginsChangedSchema,
  sessionDeltaSchema,
  type GeneratedPluginInfo,
  type SessionSummary,
} from '../contract.ts'
import { LlmConfigForm } from './config-form.tsx'

/** One rendered conversation row. */
type ChatRow =
  | { kind: 'user', text: string }
  | { kind: 'assistant', text: string }
  | { kind: 'tool', tool: string, phase: 'start' | 'end', output?: unknown, ok?: boolean }

/** One source view's payload (the plugin-read dialog). */
interface SourceView {
  id: string
  versionId: string
  hostSrc: string | null
  clientSrc: string | null
}

/** The studio status line: errors (destructive) or confirmations (muted). */
type Notice = { text: string, tone: 'error' | 'info' }

/** The studio layout occupant's body. */
export function ForgeStudio(props: { ctx: Context }): ReactNode {
  const { ctx } = props
  const link: ClientHandle['link'] = ctx.client.link
  const [tab, setTab] = useState('chat')
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [rows, setRows] = useState<ChatRow[]>([])
  const [plugins, setPlugins] = useState<readonly GeneratedPluginInfo[]>([])
  const [running, setRunning] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [draft, setDraft] = useState('')
  const [focusPluginId, setFocusPluginId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [source, setSource] = useState<SourceView | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<GeneratedPluginInfo | null>(null)
  const [pendingSession, setPendingSession] = useState<SessionSummary | null>(null)
  const [configOpen, setConfigOpen] = useState(false)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  // Window controls address this window, not the main terminal.
  const control = (action: 'minimize' | 'toggle-maximize' | 'close'): void => {
    void link.call('window.control', { action, target: 'forge' }).catch(() => {})
  }

  const reloadSessions = (): void => {
    void link.call('forge.session.list', {}).then(result => {
      if (result.ok) setSessions(result.value.sessions)
    })
  }
  const loadMessages = (id: string): void => {
    void link.call('forge.session.messages', { sessionId: id }).then(result => {
      if (!result.ok) return
      setRows(result.value.messages.map(row => {
        if (row.role === 'user') return { kind: 'user', text: row.text } as ChatRow
        if (row.role === 'assistant') return { kind: 'assistant', text: row.text } as ChatRow
        return { kind: 'tool', tool: describeToolCall(row.meta), phase: 'end', output: safeParse(row.text) } as ChatRow
      }))
    })
  }
  const reloadPlugins = (): void => {
    void link.call('forge.plugin.list', {}).then(result => {
      if (result.ok) setPlugins(result.value.plugins)
    })
  }

  useEffect(() => {
    reloadSessions()
    reloadPlugins()
  }, [ctx])

  // Live updates: session deltas stream in, plugin table changes nudge a reload.
  useEffect(() => {
    const offDelta = subscribeFrame(link, 'forge/session-delta', sessionDeltaSchema, delta => {
      if (sessionId !== null && delta.sessionId !== sessionId) return
      if (delta.kind === 'text') {
        setRows(current => {
          const next = [...current]
          const last = next.at(-1)
          if (last !== undefined && last.kind === 'assistant') next[next.length - 1] = { kind: 'assistant', text: last.text + delta.text }
          else next.push({ kind: 'assistant', text: delta.text })
          return next
        })
      } else if (delta.kind === 'tool') {
        setRows(current => {
          const next = [...current]
          if (delta.phase === 'start') next.push({ kind: 'tool', tool: delta.tool, phase: 'start' })
          else {
            const last = next.at(-1)
            const ended: ChatRow = {
              kind: 'tool',
              tool: delta.tool,
              phase: 'end',
              ...(delta.output !== undefined ? { output: delta.output } : {}),
              ...(delta.ok !== undefined ? { ok: delta.ok } : {}),
            }
            if (last !== undefined && last.kind === 'tool' && last.tool === delta.tool && last.phase === 'start') {
              next[next.length - 1] = ended
            } else next.push(ended)
          }
          return next
        })
      } else {
        setRunning(delta.state === 'running')
        if (delta.state === 'idle' || delta.state === 'error') {
          if (sessionId !== null) loadMessages(sessionId)
          if (delta.state === 'error' && delta.message !== undefined) setNotice({ text: delta.message, tone: 'error' })
        }
      }
    })
    const offPlugins = subscribeFrame(link, 'forge/plugins-changed', pluginsChangedSchema, () => reloadPlugins())
    return () => { offDelta(); offPlugins() }
  }, [ctx, sessionId, link])

  // Keep the stream pinned to the newest content while it grows.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [rows])

  const send = (): void => {
    const text = draft.trim()
    if (text === '' || busy || running) return
    setBusy(true)
    setNotice(null)
    setRows(current => [...current, { kind: 'user', text }])
    setDraft('')
    void link.call('forge.session.send', {
      ...(sessionId === null ? {} : { sessionId }),
      text,
      ...(focusPluginId !== null ? { focusPluginId } : {}),
    }).then(result => {
      if (!result.ok) {
        setNotice({ text: rpcErrorText(result.error), tone: 'error' })
        return
      }
      if (sessionId === null) {
        setSessionId(result.value.sessionId)
        reloadSessions()
      }
      setRunning(true)
    }).finally(() => { setBusy(false) })
  }

  const stop = (): void => {
    if (sessionId === null) return
    void link.call('forge.session.stop', { sessionId })
  }

  const pickSession = (id: string | null): void => {
    setSessionId(id)
    setRows([])
    setNotice(null)
    setTab('chat')
    if (id !== null) loadMessages(id)
  }

  const removeSession = (): void => {
    const target = pendingSession
    setPendingSession(null)
    if (target === null) return
    void link.call('forge.session.remove', { sessionId: target.id }).then(result => {
      if (!result.ok) {
        setNotice({ text: rpcErrorText(result.error), tone: 'error' })
        return
      }
      if (sessionId === target.id) {
        setSessionId(null)
        setRows([])
      }
      reloadSessions()
    })
  }

  const exportPlugin = (plugin: GeneratedPluginInfo): void => {
    void (async () => {
      const picked = await link.call('window.save-zip', {
        title: '导出插件包',
        defaultFileName: `${plugin.id}${plugin.currentVersionId !== null ? `-${plugin.currentVersionId}` : ''}.zip`,
      })
      if (!picked.ok) {
        setNotice({ text: rpcErrorText(picked.error), tone: 'error' })
        return
      }
      if (picked.value === null) return
      const exported = await link.call('forge.plugin.export', {
        id: plugin.id,
        ...(plugin.currentVersionId !== null ? { versionId: plugin.currentVersionId } : {}),
        path: picked.value,
      })
      if (!exported.ok) {
        setNotice({ text: rpcErrorText(exported.error), tone: 'error' })
        return
      }
      setNotice({ text: `已导出到 ${exported.value.path}；可在「设置 → 插件管理 → 安装插件」导入。`, tone: 'info' })
    })().catch(() => undefined)
  }

  return (
    <div className="flex h-full flex-col" data-forge="studio">
      <StudioTitlebar control={control} onSettings={() => { setConfigOpen(true) }} />

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-border" data-region="forge-sessions">
          <div className="p-3">
            <Button variant="outline" className="w-full justify-start gap-2" onClick={() => { pickSession(null) }}>
              <Plus className="h-4 w-4" />
              新会话
            </Button>
          </div>
          <DragScroll className="min-h-0 flex-1">
            <div className="flex flex-col gap-1 p-2 pt-0">
              {sessions.length === 0 && (
                <p className="px-2 py-1 text-xs text-muted-foreground">还没有会话；描述一个需求开始。</p>
              )}
              {sessions.map(session => (
                <div
                  key={session.id}
                  data-session-item={session.id}
                  className={cn(
                    'group flex items-center gap-1 rounded-md border px-2.5 py-2',
                    sessionId === session.id ? 'border-primary/50 bg-accent' : 'border-transparent hover:bg-accent/50',
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => { pickSession(session.id) }}
                  >
                    <span className="block truncate text-sm">{session.title}</span>
                    <span className="block text-xs text-muted-foreground">{formatClock(session.updatedAt)}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`删除会话 ${session.title}`}
                    className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                    onClick={() => { setPendingSession(session) }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </DragScroll>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-4">
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
            <TabsList className="self-start">
              <TabsTrigger value="chat">对话</TabsTrigger>
              <TabsTrigger value="plugins">我的插件{plugins.length > 0 ? `（${plugins.length}）` : ''}</TabsTrigger>
            </TabsList>

            <TabsContent value="chat" className="flex min-h-0 flex-1 flex-col gap-3">
              <DragScroll className="min-h-0 flex-1 rounded-md border border-border bg-card">
                <div className="flex min-h-full flex-col justify-end gap-3 p-4">
                  {rows.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      描述你想要的功能（例如「加一页显示本周每班的产量对比」），AI 会直接造出可用的页面；
                      造好的功能出现在主终端里，随时可回滚。
                    </p>
                  )}
                  {rows.map((row, index) => <ChatRowView key={index} row={row} />)}
                  {running && rows.at(-1)?.kind !== 'assistant' && (
                    <span className="text-sm text-muted-foreground">AI 正在思考…</span>
                  )}
                  <div ref={bottomRef} />
                </div>
              </DragScroll>
              {notice !== null && (
                <p className={cn('text-sm', notice.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')} role="alert">
                  {notice.text}
                </p>
              )}
              <div className="flex flex-col gap-2">
                {focusPluginId !== null && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Badge variant="secondary">针对插件</Badge>
                    <span className="font-mono">{focusPluginId}</span>
                    <Button variant="ghost" size="sm" onClick={() => { setFocusPluginId(null) }}>解除</Button>
                  </div>
                )}
                <Textarea
                  value={draft}
                  placeholder="描述你想要的功能…"
                  onChange={event => { setDraft(event.target.value) }}
                  onKeyDown={event => {
                    if (event.key !== 'Enter' || event.shiftKey) return
                    if (event.nativeEvent.isComposing) return
                    event.preventDefault()
                    send()
                  }}
                />
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Enter 发送 · Shift+Enter 换行</span>
                  {running
                    ? (
                        <Button variant="destructive" size="lg" onClick={stop}>
                          <Square className="h-4 w-4" />
                          停止
                        </Button>
                      )
                    : (
                        <Button size="lg" disabled={draft.trim() === '' || busy} onClick={send}>
                          <Send className="h-4 w-4" />
                          {busy ? '发送中…' : '发送'}
                        </Button>
                      )}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="plugins" className="min-h-0 flex-1">
              <DragScroll className="h-full">
                <div className="flex flex-col gap-3 p-1">
                  {plugins.length === 0 && (
                    <p className="p-4 text-sm text-muted-foreground">还没有生成的插件。到「对话」里描述一个需求试试。</p>
                  )}
                  {plugins.map(plugin => (
                    <PluginCard
                      key={plugin.id}
                      plugin={plugin}
                      disabled={busy}
                      onToggle={enabled => { void togglePlugin(link, plugin.id, enabled).then(reloadPlugins) }}
                      onRefine={() => { setFocusPluginId(plugin.id); setTab('chat') }}
                      onSource={() => { void openSource(link, plugin.id, setSource, setNotice) }}
                      onExport={() => { exportPlugin(plugin) }}
                      onRemove={() => { setPendingRemoval(plugin) }}
                    />
                  ))}
                </div>
              </DragScroll>
            </TabsContent>
          </Tabs>
        </main>
      </div>

      <Dialog open={configOpen} onOpenChange={open => { setConfigOpen(open) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>AI 创造 · 模型接口</DialogTitle>
            <DialogDescription>配置 OpenAI 兼容的服务地址、密钥与模型；保存后立即生效。</DialogDescription>
          </DialogHeader>
          <LlmConfigForm ctx={ctx} />
        </DialogContent>
      </Dialog>
      <SourceDialog source={source} onClose={() => { setSource(null) }} />
      <RemoveDialog
        plugin={pendingRemoval}
        onClose={() => { setPendingRemoval(null) }}
        onConfirm={() => {
          const target = pendingRemoval
          setPendingRemoval(null)
          if (target === null) return
          void link.call('forge.plugin.remove', { id: target.id }).then(result => {
            if (!result.ok) setNotice({ text: rpcErrorText(result.error), tone: 'error' })
            if (focusPluginId === target.id) setFocusPluginId(null)
            reloadPlugins()
          })
        }}
      />
      <SessionRemoveDialog
        session={pendingSession}
        onClose={() => { setPendingSession(null) }}
        onConfirm={removeSession}
      />
    </div>
  )
}

/** The studio window's own frameless titlebar. */
function StudioTitlebar(props: { control(action: 'minimize' | 'toggle-maximize' | 'close'): void, onSettings(): void }): ReactNode {
  return (
    <div className="drag-region flex h-14 shrink-0 select-none items-stretch justify-between border-b border-border">
      <div className="flex items-center gap-2.5 pl-4">
        <Sparkles className="h-5 w-5 text-primary" aria-hidden="true" />
        <span className="text-base font-medium tracking-wide">AI 创造</span>
      </div>
      <div className="no-drag flex items-stretch">
        <Button
          variant="ghost"
          aria-label="模型接口设置"
          className="h-full w-14 rounded-none px-0"
          onClick={props.onSettings}
        >
          <Settings className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          aria-label="最小化"
          className="h-full w-14 rounded-none px-0"
          onClick={() => { props.control('minimize') }}
        >
          <Minus className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          aria-label="最大化切换"
          className="h-full w-14 rounded-none px-0"
          onClick={() => { props.control('toggle-maximize') }}
        >
          <Square className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          aria-label="关闭"
          className="h-full w-14 rounded-none rounded-r-none px-0 hover:bg-destructive/20 hover:text-destructive"
          onClick={() => { props.control('close') }}
        >
          <X className="h-5 w-5" />
        </Button>
      </div>
    </div>
  )
}

/** One conversation row's presentation. */
function ChatRowView(props: { row: ChatRow }): ReactNode {
  const { row } = props
  if (row.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-primary px-4 py-2.5 text-base text-primary-foreground">{row.text}</div>
      </div>
    )
  }
  if (row.kind === 'assistant') {
    if (row.text === '') return null
    return <div className="max-w-[95%] whitespace-pre-wrap rounded-lg bg-muted px-4 py-2.5 text-base leading-relaxed">{row.text}</div>
  }
  const ok = row.ok !== false
  return (
    <Collapsible className="rounded-md border border-border">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <CollapsibleChevron />
        <Badge variant={ok ? 'secondary' : 'destructive'}>{row.tool}</Badge>
        <span className="text-xs text-muted-foreground">{row.phase === 'start' ? '执行中…' : ok ? '完成' : '失败'}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="max-h-60 overflow-auto border-t border-border p-3 font-mono text-xs text-muted-foreground">
          {JSON.stringify(row.output, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** One generated plugin's admin card. */
function PluginCard(props: {
  plugin: GeneratedPluginInfo
  disabled: boolean
  onToggle(enabled: boolean): void
  onRefine(): void
  onSource(): void
  onExport(): void
  onRemove(): void
}): ReactNode {
  const { plugin } = props
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-base font-medium">{plugin.title}</span>
            <Badge variant={plugin.status === 'error' ? 'destructive' : plugin.status === 'running' ? 'default' : 'secondary'}>
              {plugin.status === 'running' ? '运行中' : plugin.status === 'error' ? '出错' : '已停止'}
            </Badge>
          </div>
          <Switch
            aria-label={`启用 ${plugin.title}`}
            checked={plugin.enabled}
            disabled={props.disabled}
            onCheckedChange={props.onToggle}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">{plugin.id}</span>
          <span>版本 {plugin.versionCount}</span>
          {plugin.currentVersionId !== null && <span>当前 {plugin.currentVersionId}</span>}
          {plugin.hasClient && <span>含界面</span>}
        </div>
        {plugin.description !== '' && <p className="text-sm leading-relaxed">{plugin.description}</p>}
        {plugin.diagnostics !== null && (
          <p className="rounded border border-border bg-muted p-2 font-mono text-xs text-destructive">{plugin.diagnostics}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={props.onRefine}>继续改进</Button>
          <Button variant="outline" size="sm" onClick={props.onSource}>查看源码</Button>
          <Button variant="outline" size="sm" onClick={props.onExport}>导出</Button>
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={props.onRemove}>删除</Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** The source view + copy dialog. */
function SourceDialog(props: { source: SourceView | null, onClose(): void }): ReactNode {
  const [copied, setCopied] = useState<string | null>(null)
  if (props.source === null) return null
  const { source } = props
  const copy = (label: string, text: string): void => {
    void navigator.clipboard?.writeText(text).then(
      () => { setCopied(label); window.setTimeout(() => { setCopied(null) }, 1500) },
      () => { setCopied(null) },
    )
  }
  return (
    <Dialog open onOpenChange={open => { if (!open) props.onClose() }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{source.id} · {source.versionId}</DialogTitle>
          <DialogDescription>
            源码可复制回开发环境；「导出」则直接打包为可安装 zip，无需开发环境。
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-auto">
          {(['hostSrc', 'clientSrc'] as const).map(face => {
            const text = source[face]
            return text === null ? null : (
              <div key={face} className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{face === 'hostSrc' ? '宿主半边' : '渲染半边'}</span>
                  <Button variant="outline" size="sm" onClick={() => { copy(face, text) }}>
                    {copied === face ? '已复制' : '复制'}
                  </Button>
                </div>
                <pre className="max-h-64 overflow-auto rounded border border-border bg-muted p-3 font-mono text-xs">{text}</pre>
              </div>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The plugin removal confirmation. */
function RemoveDialog(props: { plugin: GeneratedPluginInfo | null, onClose(): void, onConfirm(): void }): ReactNode {
  if (props.plugin === null) return null
  return (
    <Dialog open onOpenChange={open => { if (!open) props.onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除插件「{props.plugin.title}」？</DialogTitle>
          <DialogDescription>将卸载其全部功能并删除版本历史，无法恢复。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>取消</Button>
          <Button variant="destructive" onClick={props.onConfirm}>删除</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The session removal confirmation. */
function SessionRemoveDialog(props: { session: SessionSummary | null, onClose(): void, onConfirm(): void }): ReactNode {
  if (props.session === null) return null
  return (
    <Dialog open onOpenChange={open => { if (!open) props.onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>删除会话？</DialogTitle>
          <DialogDescription>「{props.session.title}」的对话记录将被删除，无法恢复。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>取消</Button>
          <Button variant="destructive" onClick={props.onConfirm}>删除</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Toggle a plugin; failures surface through the notice line. */
async function togglePlugin(link: HostLink, id: string, enabled: boolean): Promise<void> {
  const result = await link.call('forge.plugin.set-enabled', { id, enabled })
  if (!result.ok) console.error(rpcErrorText(result.error))
}

/** Pull one plugin's current sources for the view dialog. */
async function openSource(
  link: HostLink,
  id: string,
  setSource: (view: SourceView) => void,
  setNotice: (notice: Notice) => void,
): Promise<void> {
  const result = await link.call('forge.plugin.read', { id })
  if (!result.ok) {
    setNotice({ text: rpcErrorText(result.error), tone: 'error' })
    return
  }
  setSource({
    id: result.value.info.id,
    versionId: result.value.version.versionId,
    hostSrc: result.value.version.hostSrc,
    clientSrc: result.value.version.clientSrc,
  })
}

/** Best-effort tool name from a persisted tool row's meta. */
function describeToolCall(meta: unknown): string {
  if (typeof meta === 'object' && meta !== null && 'toolName' in meta) {
    const name = (meta as { toolName?: unknown }).toolName
    if (typeof name === 'string') return name
  }
  return '工具'
}

/** Parse persisted tool JSON defensively. */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
