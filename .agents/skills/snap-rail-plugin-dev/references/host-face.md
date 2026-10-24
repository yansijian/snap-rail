# 宿主面：cordis 纪律与各缝的写法

宿主面跑在终端的 node 进程里（ESM）。入口导出
`definePlugin({ name, inject, apply })`；`apply(ctx)` 里完成一切注册。
类型以 `@snap-rail/cordis` 与各契约包的 d.ts 为准。

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
底座表，经统一「设备管理」设置页管理；驱动**零自有存储**、没有自己的 RPC
子命名空间和渲染端页面，**多活并存**。`requires: ['@snap-rail/equipment']`。

```ts
import { z } from 'zod'
import type { DriverRegistration } from '@snap-rail/equipment/driver'

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
```

硬规则：

- **写路径 await 到 I/O 完成**再返回/上报，不要 fire-and-forget。
- **驱动永不注册点表**——点表是底座的事（DriverHandle 上根本没有
  setPoints）；驱动只经 handle 上报 status / sample / write。
- `probe` 返回 `{ ok, latencyMs, detail?, sample?, error? }`；没有
  `probe` 驱动照常工作，只是设置页没有「测试连接」入口（注意上面的发布
  滞后警告）。
- 方言表单由设备管理页的 SchemaForm 按 JSON Schema 投影渲染——字段没标签
  就是你忘了 `.meta({ title })`。

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

## wire 方法与帧（host-service / suite 的宿主面）

- 用 `@snap-rail/protocol` 的 `defineContract` **单源声明**：一处写清方法
  行 + 请求 zod + `.ret<T>()` 响应值类型 + 帧载荷 zod；`declare module` 合并
  `RpcMethodMap`/`FrameMap` 收敛类型。方法名 `域.资源.动词`、帧名
  `域/事件`，全 kebab-case。**不改 protocol 任何文件**——协议只有信封是
  封闭的，方法/帧行住在各域自己的 `./contract` 模块。
- 业务失败 `throw RpcBusinessError`，别返回裸错误对象。
- 渲染端消费帧一律 `subscribeFrame(link, '域/事件', schema, cb)`——禁止
  `payload as` 手写判形。
- 声明完以安装的 SDK 类型为准核对挂载 API；配方测试：schema 拒坏载荷、
  disposer 随插件卸载。

## `ctx.shell`（宿主面，OS 集成缝）

要用就 `requires: ['service:shell']` + `import '@snap-rail/shell'`（类型
`import type { ShellService } from '@snap-rail/shell'`）。**永不 import
electron**。

| API | 说明 |
| --- | --- |
| `ctx.shell.notify(ctx, {title, body, actions?, tag?, silent?})` | 带按钮通知；返回 `{applied, id}` 或 `{applied:false, reason, message}`。上限单源 `SHELL_LIMITS`：标题 120 / 正文 512 / 动作标题 20 / 动作 id 64 / 最多 3 个按钮；全局节流 5 条/10s；超限回 `{applied:false}` 不抛。同 `tag` 替换不堆叠。点击回执 `ctx.on('shell/notification-action', (id, actionId) => …)`。 |
| `ctx.shell.tray.addItem / updateItem / removeItem(ctx, …)` | 托盘菜单项（单插件 12、全体 24）；点击回执 `ctx.on('shell/tray-clicked', key)`；key 自动按 `包名:id` 命名空间化。 |
| `ctx.shell.surface.present / hide / state(ctx, …)` | 立起/隐藏/查询窗口（`main` = 显示并聚焦；按需创建辅助窗）。主窗口与球互斥由底座保证。 |
| `ctx.shell.ball.setState(ctx, patch)` | 宿主聚合的球内容态：`{progress 0..1|null, label ≤8字|null, tone}`。 |
| `ctx.shell.window.setExitPolicy(ctx, {close, quit})` | 关窗/托盘退出行为声明（登记即 effect，fiber 回收即回退默认 `quit`）。值：`'ball' \| 'tray' \| 'quit' \| 'hold'`。 |

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
