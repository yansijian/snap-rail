# 跨面协作：三张表、宿主 RPC 与渲染面 link/帧

写双面套件（或任何要跨宿主/渲染面通信的插件）之前先读这一章。多数“能力到底
有没有、该从哪 import”的困惑，都是把下面三张表混成了一张。

## 0. 三张表别混

| 表 | 写在哪 | 回答什么 | 典型错误 |
| --- | --- | --- | --- |
| npm 依赖表 | `package.json` 的 `dependencies` / `devDependencies` | TypeScript 能 resolve 什么、`hostBundle` 外部化什么 | 把 base 种子当 npm 包单独安装；把 `@snap-rail/protocol` 放 devDependencies 导致 host 内联 |
| 运行时种子表 | 渲染面 `client.externalSeeds`；base 种子由终端自动播种 | 渲染面 bundle 运行时能 `require` 什么 | 把 `@snap-rail/connection` / `@snap-rail/shell/contract` 写进 `externalSeeds`，启用预检报“提供方未安装” |
| 组合依赖表 | `snapRail.requires` | 终端里必须安装/启用哪些插件或服务 | 把 npm 类型包（gateway/connection/settings）写进 `requires`，找不到插件 |

一句话：**种子 id 是运行时模块 id，不是可安装插件；npm 类型包也不是插件。**

## 1. 能力地图

### 宿主面

| 你要做的事 | 代码里怎么写 | 运行时谁提供 | manifest |
| --- | --- | --- | --- |
| 注册设备驱动 | `import type { DriverRegistration } from '@snap-rail/equipment/driver'`；`ctx.equipment.registerDriver(ctx, driver)` | equipment 插件（zip） | `requires: ['@snap-rail/equipment']` |
| 持久化命名空间 | `ctx.store.register(ctx, '<ns>', drizzle表)` | store 后端 | `requires: ['service:store']` |
| 宿主 RPC / wire 方法/帧 | `import type { GatewayService } from '@snap-rail/plugin-sdk/api'`；`inject: ['rpc']`；`ctx.rpc.claimDomain` / `serveContract` / `broadcast` | base gateway（builtin） | **不写** `requires` |
| 简单配置 | `import type { SettingsService } from '@snap-rail/plugin-sdk/api'`；`inject: ['settings']`；`ctx.settings.get/set` | base settings（builtin） | **不写** `requires` |
| 通知/托盘/窗口/球/退出 | `ctx.shell.*`；`import type { ShellService } from '@snap-rail/shell'` | base shell（builtin） | `requires: ['service:shell']` |

`@snap-rail/gateway` / `@snap-rail/connection` / `@snap-rail/settings` 是
`@snap-rail/plugin-sdk` 的 dependencies，也是终端的 base 运行时包。插件作者
**不需要单独安装它们**，也不要把它们写进 `requires` 或
`client.externalSeeds`。SDK 的 `/api` 门面已经转出了宿主类型。

> pnpm 隔离安装时，connection 是 SDK 的传递依赖，`pack` 的 `seedAbi` 可能
> 省略它（不影响运行，只是该 id 不做版本比对）；需要严格校验时把
> `@snap-rail/connection` 加回 devDependency。

### 渲染面

| 你要做的事 | 代码里怎么写 | 运行时谁提供 | `externalSeeds` |
| --- | --- | --- | --- |
| 拿宿主链接 | `ctx.client.link`；`inject: ['client']`；`import type {} from '@snap-rail/ui/runtime'` 引入 `ctx.client` 增强 | `@snap-rail/ui` runtime `ctx.provide('client', { link, surface })` | 不写（type-only） |
| 订阅宿主帧 | `import { subscribeFrame, rpcErrorText } from '@snap-rail/plugin-sdk/api/client'`；`import type { HostLink } from '@snap-rail/plugin-sdk/api/client'` | base 种子 `@snap-rail/connection` | **不写**（base 种子） |
| 时间/时长格式化 | `import { formatClock, formatDuration } from '@snap-rail/util'`（模板未带则 `pnpm add -D @snap-rail/util`） | base 种子 `@snap-rail/util` | **不写**（base 种子） |
| 语义组件/插槽/契约/皮肤 | `import … from '@snap-rail/ui/components'` / `/slots` / `/contract` / `/skins` | base 种子 | **不写** |
| 页面/布局版本 tick | `usePagesVersion()` / `useUiVersion()` | base 种子 | **不写** |
| 消费其他插件的组件 | `import … from '<包名>/<子路径>'` | 对方贡献种子 | 写 `<包名>/<子路径>` |

- **base 种子**由 shell 在 boot 时播种，任何 client bundle 都能 `require`；
  它们**不属于** `externalSeeds`。
- **贡献种子**是其他插件经 `client.seeds` 贡献的；只有值导入才需要写
  `externalSeeds`。`import type {}` 被擦除，不产生运行时 require，不用写。
- `ctx.client` 的 `ClientServices` 由内置 `@snap-rail/ui/runtime` 提供
  （`link` + `surface`），不再有可替换的独立 UI 框架插件。
- init 模板默认不带 `@snap-rail/protocol` / `zod` / `@snap-rail/util`；写
  wire 或使用 format 助手时按上表补到对应的 `dependencies` / `devDependencies`。

## 2. 依赖放哪张表

| 你的代码 | `package.json` | 原因 |
| --- | --- | --- |
| 宿主面 value import（`@snap-rail/protocol` / equipment / store / shell） | `dependencies` | `hostBundle` 只外部化 `dependencies`；运行时由终端按 appRoot 优先、池内回退解析 |
| 宿主契约模块的 `zod`（`z.object` / `method`） | `dependencies` | 契约是 host value import；app 的 resolve-hooks 会外部化 zod，避免把 zod 内联 |
| 宿主面 type-only import（`GatewayService` / `SettingsService`） | `devDependencies`（通常 SDK 已在） | 编译后擦除，不产生宿主运行时 import |
| 渲染面种子 import（SDK `/api/client`、`@snap-rail/ui` 子路径、util） | `devDependencies` | `clientBundle` 统一把种子外部化；运行时从种子表取单实例 |
| 渲染面第三方库（非种子） | `dependencies` 或 `devDependencies` | 会被内联进 client bundle；zip 不带 node_modules |

wire 契约的 `defineContract` / `method` / `RpcBusinessError` 是 **host value
import**，来自 `@snap-rail/protocol`，必须放 `dependencies`。

## 3. 双面套件最小通道

### `src/contract.ts`（宿主/渲染共用）

```ts
import { z } from 'zod'
import { defineContract, method, type FrameRows, type MethodRows } from '@snap-rail/protocol'

export const demoContract = defineContract('demo', {
  methods: {
    'demo.ping': method(z.object({}).strict()).ret<{ pong: number }>(),
  },
  frames: {
    'demo/pinged': z.object({ at: z.number() }),
  },
})

declare module '@snap-rail/protocol' {
  interface RpcMethodMap extends MethodRows<typeof demoContract> {}
  interface FrameMap extends FrameRows<typeof demoContract> {}
}
```

### 宿主面 `src/index.ts`

```ts
import type { Plugin } from '@snap-rail/cordis'
import type { GatewayService } from '@snap-rail/plugin-sdk/api'
import { demoContract } from './contract.ts'

export default {
  name: '@my-scope/demo',
  inject: ['rpc'],
  apply(ctx) {
    const rpc: GatewayService = ctx.rpc
    rpc.claimDomain(ctx, 'demo')
    rpc.serveContract(ctx, demoContract, {
      'demo.ping': () => {
        rpc.broadcast('demo/pinged', { at: Date.now() })
        return { pong: Date.now() }
      },
    })
  },
} satisfies Plugin
```

`serveContract` 同时注册方法行和帧行，不需要再逐个 `rpc.method` /
`rpc.frame`。注册随 `ctx` 的 fiber 回收。

### 渲染面 `src/client.tsx`

```tsx
import type {} from '@snap-rail/ui/runtime'
import { Page } from '@snap-rail/ui/components'
import type { Plugin } from '@snap-rail/cordis'
import { subscribeFrame } from '@snap-rail/plugin-sdk/api/client'
import { demoContract } from './contract.ts'

export default {
  name: '@my-scope/demo',
  inject: ['client', 'pages'],
  apply(ctx) {
    ctx.effect(() => subscribeFrame(
      ctx.client.link,
      'demo/pinged',
      demoContract.frames['demo/pinged'],
      frame => {
        // frame.at 已由 schema 解析；在这里更新 UI 状态
      },
    ))

    ctx.pages.registerPage(ctx, {
      id: '@my-scope/demo-view',
      title: 'Demo',
      order: 100,
      render: () => <Page title="Demo">…</Page>,
    })
  },
} satisfies Plugin
```

- `import type {} from '@snap-rail/ui/runtime'` 只为把
  `ctx.provide('client', …)` 的 `Context` 增强带进程序；不会产生运行时代码，
  也不需要写 `externalSeeds`。
- `ctx.effect(() => subscribeFrame(...))`：effect 体返回退订函数，卸载时
  自动回收。
- 调宿主方法：`const result = await ctx.client.link.call('demo.ping', {})`；
  `result.ok === false` 时用 `rpcErrorText(result.error)` 出文案。

### manifest

```json
{
  "kind": "suite",
  "layer": "suite",
  "uiProfile": "native",
  "requires": ["@snap-rail/equipment", "service:store"],
  "client": {
    "entry": "lib-client/client.js",
    "externalSeeds": [
      "@other-scope/shared/widget"
    ]
  }
}
```

`@snap-rail/connection` / `@snap-rail/protocol` / `@snap-rail/shell/contract`
都是 base 种子，**不要**出现在 `externalSeeds`。wire 作者只需要在
`dependencies` 里放 `@snap-rail/protocol` 与 `zod`：前者是 wire 单源，后者是
契约 schema 的运行时值。

## 4. base 种子清单

### 可给插件作者用（有公共类型包或 SDK 门面）

`react`、`react/jsx-runtime`、`react-dom/client`、`@snap-rail/cordis`、
`@snap-rail/connection`（经 SDK `/api/client`）、`@snap-rail/protocol`、
`@snap-rail/shell/contract`、`@snap-rail/equipment/contract`、
`@snap-rail/util`、`zod`。

### app-internal，不要 import

`@snap-rail/client-kernel`、`@snap-rail/client-modules`、
`@snap-rail/cordis-plugin-timer`、`@snap-rail/station-rpc/contract`、
`@snap-rail/app-boot/contract`。

- `ClientHandle` 是 app-internal 类型（内置 runtime 的启动入口用它）：插件
  不需要引用，也**不要**从 `@snap-rail/client-kernel` import——`skipLibCheck`
  会跳过 UI d.ts 里的内部引用。
- 需要默认导出/类形种子时，仍然只准 named/star 导入。

## 5. 常见错误

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| 启用被拒：`缺少贡献面：@snap-rail/shell/contract（提供方未安装）` | 把 base 种子写进了 `externalSeeds` | 删掉；base 种子由 shell 自动播种 |
| `Cannot find module '@snap-rail/plugin-sdk/api'` | SDK 低于 0.2.5 | 升级 `@snap-rail/plugin-sdk` 到 `^0.2.5` |
| `Property 'rpc' does not exist on type 'Context'` | 没引入 gateway 类型增强 | 从 `@snap-rail/plugin-sdk/api` 导入 `GatewayService`；不要直接 import gateway |
| `Property 'client' does not exist on type 'Context'` | 没引入 UI runtime 增强 | `import type {} from '@snap-rail/ui/runtime'` |
| `Cannot find module '@snap-rail/connection'` | 绕过 SDK 直接 import 了未安装的包 | 改用 `@snap-rail/plugin-sdk/api/client` |
| 渲染面构建报 node 内置错误 | client 文件里 import 了 `@snap-rail/settings` / `@snap-rail/gateway` | 这两个是宿主面包，只能 type-only 在宿主用 |
| host.js 上百 kB | 入口 value import 了 `@snap-rail/plugin-sdk`（`definePlugin`） | 改 `satisfies Plugin` + type-only 导入 cordis |
| `Cannot find module '@snap-rail/client-kernel'`（UI d.ts 里） | 未发布的内部包被 UI d.ts 引用 | `skipLibCheck` 会跳过；不要直接 import kernel |