# 九种模板：选型、manifest 与骨架要点

`init` 生成的仓库自带：`package.json`（manifest 与依赖已配好）、`src/`
骨架、`tsdown.config.ts`、`tsconfig.json`（extends
`@snap-rail/plugin-sdk/tsconfig.plugin.json`）、一个能通过的冒烟测试
（`tests/manifest.spec.ts`）、`.gitignore`，以及 **`AGENTS.md`**——本仓库
的短规范，动手前先读一遍。

## 先拆解：一个功能 = N 个可复用插件

SKILL.md「先拆解，再选模板」一节的判定依据与协作链路。拆解单位是
**复用预期**：对每个能力问「换一种设备 / 换一种展示 / 换一个场景，它
还有没有用」，答案彼此独立 → 各自成包。

### 能力缝 → 包型

| 需求里的能力 | 包型 | 独立复用面 |
| --- | --- | --- |
| 接一种协议/设备（采集、读写点） | `driver` | 每种设备一行、多活并存；被所有看板/套件共享 |
| 通用展示（看板/图表，读底座点数据） | `ui-view` | 换图表形状、换数据源都不动驱动 |
| 场景私有闭环（跨点聚合 + 持久化 + 专属界面） | `suite` | 单活；场景本身就是交付单位 |
| 多页面共享的组件/图表卡 | `ui-extension` | `<包>/<键>` 种子跨包同一实例 |
| 全局存储后端 | `store-provider` | 消费者零改动 |
| 宿主能力服务（无界面、跨插件协作） | `host-service` | 服务是插件间协作唯一通道 |

布局/主题是替换宿主外观的独立包型，一般不作为功能拆解的产物。

示例提案——「采集欧姆龙 PLC 的数据，并用柱状图显示」：

| 包 | 模板 | 职责 | 复用收益 |
| --- | --- | --- | --- |
| `@you/driver-omron` | driver | 欧姆龙协议适配、采样上报 | 再接三菱/西门子各加一行驱动，互不影响 |
| `@you/dashboard-bar` | ui-view | 订阅底座点帧，画柱状图 | 换折线/仪表盘只换这包；配任何驱动都能用 |

向用户确认后再各自 init——每包一套标准工作流，不要在一个仓库里混构建。

### 拆开之后怎么协作（永不互相 import，通常也互不 requires）

- **驱动 ↔ 看板互不依赖**：都只面向内置 equipment 底座，各自
  `requires: ['@snap-rail/equipment']`。换驱动、装卸看板互不影响——
  这正是复用的来源；谁也不该 require 谁。
- **看板页取数链路**（渲染面，全走 base 种子与契约；`link` 来自
  `useClient()` 或 `ctx.client.link`）：
  1. `import '@snap-rail/equipment/contract'`（side-effect 合并方法表），
     named 导入 `equipmentFrameSchemas` 拿帧 schema——运行时是 base 种子，
     **不写** `externalSeeds`；npm 侧 `pnpm add -D @snap-rail/equipment`
     供类型/构建（ui-view 模板默认不带）；
  2. `link.call('equipment.points.list', {})` 发现点表、
     `equipment.points.read` 取现值（尚无采样的点返回
     `{ value: null, time: 0 }`）；
  3. **先 `link.call('equipment.points.subscribe',
     { points: [{ device, group, name }, …] })`**（至少一个点）：
     `equipment/point-updated` 帧按订阅引用计数门禁，不订阅不流动
     （结构帧 point-added/removed 与 connection-status 恒流，不受门禁）；
  4. `subscribeFrame(link, 'equipment/point-updated',
     equipmentFrameSchemas['equipment/point-updated'], cb)`——载荷
     `{ device, group, name, value, time }`；
  5. 柱状图包在 `ChartFrame`/`Visualization` 里画（铁律 6/7）；卸载时
     对称调用 `equipment.points.unsubscribe`。
- **何时升级成 suite**：需要**场景私有聚合**（跨点计算、按班次持久化）
  时，聚合逻辑做成 suite 的宿主面——`ctx.on('point/updated',
  sample => …)` 直接听底座点事件（宿主面进程内事件，无订阅门禁，载荷
  `{ device, group, name, value, time }`），聚完
  `rpc.broadcast('<域>/<帧>', …)` 推自己的域帧；看板订聚合帧，纯展示
  仍留独立 ui-view。自建域帧的 schema 住自己的包，跨包订阅方自备 zod
  副本（跨插件值导入禁止）。

### 何时合（防过度拆）

- 场景私有宿主逻辑 + 专属界面 = 一个 suite；场景契约住套件包自己的
  `./<子路径>` 导出，别外置。
- 设置页不单独成包：页面同包追加 `ctx.settings.registerPage`。
- 工具互不依赖（门禁强制）；跨包场景逻辑做 suite，不要拆成工具。
- 判据永远是复用预期：两个能力事实上只在一个场景一起用 → 合；各自会被
  独立替换/复用 → 拆。

### 多包交付

- 默认每包一仓、各自 feed；也可同仓多包、共用一个 `dist/` 出 feed
  （feed 按包名收编，同目录同名只留最新版）。
- 整组交付 / 离线部署做**组合包**（根 `recipe.yml` + 每成员一个已签名
  zip，用户装一次齐活），见 [publish.md](publish.md) 的「组合包」。

## 选型速查

| template | kind/layer | 面 | 独占 | 默认依赖锚点 |
| --- | --- | --- | --- | --- |
| `driver` | driver / equipment | 宿主 | 多活 | `@snap-rail/equipment@^0.1.0`（dev）+ zod |
| `store-provider` | plugin / store | 宿主 | `store-backend` 单活 | `@snap-rail/store@^0.1.0`（dev） |
| `host-service` | plugin / tool | 宿主 | 多活 | cordis |
| `tool` | plugin / tool | 宿主 | 多活 | cordis |
| `suite` | suite / suite | 双面 | `suite` 单活 | `@snap-rail/ui` + react |
| `ui-view` | plugin / ui | 渲染（clientOnly） | 多活 | `@snap-rail/ui` + react |
| `ui-layout` | plugin / ui | 渲染（clientOnly） | 多活 | `@snap-rail/ui` + react |
| `ui-extension` | plugin / ui | 渲染（clientOnly） | 多活 | `@snap-rail/ui` + react |
| `ui-skin` | skin / ui | 渲染（clientOnly） | `skin` 单活 | `@snap-rail/ui` + react |

UI 模板以 base 种子 `@snap-rail/ui` 为语义基座；它不是 `requires` 条目，
模板只把它放进 devDependencies 供类型/构建，运行时由终端种子表提供。
宿主面模板依赖锚点列的「（dev）」只是 init 生成态——动手前按 SKILL.md
1.5「宿主面构建纪律」把契约包挪进 `dependencies`。
`--framework <包名[@范围]>` 只对 UI 模板生效，作为类型/构建包覆盖入口保留。

要写宿主 RPC 或渲染帧时不需要新增依赖：宿主类型从
`@snap-rail/plugin-sdk/api`、渲染 link/帧从 `/api/client` 导入；完整骨架见
[faces-and-wire.md](faces-and-wire.md)。

## tsdown 配置形态（生成后一般不用动）

```ts
// 宿主单面（driver / store-provider / host-service / tool）：
import { hostBundle } from '@snap-rail/plugin-sdk'
export default hostBundle('src/index.ts')

// 渲染单面（ui-*）：
import { clientBundle } from '@snap-rail/plugin-sdk'
export default clientBundle('@my-scope/my-ui', 'src/client.tsx')

// 双面（suite）：
import { clientBundle, hostBundle } from '@snap-rail/plugin-sdk'
export default [
  hostBundle('src/index.ts'),
  clientBundle('@my-scope/my-suite', 'src/client.tsx'),
  // 辅助面再各加一条，outName 决定文件名，第三参决定模块 id：
  clientBundle('@my-scope/my-suite/ball', 'src/ball.tsx', { outName: 'ball' }),
]
```

- 宿主面：ESM node 包；**只有 package.json `dependencies` 保持外部**（含
  `@snap-rail/equipment` 等契约包——所以要把模板放在 devDependencies 的
  契约包挪进 dependencies），其余第三方库打进包内；运行时由终端按
  appRoot 优先、池内回退解析 `@snap-rail/*` / `zod` / `drizzle-orm`。
- 渲染面：CJS 工厂包；种子模块（`@snap-rail/ui` 语义原语、base 契约）外部化到运行时种子
  表，第三方库与 CSS 全部内联，位图/SVG 以 `snap-plugin://` URL 随包发射。
- 两个模板层面的坑（详见
  [host-face.md](host-face.md) 的「构建纪律」）：入口对 plugin-sdk 只准
  type-only 导入（`satisfies Plugin` 替代 `definePlugin`）；重发布前清空
  产物目录（hostBundle 不清目录、pack 整目录收编）。

## 各模板骨架要点

### driver

```ts
import '@snap-rail/equipment'
import { z } from 'zod'
import type { DriverRegistration } from '@snap-rail/equipment/driver'
import type { Plugin } from '@snap-rail/cordis'

const driver: DriverRegistration = {
  id: 'my-driver',
  title: '我的驱动',
  schemas: { device: z.object({}), point: z.object({}) },
  createConnection: () => ({ update() {}, dispose() {} }),
}

export default {
  name: 'my-driver',
  inject: ['equipment'],
  apply(ctx) { ctx.equipment.registerDriver(ctx, driver) },
} satisfies Plugin
```

细节全部在 [host-face.md](host-face.md) 的「驱动」一节——schema 怎么写才有
表单标签、`probe` 怎么给、连接怎么上报。

### store-provider

实现 `@snap-rail/store` 的 `StoreService`，`ctx.provide('store', store)`
注册；manifest 带 `exclusive: 'store-backend'`。全局单活：装了你就替换掉
现有后端，所有消费者零改动。参考 [host-face.md](host-face.md)。

### host-service / tool

骨架是空 `apply()`。宿主服务 = `ctx.provide('<服务名>', 实现)` +
`inject: ['<依赖服务>']`；wire 方法/帧用 `@snap-rail/protocol` 的
`defineContract` 单源声明，挂载用 `ctx.rpc`（类型从
`@snap-rail/plugin-sdk/api` 导入，`inject: ['rpc']`）。契约模块 import
`zod`：`@snap-rail/protocol` 与 `zod` 都放 `dependencies`（host value
import）。工具与宿主服务同层（tool），**工具互不依赖**（门禁强制）；跨包
场景逻辑请做 suite，不要拆成工具。

### suite（双面、单活）

- 宿主面 `src/index.ts`：场景私有宿主逻辑——服务、store 命名空间、wire
  方法/帧、聚合帧推送。`ctx.rpc.claimDomain/serveContract` 挂载；类型从
  `@snap-rail/plugin-sdk/api` 导入。渲染面通过 wire 与宿主面通信，**永不
  import 宿主代码**。
- 渲染面 `src/client.tsx`：`ctx.pages.registerPage`（主页面）与
  `ctx.ui.registerLayout`（布局）注册进内置 UI 基座；`ctx.client.link` +
  `subscribeFrame`（SDK `/api/client`）消费宿主帧；只组合
  `@snap-rail/ui/components` 的语义原语。设置页不需要另一个模板：同一个
  `ui-view` 包在 `apply` 里追加 `ctx.settings.registerPage` 即可
  （片段见 [client-face.md](client-face.md)）。
- 场景契约（跨面类型/帧载荷）住套件包自己的 `./<子路径>` 导出（如首方
  `terminal-ops` 的 `./stats`），别外置。契约模块 import `zod`；
  `dependencies` 至少 `@snap-rail/protocol` + `zod`（host value import，
  `hostBundle` 才会外部化）。UI 用 `formatClock`/`formatDuration` 时把
  `@snap-rail/util` 加 devDependency。
- 要悬浮球就加 `surfaces.ball` + 对应 `clientBundle`；要用通知/托盘/退出
  策略就 `requires: ['service:shell']`。
- 双面最小通道完整代码见 [faces-and-wire.md](faces-and-wire.md)。

### ui-view

```tsx
import { Page } from '@snap-rail/ui/components'
import type { Plugin } from '@snap-rail/cordis'

export default {
  name: '@my-scope/my-ui',
  inject: ['pages'],
  apply(ctx) {
    ctx.pages.registerPage(ctx, {
      id: '@my-scope/my-ui',
      title: '我的页面',
      order: 100,
      render: () => <Page title="我的页面">…</Page>,
    })
  },
} satisfies Plugin
```

同一个包也可以在 `apply` 里追加 `ctx.settings.registerPage`，把设置页注册进
内置设置外壳（无需新模板；字段见 [client-face.md](client-face.md)）。

### ui-layout

`ctx.ui.registerLayout(ctx, { id, order, provides: [...], window, ball,
render })` 声明并编排区域插槽。叠层对话框（如退出确认）**不要**为此注册
高 order 布局——贡献到 `UI_SLOT_IDS.overlay`（
`ctx.ui.contribute(ctx, UI_SLOT_IDS.overlay, { id, order, render })`），由
内置 runtime 渲染、永远在最上层。

### ui-extension

`export default { seeds: { widget } }`——`client.seeds` 声明的每个键成为
`<包名>/<键>` 种子 id；组件必须建在 `@snap-rail/ui/components` 原语上，
不许私有拷贝。消费方在自己的 `externalSeeds` 里声明 `<你的包>/<键>`。

### ui-skin

`ctx.skins.register(ctx, { id, title, tokens, css })` 注册一套完整观感：
**单套 token + 可选 part CSS，纯样式**（组件定义与槽都不在主题内）。主题
id 用包名；单活（`exclusive: 'skin'`），出厂「钴蓝·白天/黑夜」永远可选、
缺失回退黑夜；所有 CSS 规则必须作用域到 `[data-snap-skin='<id>']`，只命中
`data-snap-part`。启用后主窗自动重载生效，外观页主题列表点选即用。

## 包名规则

- `init` 默认 `@local/<目录名>`：只用于本地试验；发布前改成自己的 npm
  scope。**要同步改的四处**（漏一处 doctor/测试就红）：
  1. `package.json` 的 `name`；
  2. 入口对象里的 `name`（`satisfies Plugin` 的那一份）；
  3. `tests/manifest.spec.ts` 断言里的包名（init 时硬编码）；
  4. `tsdown.config.ts` 里的包名字符串——**仅 ui-view / ui-layout /
     ui-extension / ui-skin / suite 模板有**（clientBundle 第一参）；
     driver 等宿主单面模板的 tsdown 配置里没有包名，别找。
- `@snap-rail/*` 命名空间保留给官方（无论签名策略强制 verified）；doctor
  会对你的 `@snap-rail/*` 包名给 warning。
- 目录名即初始包名来源，先想好再 init，省一轮重命名。
