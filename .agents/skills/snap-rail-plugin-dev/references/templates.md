# 九种模板：选型、manifest 与骨架要点

`init` 生成的仓库自带：`package.json`（manifest 与依赖已配好）、`src/`
骨架、`tsdown.config.ts`、`tsconfig.json`（extends
`@snap-rail/plugin-sdk/tsconfig.plugin.json`）、一个能通过的冒烟测试
（`tests/manifest.spec.ts`）、`.gitignore`，以及 **`AGENTS.md`**——本仓库
的短规范，动手前先读一遍。

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

`ctx.skins.register(ctx, { id, title, tokens, presentations, css })` 注册
token + part CSS + 展示变体。皮肤单活（`exclusive: 'skin'`），默认皮肤
永远兜底；所有 CSS 规则必须作用域到 `[data-snap-skin='<id>']`，只命中
`data-snap-part`。启用后重启生效。

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
