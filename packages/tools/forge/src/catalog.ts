/**
 * The static capability catalog `rail_inspect` serves from: the two require
 * whitelists, the renderer seams' exact signatures, the shared UI primitive
 * roster, theme tokens, persistence recipes, code templates, and the
 * failure→check table. The seed ids and host whitelist derive from their
 * single sources at build time; the seam texts are hand-curated from the
 * spine sources and guarded by the catalog snapshot test — a drifted name
 * fails the suite, never a generated plugin at run time.
 *
 * @module @snap-rail/forge/catalog
 */

import { SEED_MODULES } from '@snap-rail/plugin-kit/seeds'
import { HOST_REQUIRE_IDS } from './runner.ts'

/** The `capabilities` catalog section. */
export interface CatalogCapabilities {
  hostRequire: readonly string[]
  clientSeeds: readonly string[]
  slots: string
  seams: string
  uiPrimitives: string
  theme: string
  persistence: string
}

/** The `capabilities` section: what generated code may touch and how. */
export const CATALOG_CAPABILITIES: CatalogCapabilities = {
  hostRequire: HOST_REQUIRE_IDS,
  clientSeeds: SEED_MODULES,
  slots: [
    "uiSlots 槽词表（渲染端 ctx.uiSlots.register(ctx, slot, {id, order, render})）：",
    "- 'titlebar'：顶栏（当前被套件占用，仅追加性内容考虑）",
    "- 'sidebar'：侧栏（流程导航由套件 chrome 管理，慎用）",
    "- 'view'：主内容区（被套件布局占用，不要整体替换）",
    "- 'statusbar'：底部状态条（追加性小块适合）",
    "- 'layout'：整树布局（一个终端一个布局主人，生成插件不要注册）",
    "生成插件的页面一律走 ctx.workflows.register（流程页，出现在侧栏导航）或",
    "ctx.settingsPages.register（设置页），不要注册 layout/titlebar/view。",
  ].join('\n'),
  seams: [
    '== 渲染端（client 半边 apply(ctx) 内可用，需相应 inject 声明）==',
    "ctx.workflows.register(ctx, {id, title, order, requires:[{action,scope:'operator-day'|'day'}], render()}) —— 流程页；requires 空数组=常开；audit 动作门控。",
    "ctx.settingsPages.register(ctx, {id, title, order, render()}) —— 设置页。",
    "ctx.variables.register(ctx, [{device, group, name, type:'i32'|'bool'|…, title?}]) —— 声明消费的现场变量。",
    "ctx.session.current() —— 当前签入操作员（string|null）；事件 'session/changed'。",
    "ctx.client.link.call('域.资源.动词', payload) —— 调宿主 RPC，返回 {ok:true,value}|{ok:false,error}；错误文案用 rpcErrorText(error)（require('@snap-rail/connection')）。",
    "subscribeFrame(link, '域/事件', payloadSchema, cb) —— 帧消费唯一正道（require('@snap-rail/connection')），坏帧自动丢弃。",
    "ctx.uiSlots.register(ctx, slot, {id, order, render}) —— 槽词表见 slots 节。",
    '',
    '== 宿主端（host 半边 apply(ctx) 内可用）==',
    "ctx.rpc.claimDomain(ctx, 'yourdomain') —— 认领 wire 域（1-2 段 kebab，首认即得，进程内唯一）。",
    "ctx.rpc.method(ctx, 'yourdomain.thing.do', {request: z.object({...}).strict()}, handler) —— 方法；request schema 必须给；业务失败 throw new RpcBusinessError({code, details})（require('@snap-rail/protocol')）。",
    "ctx.rpc.frame(ctx, 'yourdomain/changed', {payload: schema}) + ctx.rpc.broadcast('yourdomain/changed', value) —— 帧。",
    "ctx.settings.get(key)/set(key, value) —— 简单持久配置（settings.json 键 '域.名'）；写后广播 settings/changed 事件，两端热应用。",
    "ctx.store.register(ctx, 'yourns', {table: sqliteTable('table', {...})}) —— 结构化持久（data/<ns>.db 独立分库）；只用 drizzle 查询构建器；表注册即建表、加列只增不改。",
    "ctx.timeout(fn, ms)/ctx.interval(fn, ms) —— 定时器（inject:['timer']；禁止全局 setTimeout）。",
    "ctx.on('point/updated', sample => …) —— 现场点样本流（sample:{device,group,name,value,…}）；pointKey({device,group,name}) 生成地址键（require('@snap-rail/field/contract')）。",
    "ctx.audit.record({actor, action, subject?, detail?}) —— 业务事件（也用于流程页门控）。",
  ].join('\n'),
  uiPrimitives: [
    "页面只组合 require('@snap-rail/client-ui') 的共享原语，不自创交互组件：",
    '布局/容器：Card, CardHeader, CardTitle, CardContent, ScrollArea, DragScroll（滚动容器一律 DragScroll，按住拖动）',
    '动作：Button, Switch, Checkbox, RadioGroup, RadioGroupItem',
    '输入：Input, Label, NumberInput（数值输入必须用，触屏数字键盘）, TouchSelect（单选必须用，模态列表）, SchemaForm（zod schema 驱动表单）',
    '展示：Badge, Led, Tooltip, Table/TableHeader/TableBody/TableRow/TableHead/TableCell, Tabs/TabsList/TabsTrigger/TabsContent',
    '弹层：Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter',
    '折叠：Collapsible, CollapsibleTrigger, CollapsibleChevron, CollapsibleContent',
    "横切：useRefresh(ctx, events)（事件驱动重渲染）、rpcErrorText（错误文案）、formatClock/formatDuration（时间，require('@snap-rail/util')）、cn（类名合并）",
  ].join('\n'),
  theme: [
    '禁止硬编码色值与 dark: 变体；只用主题类名与语义色：',
    '表面/文本：bg-background/text-foreground、bg-card、bg-muted、text-muted-foreground、border-border',
    '语义：text-destructive（错误）、text-success（成功）、text-warning（警告）——红黄绿只表达状态语义',
    '图表系列只用 --chart-1…6（类名 text-chart-1 等）；系列1实心+glow-bar 为实际值、系列2虚线为理论值是既有惯例',
    '明暗两模式由 html[data-mode] 切换，页面代码对模式无感知',
  ].join('\n'),
  persistence: [
    '持久化三选一（按需取最简）：',
    "1. 不持久 —— 会话内状态放 apply 闭包变量（不是 this、不是模块顶层）。",
    "2. settings 键值 —— 少量配置类数据；宿主半 ctx.settings.set('yourns.key', value)；值结构自己用 zod 校验；监听 'settings/changed' 热应用。",
    "3. store 命名空间 —— 结构化/历史数据；宿主半 ctx.store.register(ctx, 'yourns', tables)；跨命名空间协作走服务，永不共享表。",
    '渲染端不持久化任何东西；页面状态用 React state + useRefresh。',
  ].join('\n'),
}

/** One code template: ready-to-paste halves (at least one non-null). */
export interface CatalogTemplate {
  /** What this template demonstrates (shown to the model). */
  note: string
  /** A complete host-half function body, when the template has one. */
  hostSrc: string | null
  /** A complete renderer-half function body, when the template has one. */
  clientSrc: string | null
}

/** The `templates` catalog section: complete, pre-flight-clean bodies. */
export const CATALOG_TEMPLATES: Record<string, CatalogTemplate> = {
  'minimal-both': {
    note: '最小双面插件：宿主半边认领域并提供方法，渲染半边注册流程页调用它。',
    hostSrc: [
      "const { z } = require('zod')",
      'return {',
      "  name: 'hello-forge-host',",
      "  inject: ['rpc'],",
      '  apply(ctx) {',
      "    ctx.rpc.claimDomain(ctx, 'hello')",
      "    ctx.rpc.method(ctx, 'hello.greet', { request: z.object({ name: z.string() }).strict() },",
      "      ({ name }) => ({ greeting: '你好，' + name }))",
      '  },',
      '}',
    ].join('\n'),
    clientSrc: [
      "const React = require('react')",
      "const { Card, CardContent, Button } = require('@snap-rail/client-ui')",
      'return {',
      "  name: 'hello-forge-client',",
      "  inject: ['client', 'workflows'],",
      '  apply(ctx) {',
      "    ctx.workflows.register(ctx, {",
      "      id: 'hello', title: '示例页', order: 90, requires: [],",
      '      render() {',
      "        return React.createElement(HelloPage, { ctx })",
      '      },',
      '    })',
      '  },',
      '}',
      'function HelloPage(props) {',
      "  const [reply, setReply] = React.useState(null)",
      '  const ask = () => {',
      "    void props.ctx.client.link.call('hello.greet', { name: 'Forge' }).then(result => {",
      "      if (result.ok) setReply(result.value.greeting)",
      '    })',
      '  }',
      "  return React.createElement(Card, null,",
      "    React.createElement(CardContent, { className: 'p-6 space-y-4' },",
      "      React.createElement(Button, { onClick: ask }, '问好'),",
      "      reply !== null && React.createElement('div', { className: 'text-base' }, reply)",
      '    )',
      '  )',
      '}',
    ].join('\n'),
  },
  'store-counter': {
    note: '宿主半边持久化：drizzle 表 + upsert 计数 + 广播帧；配 frame-subscriber-page 的渲染半边成套。',
    hostSrc: [
      "const { integer, sqliteTable } = require('drizzle-orm/sqlite-core')",
      "const { eq } = require('drizzle-orm')",
      "const { z } = require('zod')",
      "const counters = sqliteTable('counters', {",
      "  id: integer('id').primaryKey(),",
      "  count: integer('count').notNull().default(0),",
      '})',
      'return {',
      "  name: 'demo-counter-host',",
      "  inject: ['rpc', 'store'],",
      '  apply(ctx) {',
      "    ctx.rpc.claimDomain(ctx, 'democount')",
      "    ctx.rpc.frame(ctx, 'democount/changed', { payload: z.object({ count: z.number() }).strict() })",
      "    const db = ctx.store.register(ctx, 'demo_counter', { counters })",
      '    const read = () => db.select().from(counters).where(eq(counters.id, 1)).get()?.count ?? 0',
      "    ctx.rpc.method(ctx, 'democount.bump', { request: z.object({}).strict() }, () => {",
      '      const next = read() + 1',
      '      db.insert(counters).values({ id: 1, count: next })',
      '        .onConflictDoUpdate({ target: counters.id, set: { count: next } }).run()',
      "      ctx.rpc.broadcast('democount/changed', { count: next })",
      '      return { count: next }',
      '    })',
      "    ctx.rpc.method(ctx, 'democount.read', { request: z.object({}).strict() }, () => ({ count: read() }))",
      '  },',
      '}',
    ].join('\n'),
    clientSrc: null,
  },
  'frame-subscriber-page': {
    note: '渲染半边订阅帧：subscribeFrame + 组件状态；配 store-counter 的宿主半边成套。',
    hostSrc: null,
    clientSrc: [
      "const React = require('react')",
      "const { z } = require('zod')",
      "const { Card, CardContent } = require('@snap-rail/client-ui')",
      "const { subscribeFrame } = require('@snap-rail/connection')",
      "const changedSchema = z.object({ count: z.number() }).strict()",
      'return {',
      "  name: 'demo-counter-client',",
      "  inject: ['client', 'workflows'],",
      '  apply(ctx) {',
      "    ctx.workflows.register(ctx, {",
      "      id: 'demo-count', title: '计数页', order: 91, requires: [],",
      '      render() {',
      "        return React.createElement(CounterPage, { ctx })",
      '      },',
      '    })',
      '  },',
      '}',
      'function CounterPage(props) {',
      "  const [count, setCount] = React.useState(0)",
      '  React.useEffect(() => {',
      "    return subscribeFrame(props.ctx.client.link, 'democount/changed', changedSchema,",
      '      payload => setCount(payload.count))',
      '  }, [props.ctx])',
      "  return React.createElement(Card, null,",
      "    React.createElement(CardContent, { className: 'p-6' },",
      "      React.createElement('div', { className: 'text-4xl font-bold' }, String(count))",
      '    )',
      '  )',
      '}',
    ].join('\n'),
  },
  'settings-page': {
    note: '渲染半边注册设置页：表单值经 settings.set 持久，宿主半边监听 settings/changed 热应用。',
    hostSrc: null,
    clientSrc: [
      "const React = require('react')",
      "const { Button, Card, CardContent, Input, Label, NumberInput } = require('@snap-rail/client-ui')",
      'return {',
      "  name: 'demo-settings-client',",
      "  inject: ['client', 'settingsPages'],",
      '  apply(ctx) {',
      "    ctx.settingsPages.register(ctx, {",
      "      id: 'demo-settings', title: '示例设置', order: 80,",
      '      render() {',
      "        return React.createElement(DemoSettingsPage, { ctx })",
      '      },',
      '    })',
      '  },',
      '}',
      'function DemoSettingsPage(props) {',
      "  const [threshold, setThreshold] = React.useState(10)",
      '  const [busy, setBusy] = React.useState(false)',
      '  const save = () => {',
      '    setBusy(true)',
      "    void props.ctx.client.link.call('settings.set', { key: 'demo.threshold', value: threshold })",
      '      .finally(() => { setBusy(false) })',
      '  }',
      "  return React.createElement(Card, null,",
      "    React.createElement(CardContent, { className: 'p-6 space-y-4' },",
      "      React.createElement(Label, null, '报警阈值'),",
      "      React.createElement(NumberInput, { value: threshold, onValueChange: setThreshold }),",
      "      React.createElement(Button, { disabled: busy, onClick: save }, busy ? '保存中…' : '保存')",
      '    )',
      '  )',
      '}',
    ].join('\n'),
  },
}

/** The `troubleshooting` catalog section: failure → first checks. */
export const CATALOG_TROUBLESHOOTING: ReadonlyArray<{ failure: string, check: string }> = [
  {
    failure: 'require("x") 不在白名单内',
    check: 'host 半边只能 require HOST_REQUIRE（见 capabilities），client 半边只能 require SEED_MODULES；其余依赖不可用——用能力缝（服务/RPC/帧）替代，或把逻辑挪到拥有该能力的半边。',
  },
  {
    failure: 'client 半边加载失败：Unexpected token < / JSX / import',
    check: '半边是纯 JS 函数体：无 JSX（用 React.createElement）、无 import/export、无 TypeScript 类型标注、无顶层 await。',
  },
  {
    failure: '半边必须 return 一个插件对象',
    check: '函数体 return { name: 字符串, inject?: [...], apply(ctx) {} }；name 不能为空，apply 必须是函数。',
  },
  {
    failure: 'cannot get property "x" without inject / service "x" is not declared',
    check: 'ctx 上的服务（rpc/settings/store/timer/audit/client/session/workflows/settingsPages/uiSlots/variables）必须先在 inject 数组声明；不确定存在时用 ctx.get(name) 判空。',
  },
  {
    failure: '宿主半边挂载失败（rail_run 返回诊断）',
    check: '读诊断的文件与行号；常见：apply 内引用错误、RPC 域名不是 kebab、request schema 缺失、store 表列名冲突。修复 = 同 pluginId define 新版本再 update，不要重试旧版本。',
  },
  {
    failure: '渲染半边挂载失败（client-report stage=load）',
    check: '与宿主半边相同的形状规则；另外 require 的模块必须在 SEED_MODULES。修复同样走新版本。',
  },
  {
    failure: '页面没有出现',
    check: 'workflows 页的 requires 门控是否满足（audit 动作当天是否存在）；settingsPages 的 id 是否与现有页冲突（同 id 替换）；order 是否把它排到视野外。',
  },
  {
    failure: '帧订阅收不到数据',
    check: '帧名格式 域/事件 且域已 claimDomain；subscribeFrame 的 schema 与广播 payload 完全一致（strict 对多余字段报错）；确认宿主确实 broadcast 了。',
  },
  {
    failure: 'RPC 调用返回 bad-request',
    check: 'request schema 用了 .strict() 时 payload 不能有多余字段；错误文案用 rpcErrorText(error) 展示 issues。',
  },
  {
    failure: '状态重启/换页后丢失',
    check: '可变状态放 apply 闭包内（不是 this、不是模块顶层——代理每次访问重绑 this）；要跨重启就落 settings 或 store。',
  },
  {
    failure: 'store 列变更后旧数据读不出',
    check: '命名空间的表只增列不改列：新列 nullable/带默认；不要改列名或类型；一次定义到位最稳。',
  },
  {
    failure: '界面颜色在明/暗模式下一个看不清',
    check: '用了硬编码色值。改用主题类名（text-muted-foreground、bg-card 等），语义状态用 text-destructive/success/warning。',
  },
]
