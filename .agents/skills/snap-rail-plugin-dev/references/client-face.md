# 渲染面：种子纪律、语义原语、页面/布局/皮肤与多窗口

渲染面跑在浏览器/Electron renderer 里，构建产物是 **CJS 工厂包**（焊进
`__ModuleLoader__` 执行）。入口导出 `{ name, inject, apply } satisfies Plugin`
（`Plugin` 从 `@snap-rail/cordis` type-only 导入；ui-extension 例外：导出
`{ seeds }`）。

## 种子纪律（最先搞懂，崩都崩在这）

- 渲染面运行时能 `require` 的外部模块 = **种子表**：base 种子 ∪ 其他插件
  贡献的种子（`client.seeds`）∪ 消费方 manifest `client.externalSeeds`
  声明的贡献 id。
- **base 种子由 shell 自动播种，不能写 `externalSeeds`**：connection、
  protocol、util、shell/contract、equipment/contract、react、zod，以及
  `@snap-rail/ui` 的 components / contract / slots / skins / settings /
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

页面组件只组合 `@snap-rail/ui/components` 的内置原语：
Button / Card / Dialog / Table / Tabs / Page / Stack / Grid / Form /
Field / Switch / Select / ScrollArea…。缺原语时**不要在页面里手写交互
组件**——改用现有原语组合，或把原语补进 `@snap-rail/ui`（一方职责）。

| 助手 | import |
| --- | --- |
| 语义组件 / 布局 | `@snap-rail/ui/components` |
| `UI_SLOT_IDS` / slot 定义 | `@snap-rail/ui/contract` |
| `Slot` / `ctx.ui` / `useUi` | `@snap-rail/ui/slots` |
| `ctx.skins` / `useSkinTokens` | `@snap-rail/ui/skins` |
| `ChartFrame` / `useChartTheme` | `@snap-rail/ui/charts` |
| `rpcErrorText` / `subscribeFrame` / `HostLink` | `@snap-rail/plugin-sdk/api/client` |
| `formatClock` / `formatDuration` | `@snap-rail/util`（插件自加 devDependency） |

色值一律 skin token（`data-snap-mode` 切换明暗，禁止硬编码色值和 `dark:`
变体；图表系列只用 `--snap-chart-1…6`，红/黄/绿是状态语义不进数据系列）。

## link 与帧

- `ctx.client` 由内置 `@snap-rail/ui/runtime` 提供（`{ link, surface }`）；
  `inject: ['client']`。
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

## UI 插件写法（页面 / 布局 / 共享组件 / 皮肤，+ 设置页）

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
  开关 `open` / `close` / `toggle`。
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
  用 fallback/诊断补位。
- `window`/`ball` 是布局推荐档案，宿主会夹取边界；用户可在「外观与显示」
  覆盖。
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

### ui-skin：贡献皮肤

```ts
import { DEFAULT_SKIN } from '@snap-rail/ui/skins'
import type { Plugin } from '@snap-rail/cordis'

export default {
  name: '@my-scope/my-skin',
  inject: ['skins'],
  apply(ctx) {
    ctx.skins.register(ctx, {
      id: '@my-scope/my-skin',
      title: '我的皮肤',
      tokens: DEFAULT_SKIN.tokens,          // 换成你的 light/dark token
      presentations: { dialog: 'sheet' },
      css: '[data-snap-skin="@my-scope/my-skin"] [data-snap-part="button.root"] { … }',
    })
  },
} satisfies Plugin
```

皮肤单活（`exclusive: 'skin'`），启用后重启生效；默认皮肤永远兜底。
CSS 必须作用域到 `[data-snap-skin='<id>']`，只命中 `data-snap-part`。

- `tokens` 必须是 **light + dark 两套完整 `SkinTokens`**（颜色/字体/字号/
  间距/圆角/边框/阴影/动效/z-index/控件高度/密度），不用写 `--snap-*`
  前缀——注册后按 `skinTokenVar` 映射注入 `<html>`。
- `presentations` 只选核心实现的展示变体：目标 `dialog` / `select` /
  `tabs` / `toast`；变体 `modal` / `sheet` / `fullscreen` / `popover` /
  `segmented` / `inline`。页面仍可显式覆盖某一处。
- `parts` 可声明本皮肤覆盖的 part 清单（覆盖诊断用，可选）；组件与 part
  的完整目录在 `@snap-rail/ui/contract` 的 `UI_COMPONENTS`，最小覆盖
  root / label / field / panel。

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
- 主窗口与球互斥由底座保证：`present('main')` 收球、`present('ball')` 收
  主窗——面只画两种形态，不做互斥逻辑。

### 球面几何与贴边

几何单源 `resolveBallProfile`（`@snap-rail/shell/contract`）：默认窗口
128×128、球体 112、四周 8px 余量；尺寸可被布局/用户覆盖，但方形、8px
余量固定。三条硬规则：

1. **阴影画在余量内**：CSS `box-shadow` 会被透明窗口边界硬切成灰边；用
   径向渐变把阴影画进 8px 余量并衰减到零。
2. **贴边态读 `shell.ball.dock` + 订阅 `shell/ball-dock-changed`**：
   球拖到左右边缘自动收起，悬停滑出；面在 `collapsed` 时按 `edge` 画
   收起形态，并自留拖拽区（`-webkit-app-region: drag`）。
3. 球出生时可能不在主窗——先 `shell.surface.state` 读当前可见面再画；
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