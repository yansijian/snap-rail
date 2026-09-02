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
- **脊柱不依赖住户**：脊柱与住户的名单单源在
  `packages/util/util/src/manifest.ts`（`SPINE_PACKAGE_DIRS` /
  `OCCUPANT_PACKAGES`），门禁与文档都读它，别处不得复列。脊柱
  （`vendor/*`、`util`、`settings`、`store`、`audit`、`boot/`、
  `protocol/*`、`field/field`、
  `client/{kernel,slots,settings,variables,session,workflows,runtime,ui}`）
  不得 import 或依赖（package.json）任何住户（`suites/terminal-ops`
  （业务套件，含 `./stats` 宿主面）、`client/settings-station`、
  `field/driver-mock|driver-modbus`、`apps/*`）。
  `pnpm test` 里的门禁脚本断言这一点。
- **业务套件 = 单包多入口、单活**：一个场景的全部界面（布局、chrome、
  流程页、设置页）合成一个套件包（`packages/suites/<名>`，
  `snapRail.kind='suite'`），强耦合留在包内（跨页 action 常量走包内
  相对导入）；启用套件经 `plugins.set-enabled` 自动停用其他套件（终
  端一次服务一个场景）。新场景 = 新套件包，成套交付、成套丢弃。
- **可安装插件的最终格式**：zip（manifest + 构建产物），经设置页
  「安装插件」（pick-zip → `plugins.inspect` 预检 → 确认 →
  `plugins.install` 解压进 `<home>/plugins/`）落地；渲染面必须是
  plugin-kit `clientBundle` 产出的 CJS 工厂包（种子表共享实例，
  `SEED_MODULES` 单源——跨插件值导入禁止，协作走 cordis 服务）；
  宿主侧依赖解析靠 resolve-hooks（池内文件的 `@snap-rail/*`/zod 锚定
  appRoot）。发布 zip：`pnpm run pack:plugins`。
- **注册皆 effect**：一切贡献经 `ctx.effect()`/`ctx.on()`；`register()`
  返回处置函数。effect 体返回 disposer——把函数本身传进去等于立即执行。
- **状态放构造期闭包，不放 Service 子类字段**：cordis 可追踪代理每次
  访问重绑 `this`，`this` 上的可变状态会"每读一次一个世界"（uiSlots 的
  教训，源码有注释）。
- **文件即接口**：用户层 `plugins.yml` 按包名寻址（`enabled`/`config`），
  页面、手编、Agent 共用一条 LayerAdmin 热重载路径；坏文件保持旧树。
  渲染端住户的行也写同一文件（boot `rendererPackages` 挡在宿主树外，
  `client-config.list` 启动时下发；行变更重启生效）。
- **简单持久化配置走 settings.json**：键 `域.名`，经 `settings.get/set`
  RPC 存取宿主原子 JSON；写后 `settings/changed` 帧广播，消费方当场热
  应用。要即时生效的渲染端配置走这条路，不要改 plugins.yml 行（那要
  重启）；值结构由消费方 zod 校验。
- **结构化数据走 store（drizzle + 分库）**：`ctx.store.register(ctx,
  '<ns>', drizzle表)` 得到类型安全 db（每命名空间一个 `data/<ns>.db`，
  文件即隔离边界）；只用 drizzle 查询构建器（`excluded.*` upsert 引用
  除外），无裸 SQL；注册即建表 + append-only 加列；跨命名空间协作走
  服务，永不共享表。
- **驱动是纯协议适配器**：设备/组/点住在底座表（`data/field.db`），经
  统一「设备管理」设置页管理；驱动只上交 zod schema（`.meta({title})`
  做表单标签）+ 可选探测 + `createConnection`（返回 `{update, dispose}`），
  经 handle 上报 status/sample/write。新驱动照抄 `driver-mock`；方言
  表单由底座 SchemaForm 渲染，驱动零渲染端代码、零自有存储。
- **页面组件必须用 shadcn UI**：客户端页面只组合 `@snap-rail/client-ui`
  里的 shadcn 原语（Button/Card/Dialog/Table/Tabs/Collapsible…）；
  缺原语按 shadcn 官方实现移植进 ui 包（包 Radix、内联 SVG、`cn` 合并），
  不在页面里手写交互组件，也不自创变体（折叠面板用 Collapsible——
  曾经手包过一个 Accordion，已回退，勿再犯）。横切物不手搓：重渲染
  tick 用 `useRefresh`，错误文案用 `rpcErrorText`，时间用
  `formatClock`/`formatDuration`，色值用 theme 令牌；schema 驱动的
  配置表单用 `SchemaForm`（新交互模式往 ui 包加字段类型，不开
  每驱动自定义表单的口子）。
- **主题与图表色单源在 theme 令牌**：明暗两模式由 `html[data-mode]`
  切换（设置键 `ui.theme`，经 `themeSettingsSchema`/`applyTheme` 热应用），
  页面禁止硬编码色值或 `dark:` 变体；图表系列只用 `--chart-1…6`
  （实际=系列1实心+`glow-bar`，理论=系列2虚线），红/黄/绿是状态语义
  不进数据系列。触屏基线：数值输入用 `NumberInput`（数字键盘）、
  单选用 `TouchSelect`（模态列表）、滚动容器用 `DragScroll`（按住拖动）。
  细则见 [docs/theme.md](docs/theme.md)。
- **模型可见 ⟺ 有事件**；模型/用户可见行为变更配可运行例子的无 key
  快照式测试（本仓以 vitest 直测装配链路为主）。
- **协议扩展（开放注册，不改 protocol）**：protocol 只有信封是封闭的；
  方法/帧行与 schema 住在各域自己的 `./contract` 模块（`declare module`
  合并进 `RpcMethodMap`/`FrameMap`）。新增 = 域主包 contract 一份 +
  宿主桥 `ctx.rpc.claimDomain` + `ctx.rpc.method`（请求 zod **必须**）/
  `ctx.rpc.frame`；消费方 import 该 contract 获得类型，帧消费一律
  `subscribeFrame`。四张 checklist 见 architecture.md「开发配方」。
- 命名：包一律 `@snap-rail/<name>`；目录双层 `packages/<组>/<包>`；
  跨包用包名，本地相对导入带 `.ts`；wire 名全 kebab-case（方法
  `域.资源.动词`、帧 `域/事件`）。
- strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`；
  模块与导出有 JSDoc；文件恰好一个结尾换行。
- 打包：asar 关闭是决策不是疏忽（见 architecture.md 打包节）；宿主面
  插件包必须在 desktop 的 `dependencies` 里才会随包发布。

## Vendoring

`vendor/` 是钉死的源码拷贝（上游 SHA 与同步流程见 vendor/README.md）。
改动走"记录-重放"流程，不要直接散改。
