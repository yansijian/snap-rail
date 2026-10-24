# 八种模板：选型、manifest 与骨架要点

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
| `suite` | suite / suite | 双面 | `suite` 单活 | framework-shadcn + react |
| `ui-view` | plugin / ui | 渲染（clientOnly） | 多活 | framework-shadcn + react |
| `ui-layout` | plugin / ui | 渲染（clientOnly） | 多活 | framework-shadcn + react |
| `ui-extension` | plugin / ui | 渲染（clientOnly） | 多活 | framework-shadcn + react |

UI 模板默认绑定 `@snap-rail/framework-shadcn@^0.2`；`--framework
<包名[@范围]>` 只对 `ui-view` / `ui-layout` / `ui-extension` / `suite`
生效。绑定同时决定 manifest `requires` 条目、devDependency、bundle 外部化
种子——三处由模板保证一致，不会互相矛盾。

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
- 渲染面：CJS 工厂包；种子模块（框架原语、base 契约）外部化到运行时种子
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
import { definePlugin } from '@snap-rail/plugin-sdk'

const driver: DriverRegistration = {
  id: 'my-driver',
  title: '我的驱动',
  schemas: { device: z.object({}), point: z.object({}) },
  createConnection: () => ({ update() {}, dispose() {} }),
}

export default definePlugin({
  name: 'my-driver',
  inject: ['equipment'],
  apply(ctx) { ctx.equipment.registerDriver(ctx, driver) },
})
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
`defineContract` 单源声明。工具与宿主服务同层（tool），**工具互不依赖**
（门禁强制）；跨包场景逻辑请做 suite，不要拆成工具。

### suite（双面、单活）

- 宿主面 `src/index.ts`：场景私有宿主逻辑——服务、store 命名空间、wire
  方法/帧、聚合帧推送。渲染面通过协作服务与宿主面通信，**永不 import 宿主
  代码**。
- 渲染面 `src/client.tsx`：`ctx.uiContract.registerView/registerLayout`
  挂进框架槽位；只组合框架原语。
- 场景契约（跨面类型/帧载荷）住套件包自己的 `./<子路径>` 导出（如首方
  `terminal-ops` 的 `./stats`），别外置。
- 要悬浮球就加 `surfaces.ball` + 对应 `clientBundle`；要用通知/托盘/退出
  策略就 `requires: ['service:shell']`。

### ui-view

```tsx
import '@snap-rail/framework-shadcn/semantic'
import { UI_SLOT_IDS } from '@snap-rail/framework-shadcn/slots'
import { Card, CardContent, CardHeader, CardTitle } from '@snap-rail/framework-shadcn/ui'
import { definePlugin } from '@snap-rail/plugin-sdk'

export default definePlugin({
  name: '@my-scope/my-ui',
  inject: ['uiContract'],
  apply(ctx) {
    ctx.uiContract.registerView(ctx, {
      id: '@my-scope/my-ui',
      title: '我的页面',
      slot: UI_SLOT_IDS.view,
      order: 100,
      render: () => (/* 只组合框架原语 */),
    })
  },
})
```

### ui-layout

`registerLayout(ctx, { id, order, slots: Object.values(UI_SLOT_IDS),
render })` 接管槽位编排。叠层对话框（如退出确认）也走 layout：空
`slots: []` + 高 `order`（如 101，高于套件主布局）。

### ui-extension

`export default { seeds: { widget } }`——`client.seeds` 声明的每个键成为
`<包名>/<键>` 种子 id；组件必须建在框架原语上，不许私有拷贝。消费方在
自己的 `externalSeeds` 里声明 `<你的包>/<键>`。

## 包名规则

- `init` 默认 `@local/<目录名>`：只用于本地试验；发布前改成自己的 npm
  scope。**要同步改的四处**（漏一处 doctor/测试就红）：
  1. `package.json` 的 `name`；
  2. 入口对象里的 `name`（`definePlugin`/`satisfies` 的那一份）；
  3. `tests/manifest.spec.ts` 断言里的包名（init 时硬编码）；
  4. `tsdown.config.ts` 里的包名字符串——**仅 ui-view / ui-layout /
     ui-extension / suite 模板有**（clientBundle 第一参）；driver 等宿主
     单面模板的 tsdown 配置里没有包名，别找。
- `@snap-rail/*` 命名空间保留给官方（无论签名策略强制 verified）；doctor
  会对你的 `@snap-rail/*` 包名给 warning。
- 目录名即初始包名来源，先想好再 init，省一轮重命名。
