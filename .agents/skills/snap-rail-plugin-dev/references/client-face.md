# 渲染面：种子纪律、语义原语、页面/布局/主题与多窗口

渲染面跑在浏览器/Electron renderer 里，构建产物是 **CJS 工厂包**（焊进
`__ModuleLoader__` 执行）。入口导出 `{ name, inject, apply } satisfies Plugin`
（`Plugin` 从 `@snap-rail/cordis` type-only 导入；ui-extension 例外：导出
`{ seeds }`）。

## 种子纪律（最先搞懂，崩都崩在这）

- 渲染面运行时能 `require` 的外部模块 = **种子表**：base 种子 ∪ 其他插件
  贡献的种子（`client.seeds`）∪ 消费方 manifest `client.externalSeeds`
  声明的贡献 id。
- **base 种子由 shell 自动播种，不能写 `externalSeeds`**：connection、
  protocol、util、shell/contract、equipment/contract、react、react-dom、zod，
  以及 `@snap-rail/ui` 的 components / contract / slots / skins / settings /
  runtime / pages / fallback / charts。写了启用预检会报“提供方未安装”。
- **只有其他插件贡献的种子才写 `externalSeeds`**：`<包>/<子路径>`。只
  type-only 导入的贡献种子不产生运行时 require，不用写。
- **import 语句写法**：只准 named/star——
  ```ts
  import { Card, CardContent } from '@snap-rail/ui/components'   // ✓
  import * as slots from '@snap-rail/ui/slots'                   // ✓
  import Card from '@snap-rail/ui/components'                    // ✗ 构建期硬错
  ```
  原因：default 导入经 rolldown 的 CJS node-mode interop 会把 `.default`
  变成整个命名空间对象而非模块自身的 default，运行时挂载即崩。
- **跨插件值导入禁止**：种子共享单实例，协作走 cordis 服务与帧。
- node 侧实现（store-sqlite、drizzle、node:sqlite）**永不进 client
  bundle**；跨端消费类型/schema 走包的 `./contract` 纯面。

## 语义原语（只组合，不手搓）

页面组件只组合 `@snap-rail/ui/components` 的内置原语（`@snap-rail/ui`
0.1.x 实际导出，按文件分组）：

| 组 | 导出 |
| --- | --- |
| 按钮 | `Button`（`intent`: neutral/primary/danger/success/warning；`emphasis`: solid/soft/outline/ghost/link；`size`: sm/md/lg）、`IconButton`、`Spinner` |
| 控件 | `Label`、`Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`、`Switch`、`Checkbox`、`RadioGroup`/`RadioGroupItem`、`TouchSelect`、`Select` |
| 输入 | `Input`、`Textarea`、`NumberInput` |
| 表单 | `Form`、`Field`、`SchemaForm`（见下节） |
| 对话 | `Dialog`/`DialogTrigger`/`DialogClose`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogDescription`/`DialogBody`/`DialogFooter`、`Sheet`（`presentation`: modal/sheet/fullscreen） |
| 反馈 | `Badge`、`Led`、`Progress`、`EmptyState` |
| 容器 | `Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter`、`Panel`、`Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell`/`TableEmpty` |
| 布局 | `Stack`、`Row`、`Grid`、`Split`、`AppShell`、`Page`、`Section`、`Toolbar`、`ScrollArea`、`DragScroll` |

缺原语时**不要在页面里手写交互组件**——改用现有原语组合，或把原语补进
`@snap-rail/ui`（一方职责）。`@snap-rail/ui/contract` 的 `UI_COMPONENTS`
目录里 `popover` / `tooltip` / `menu` / `toast` 目前只有解剖词汇、没有 React
组件。

| 助手 | import |
| --- | --- |
| 语义组件 / 布局 | `@snap-rail/ui/components` |
| `UI_SLOT_IDS` / `UI_SLOT_MODES` / slot 定义 / `UI_COMPONENTS` | `@snap-rail/ui/contract` |
| `Slot` / `ctx.ui` / `useUi` / `useUiVersion(ctx.ui)` | `@snap-rail/ui/slots` |
| `ctx.pages` / `usePagesVersion(ctx)` | `@snap-rail/ui/pages` |
| `ctx.settings` / `SettingsPageDefinition` | `@snap-rail/ui/settings` |
| `ctx.skins` / `useSkinTokens` / `useSkinId` / `DEFAULT_LIGHT` / `DEFAULT_DARK` | `@snap-rail/ui/skins` |
| `ChartFrame` / `Visualization`（同一组件的别名）/ `useChartTheme` / `chartThemeOf` | `@snap-rail/ui/charts`（根 `@snap-rail/ui` 也转出） |
| `ctx.client` 增强 / `useClient()` / `attachBallDrag` | `@snap-rail/ui/runtime` |
| `rpcErrorText` / `subscribeFrame` / `HostLink` | `@snap-rail/plugin-sdk/api/client` |
| `formatClock` / `formatDuration` | `@snap-rail/util`（插件自加 devDependency） |

色值一律 theme token（禁止硬编码色值和 `dark:` 变体；图表系列只用
`--snap-chart-1…6`，红/黄/绿是状态语义不进数据系列）。

## SchemaForm（schema 驱动表单）

`SchemaForm` 是 **JSON-Schema 渲染器**（props `{ schema, value, onChange,
idPrefix? }`），设备管理页用它渲染驱动方言表单，自己的设置页也可以用。宿主
侧经 `z.toJSONSchema(schema, { io: 'input' })` 投影 zod，所以 zod 怎么写决定
控件长什么样：

| zod 写法 | JSON Schema | 控件 |
| --- | --- | --- |
| `z.enum(['a', 'b'])` 或 `z.union([z.literal('a'), z.literal('b')])`（全部分支为字符串/数字/布尔字面量） | `enum` / `anyOf[].const` | `TouchSelect` 单选，回写原字面量类型 |
| `z.boolean()` | `type: 'boolean'` | `Switch`（开启/关闭） |
| `z.number()` / `z.int()`（`.min/.max` → `minimum/maximum`） | `type: 'number' \| 'integer'` | `NumberInput` 带上下限 |
| `z.object` / `z.array` | `type: 'object' \| 'array'` | JSON 文本框（失焦解析） |
| 其余（`z.string()` 等） | — | `Input` |

- `.meta({ title })` → 字段标签（**缺省用键名**，不会不渲染）；`.describe()`
  → 字段说明；`.default()` → 初始值；必填来自 `required`。
- 联合分支混进非字面量（如 `z.object`）就退回 JSON 文本框。

## link 与帧

- `ctx.client` 由内置 `@snap-rail/ui/runtime` 提供（`{ link, surface }`）；
  `inject: ['client']`。组件树内部也可用 `useClient()`（同模块导出）取同一
  对象，不必把 `ctx` 透传到叶子组件。
- 类型增强：`import type {} from '@snap-rail/ui/runtime'`——只为把
  `ctx.client` 的 `Context` 增强带进程序，不产生运行时代码。
- 订阅：`import { subscribeFrame, rpcErrorText } from
  '@snap-rail/plugin-sdk/api/client'`；
  `ctx.effect(() => subscribeFrame(ctx.client.link, '域/事件', schema, cb))`。
- `ctx.client.link.call` 返回 `RpcResult`，`ok: false` 时用
  `rpcErrorText(result.error)` 出文案。

触屏基线：数值输入 `NumberInput`、单选 `TouchSelect`、滚动容器
`DragScroll`（均已在内置组件集内）。

## 区域插槽与贡献（布局之外也能挂 UI）

`UI_SLOT_IDS`（`@snap-rail/ui/contract`）是稳定的区域插槽词汇，占用模式见
`UI_SLOT_MODES`：

| 插槽 | id | 模式 | 由谁渲染 | scoped context |
| --- | --- | --- | --- | --- |
| 布局（保留） | `shell.layout` | one | runtime 直接渲染 `registerLayout` 选举出的活动布局；**不要**向该槽 contribute | `{ surface }` |
| 标题栏 | `shell.titlebar` | one | 布局 | `{ surface, controls }` |
| 标题栏动作 | `shell.titlebar.actions` | many | 布局 | `{ surface, controls }` |
| 侧栏 | `shell.sidebar` | many | 布局 | `{ surface }` |
| 状态栏 | `shell.statusbar` | many | 布局 | `{ surface }` |
| 全局叠层 | `shell.overlay` | many | **内置 runtime 的 OverlayHost（与布局无关，永远在最上层）** | `{ surface }` |
| 悬浮球面 | `shell.ball` | one | 球的渲染面 | `{ surface: 'ball' }` |
| 设置入口 | `settings.entry` | one | 布局（布局不提供时 runtime 兜一个右下角入口） | `SettingsEntryContext` |
| 设置面板 | `settings.surface` | one | runtime 叠层 | `SettingsSurfaceContext` |

不是布局也要往界面挂东西时用 `ctx.ui.contribute`（登记即 effect）：

```tsx
import { UI_SLOT_IDS } from '@snap-rail/ui/contract'

export default {
  name: '@my-scope/my-widget',
  inject: ['ui'],
  apply(ctx) {
    ctx.ui.contribute(ctx, UI_SLOT_IDS.statusbar, {
      id: '@my-scope/my-widget/clock',
      order: 10,
      render: () => <span>…</span>,
    })
  },
} satisfies Plugin
```

- `one` 槽按 `precedence` 选举（高者胜，同分取后注册），`many` 槽按 `order`
  排序；`id` 相同视为替换。
- 退出确认框、全局告警挂 `shell.overlay`——它由 runtime 渲染、不依赖任何布局，
  比「注册一层高 order 的布局」更正确。
- 私有插槽用 `custom:<publisher>.<name>` 命名，先 `ctx.ui.defineSlot` 声明
  再 contribute；跨包消费同一词汇，禁止把包名当插槽 id。
- 槽位诊断在 `ctx.ui.diagnostics()`（unknown-slot / missing-provider /
  declared-not-rendered 等），页面里不要自己发明全局槽。

## UI 插件写法（页面 / 布局 / 共享组件 / 主题，+ 设置页）

### ui-view：注册一个页面

```tsx
import { Card, CardContent } from '@snap-rail/ui/components'
import type { Plugin } from '@snap-rail/cordis'

export default {
  name: '@my-scope/my-view',
  inject: ['pages'],
  apply(ctx) {
    ctx.pages.registerPage(ctx, {
      id: '@my-scope/my-view',
      title: '我的页面',
      order: 100,
      render: () => <Card><CardContent>…</CardContent></Card>,
    })
  },
} satisfies Plugin
```

页面由活动布局渲染：布局里调用 `ctx.pages.active()?.render()`，并用
`usePagesVersion(ctx)` 订阅页面注册/切换触发的重渲染（内置回退布局即此写法）。
`PageDefinition` 只有 `id` / `title` / `order`（必填）/ `render`；
`ctx.pages.list()` 列全部、`ctx.pages.setActive(id)` 切页（未知 id 无操作），
首个注册的页面自动成为活动页。

### ui-view：也可以注册设置页（不新增模板）

设置页与主页面是两套注册表：主页面进 `ctx.pages`（由布局渲染），设置页进
`ctx.settings`——出现在内置设置外壳的左侧导航，按 `group` 分组：

```tsx
ctx.settings.registerPage(ctx, {
  id: '@my-scope/my-view/settings',
  title: '采集参数',
  group: '扩展',
  order: 200,
  keywords: ['阈值', '采样'],
  render: () => <Page title="采集参数" description="保存后立即生效。">…</Page>,
})
```

- `SettingsPageDefinition`：`id` / `title` / `group?`（缺省「其他」）/
  `order` / `keywords?`（搜索词）/ `icon?` / `render`。
- 插件 `inject: ['settings']`；打开指定页 `ctx.settings.open(id)`，程序内
  开关 `open` / `close` / `toggle`；查询 `listPages()` / `isOpen()` /
  `activePage()`。
- 内建页 id 可直接 `open`：`plugins`（插件管理，组「系统」）、`appearance`
  （外观与显示，组「系统」）、`equipment`（设备管理，组「设备」）——例如
  「未装驱动」空态的就地动作 `ctx.settings.open('plugins')`。
- 设置页同样是纯渲染面：配置读写走 `ctx.client.link`（如 `settings.get/set`），
  写后 `settings/changed` 帧热应用；页面只组合语义原语。

### ui-layout：声明并编排区域插槽

```tsx
import { AppShell, Slot } from '@snap-rail/ui'
import { UI_SLOT_IDS } from '@snap-rail/ui/contract'
import type { Plugin } from '@snap-rail/cordis'

export default {
  name: '@my-scope/my-layout',
  inject: ['ui'],
  apply(ctx) {
    ctx.ui.registerLayout(ctx, {
      id: '@my-scope/my-layout',
      order: 0,
      provides: [UI_SLOT_IDS.titlebar, UI_SLOT_IDS.sidebar, UI_SLOT_IDS.settingsEntry, UI_SLOT_IDS.statusbar],
      window: { width: 1440, height: 900, minWidth: 1024, minHeight: 600 },
      ball: { size: 128, enabled: true, dockable: true, collapse: true },
      render: () => <AppShell header={<Slot name={UI_SLOT_IDS.titlebar} />} sidebar={<Slot name={UI_SLOT_IDS.sidebar} />} />,
    })
  },
} satisfies Plugin
```

- `provides` 必须列全布局实际渲染的槽；未列出的槽视为未提供，runtime 会
  用 fallback/诊断补位（`Slot` 对未声明的槽渲染 `null`）。
- **布局选举**：`precedence` 降序 → `order` 升序 → 后注册胜。内置回退布局
  是 `precedence: 0, order: 200`，所以插件布局 `order < 200` 或
  `precedence ≥ 1` 都能接管；`LayoutContribution` 字段 = `id` / `order` /
  `precedence?` / `provides` / `window?` / `ball?` / `render`。
- `window`/`ball` 是布局推荐档案（`WindowProfile` / `BallProfile`，类型来自
  `@snap-rail/shell/contract`），宿主只夹上限（屏幕工作区/球 ≤192），尺寸
  无下限；用户可在「外观与显示」
  覆盖（来源优先级 user > persisted > layout > face > default）：
  - `WindowProfile`：`mode?`（`'windowed' | 'maximized' | 'fullscreen'`）、
    `width?` / `height?`（正整数，≤ 7680×4320，默认 1280×800）、
    `minWidth?` / `minHeight?`、`resizable?` / `center?` / `remember?`
    （默认皆 true）。
  - `BallProfile`：`enabled?` / `size?`（24–192，默认 128；球体 = size − 16）/
    `dockable?` / `collapse?`（默认皆 true）/ `dockEdges?`（四边子集，默认
    全部）/ `collapseRatio?`（收起后留在屏内的比例，1/4–1/2，默认 1/3）/
    `hoverDelayMs?`（指针离开到收起的延迟，300–1200，默认 600）。
- 叠层（退出确认等）**不要**为此注册高 order 的布局——贡献到
  `shell.overlay`（见上节「区域插槽与贡献」）；底座不画任何业务 UI。

### ui-extension：贡献共享组件

```tsx
import { Card, CardContent } from '@snap-rail/ui/components'
const widget = () => <Card><CardContent>…</CardContent></Card>
export default { seeds: { widget } }
```

manifest `client.seeds: ['widget']` → 其他插件在 `externalSeeds` 声明
`<你的包>/widget` 后可 require 到**同一实例**；组件必须建在内置原语上。

### ui-skin：贡献主题

```ts
import { DEFAULT_DARK } from '@snap-rail/ui/skins'
import type { Plugin } from '@snap-rail/cordis'

export default {
  name: '@my-scope/my-skin',
  inject: ['skins'],
  apply(ctx) {
    ctx.skins.register(ctx, {
      id: '@my-scope/my-skin',              // 主题 id 用包名
      title: '我的主题',
      tokens: { ...DEFAULT_DARK.tokens },   // 换成你的单套 token
      css: '[data-snap-skin="@my-scope/my-skin"] [data-snap-part="button.root"] { … }',
    })
  },
} satisfies Plugin
```

主题 = **单套完整观感，纯样式**：`exclusive: 'skin'` 单装载（池里同时
只能启用一个皮肤包）。**`register` 只登记、不激活**：激活单源是设置键
`ui.theme = { id }`，所有已装载主题在主窗 + 悬浮球上**热切、零重载**
（`settings/changed` 到达即换 token）；只有外观页点选**尚未装载**的皮肤包
时，底座先 `plugins.set-enabled` 再写 `ui.theme`，渲染窗经
`ui.rendererAutoReload`（默认开）重载一次。出厂两主题 id 为
`default-light`（钴蓝·白天）/ `default-dark`（钴蓝·黑夜）永远可选，选中
的主题缺失回退 `default-dark`。CSS 必须作用域到 `[data-snap-skin='<id>']`，
只命中 `data-snap-part`。

- `tokens` 是**一套**完整 `SkinTokens`（颜色/字体/字号/间距/圆角/边框/
  阴影/动效/z-index/控件高度 `controlHeightSm/Md/Lg` = 40/48/56px/密度），
  不用写 `--snap-*` 前缀——注册后按 `skinTokenVar` 映射注入 `<html>`
  （camelCase → `--snap-kebab`，`chart1` → `--snap-chart-1`）。起稿可展开
  `DEFAULT_DARK.tokens` 或 `DEFAULT_LIGHT.tokens`（两者都从
  `@snap-rail/ui/skins` 导出）。没有明暗两套、没有跟随系统；想给白天/黑夜
  各出一个主题就在同一包里 `register` 两次（每个主题一个 id，首主题 id 用
  包名——`ctx.skins.activate(selection)` 先按精确 id 找，找不到再把
  selection 当包名解析到该包首个注册的主题；外观页点选未装载的包走的就是
  这条）。`ctx.skins.list()` / `active()` / `tokens()` 供查询，
  `useSkinId()` / `useSkinTokens()` 供组件订阅。
- 组件定义与槽都不在主题内：主题不选组件形态、不占插槽，只提供 token 值
  与 part CSS。组件与 part 的完整目录在 `@snap-rail/ui/contract` 的
  `UI_COMPONENTS`；最小覆盖 root / label / field / panel。

## 多窗口：surface 与悬浮球

一个包可以给每个窗口各出一个渲染面——**一个包、一个开关、每窗一个
bundle**：

```ts
clientBundle('@my-scope/my-suite', 'src/client.tsx'),                          // 主窗
clientBundle('@my-scope/my-suite/ball', 'src/ball.tsx', { outName: 'ball' }),  // 球
```

```json
"client": { "entry": "lib-client/client.js", "surfaces": { "ball": "lib-client/ball.js" } }
```

- 主面模块 id = 包名；辅助面 = `<包名>/<surface>`；`outName` 只决定文件名。
- `main` 不出现在 `surfaces`；没出面又开了窗 → kernel 回退页，不会白屏。
- **辅助面不订阅工业点**：要显示的信息由宿主面聚合后推帧。
- 主窗口与球**各自独立显隐**，底座不互斥：`present`/`hide` 只作用于自己
  点名的面，所有显隐（含任务栏还原等旁路）都以 `shell/surface-changed` 帧
  广播。需要「窗口与球二选一」就自己编排：订阅 `shell/surface-changed`，
  见 `main` 可见 `hide('ball')`、见 `main` 隐藏 `present('ball')`
  （`present('ball')` 受 `enabled` 门禁）。

### 球面几何与贴边

几何单源 `resolveBallProfile`（`@snap-rail/shell/contract`）：默认窗口
128×128、球体 112、四周 8px 余量；尺寸可被布局/用户覆盖（24–192，下限
只是 8px 余量的几何技术下限），但
方形、8px 余量固定——面里 `100% × 100%` 恒等于 `size × size`。四条硬规则：

1. **阴影画在余量内**：CSS `box-shadow` 会被透明窗口边界硬切成灰边；用
   径向渐变把阴影画进 8px 余量并衰减到零。
2. **贴边态读 `shell.ball.dock` + 订阅 `shell/ball-dock-changed`**：载荷
   `{ edge: 'left' | 'right' | 'top' | 'bottom' | null, collapsed: boolean,
   visiblePx: number }`。球贴边停泊后指针离开 `hoverDelayMs` 即收起（四边
   一律；留在屏内的像素 = `visiblePx`，默认 size × 1/3 ≈ 43），悬停滑出；
   停泊先发一次 `collapsed: false`，收起再发 `collapsed: true`。面在
   `collapsed` 时按 `edge` 画收起形态。
3. **拖拽用 `attachBallDrag`（`import { attachBallDrag } from
   '@snap-rail/ui/runtime'`，ui ≥ 0.1.1）**：整球一个 drag/click 表面——
   按住拖过 4px 阈值（`threshold` 可调）发 `shell.ball.move` `begin`，松开发
   `end`，原地按放回调 `onClick`；宿主从 OS 光标取锚、16ms 轮询让球窗绝对
   跟随，贴边/收起/位置记忆全在宿主。**不要** import
   `@snap-rail/client-kernel`（app-internal，npm 上没有类型），**不要**用
   CSS `-webkit-app-region`（透明窗命中不可靠），**不要**自己流式上报坐标
   （窗动则坐标系动，必然停摆抖动）。
4. 球出生时可能不在主窗——先 `shell.surface.state` 读当前可见面再画；
   `present('main')` 是回退圆球唯一的动作。

## 退出策略（套件的渲染面 + 宿主面配合）

1. 宿主面声明一次：`ctx.shell.window.setExitPolicy(ctx, { close: 'ball',
   quit: 'hold' })`（登记即 effect；`'hold'` 把请求挂起交回插件）。
2. 渲染面订阅 `shell/exit-requested` 帧 → **自己画确认框**（贡献到
   `shell.overlay`，见「区域插槽与贡献」）；底座不画 UI。
3. 用户选择后 `shell.exit.resolve` 应答 `'ball' | 'tray' | 'quit' |
   'cancel'` 并撤下自己；10s 未应答按 quit 兜底。
4. 确认框要一个活着的渲染面：宿主面收到 `source: 'tray'` 且主窗藏着时，
   先 `ctx.shell.surface.present(ctx, 'main')` 把窗口叫回来。

## 测试

- 渲染面组件测试用 happy-dom / testing-library 直挂装配链路（init 仓库的
  devDependencies 不含它们，按需加）。
- 每个注册都断言 disposer：卸载后槽位/帧订阅消失。