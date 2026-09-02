/**
 * The AI 创造 workbench: the conversation pane (streaming deltas, tool
 * cards, stop control) and the generated-plugin pane (status cards, enable
 * toggles, version rollback, source export, removal). Registered both as a
 * settings page and a workflow page — the studio is usable from the shell
 * and from inside the active scenario alike.
 *
 * All writes go through the forge RPC domain; frames (`forge/session-delta`,
 * `forge/plugins-changed`) drive the live updates.
 *
 * @module @snap-rail/forge/client/workbench
 */

import type { Context } from '@snap-rail/cordis'
import type { ClientHandle } from '@snap-rail/client-runtime'
import type { HostLink } from '@snap-rail/connection'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { rpcErrorText, subscribeFrame } from '@snap-rail/connection'
import {
  Badge, Button, Card, CardContent, Collapsible, CollapsibleChevron, CollapsibleContent, CollapsibleTrigger,
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DragScroll,
  Switch, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, TouchSelect,
} from '@snap-rail/client-ui'
import {
  pluginsChangedSchema,
  sessionDeltaSchema,
  type GeneratedPluginInfo,
  type SessionSummary,
} from '../contract.ts'

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

/** The workbench page. */
export function ForgeWorkbenchPage(props: { ctx: Context }): ReactNode {
  const { ctx } = props
  const link: ClientHandle['link'] = ctx.client.link
  const [tab, setTab] = useState('chat')
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [rows, setRows] = useState<ChatRow[]>([])
  const [plugins, setPlugins] = useState<readonly GeneratedPluginInfo[]>([])
  const [running, setRunning] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [focusPluginId, setFocusPluginId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [source, setSource] = useState<SourceView | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<GeneratedPluginInfo | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

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
          if (delta.state === 'error' && delta.message !== undefined) setNotice(delta.message)
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
        setNotice(rpcErrorText(result.error))
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
    if (id !== null) loadMessages(id)
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4" data-forge="workbench">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <TouchSelect
            label="选择会话"
            placeholder={sessions.length === 0 ? '还没有会话' : '选择会话'}
            value={sessionId ?? 'new'}
            options={[
              { value: 'new', label: '＋ 新会话' },
              ...sessions.map(session => ({ value: session.id, label: session.title })),
            ]}
            onValueChange={value => { pickSession(value === 'new' ? null : value) }}
          />
        </div>
        {running && <Button variant="destructive" onClick={stop}>停止</Button>}
      </div>

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="chat">对话</TabsTrigger>
          <TabsTrigger value="plugins">我的插件{plugins.length > 0 ? `（${plugins.length}）` : ''}</TabsTrigger>
        </TabsList>

        <TabsContent value="chat" className="flex min-h-0 flex-1 flex-col gap-3">
          <DragScroll className="min-h-0 flex-1 rounded-md border border-border bg-card">
            <div className="flex min-h-full flex-col justify-end gap-3 p-4">
              {rows.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  描述你想要的功能（例如「加一页显示本周每班的产量对比」），AI 会直接造出可用的页面。
                </p>
              )}
              {rows.map((row, index) => <ChatRowView key={index} row={row} />)}
              {running && rows.at(-1)?.kind !== 'assistant' && (
                <span className="text-sm text-muted-foreground">AI 正在思考…</span>
              )}
              <div ref={bottomRef} />
            </div>
          </DragScroll>
          {notice !== null && <p className="text-sm text-destructive" role="alert">{notice}</p>}
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
              onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) send() }}
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Ctrl+Enter 发送</span>
              <Button size="lg" disabled={draft.trim() === '' || busy || running} onClick={send}>
                {busy ? '发送中…' : running ? '运行中' : '发送'}
              </Button>
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
                  onRemove={() => { setPendingRemoval(plugin) }}
                />
              ))}
            </div>
          </DragScroll>
        </TabsContent>
      </Tabs>

      <SourceDialog source={source} onClose={() => { setSource(null) }} />
      <RemoveDialog
        plugin={pendingRemoval}
        onClose={() => { setPendingRemoval(null) }}
        onConfirm={() => {
          const target = pendingRemoval
          setPendingRemoval(null)
          if (target === null) return
          void link.call('forge.plugin.remove', { id: target.id }).then(result => {
            if (!result.ok) setNotice(rpcErrorText(result.error))
            if (focusPluginId === target.id) setFocusPluginId(null)
            reloadPlugins()
          })
        }}
      />
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
          <DialogDescription>源码可复制回开发环境，按正式插件的构建范式（plugin-kit）打包发行。</DialogDescription>
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

/** The removal confirmation. */
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
  setNotice: (text: string) => void,
): Promise<void> {
  const result = await link.call('forge.plugin.read', { id })
  if (!result.ok) {
    setNotice(rpcErrorText(result.error))
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
