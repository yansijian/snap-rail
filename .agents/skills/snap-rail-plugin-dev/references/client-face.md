# 渲染面：种子纪律、框架原语、多窗口与退出策略

渲染面跑在浏览器/Electron renderer 里，构建产物是 **CJS 工厂包**（焊进
`__ModuleLoader__` 执行）。入口导出 `definePlugin({ name, inject, apply })`
（ui-extension 例外：导出 `{ seeds }`）。

## 种子纪律（最先搞懂，崩都崩在这）

- 渲染面运行时能 `require` 的外部模块 = **种子表**：base 契约种子 ∪ 框架
  贡献种子（框架的面经 `client.seeds` 贡献：
  `ui/slots/semantic/settings-pages/session/variables/workflows/runtime/
  fallback`）∪ 消费方 manifest `client.externalSeeds` 声明的 id。
- **import 语句写法**：只准 named/star——
  ```ts
  import { Card, CardContent } from '@snap-rail/framework-shadcn/ui'   // ✓
  import * as slots from '@snap-rail/framework-shadcn/slots'           // ✓
  import Card from '@snap-rail/framework-shadcn/ui'                    // ✗ 构建期硬错
  ```
  原因：default 导入经 rolldown 的 CJS node-mode interop 会把 `.default`
  变成整个命名空间对象而非模块自身的 default，运行时挂载即崩。
- **每个 import 到的外部种子 id 必须出现在 manifest
  `client.externalSeeds`**，否则启用预检拒装。UI 模板默认声明
  `<framework>/slots`、`<framework>/semantic`、`<framework>/ui`；多 import
  了一条（如 `/session`）就自己补。
- **跨插件值导入禁止**：种子共享单实例，协作走 cordis 服务与帧。
- node 侧实现（store-sqlite、drizzle、node:sqlite）**永不进 client
  bundle**；跨端消费类型/schema 走包的 `./contract` 纯面。

## 框架原语（只组合，不手搓）

页面组件只组合 `@snap-rail/framework-shadcn/ui` 的 shadcn 原语：
Button / Card / Dialog / Table / Tabs / Collapsible / SchemaForm…
缺原语时**不要在页面里手写交互组件**——要么改用现有原语组合，要么等框架
包补（那不是你能做的决定）。

横切物不手搓：重渲染 tick 用 `useRefresh(ctx, events)`；错误文案用
`rpcErrorText`；时间用 `formatClock` / `formatDuration`；色值一律 theme
令牌（明暗由 `html[data-mode]` 切换，禁止硬编码色值和 `dark:` 变体；图表
系列只用 `--chart-1…6`，红/黄/绿是状态语义不进数据系列）；schema 驱动的
配置表单用 `SchemaForm`。这些横切助手来自框架包（`/ui`、`/runtime`），以
包内 d.ts 为准。

触屏基线：数值输入 `NumberInput`（数字键盘）、单选 `TouchSelect`（模态列
表）、滚动容器 `DragScroll`（按住拖动）。

## 三种 UI 插件写法

### ui-view：挂一个页面

```tsx
ctx.uiContract.registerView(ctx, {
  id: '@my-scope/my-ui',          // 全局唯一
  title: '我的页面',
  slot: UI_SLOT_IDS.view,          // 槽位词汇单源 UI_SLOT_IDS；要标题栏/侧栏/状态栏换别的 slot id
  order: 100,
  render: () => (<Card>…</Card>),  // 只组合框架原语
})
```

- 消费框架服务：按需 `inject: ['workflows', 'session', 'variables']`（框架
  提供的服务名），import 对应子路径（`/workflows`、`/settings-pages`、
  `/session`、`/variables`）并把它们加进 `externalSeeds`。
- 流程页经 `ctx.workflows.register` 声明 `requires` 门控；需求变量经
  `ctx.variables.register`，消费走 `usePoint` / `useBinding`。

### ui-layout：接管编排 / 叠层

```ts
ctx.uiContract.registerLayout(ctx, {
  id: '@my-scope/my-layout',
  order: 0,                                   // 数字越小越底层；叠层 occupant 取 101+
  slots: Object.values(UI_SLOT_IDS),          // 或只声明你编排的槽位
  render: () => (/* 槽位编排 */),
})
```

**没有 overlay 槽**：要叠在套件布局之上的对话框（如退出确认），注册为
`slots: []` + `order: 101` 的叠层 layout occupant，订阅相关帧决定显示与否，
用完撤下自己。

### ui-extension：贡献共享组件

```tsx
import { Card, CardContent } from '@snap-rail/framework-shadcn/ui'
const widget = () => (<Card><CardContent>…</CardContent></Card>)
export default { seeds: { widget } }
```

manifest `client.seeds: ['widget']` → 其他插件的渲染面在 `externalSeeds`
声明 `<你的包>/widget` 后可 require 到**同一实例**。组件必须建在框架原语上，
不许私有拷贝框架已有组件。

## 多窗口：surface 与悬浮球

一个包可以给每个窗口各出一个渲染面——**一个包、一个开关、每窗一个
bundle**：

```ts
// tsdown.config.ts
clientBundle('@my-scope/my-suite', 'src/client.tsx'),                          // 主窗
clientBundle('@my-scope/my-suite/ball', 'src/ball.tsx', { outName: 'ball' }),  // 球
```

```json
"client": { "entry": "lib-client/client.js", "surfaces": { "ball": "lib-client/ball.js" } }
```

- 主面模块 id = 包名；辅助面 = `<包名>/<surface>`；`outName` 只决定文件名。
  ⚠ 版本陷阱：plugin-kit `0.2.2`（官方 npm）+ plugin-sdk `0.2.4` 起类型才
  放行 `surfaces`（更早安装版、或 npmmirror 滞后解析出的旧版会拒，见
  [manifest.md](manifest.md)）——被拒就先做单 `client.entry`。
- `main` 不出现在 `surfaces`；没出面又开了窗 → kernel 朴素回退页，不会白屏。
- **辅助面不订阅工业点**（球隐藏时不该保留数据通路）：要显示的信息由宿主面
  聚合后推帧（如 `production/stats-changed`、`shell/ball-changed`）。
- 主窗口与球互斥由底座保证：`present('main')` 收球、`present('ball')` 收主
  窗——面只画两种形态，不做互斥逻辑。

### 球面几何与贴边（ball surface）

几何单源 `BALL_SURFACE`（`@snap-rail/shell/contract`）：窗口 128×128、球体
112、四周 8px 余量。三条硬规则：

1. **阴影画在余量内**：CSS `box-shadow` 会被透明窗口边界硬切成灰边；用径向
   渐变把阴影画进 8px 余量并衰减到零。
2. **贴边态读 `shell.ball.dock` + 订阅 `shell/ball-dock-changed`**
   （`{edge, collapsed, visiblePx}`）：球拖到左右边缘自动收起只留 1/3、悬停
   滑出——几何与时机全归底座；面在 `collapsed` 时按 `edge` 在可见条里画
   **收起形态**（贴边小标签），并**自留拖拽区**
   （`-webkit-app-region: drag`），否则收起的球拽不回来。
3. 球出生时可能不在主窗（主窗隐藏）——先 `shell.surface.state` 读当前可见
   面再画；`present('main')` 是回退圆球唯一的动作。

球内容态：`shell.ball.state` 读 + `shell/ball-changed` 帧推送（宿主面
`ctx.shell.ball.setState` 聚合）。

## 渲染面 shell 契约（`@snap-rail/shell/contract`）

| API | 说明 |
| --- | --- |
| `shell.toast` | 单向通知：无按钮、无回调，点击聚焦主窗口。 |
| `shell.surface.present / hide / state` | 立起/收起窗口；`state` 读当前可见面。 |
| `shell.ball.state` / `shell.ball.dock` | 读宿主聚合的球内容态 / 窗口贴边态（帧：`shell/ball-changed`、`shell/ball-dock-changed`）。 |
| `shell.exit.resolve` | 应答挂起的退出请求（见下）。 |

帧消费一律 `subscribeFrame`，禁止手写判形。

## 退出策略（套件的渲染面 + 宿主面配合）

1. 宿主面声明一次：`ctx.shell.window.setExitPolicy(ctx, { close: 'ball',
   quit: 'hold' })`（登记即 effect；`'hold'` 把请求挂起交回插件）。
2. 渲染面订阅 `shell/exit-requested` 帧（载荷 `{source: 'window' | 'tray'}`）
   → **自己画确认框**（叠层 layout occupant，`order` 高于套件主布局，如
   101——底座不画任何 UI）。
3. 用户选择后 `shell.exit.resolve` 应答 `'ball' | 'tray' | 'quit' |
   'cancel'` 并撤下自己；**10s 未应答按 quit 兜底**——确认框是锦上添花，
   不能变成关不掉。
4. 确认框要一个活着的渲染面：宿主面收到 `source: 'tray'` 且主窗藏着时，先
   `ctx.shell.surface.present(ctx, 'main')` 把窗口叫回来，取消时把球放回去。

## 测试

- 渲染面组件测试用 happy-dom / testing-library 直挂装配链路（init 仓库的
  devDependencies 不含它们，按需加）。
- 每个注册都断言 disposer：卸载后槽位/帧订阅消失。
