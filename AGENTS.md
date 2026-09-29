# AGENTS.md

snap-rail 是基于 vendored Cordis 的插件化工业终端：**一切皆插件**。
动手改 `packages/` 前先读 [docs/architecture.md](docs/architecture.md)。

## 命令

```sh
pnpm install
pnpm run build            # tsc -b (lib/types) + tsdown (lib)；测试前必须构建
pnpm run typecheck
pnpm test                 # vitest 全量 + 层依赖门禁
pnpm run verify-vendor-names   # vendored 树无 @deepseek-ai/ 残留
pnpm app:dev              # Vite dev server + Electron 实机开发
pnpm app:pack / app:dist  # 打包（目录形态 / NSIS 安装包）
```

## 分层模型（无脊柱名单）

每个包在 `package.json` 的 `snapRail.layer` 声明自己的层；**没有手写的脊柱/住户名单**——
门禁（`scripts/verify-layers.ts`）从各包 manifest 派生一切。层序（低 → 高）：

`base` → `store` → `equipment` → `ui` → `tool` → `suite`

- **依赖方向**：只准 import 严格更低的层；两个例外——base 内部互相自由引用，
  以及任何包可以 import 更低或同层缝包（见下）。
- **每层的缝**（Service Definition 属主，同层唯一可 import 的目标）：
  `store → @snap-rail/store`、`equipment → @snap-rail/equipment`、
  `ui → @snap-rail/framework-shadcn`。同层其余包互不依赖
  （驱动不 import 驱动、工具不 import 工具、套件不 import 套件）。
- **base 层 = 出厂全集**：打包只带 base；store/equipment/ui/tool/suite
  的一切包都经 zip 安装进 `<home>/plugins/` 池。内置不可禁用——设置页
  操作按钮禁用（悬浮提示「内置插件禁止删除/修改」），出厂行（不声明
  分类）在管理页恒归「内置」分组垫底（行无来源徽标），
  `plugins.set-enabled/set-config/uninstall` 一律拒绝；保护按**来源**判定
  （builtin 行/dev 静态住户行，宿主从层文件计算，manifest 声明改变不了
  它），并有两条结构闸：与内置行重名的 zip 拒绝安装；组合解析对内置
  名字永不走池（手拷进池的同名目录也遮蔽不了）。替换 base 包的唯一路径
  是拿源码重新构建。dev（Vite）用 `apps/desktop/dev/builtins.dev.cordis.yml`
  全量 overlay，永不随包发布。
- **依赖预检（`snapRail.requires`）**：包名条目（`@snap-rail/equipment`）
  或服务名条目（`service:store`）；启用正向校验（缺 → 拒绝）、禁用/卸载
  反向校验（有依赖方 → 拒绝），`snapRail.framework` 绑定视同依赖——
  错序安装不再变成下次开机失败。
- **分类与显示名（`snapRail.category` / `snapRail.title`）**：开放字符串、
  插件作者随意命名（中文可用）；管理页按标记原文动态分组——声明即归组、
  不问来源（dev overlay 住户也各归其标记），未声明落「其他」，无硬编码
  枚举；出厂 base 行不声明该词汇，恒归「内置」组。`title` 是人面显示名
  （行上标题为主、包名小字次要，未声明回退包名）。页面布局：分类节可
  折叠 + 顶部「全部折叠/展开」，条目平铺——无包组合卡，一行一开关。
  `kind` 只承担功能（互斥默认、套件单选），`layer` 只是仓内门禁词汇。
- 单源：层词汇与规则在 `packages/base/util/src/manifest.ts`
  （`PLUGIN_LAYERS`/`LAYER_RANK`/`LAYER_SEAMS`/`edgeAllowed`），
  plugin-kit 的 manifest schema 与门禁都从这里取。

## 各层规约

- **store 层**：`@snap-rail/store` 是规范包（`ctx.store.register(caller, ns,
  schema)`；**drizzle 查询构建器即规范**——只用查询构建器，无裸 SQL/CTE/窗口函数；
  命名空间 = 隔离边界；注册即建表 + append-only 加列）——纯类型零运行时，
  随应用惰性发布（规范随应用、实现随插件）。实现包
  `@snap-rail/store-sqlite`（zip 安装；node:sqlite，`data/<ns>.db`，WAL）
  全局单活（`snapRail.exclusive: 'store-backend'`）；换后端 = 新实现包
  替换单活，消费者零改动。
- **equipment 层**：`@snap-rail/equipment` 即规范包（设备/组/点底座表
  `data/equipment.db`、`ctx.equipment.registerDriver` 契约、点运行时、reconcile 调度），
  zip 安装、`requires: ['service:store']`；`./rpc` 桥以子路径行
  （`@snap-rail/equipment/rpc`）一并启用，`./contract` 是随应用发布的
  base 种子。驱动（modbus/…）是实例插件，**多活并存**，零渲染端代码、
  零自有存储；新驱动照抄 `driver-modbus`（范本）。统一「设备管理」设置页在
  `@snap-rail/equipment-station`（ui 层）。点位地址 = (device, group, name)
  三元组；wire 名 `equipment.*`、帧 `equipment/*`。
- **ui 层**：`@snap-rail/framework-shadcn` 是**框架插件**（zip 安装、
  clientOnly、单活，`snapRail.exclusive: 'framework'`），接管全套 UI
  栈——槽位词汇（`ctx.uiSlots`）、renderer runtime + Shell、shadcn 共享
  原语 + 主题令牌（预编译 tailwind 输出随 zip 内联）、settings/session/
  variables/workflows 服务、fallback 布局；client 面把全部面贡献为共享
  种子（`client.seeds`）。**没有框架面启用时，kernel 的引导安装页**
  （拖拽 zip → 确认 → 安装 → 启用 → 重启）就是全部界面。**生态断裂是
  已接受的决策**：Component 插件在 manifest 声明
  `snapRail.framework: '@snap-rail/framework-shadcn'`，框架不匹配不挂载
  （fail-loud）；换框架 = 换生态。Component 永不互相 import，只占槽。
- **tool 层**：暂无规范缝，工具互不依赖（门禁强制）。暂无住户——场景私有
  逻辑收进套件（见 suite 层），不再拆跨包场景工具。
- **suite 层**：单包单行、可双面（宿主面 + 渲染面）、单活（`snapRail.exclusive: 'suite'`
  或 kind=suite 默认）。一个场景的全部界面**与场景私有宿主逻辑**合成一个
  套件包（班产计数住 `./stats`：store 缝持久化 + 订阅 equipment 点事件 +
  `production/stats-changed` 帧）——杜绝跨包场景耦合；启用套件经
  `plugins.set-enabled` 自动停用其他同互斥组成员。

## 硬约定

- **能力缝三件套齐备**：Service Definition / Provider / Consumer；
  角色不独立演化不拆包。新增能力先补缝，再补首方实现。
- **渲染面零宿主入口**：任何进浏览器图的代码禁止 import 双面包的宿主入口——
  node 侧实现（store-sqlite/drizzle/node:sqlite）永不进 client bundle；跨端消费
  类型/schema 走该包 `./contract` 纯面（equipment 的 contract 是随应用
  发布的 base 种子；场景契约住在套件包内）。渲染面运行时 require 的模块 id 必须在
  `CLIENT_EXTERNALS`（= base 种子 `SEED_MODULES` ∪ 框架贡献种子
  `CONTRIBUTED_SEED_MODULES` ∪ 消费方 manifest 声明的 `client.externalSeeds`；
  基础层单源三处一致：种子表 = 客户端入口
  播种 = `clientBundle` external，客户端入口 boot 时 parity fail-loud，加
  base id 是 base 层决策；框架的面经其 client 入口的 `seeds` 映射贡献，
  壳 require 后统一播种——跨插件共享框架单实例）。
- **可安装插件是构建产物**：发行 zip = 精简 manifest（`main` 指宿主面或
  （clientOnly 包）client 入口，`exports` 映射子路径，池内包单宿主入口）
  + 构建好的面目录，永不带 src；经设置页「安装插件」或无框架时的引导页
  拖拽（取路径 → `plugins.inspect` 预检（`missing` 缺依赖警告）→ 确认 →
  `plugins.install` 解压进 `<home>/plugins/`；启用经 `plugins.set-enabled`
  做 requires 正反向预检）落地；渲染面必须是 plugin-kit `clientBundle`
  产出的 CJS 工厂包（种子表共享实例——跨插件值导入禁止，协作走 cordis
  服务；三方库与 CSS 全部内联；位图/SVG 以 `snap-plugin://` URL 随包
  发射）。宿主面裸导入边界：`@snap-rail/*`、`zod`、`drizzle-orm`
  （含子路径）经 resolve-hooks 按 **appRoot 优先、池内回退** 解析
  （对象跨缝传递才入名单；自带规范/库永不被 zip 遮蔽，不随包的包由池
  副本供单实例），其余第三方库打进宿主面 bundle。发布 zip：
  `pnpm run build && pnpm run pack:plugins -- --sign-key <private.pem> --key-id <id>`（装配规则单源
  `@snap-rail/plugin-kit/pack`；`scripts/install-dev-plugins.ts <home>`
  把全量 zip 装进任意 home 做安装管线 dogfooding）。
- **注册皆 effect**：一切贡献经 `ctx.effect()`/`ctx.on()`；`register()`
  返回处置函数。effect 体返回 disposer——把函数本身传进去等于立即执行。
- **状态放构造期闭包，不放 Service 子类字段**：cordis 可追踪代理每次
  访问重绑 `this`，`this` 上的可变状态会"每读一次一个世界"。
- **文件即接口**：用户层 `plugins.yml` 按包名寻址（`enabled`/`config`），
  页面、手编、Agent 共用一条 LayerAdmin 热重载路径；坏文件保持旧树。
  渲染端住户的行也写同一文件（`clientOnly` 池包行天然不进宿主树，dev
  静态住户经 `rendererPackages` 挡板——仅 dev；`client-config.list`
  启动时下发，行带 kind/category/贡献种子；行变更经 `client-config/changed`
  帧通知，渲染窗自动 reload（`ui.rendererAutoReload` 键可关），子路径行如
  `@snap-rail/equipment/rpc` 经池包 exports 映射解析）。行名必须是当前
  manifest 中真实存在的包；旧包名、退役行和未安装包直接报错，不提供上线前
  兼容桥。迁移时修改明确的 `plugins.yml` 或预设文件。
- **预设层（出厂组合作为数据）**：`<home>/presets/*.yml`（字典序叠层），
  文档形状与 `plugins.yml` 完全一致；组合序 = builtin → 预设 → 用户层，
  逐字段合并（用户行覆盖预设行的 `enabled`/`config`，仅预设携带的字段
  保留，合并后每 id 恰一个补丁）。型号出厂组合 = 一张可整张替换的预设
  文件：推送 v2 预设不动用户手编。预设引用的池包拒绝卸载（行会悬空，
  组合即失败）；仅被预设引用的行在管理页显示「预设」来源，可被用户行
  覆盖开关。
- **插件市场与组合（纯静态 feed + 本地强校验）**：线上三件套（官网/
  插件源/更新源）零服务器逻辑，基准内网 `http://192.168.1.10/`；发布
  `pnpm run publish` 装配并同步（deploy.config.json 配目标，`--skip-sync`
  只装配）。市场 = feed 静态目录（`index.json` + zip，条目从发行 manifest
  回读并带 sha256/size，下载先验哈希；wire 只传插件名，`file` 强制纯
  文件名）。**组合（recipe）** = `recipes.json`（id/version/title/kind
  base|scenario/file）+ 每组合一份 yml（strict，与 plugins.yml 完全
  同形）；一键安装 = 缺失插件逐个走标准安装管线 → 全部成功才原子写
  `<home>/presets/recipe-<id>.yml`（预设层热生效、卸载保护自动覆盖），
  「移除」只删预设文件；主仓 `recipes/<id>/` 是一方首发（standard-base、
  production-board），社区组合与插件住 snap-rail-market 仓 PR 上架
  （包名禁 `@snap-rail/*`，publish `--market` 合流）。
- **简单持久化配置走 settings.json**：键 `域.名`，经 `settings.get/set`
  RPC 存取宿主原子 JSON；写后 `settings/changed` 帧广播，消费方当场热
  应用。要即时生效的渲染端配置走这条路，不要改 plugins.yml 行（那要
  重启）；值结构由消费方 zod 校验。
- **结构化数据走 store（drizzle + 分库）**：`ctx.store.register(ctx,
  '<ns>', drizzle表)` 得到类型安全 db（每命名空间一个隔离边界）；
  只用 drizzle 查询构建器（`excluded.*` upsert 引用
  除外），无裸 SQL；注册即建表 + append-only 加列；跨命名空间协作走
  服务，永不共享表。
- **驱动是纯协议适配器**：设备/组/点住在底座表（`data/equipment.db`），经
  统一「设备管理」设置页管理；驱动只上交 zod schema（`.meta({title})`
  做表单标签）+ 可选探测 + `createConnection`（返回 `{update, dispose}`），
  经 handle 上报 status/sample/write。方言
  表单由 equipment-station 的 SchemaForm 渲染。
- **页面组件必须用框架原语**：客户端页面只组合 `@snap-rail/framework-shadcn/ui`
  里的 shadcn 原语（Button/Card/Dialog/Table/Tabs/Collapsible…）；
  缺原语按 shadcn 官方实现移植进框架包（包 Radix、内联 SVG、`cn` 合并），
  不在页面里手写交互组件，也不自创变体。横切物不手搓：重渲染
  tick 用 `useRefresh`，错误文案用 `rpcErrorText`，时间用
  `formatClock`/`formatDuration`，色值用 theme 令牌；schema 驱动的
  配置表单用 `SchemaForm`（新交互模式往框架包加字段类型，不开
  每驱动自定义表单的口子）。
- **主题与图表色单源在 theme 令牌**：明暗两模式由 `html[data-mode]`
  切换（设置键 `ui.theme`），页面禁止硬编码色值或 `dark:` 变体；
  图表系列只用 `--chart-1…6`
  （实际=系列1实心+`glow-bar`，理论=系列2虚线），红/黄/绿是状态语义
  不进数据系列。触屏基线：数值输入用 `NumberInput`（数字键盘）、
  单选用 `TouchSelect`（模态列表）、滚动容器用 `DragScroll`（按住拖动）。
  细则见 [docs/theme.md](docs/theme.md)。
- **模型可见 ⟺ 有事件**；模型/用户可见行为变更配可运行例子的无 key
  快照式测试（本仓以 vitest 直测装配链路为主）。
- **协议扩展（开放注册，不改 protocol）**：protocol 只有信封是封闭的；
  方法/帧行与 schema 住在各域自己的 `./contract` 模块，经 `defineContract`
  **单源声明**（一处写清方法行 + 请求 schema + 响应值类型 + 帧载荷
  schema；`.ret<T>()` 声明响应值类型，`res(schema)` 附加响应自检），
  `declare module` 合并收敛为每域一次 `interface RpcMethodMap extends
  MethodRows<typeof contract> {}`。宿主桥 `ctx.rpc.claimDomain` +
  `ctx.rpc.serveContract(ctx, contract, handlers)` 一次挂载全部方法与帧
  （schema 随行、handler 载荷/返回按行推导）；消费方 import 该 contract
  获得类型，帧消费一律 `subscribeFrame`。`docs/wire-catalog.md` 由
  `pnpm run gen:wire-catalog` 从契约生成（`--check` 进测试链，禁止手编）。
- **invariant 侧车（诊断与运行时解耦）**：域可发布 `./invariant` 面——
  普通插件，挂载即校验本域持久数据的「永远应成立的规则」，违规以数据
  报告（logger + 事件），**永不修复、永不抛、不进默认组合**（`plugins.yml`
  子路径行显式挂载才生效）。现居民：`@snap-rail/app-boot/invariant`
  （层文件不变量）。
- **scope 作用域原语（`@snap-rail/scope`）**：`createScope(ctx, key)` 铸出
  带标签的子 context——注册上下文同时决定可见性与所有权（`ScopedLayers`
  注册表：本域贡献只对该 scope 可见、子域就近覆盖、销毁整层回收；
  `scopeTarget` 事件向上放行不下行）。**是可信路由不是沙箱**——信任边界
  仍在进程/OS 层。
- 命名：包一律 `@snap-rail/<name>`；目录 `packages/<层>/<包>`
  （base/store/equipment/ui/tool/suite 六组）；wire 名全 kebab-case（方法
  `域.资源.动词`、帧 `域/事件`）。
- strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`；
  模块与导出有 JSDoc；文件恰好一个结尾换行。
- 打包：asar 关闭是决策不是疏忽（见 architecture.md 打包节）；**出厂净身**
  ——desktop 生产依赖只有 base 包 + 纯类型规范包 `@snap-rail/store` +
  共享库，一切可替换实现只能 zip 安装（打包器只收生产依赖）。

## Vendoring

`vendor/` 是钉死的源码拷贝（上游 SHA 与同步流程见 vendor/README.md）。
改动走"记录-重放"流程，不要直接散改。

## 平台扩展约定

- Host 是唯一执行插件安装、签名验证、存储、设备通讯和 RPC 的进程面；
  Electron 只做窗口、IPC 和崩溃恢复，Renderer 只消费契约和挂载 UI。
- 能力是版本化插件接口。manifest 必须声明
  `snapRail.capabilities.provides/requires` 和支持的 `snapRail.engines`；
  安装、启用、禁用、卸载都要经过能力解析，不能把缺依赖留给下次启动。
- UI 插件按 `@snap-rail/framework-shadcn/semantic` 的语义契约注册
  view、layout、navigation；槽位使用 `UI_SLOT_IDS` 的稳定命名，禁止把
  某个布局包名当作组件依赖。
- 独立插件仓库使用 `@snap-rail/plugin-sdk` 和 `snap-rail-plugin` CLI，
  仓库根部必须有自己的 `AGENTS.md`。插件 Agent 只读 SDK 类型和该指南，
  不需要进入本仓库或复制 `packages/*/src`。
- 发布包必须带 Ed25519 `META-INF/release.json`、`META-INF/signature.json`；
  Host 只信任 `<home>/trusted-release-keys.json` 中的公钥，缺少签名、摘要
  不匹配或 key id 未登记都拒绝安装。
