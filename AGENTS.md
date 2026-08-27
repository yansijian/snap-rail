# AGENTS.md

snap-rail 是基于 vendored Cordis 的插件化工业终端：**一切皆插件**。
动手改 `packages/` 前先读 [docs/architecture.md](docs/architecture.md)。

## 命令

```sh
pnpm install
pnpm run build            # tsc -b (lib/types) + tsdown (lib)；测试前必须构建
pnpm run typecheck
pnpm test                 # vitest 全量 + 脊柱独立性门禁
pnpm run verify-vendor-names   # vendored 树无 @deepseek-ai/ 残留
pnpm app:dev              # Vite dev server + Electron 实机开发
pnpm app:pack / app:dist  # 打包（目录形态 / NSIS 安装包）
```

## 硬约定

- **能力缝三件套齐备**：Service Definition / Provider / Consumer；
  角色不独立演化不拆包。新增能力先补缝，再补首方实现。
- **脊柱不依赖住户**：`vendor/*`、`util`、`settings`、`audit`、`boot/`、
  `protocol/*`、`field/field`、`client/{kernel,slots,runtime,ui}` 是脊柱，
  不得 import 任何住户（`client/layout-default|chrome-titlebar|
  panel-dashboard|manage-plugins|manage-connections`、`field/driver-mock`、
  `apps/*`）。`pnpm test` 里的门禁脚本断言这一点。
- **注册皆 effect**：一切贡献经 `ctx.effect()`/`ctx.on()`；`register()`
  返回处置函数。effect 体返回 disposer——把函数本身传进去等于立即执行。
- **状态放构造期闭包，不放 Service 子类字段**：cordis 可追踪代理每次
  访问重绑 `this`，`this` 上的可变状态会"每读一次一个世界"（uiSlots 的
  教训，源码有注释）。
- **文件即接口**：用户层 `plugins.yml` 按包名寻址（`enabled`/`config`），
  页面、手编、Agent 共用一条 LayerAdmin 热重载路径；坏文件保持旧树。
- **模型可见 ⟺ 有事件**；模型/用户可见行为变更配可运行例子的无 key
  快照式测试（本仓以 vitest 直测装配链路为主）。
- **协议扩展**：新 rpc 方法 = methods.ts 一个签名 + schemas.ts 一条
  zod + 桥一处注册；校验在信任边界一次做足。
- 命名：包一律 `@snap-rail/<name>`；目录双层 `packages/<组>/<包>`；
  跨包用包名，本地相对导入带 `.ts`。
- strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`；
  模块与导出有 JSDoc；文件恰好一个结尾换行。
- 打包：asar 关闭是决策不是疏忽（见 architecture.md 打包节）；宿主面
  插件包必须在 desktop 的 `dependencies` 里才会随包发布。

## Vendoring

`vendor/` 是钉死的源码拷贝（上游 SHA 与同步流程见 vendor/README.md）。
改动走"记录-重放"流程，不要直接散改。
