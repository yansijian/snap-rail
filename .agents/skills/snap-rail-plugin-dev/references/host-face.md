# 宿主面：cordis 纪律与各缝的写法

宿主面跑在终端的 node 进程里（ESM）。入口导出
`{ name, inject, apply } satisfies Plugin`（`Plugin` 从 `@snap-rail/cordis`
type-only 导入）；`apply(ctx)` 里完成一切注册。
类型以 `@snap-rail/cordis`、`@snap-rail/plugin-sdk/api` 与各契约包的 d.ts 为准。

## cordis 纪律（所有模板通用）

- **缝方法自带 fiber 跟踪**：`registerDriver(caller, desc)` 一类缝注册的
  处置随 caller 的 fiber 自动回收（SDK 注释原文：disposal rides the
  caller's fiber）——**裸调用就是完整写法**，返回的 disposer 不需要你另存
  另管。
- **`ctx.effect()` / `ctx.on()` 用于非缝的副作用**：
  ```ts
  ctx.effect(() => {
    const added = ctx.shell.tray.addItem(ctx, { id: 'pause', label: '暂停采集' })
    return () => void ctx.shell.tray.removeItem(ctx, 'pause')
  })
  ```
  把函数本身传进 `ctx.effect()`（而不是调它）等于立即执行——常见手滑。
- **caller 上下文永远首参**：`registerDriver(ctx, …)`、`tray.addItem(ctx, …)`。
- **状态放构造期闭包**：可变状态包在 `apply(ctx)` 作用域（或包住它的模块级
  工厂函数）里才是安全的家；Service 子类字段会被 cordis 可追踪代理每次访问
  重绑 `this`——字段上的可变状态会「每读一次一个世界」。
- **服务协作**：`ctx.provide('<名>', 实现)` 上供，`inject: ['<名>']` 下取；
  服务就是跨插件协作的唯一通道（永不互相 import、永不共享表）。

## 驱动（driver 模板）

驱动是**纯协议适配器**，注册进设备底座：设备/组/点住在 `data/equipment.db`
底座表，经统一「设备管理」设置页管理；驱动**零自有存储**、零渲染端页面，
**多活并存**。`requires: ['@snap-rail/equipment']`。纪律上驱动也不开自己的
wire 域——底座为确需的驱动预留了 `equipment.<driverId>.*` 子命名空间
（驱动 `id` 兼作前缀），默认不用；真要用就是普通的
`claimDomain` / `serveContract` 写法。

```ts
import { z } from 'zod'
import type { DriverRegistration } from '@snap-rail/equipment/driver'
import type { Plugin } from '@snap-rail/cordis'

const driver: DriverRegistration = {
  id: 'my-driver',
  title: '我的驱动',
  schemas: {
    // 设备连接配置（地址/端口/站号…）；每个字段 .meta({title}) 给表单中文标签
    device: z.object({
      host: z.string().meta({ title: 'PLC 地址' }),
      port: z.number().meta({ title: '端口' }),
    }),
    // 点位配置；校验 {type, ...config}，type 字面量区分点位种类
    point: z.discriminatedUnion('type', [
      z.object({ type: z.literal('holding'), address: z.number().meta({ title: '寄存器地址' }) }),
      z.object({ type: z.literal('input'), address: z.number().meta({ title: '寄存器地址' }) }),
    ]),
  },
  // 可选：设置页「测试连接」——一次性只读探测，不落库、不建长连接。
  // ⚠ 版本陷阱：主仓已实现 probe，但 npm @snap-rail/equipment@0.1.4 的
  //   类型里还没有该字段——0.1.5 起恢复。写之前先查：
  //   Select-String -Path node_modules/@snap-rail/equipment/lib/types/*.d.ts -Pattern probe
  //   查不到就先升级 equipment（或暂不实现），硬写会被类型拒绝。
  probe: async (config) => ({ ok: true, latencyMs: 12 }),
  // 必选：建连接。底座决定何时调 update/dispose，驱动决定怎么落地
  // （两者都可返回 Promise）
  createConnection(device, points, handle) {
    // handle 上报：handle.status(status, message?) 连接状态、
    // handle.sample(ref, value) 点值（null = 点位异常）、
    // handle.onWrite(handler) 安装写点回调（只装一次，装前写入报 no-write-handler）
    return {
      update(nextDevice, nextPoints) { /* 热调参或内部重连 */ },
      dispose() { /* 关 socket、清定时器 */ },
    }
  },
}

export default {
  name: 'my-driver',
  inject: ['equipment'],
  apply(ctx) { ctx.equipment.registerDriver(ctx, driver) },
} satisfies Plugin
```

硬规则：

- **写路径 await 到 I/O 完成**再返回/上报，不要 fire-and-forget。
- **驱动永不注册点表**——点表是底座的事（DriverHandle 上根本没有
  setPoints）；驱动只经 handle 上报 status / sample / write。
- `probe` 返回 `DeviceProbeResult`：`{ ok, latencyMs, detail?, sample?: { label,
  value }, error?: { code, message, hint? } }`。底座给 probe 包了 **10s 硬
  超时**（超时回 `error.code: 'timeout'`），抛出的异常映射为
  `'probe-failed'`——所以 probe 内部不必自己兜超时，但必须是一次性只读探测、
  不建长连接。没有 `probe` 驱动照常工作，只是设置页没有「测试连接」入口。
  连接状态枚举 `'connecting' | 'online' | 'offline'`；点 ref 三元组各段非空、
  ≤128 字符、不含 `/`。
- 方言表单由设备管理页的 `SchemaForm` 按 JSON Schema 投影渲染：
  `.meta({ title })` 是标签（缺省回退键名）、`.describe()` 是说明、
  `z.enum` / 字面量联合渲染成单选、`z.boolean` 成开关、数字带上下限——
  完整映射见 [client-face.md](client-face.md) 的「SchemaForm」节。

## 构建纪律（宿主面）

- **hostBundle 只外部化 package.json 的 `dependencies`**（build.d.ts 原文：
  "tsdown externalizes package.json dependencies"），其余一律打进包内。
  所以：宿主运行时要 resolve 的契约包（`@snap-rail/equipment` 等）必须在
  `dependencies` 里——init 模板把它放在 devDependencies，**动手前先挪**，
  否则整套底座实现（含 drizzle）内联进 host.js（实测 281 kB，正常应几 kB）。
- **入口对 `@snap-rail/plugin-sdk` 只准 type-only 导入**：它是构建期工具
  包（pack/sign/fflate 全在桶里），value 导入（含模板骨架的
  `definePlugin`）会把整桶拖进 host.js（实测 +230 kB）。等价零代价写法：
  ```ts
  import type { Plugin } from '@snap-rail/cordis'

  export default {
    name: 'my-driver',
    inject: ['equipment'],
    apply(ctx) { ctx.equipment.registerDriver(ctx, driver) },
  } satisfies Plugin
  ```
- **重新发布前清空 `lib-host/`（与 `lib-client/`、`dist/`）再 build**：
  hostBundle 不清产物目录、pack 按面目录整目录收编——旧 chunk 会混进 zip。
- build 后把 host.js 体积当冒烟指标：上百 kB = 有东西被内联了，回头查上面
  两条。

## store 缝（store-provider 及一切要存数据的宿主面）

```ts
import { sqliteTable, text, integer } from 'drizzle-orm'  // 表定义随你的场景
```

- 消费方：`requires: ['service:store']` +
  `inject: ['store']`，然后
  `const db = ctx.store.register(ctx, '<我的命名空间>', { 表… })`——注册即
  建表 + append-only 加列；拿到的是类型安全 drizzle db。
- **只用 drizzle 查询构建器**：无裸 SQL / CTE / 窗口函数（`excluded.*` 的
  upsert 引用除外）。
- 命名空间 = 隔离边界：**跨命名空间协作走服务，永不共享表**。
- 实现方（store-provider）：实现 `@snap-rail/store` 的 `StoreService`，
  manifest `exclusive: 'store-backend'`，`ctx.provide('store', …)`；换后端
  = 新实现包替换单活，消费者零改动。规范包是纯类型、随应用发布——不要
  import 任何具体后端。

## 简单配置走 settings.json

要即时生效的渲染端/宿主端配置（主题、阈值、开关）不要改 `plugins.yml`
行（那要重启）、也不要建表：键 `域.名` 经 settings 服务的 get/set 存取，
写后 `settings/changed` 帧广播，消费方当场热应用；值结构由消费方 zod 校验。

```ts
import type { Plugin } from '@snap-rail/cordis'
import type { SettingsService } from '@snap-rail/plugin-sdk/api'

export default {
  name: '@my-scope/my-service',
  inject: ['settings'],
  apply(ctx) {
    const settings: SettingsService = ctx.settings
    settings.set('my-domain.threshold', 42)
  },
} satisfies Plugin
```

settings 是 base 内置服务：类型从 SDK `/api` 转出，不要把
`@snap-rail/settings` 写进 `requires` 或单独安装。`get<T>(key)` /
`set<T>(key, value)` 都是**同步**的、不做 schema 校验（值形状是消费方的
契约）；`set` 原子落盘后 `ctx.emit('settings/changed', key, value)`，宿主面
`ctx.on('settings/changed', (key, value) => …)` 即可热应用。键形**照 wire
的规则写** `域.名`（`^[a-z0-9][a-z0-9-]*\.[A-Za-z0-9_.-]+$`，3–128 字符）——
宿主面直调不校验，但渲染面经 `settings.get/set` 读同一键时会被 wire 拒。

## wire 方法与帧（host-service / suite 的宿主面）

- 用 `@snap-rail/protocol` 的 `defineContract` **单源声明**：一处写清方法
  行 + 请求 zod + `.ret<T>()` 响应值类型 + 帧载荷 zod；`declare module` 合并
  `RpcMethodMap`/`FrameMap` 收敛类型。方法名 `域.资源.动词`、帧名
  `域/事件`，全 kebab-case。**不改 protocol 任何文件**——协议只有信封是
  封闭的，方法/帧行住在各域自己的 `./contract` 模块。
- 挂载用 `ctx.rpc`：类型从 `@snap-rail/plugin-sdk/api` 转出，
  `inject: ['rpc']`；`claimDomain` 先占域，`serveContract` 一次注册全部方法
  和帧：

```ts
import type { Plugin } from '@snap-rail/cordis'
import type { GatewayService } from '@snap-rail/plugin-sdk/api'
import { demoContract } from './contract.ts'

export default {
  name: '@my-scope/my-service',
  inject: ['rpc'],
  apply(ctx) {
    const rpc: GatewayService = ctx.rpc
    rpc.claimDomain(ctx, 'demo')
    rpc.serveContract(ctx, demoContract, {
      'demo.ping': () => ({ pong: Date.now() }),
    })
    // 广播：rpc.broadcast('demo/pinged', { at: Date.now() })
    // 或 rpc.bridgeEvent(ctx, 'point/updated', 'demo/point-updated', …)
  },
} satisfies Plugin
```

- gateway 是 base 内置服务：不要写进 `requires`、不要单独安装、不要 value
  import；类型统一从 SDK `/api` 取。
- 业务失败 `throw RpcBusinessError`，别返回裸错误对象。
- 渲染端消费帧：`subscribeFrame(ctx.client.link, '域/事件', schema, cb)`，
  从 `@snap-rail/plugin-sdk/api/client` 导入；`ctx.client` 由内置
  `@snap-rail/ui/runtime` 提供。完整双面骨架见
  [faces-and-wire.md](faces-and-wire.md)。
- 配方测试：schema 拒坏载荷、disposer 随插件卸载。

## 可订阅的宿主事件（`ctx.on`，进程内，无订阅门禁）

| 域 | 事件 → 载荷 |
| --- | --- |
| equipment | `point/updated` → `PointSample { device, group, name, value, time }`（套件聚合的首选入口）；`point/added` → `PointDescriptor`；`point/removed` → `PointRef`；`connection/added` → `ConnectionSnapshot`；`connection/removed` → connectionId；`connection/status` → `{ …, status: 'connecting' \| 'online' \| 'offline' }`；`equipment/mappings-changed` / `equipment/structure-changed` → 无载荷 |
| settings | `settings/changed` → `(key, value)` |
| shell | `shell/notification-clicked` → `(id)`；`shell/notification-action` → `(id, actionId)`；`shell/tray-clicked` → `(key)`；`shell/surface-changed`、`shell/ball-changed`、`shell/ball-dock-changed`、`shell/window-profile-changed`、`shell/ball-profile-changed` → 与同名 wire 帧同载荷；`shell/exit-requested` → `{ source: 'window' \| 'tray' }`；`shell/exit-resolved` → `(request, action)` |

事件名的类型增强随对应包的 `declare module '@snap-rail/cordis' { interface
Events … }` 进来：equipment 的在 `@snap-rail/equipment`（宿主面 value
import 即可），shell 的在 `@snap-rail/shell`，settings 的在
`@snap-rail/plugin-sdk/api`。

## `ctx.shell`（宿主面，OS 集成缝）

要用就 `requires: ['service:shell']` + `import '@snap-rail/shell'`（类型
`import type { ShellService } from '@snap-rail/shell'`）。**永不 import
electron**。所有写操作回 `{ applied: true, … }` 或
`{ applied: false, reason, message }`（reason：`no-shell` / `no-tray` /
`limit-reached` / `duplicate` / `not-found` / `not-controllable` /
`unavailable`），溢出不抛。

| API | 说明 |
| --- | --- |
| `ctx.shell.notify(ctx, {title, body?, actions?, tag?, silent?})` | 带按钮通知；成功回 `{applied: true, id}`。上限单源 `SHELL_LIMITS`：标题 120 / 正文 512 / 动作标题 20 / 动作 id 64 / `tag` 64 / 最多 3 个按钮；全局节流 5 条/10s。同 `tag` 替换不堆叠。回执 `shell/notification-action` `(id, actionId)`、无按钮点击 `shell/notification-clicked` `(id)`；冷启动期间的点击回退为聚焦主窗。 |
| `ctx.shell.tray.addItem / updateItem / removeItem(ctx, …)`；`tray.available`；`tray.entries()` | 托盘菜单项 `{ id, label ≤40, checked? }`（单插件 12、全体 24；`checked` 画勾选态）；点击回执 `shell/tray-clicked` `(key)`，key 自动按 `包名:id` 命名空间化。 |
| `ctx.shell.surface.present / hide(ctx, surface)`；`surface.state()` | 立起/隐藏/查询窗口（`present('main')` = 显示并聚焦；`hide` 只接受辅助面 `'ball'`；按需创建辅助窗）。主窗口与球各自独立显隐，底座不互斥；显隐变化经 `shell/surface-changed`（事件 + 帧）广播。 |
| `ctx.shell.ball.setState(ctx, patch)`；`ball.state()` | 宿主聚合的球内容态：`{ progress: 0..1 \| null, label: ≤8 字 \| null, tone: 'neutral' \| 'accent' \| 'warning' \| 'danger' }`，变化经 `shell/ball-changed` 广播。 |
| `ctx.shell.ball.setProfile(ctx, profile)`；`ball.profile()` | 宿主面请求球形态（`BallProfile`，字段见 client-face.md 布局节），宿主夹取后回 `{ applied, profile, source, reason? }`。只有操作员在外观页显式固定（`source: 'user'`）会拒绝；布局与面的请求后到者生效。 |
| `ctx.shell.window.setProfile(ctx, profile)`；`window.profile()` | 同上，操作员窗口形态（`WindowProfile`）。记住的历史尺寸只做开机恢复、不锁请求，布局/面的应用结果也不写入该记忆（`remember` 只决定之后的手动调整记不记）。**检查返回值**——拒绝是 `{applied:false}` 正常返回，不抛异常。 |
| `ctx.shell.window.setExitPolicy(ctx, {close?, quit?})`；`window.exitPolicy()` | 关窗/托盘退出行为声明（登记即 effect，fiber 回收即回退默认 `quit/quit`）。值：`'ball' \| 'tray' \| 'quit' \| 'hold'`。 |
| `ctx.shell.window.resolve(ctx, action)` | 宿主面应答挂起的退出请求（与渲染面的 `shell.exit.resolve` 等价；确认框仍必须由渲染面画，这里只是宿主侧兜底/自动决策）。 |

`'hold'` 流程：Shell 冻结请求 → 广播 `shell/exit-requested`（载荷
`{source: 'window' | 'tray'}`）→ **你的渲染面**弹确认框（底座从不画 UI）→
`shell.exit.resolve` 应答 `'ball' | 'tray' | 'quit' | 'cancel'`；10s 未应答
按 `quit` 兜底。宿主面收到 `source: 'tray'` 而主窗口藏着时，先
`ctx.shell.surface.present(ctx, 'main')` 把窗口叫回来（确认框要活在渲染面），
取消时把球放回去。细节见 [client-face.md](client-face.md) 的退出策略节。

## 测试

- vitest 直测装配链路：manifest 校验、注册→回收（disposer 被调）、schema
  拒坏载荷、服务上供可注入。
- **模型可见 ⟺ 有事件**：改了用户可见行为，就配一个可运行例子的快照式
  测试；不让驱动/协议的 I/O 真的出网——mock handle。
