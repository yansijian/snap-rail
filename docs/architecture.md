# snap-rail 架构

工业终端的开源底座：OT 现场数据与 IT 工具链在一个"一切皆插件"的宿主里汇合。
本文是缝（seam）目录与关键决策的单一权威；代码 JSDoc 是各包契约的权威。
插件开发与社区发布见 [plugin-development.md](plugin-development.md)；部署、
组合包与信任模型见 [deploy.md](deploy.md)。

## 产品宪法

不复现组态画布与传统工业 HMI。那是社区与 Agent 的领域——底座只提供
进程模型、插件机制、数据缝与最小 UI 骨架；创新界面由插件生态生长。

## 分层模型（无脊柱名单）

每个包在 `package.json` 的 `snapRail.layer` 声明自己的层，目录
`packages/<层>/<包>` 与之一致。**没有手写的脊柱/住户名单**：层词汇与
规则单源在 `packages/base/util/src/manifest.ts`
（`PLUGIN_LAYERS`/`LAYER_RANK`/`LAYER_SEAMS`/`edgeAllowed`），
门禁 `scripts/verify-layers.ts`（`pnpm test` 内置）从各包 manifest 派生一切。

层序（低 → 高）：`base` → `store` → `equipment` → `ui` → `tool` → `suite`

- **依赖方向**：只准 import 严格更低的层；例外一，base 内部互相自由引用；
  例外二，任何包可以 import 更低或同层**缝包**（该层 Service Definition
  属主）：store 层缝 = `@snap-rail/store`，equipment 层缝 =
  `@snap-rail/equipment`，ui 层缝 = `@snap-rail/framework-shadcn`。
  同层其余包互不依赖（驱动不 import 驱动、工具不 import 工具、套件不
  import 套件）。
- **base 层**：boot 关键内置（vendor 同级待遇）——cordis 装载、协议信封、
  工作站桥、settings/audit、kernel/modules。base 是插件但**不可经界面或
  RPC 禁用/替换**：管理面不显示内置行（全部操作都被拒绝的行是噪音），
  `plugins.set-enabled/set-config/uninstall` 一律拒绝；替换 = 拿源码重建。
- **出厂净身**：随应用发布的 builtin 层只有 base（`resources/
  builtins.cordis.yml`）；store/equipment/ui/tool/suite 的一切包都经
  zip 安装进 `<home>/plugins/` 池。保护语义按「来源」判定——builtin 行
  即受保护，装来的 zip 永不可能伪装进这个集合。
  dev（Vite harness）用 `dev/builtins.dev.cordis.yml` 覆盖 base 行
  （resources 外，永不随包发布）；框架/驱动/套件 dev 与生产同路，经
  `install-dev-plugins` 把各仓 dist zip 装进 dev home 的插件池。
- **互斥组**（`snapRail.exclusive`）：启用一个成员自动停用同组其他成员
  （一次批量写）。现组：`suite`（套件默认组）、`framework`（框架插件）、
  `store-backend`（store 实现包）。池内包都可经界面启停。
- **依赖预检**（`snapRail.requires`，唯一兼容声明）：包作者声明依赖——
  包名条目（`@snap-rail/equipment`）、带版本范围的包名条目
  （`name@range`，如 `@snap-rail/framework-shadcn@^0.2`，语义单源
  `@snap-rail/util/semver`）或服务名条目（`service:store`）。启用前
  正向校验（缺依赖或版本不合 → bad-request「先安装/启用」），禁用/卸载
  前反向校验（还有已启用行依赖时拒绝并列出依赖方）——错序安装不再变成
  下次开机失败。
- **分类标记**（`snapRail.category`）：开放字符串，插件作者随意命名
  （中文可用）；管理页按标记原文动态分组，无硬编码枚举。**显示名**
  （`snapRail.title`）：同一哲学的人面名字——行上标题为主、包名小字
  次要，未声明回退包名。`kind` 退居
  纯功能（互斥默认、套件 radio 卡），`layer` 只是仓内门禁词汇。
- **框架绑定**：渲染面 Component 在 `requires` 里声明框架包
  （`@snap-rail/framework-shadcn@^0.2`，绑定即依赖）；框架不匹配装不上
  /启不了。**生态断裂是已接受的决策**：换框架 = 换生态，旧 Component 需
  重写。（历史的 `snapRail.framework`/`snapRail.capabilities` 字段已
  退役：manifest 校验剥离旧 zip 里的残留，宿主永不再读。）
- 缝纪律与 deepseek-harness 的 core/seam 分类同构：Service Definition
  （规范包）+ Provider（实现/实例包）+ Consumer；消费者只依赖规范包并
  `inject` 对应服务，provider 缺席时依赖它的插件不激活（终端仍可启动，
  framework 的 fallback 布局兜底）。**规范随应用、实现随插件**：纯类型/
  契约面（`@snap-rail/store`、equipment 的 `./contract`）随应用
  惰性发布，可替换的实现全部走池。

## 进程模型

```
Electron Shell + Node Host（当前同进程）        renderer（每窗口一个）
┌───────────────────────────┐          ┌─────────────────────────┐
│ Shell: 窗口/IPC/IPC carrier │  invoke  │ client Cordis 树         │
│ Host: Cordis 宿主树         │ ───────▶ │  kernel → framework      │
│  gateway ── 点表/管理方法    │ ◀─────── │   runtime → 住户(组件)   │
│  shell 缝 ── 通知/托盘/窗口   │  帧流端口 │  React root（槽位驱动）   │
│  equipment / driver-* …    │          └─────────────────────────┘
└───────────────────────────┘            main / ball / panel 三种窗口
```

- **窗口即 surface**：`main`（操作员主窗口，唯一默认存在的窗口）、`ball`
  （128×128 透明置顶悬浮球）、`panel`（360×480 透明置顶小面板）。三种窗口
  跑同一份 renderer 代码、同一个 page 之外的两张 html（`index.html` /
  `surface.html?surface=ball|panel`），差别只在**装哪些面**：主窗口装每行
  的 `clientUrl`，辅助窗口装 `surfaceUrls[surface]`（模块 id
  `<包名>/<surface>`），种子提供方（框架）在所有窗口都装——一个球面也需要
  框架的原语与样式。承载者（`carrier`）按 WebContents 分流帧流，多窗口天然
  支持。
- **辅助窗口不订阅工业点**：球/面板只消费宿主聚合后的帧（如
  `shell/ball-changed`、`production/stats-changed`），因此隐藏的球不保留
  任何数据通路，显示的球也不需要第二套订阅图。
- Electron Shell 只持有 Host 边界与 IPC carrier；当前 Host 与 Shell 同进程，
  后续可移到 utility process；一切能力插件跑在 Host，renderer 是纯投影客户端
  （contextIsolation 开、nodeIntegration 关、preload 只暴露三原语
  invoke/openStream/zipPathOf——第三个是拖拽安装的路径桥）。
- renderer 内跑一棵轻量 client Cordis 树：kernel 引导（启动页 + HostLink），
  **已启用框架的 runtime** 接管 React root——先挂框架服务
  （timer/slots/settings-pages/variables/session/workflows）再挂住户
  （逐插件 config），最后挂框架自带的 fallback 布局（零套件时兜底，
  套件 layout 注册即让位）。**没有框架面启用时，kernel 的引导安装页
  （恢复控制台）就是全部界面**：空白页 + 右上角关闭 + 中央「拖拽插件包
  （.zip）到此处安装」——inspect → 确认 → 安装 → 启用 → 重启，全走
  常规 `plugins.*`/`window.*` 方法。
- **文件即接口**：`plugins.yml` 同时被页面按钮、手编、Agent 编辑——一条
  热重载路径服务全部三种来源。

## 能力缝目录

每条缝 = Service Definition（类型与事件）+ Provider（实现）+ Consumer（消费），
三者齐备才算完整；仅当角色独立演化时才拆包。

| 缝 | 包（层） | 说明 |
| --- | --- | --- |
| 启动/组合 | `base/app-boot` | 两层合成、boot()、LayerAdmin 热重载、`./rpc` 管理桥（认领 `plugins` 域；互斥组、requires 正反向预检与按来源的内置保护在这里执行；`./contract` 是方法行与 schema 的家）；池扫描 `./scan`（含 clientOnly/subpath 声音）、解析钩子 `./resolve-hooks`（appRoot 优先、池内回退）；dev 静态住户经 `rendererPackages` 挡板（仅 dev） |
| 工作站桥 | `base/station-rpc` | `session.*`/`settings.*`/`audit.*`/`client-config.list`（登录态落 settings + 审计；`./contract` 是方法/帧行与 schema 的家，渲染住户 import 它获得类型；行携带 `clientUrl` 与该包**每个辅助 surface 的面 URL**（`surfaceUrls`），渲染端据此决定每个窗口装什么） |
| 系统外壳 | `base/shell` | **OS 集成缝**：`ctx.shell`（宿主面）与 `./contract`（渲染面）两个面。宿主面 = 通知（含动作按钮与点击回执）、托盘菜单贡献、辅助 surface 的窗口生命周期、悬浮球状态；渲染面只有单向 `shell.toast`、`surface.present/hide`、`shell.ball.state` 与两个帧。**池插件永不 import Electron**，Electron 只出现在首方 provider（`apps/desktop/src-host/main/shell`） |
| RPC 协议 | `base/protocol` | **信封封闭、内容开放**：四象限消息模型、RpcMethodMap/FrameMap 两个开放合并基座（只有平台行 `host.*`/`rpc.*`/`window.*` 留在这里）、zod 信封校验、AbstractApiClient 双 overload |
| RPC 宿主侧 | `base/gateway` | `ctx.rpc`：域名认领（`claimDomain` 首认即得、冲突 fail-loud）、`method`（请求 schema 必须随注册）、`frame`（载荷 schema 注册）、`bridgeEvent`、`rpc.describe` 能力发现、帧泵 |
| RPC 客户端侧 | `base/connection` | HostLink：两原语之上的类型化客户端；`subscribeFrame(link, method, schema, cb)` 是消费帧的标准姿势；`rpcErrorText` 统一错误文案 |
| 设置持久化 | `base/settings` | 原子 JSON 持久化（`settings.json`）；`settings.get/set` RPC + `settings/changed` 帧让渲染端简单配置即时生效 |
| 审计 | `base/audit` | 追加式 JSONL：启停/配置/控制写全记录；`list(filter)` 读回；wire 类型（`AuditEntryInfo`）由它导出 |
| 工具 | `base/util`、`base/plugin-kit` | Branded、assertNever、`formatClock`/`formatDuration`；`util/manifest` 是层词汇与规则单源。plugin-kit：`snapRail` manifest 词汇表（zod：kind/layer/category/exclusive/framework/requires/clientOnly/client/permissions）、种子两层（`SEED_MODULES` 基础层 + `CONTRIBUTED_SEED_MODULES` 框架贡献层，并集 `CLIENT_EXTERNALS` 是 clientBundle external 面）、tsdown preset（含 CSS 内联、三方库全内联、**种子导入护栏**——种子只准 named/star 导入，default 经 rolldown CJS interop 会变成命名空间对象，构建期硬错）、最终格式打包器 `./pack`（含 exports 映射、clientOnly 形态、**pack 时盖 `snapRail.client.seedAbi` 章**——bundle 真实 require 到的种子 id + 本包解析到的版本 + `SEED_ABI_REVISION`） |
| 引导 | `base/kernel`、`base/modules` | 启动页、carrier 握手、root 移交、**无框架朴素插件页**（三合一输入：地址/拖拽/搜索安装 + 已安装列表 + 红色异常提示条；`droppedZipPath` 路径桥；`showBootstrapAfterFailure` 崩溃回退——框架运行时抛异常时重植 root 并把错误带上提示条回到此页）；**辅助 surface 回退**（`showSurfaceFallback`：球是没有框架时的可拖可点圆球、面板是说明卡；`ClientHandle.surface` 让每个窗口知道自己是哪个 surface）；渲染端模块系统（`__ModuleLoader__` queue→live 门面 + 种子表 + `loadPluginBundle`） |
| 持久化规范 | `store/store` | `ctx.store` 的 Service Definition：`register(caller, ns, drizzle表)`；**drizzle 查询构建器即规范**（无裸 SQL/CTE/窗口函数）；命名空间 = 隔离边界；注册即建表 + append-only 加列 |
| 持久化实现 | `store/store-sqlite` | 参考实现（zip 安装；互斥组 `store-backend`，单活）：node:sqlite + 自写 drizzle 适配器（零原生模块），`data/<ns>.db`，WAL；换后端 = 新实现包替换单活 |
| 工业通讯协议域 | `equipment/equipment` | **equipment 缝 = 规范包**：`data/equipment.db` 三表（设备/组/点 + 方言 config blob）+ 点表运行面 + 驱动注册面。`ctx.equipment.registerDriver` 上交 `{id, title, schemas, createConnection, probe?}`——驱动是纯协议适配器（零存储、零渲染端）；`probe` 驱动一次性只读连接测试，`equipment.devices.test` 是其 wire 面。底座编排（reconcile：配置×驱动→连接），驱动决策（update 内热调或重连）。zip 声明 `requires: ['service:store']`，`./rpc` 桥以子路径行（`@snap-rail/equipment/rpc`）一并启用；`equipment.config.list`/`equipment.devices|groups|points.*` CRUD、`equipment/structure-changed` 帧；`equipment.mappings.list` 读底座表投影（消费方零改动）。`./contract` 是随应用发布的渲染契约（base 种子），`./driver` 是独立驱动仓库只读的纯类型面 |
| ModbusTCP 驱动 | 独立仓 `snap-rail-driver-modbus` | 范本驱动（新驱动作者的活文档）：纯协议适配器，块轮询/编解码；方言 schema（`.meta` 中文标题 → JSON Schema）；无存储无渲染端；`requires: ['@snap-rail/equipment']` |
| EtherNet/IP 驱动 | 独立仓 `snap-rail-driver-enip` | 照 modbus 范本的第二个驱动（首期对接 OMRON NX1P2）：自研轻量 ENIP/CIP 编解码（RegisterSession + SendRRData + Read/Write Tag 符号寻址，无第三方协议库），按已发布全局变量名轮询读写；变量级 CIP 失败只 null 单点（设备保持在线），写前经首读自学类型字；`slot>0` 发背板路由段（留 Logix 兼容门） |
| UI 框架 | 独立仓 `snap-rail-framework-shadcn` | **框架插件（互斥组 `framework`，单活，clientOnly）**：接管全套 UI 栈——槽位词汇 `ctx.uiSlots`（well-known ids + `custom:*` + 缺槽降级）、renderer runtime + 槽位驱动 Shell、shadcn 共享原语 + 主题令牌（theme.css，Tailwind v4 预编译输出随 zip 走）+ `SchemaForm` + `useRefresh`、`ctx.settingsPages`/`ctx.session`/`ctx.variables`/`ctx.workflows` 服务、**设置外壳（对话框 occupant + 主题热应用 + 一方「插件/主题/软件更新」三页——原 `ui/settings-station` 包已退役并入，只装框架即得完整管理界面）**、fallback 布局。client 面把全部面贡献为共享种子（`client.seeds`）；Component 经 `requires` 里的框架条目绑定（绑定即依赖）；换框架 = 换生态 |
| 统一设备管理页 | `ui/equipment-station` | equipment 缝的渲染面：设备 Tabs、连接灯、分组健康、点位表（方言列+实时值）、SchemaForm 配置对话框（见 equipment 语义节）；经 `ctx.settingsPages` 缝贡献设置页；clientOnly zip，`requires` 声明框架与 equipment |
| 业务套件 | 独立仓 `snap-rail-suite-terminal-ops` | **套件 = 单包单行，可双面**（互斥组 `suite`，单活）：一个渲染行挂全套成员（layout 槽+titlebar 槽+五个流程页+产量采集设置页，成员为子 fiber，跨页 action 常量收在包内）；宿主面 `./stats` 是同一场景的持久班产计数（store 缝 + 登录锚定 + `production/stats-changed` 帧），契约面为包内私面——场景逻辑收在套件内，杜绝跨包场景工具；`requires` 声明框架、equipment、`service:store` |

## 窗口与 surface（OS 集成）

OS 资源只有一个入口：**`ctx.shell`（宿主面）与 `@snap-rail/shell/contract`
（渲染面）**。池插件永不 import Electron；Electron 只出现在首方 provider
（`apps/desktop/src-host/main/shell/*`），换实现（无头宿主、远程外壳）是换
provider，消费方零改动。

**所有权按点击寿命划分，不按调用点划分**：

- **宿主面**（`ctx.shell`）：带动作按钮的通知、托盘菜单项、窗口本身。这些
  活得比任何 renderer 都长——按钮点击可能在客户端面消失几分钟后才到，所以
  只有宿主面 fiber（与应用同寿）能贡献它们；`shell/notification-clicked`、
  `shell/notification-action`、`shell/tray-clicked` 是回执。
- **渲染面**（`./contract`）：单向 `shell.toast`（无按钮、无回调，点击聚焦
  主窗口）、`shell.surface.present/hide`、`shell.ball.state` 与两个帧
  （`shell/surface-changed`、`shell/ball-changed`）。会消失的调用方不得留下
  无法应答的按钮，也拿不到 OS 句柄。

**窗口**：`main` 永远由 Shell 拥有；`ball`/`panel` **按需创建**、隐藏后保留
（下次 present 不重载，订阅仍在）。面板失焦即隐藏、Esc 即隐藏（由窗口拦截，
任何 renderer 都吃不到"关不掉"的浮窗）。悬浮球位置跨会话记忆；记忆位置不再
落在任何显示器工作区内时丢弃并回到右下角。尺寸固定（球 128、面板 360×480），
不接受任意 URL 或任意窗口——surface 白名单就是封闭的三元组。

**通知**：宿主面 `ctx.shell.notify(caller, input)`，上限单源在
`SHELL_LIMITS`（标题 120 / 正文 512 / 动作标题 20 / 动作 id 64 / 一条最多 3
个按钮），全局节流 5 条 / 10 秒，保留 50 条记录用于点击关联；同一 `tag` 的
后一条替换前一条（沿用同一 id，不占节流预算——否则屏幕上会留下过期的计数）。
超限/节流一律回 `{applied:false, reason, message}`，不抛进调用方 fiber。
**冷启动**（应用未运行时点通知启动）没有记录可查：`Notification.handleActivation`
的落点是通用的"聚焦主窗口"，不做插件路由（将来若需要，走 `toastXml` 携令牌
预留）。

**托盘**：单例、**懒创建**（首个托盘项或首个辅助 surface 出现时才建图标——
终端默认不在通知区占位）；固定行（显示主窗口 / 隐藏到托盘 / 退出）+ 贡献行。
托盘项 id 按 `<插件>:<id>` 命名空间化，两个插件可以都叫 `pause` 而互不干扰；
单插件 12 项、全体 24 项上限；贡献随**调用方 fiber** 回收（`caller.effect`），
重载/禁用插件不会留下孤儿菜单项。`X = 关窗即退出` 保持不变；隐藏到托盘只能
是托盘菜单里的显式动作——托盘建不起来时该动作回 `{applied:false}`，绝不把
窗口藏进一个不存在的图标后面。

**悬浮球状态**：`ctx.shell.ball.setState(caller, patch)` 是宿主聚合面——产量
计数、连接健康这类宿主面插件不需要球窗口存在就能驱动它；`shell/ball-changed`
帧把它推给球窗口，`shell.ball.state` 是读取面。越界值**夹取/截断**而非拒绝
（显示值不值得让插件失败）：进度夹到 `0..1`、标签截到 8 字、未知 tone 保持
原值。

**权限词汇**：`shell:notify`、`shell:tray`、`shell:surface` 出现在 manifest
的 `permissions` 里，**当前只做安装期展示、不做运行时强制**（与仓库其他权限
一致）；强制点仍在进程/OS 层。

## 工作站语义（station 层）

- **一切业务动作皆审计事件**：维护完成、生产启停、抽检提交、故障三步、
  停机起止都以 `audit.record` 落 JSONL（actor=当前登录工号，宿主侧落定，
  客户端不自报身份）；渲染端用 `audit.list` 在启动/登录后重建全部状态，
  重启不丢。
- **门控链是涌现的**：每个流程插件注册时声明 `requires`（如生产依赖
  `maintenance.complete` @ `operator-day`，抽检依赖当日 `production.start`
  @ `day`），workflows 服务只做通用求值，不含任何具体流程知识；故障/停机
  常开。action 常量由生产方插件导出、依赖方按包名导入。
- **登录门控**：未登录整幅登录页（标题栏常驻）；工号持久化在 settings
  （`session.operatorId`），重启保持登录，标题栏提供退出登录换人；换人后
  `operator-day` 门控自动重算（换人重做当日维护）。
- **生产理论计数**：rate × 净运行时长；故障与停机区间取并集剔除，故障与
  停机可并发。理论曲线函数住在套件自己的 `./contract` 面。
- **班产统计（实际计数）**：计数在宿主侧运行——套件的双面宿主
  `./stats`：监听 equipment 的 `point/updated`、只累计正增量（负增量=
  计数器复位忽略、`null`=异常重播种基线），按三班分桶落 store
  （班行 + 小时桶 + 登录锚），页面开闭/注销/重启都不丢。
  班次以**登录时刻**锚定：整个登录会话计入登录时所在班，只有退出重登
  才换班（同班交接延续同一班行，重启按持久化锚恢复原班次，未登录期间
  不归班）。生产页是纯投影：宿主每个 flush 周期广播
  `production/stats-changed` 全量快照（兼作渲染端初值心跳），页面显示
  当前班徽标、本班实际产量、今日三班与 24 小时图表。绑定地址
  （`(device, group, name)` 三元组）持久化在 settings.json
  （`production.countBinding`），在设置对话框「产量采集」页级联选择；
  保存后经 `settings/changed` 帧当场热换绑。
- **侧栏注意效果**：抽检光晕提前 5 分钟亮起（黄→红线性、2.4s→0.7s 加速、
  逾期钉在深红最快档），故障红匀速、停机黄匀速呼吸；调度与告警在插件
  apply 作用域运行，切页/重启后依然生效。

## 两层组合与热重载

- 内置层（`resources/builtins.cordis.yml`，随应用只读，**base-only**）+
  预设层（`<home>/presets/*.yml`，字典序叠层，可缺省）+
  用户层（userData `plugins.yml`，**按包名**寻址：`enabled`/`config`）→
  `composeEntries` 重算（预设行与用户行先按名逐字段合并为一份补丁集，
  用户永远胜出）→ 原子写派生物 `.composed.cordis.yml` →
  include `refresh()` 事务性对账（逐条 create/update/remove，失败回滚）。
  预设层是"出厂组合作为数据"：型号出厂配置 = 一张可整张替换的预设文件，
  推送新版预设不覆盖用户手编；预设引用的池包拒绝卸载（行会悬空），
  仅被预设引用的行在管理页显示「预设」来源。dev 用 base overlay
  （`dev/builtins.dev.cordis.yml`，随 SNAP_RAIL_DEV_URL 切换，永不随包发布）。
- 渲染端住户的行也写在同一个 `plugins.yml`：`clientOnly` 池包的行天然
  不进宿主树（manifest 自描述），dev 与生产同路（静态住户挡板随拆仓移除）；
  `client-config.list` 在渲染端启动时下发，
  行带 kind/category/贡献种子（行变更经 `client-config/changed` 帧通知，
  渲染窗自动 reload——kernel 的 `installRendererAutoReload` 去抖 500ms，
  设置键 `ui.rendererAutoReload` 可关）——用户只认识一个文件、
  一套按包名寻址的语义。**子路径行**（`@snap-rail/equipment/rpc`）经
  池包 release manifest 的 exports 映射解析为对应入口文件。
- LayerAdmin 串行化所有变更；watch 层文件与池目录（150ms 去抖）。
- 包是管理单元：`plugins.list` 给每行带 `packageName`、`kind`、
  `title`、`category`、`exclusive`、`framework`、`requires`、`clientOnly`
  （经池清单或 appRoot 解析 manifest），插件管理页条目平铺——一个包
  与其子路径行各占一行、各带开关，无包组合卡；**内置行不显示**
  （全部操作都被拒绝的行是噪音；保护仍在——RPC 侧同样拒绝，保护按
  来源判定，zip 永不入保护集）。行上无来源徽标：声明的 `category`
  优先归组（不问来源，dev overlay 住户各归其标记——内置来源的行不进
  管理面），未声明的安装/preset 行落「其他」——徽标是冗余，分类即归属。
- **防冒充双闸**：保护集（builtin 行 + 包名 + dev 住户）由宿主从层文件
  计算，manifest 声明改变不了它；在此之上 `plugins.install` 拒装与内置
  行重名的 zip（conflict，解压前拒绝），组合解析对内置名字永不走池
  （`resolveModuleSpecifier`/`packageManifestOf` 的 reserved 旁路）——
  手工拷进池的同名目录也顶替不了应用树里的真内置插件。
- **依赖预检**：`plugins.set-enabled` 启用方向先正向校验 requires（包名
  条目须已启用、`service:` 条目须当前活动、框架绑定视同依赖），禁用与
  `plugins.uninstall` 先反向校验（依赖方清单非空即拒绝）——「禁用
  store-sqlite 留 equipment」不再变成重启变砖。
- **互斥组单活**：启用带 `snapRail.exclusive`（或 kind=suite 默认组）的包
  时，`plugins.set-enabled` 在同一次 `setUserRows` 批量写里停用同组其他
  成员的全部行——套件、框架、store 实现都走这一条路。退役行名（包合并
  遗留，含 field→equipment、suite/stats→trend、trend/forge 整包删除、
  driver-mock 整包删除）在 `loadUserLayer` 内存态改名到后继行、彻底退役
  的行直接丢弃；**不再随包发布的一方包行**（equipment/store-sqlite/
  驱动/框架/套件/两 station——后五者已迁独立仓）在池中无副本时自动
  退役（装回即复活），老文件升级不炸组合，下次写回自然收敛。
- 坏文件（YAML 解析失败、未知插件引用）**保持当前树运行**并报错；
  修好文件后下一次写自然恢复。扫描池回答"有什么"，清单回答"挂什么"。

## 四象限协议（IPC 缝）

- 上行：`ipcMain.handle`，完整 ClientRequest/ServerResponse 一问一答。
- 下行：`MessageChannelMain` 专用端口承载 `ServerRequest` 帧；
  preload 端 `addEventListener` 后必须 `port.start()`（仅 `onmessage`
  赋值会隐式启动）。
- rpcId：发起方铸造、响应回显、不匹配即传输错误。业务失败走
  `RpcResult`（`{ok:false,error}`）永不抛；传输失败才抛。
- BigInt 经结构化克隆无损过线。

### 开放注册（信封封闭、内容开放）

协议包只有信封是封闭的：四象限消息模型、rpcId 纪律、错误码表、
envelope 校验、客户端基类。方法与帧的**内容**全部开放——
`RpcMethodMap` 与 `FrameMap` 是两个空的合并基座，每个域的行住在
owner 自己的 contract 模块里（`declare module '@snap-rail/protocol'`
声明合并），schema 随注册走，**新增能力不改 protocol 任何文件**：

1. **域名认领**：`ctx.rpc.claimDomain(ctx, 'demo')`——首认即得、
   重复认领 fail-loud；方法名按最长前缀（1-2 段）校验认领权。
   `equipment.modbus` 这类子空间由驱动认领（equipment 域先被
   equipment-rpc 认领，驱动桥在其后挂载）。命名规则：方法
   `域.资源.动词`（全 kebab-case，2-4 段），帧 `域/事件`（kebab 段）。
2. **方法注册**：`ctx.rpc.method(ctx, 'demo.add', { request: zod,
   response?: zod }, handler)`——请求 schema **必须**（信任边界用它
   校验）；可选 response schema 出站自检；返回 disposer。
3. **帧注册**：`ctx.rpc.frame(ctx, 'demo/tick', { payload: zod })`——
   帧域须已被认领；跨插件同名帧 fail-loud。schema 服务 `rpc.describe`
   与客户端解析；`broadcast` 热路径不重复校验。
4. **事件桥接**：`ctx.rpc.bridgeEvent(ctx, 'point/added',
   'equipment/point-added', point => ({ point }))`——宿主 cordis 事件转发
   为帧的标准姿势。
5. **能力发现**：`rpc.describe` 列出活的域认领、方法、帧。
6. **类型可见性 = 消费方 import 提供方 contract**：合并行只进入
   import 了该 contract 的程序。"谁能调什么域"显式落在 package.json。

### 契约单源（defineContract）

传统写法把"同一件事"说三遍：Api interface、declare module 合并行、
请求 schema 表——漏一处就类型/校验脱节。现在每个域一份
`defineContract('域', { methods, frames })`：方法行 = `method(请求
zod).ret<响应值类型>()`（或 `.res(zod)` 附带出站自检），帧行 = 载荷
schema；`interface RpcMethodMap extends MethodRows<typeof contract> {}`
一次合并全域行；宿主桥 `ctx.rpc.serveContract(ctx, contract, handlers)`
一次挂载（handler 载荷/返回按行推导）。请求 schema 的输出类型**就是**
载荷类型——手写 readonly 而库产生可变数组那类分歧从此在编译期暴露
（数组载荷用 `.readonly()` 表达只读语义）。`docs/wire-catalog.md` 由
`pnpm run gen:wire-catalog` 从契约生成并进测试链（`--check` 禁手编）。

### 诊断侧车与作用域原语

- **invariant 侧车**：域可发布 `./invariant` 面（普通插件），挂载即
  校验本域持久数据的"永远应成立的规则"，违规以数据报告（logger +
  cordis 事件），永不修复、永不抛、不进默认组合——诊断与运行时解耦。
  现居民：`@snap-rail/app-boot/invariant`（行可解析、互斥组单活、
  requires 双向满足）。
- **`@snap-rail/scope`**（移植自 deepseek-harness dsh-scope，同源
  vendored cordis）:`createScope(ctx, key)` 铸带标签子 context——
  注册上下文即决定可见性与所有权（`ScopedLayers`：本域贡献只对该
  scope 可见、子域就近覆盖、dispose 整层回收；`scopeTarget` 事件沿
  父链向上放行）。**可信路由而非沙箱**。

### 高频点值与帧消费

- `equipment.points.subscribe` 按 (device, group, name) 三元组登记，引用
  计数——最后一个退订者才停帧。`equipment/point-updated` 仅对计数 > 0
  的地址广播；结构帧（增删/状态/映射变化）永远全播。
- 渲染端消费帧一律 `subscribeFrame(link, method, schema, listener)`
  （connection 包）：载荷一次 zod 解析、坏帧丢弃并记录，禁止手写
  `payload as {...}` 判形。`settings/changed` 帧跟随每次 settings.json
  写入（含会话工号）；消费方按 key 过滤、zod 校验后热应用。
- 下行端口重开是替换语义：carrier 对已存在端口的 `open-stream` 关旧
  建新回包；preload 扇出对单个抛错的 listener 隔离 try/catch。

## equipment 语义（设备连接底座）

equipment 是设备连接底座（原 field，已全链改名含 wire 与数据文件）：
**底座拥有配置表与统一 UI，驱动是纯协议适配器**。三层切分——
`data/equipment.db`（设备/组/点 + 方言 config blob；启动时自动把遗留
`data/field.db` 改名迁移）、点表运行面（points/connections）、驱动注册面
（`registerDriver`：schema + 连接工厂）。底座编排"什么时候变"
（reconcile：配置表 × 已注册驱动 → 连接集合），驱动决策"怎么变"
（`update(config, points)` 内部自决热调或重连；`dispose` 拆除）。

- 点位寻址统一为三元组 `(device, group, name)`：缝定义、rpc 方法
  （`equipment.points.read/write/subscribe/unsubscribe`）与帧载荷都只讲
  三元组，没有不透明 id 过线。`pointKey`（`设备/分组/名字`）只是
  宿主侧 Map 键与审计主体的内部组合串（组名与点位名拒含 `/`）。
- **点位的类型来自分组**（同组同类型是底座结构约束）；驱动 point schema
  校验合并对象 `{type, ...config}`（底座注入 type，存储剥离之）。
- 设备 id 从名称铸造（重名加 `-2` 后缀）；改名不改 id（绑定不漂移），
  改名重建连接（descriptor 不可变）。删除级联：设备→组→点。
- 值为 `null` 即点位异常；连接级故障看连接状态（`connecting/online/
  offline` + 消息），没有质量码。
- 总线语义四类型：`bool` / `int`（BigInt 承载 int64）/ `float`（double）/
  `string`。协议方言住在驱动自己的 `./contract`，经 zod
  `.meta({title})` 携带表单标题；JSON Schema 投影随
  `equipment.drivers.list` 下发，equipment-station 的 SchemaForm 渲染
  ——驱动零渲染端代码。
- 配置面 RPC：`equipment.config.list`（整棵配置树）、
  `equipment.devices|groups|points.upsert/remove`；任何变更广播
  `equipment/structure-changed`，且映射文档随之重投影。
- **通用映射面**：`equipment.mappings.list` 读底座表投影（仅含驱动在线
  的设备）——绑定解析（framework 的 variables 服务）只消费这一个面，
  对具体驱动零知识，多驱动映射自动成立。
- 写入路由到拥有连接的驱动，按声明类型做 typeof 校验；驱动侧写路径
  await 化——`equipment.points.write` 在驱动 I/O 完成后才 resolve，审计
  记录的是真实结果。

## 业务点位与分组

- 点位身份是三元组 `(device, group, var)`：名字只在组内唯一。
- 分组是显式实体，组身份是 `(device, group)`，创建先于点位：先对设备
  建组、再在组内加点。组携带唯一数据类型，upsert 在信任边界校验组存在
  且类型一致（not-found/conflict）——同组同类型是结构约束不是约定。
  删组级联删组内点位，删设备级联删组与点位。
- 字序（abcd/cdab）是设备级链路属性（设备表 `byte_order`，默认
  abcd），点位不再携带；改字序按设备 shape 变化热重建该设备连接。
- 需求组件的声明即三段地址：`ctx.variables.register(ctx, [{device,
  group, name, type}])`；消费必须同样三段——`usePoint(ctx, {device,
  group, name})`、`useBinding(ctx, {device, group, name})` 或组聚合
  `useBinding(ctx, {device, group})`。
- 绑定解析以 `equipment.mappings.list` 的通用映射文档为准；
  `equipment/mappings-changed` 帧触发重拉重解析——改映射即时生效，
  无需重挂页面。组聚合 v1 仅"任一激活"：bool 真 / 数值非 0 / 非空字符串
  即激活，`null` 分量列入通讯异常、未观测（`time` 0）列入 pending。
- 设置页按"设备 tab + 分组折叠面板"组织，连接健康以呼吸灯呈现：
  设备灯随连接在线/离线（绿/红），组灯按成员取值健康度（全好绿 /
  部分失败黄 / 全失败红）。

## 开发配方（Agent/人共用 checklist）

共同纪律：**schema 跟着 owner 走**（contract 模块是方法/帧行与 zod 的
唯一家）、**注册即 effect**（caller 首参、返回 disposer）、**跨包 import
用包名**、改动配 vitest 直测装配链路。

### 一、新增一个 RPC 方法域（如 `demo`）

1. 域主包内建 `src/contract.ts`：API 接口 + `declare module
   '@snap-rail/protocol'` 合并 `RpcMethodMap` 行 + 请求/响应 zod
   （`as const` schema 表）；package.json 加 `./contract` 导出。
2. 宿主桥插件 apply：`ctx.rpc.claimDomain(ctx, 'demo')` →
   `ctx.rpc.method(ctx, 'demo.x.y', { request, response? }, handler)`。
   业务失败 throw `RpcBusinessError`，别返回裸错误。
3. 渲染消费方：package.json 依赖域主包，源文件 `import '<包>/contract'`
   （获得类型行），`link.call('demo.x.y', {...})` 全类型。
4. 配方测试：schema 拒坏载荷、disposer 随插件卸载、`rpc.describe`
   能列出。**不改 protocol 任何文件。**

### 二、新增一个帧

1. contract 里合并 `FrameMap` 行 + 载荷 zod；宿主侧
   `ctx.rpc.frame(ctx, 'demo/event', { payload })` 后广播
   `ctx.rpc.broadcast('demo/event', payload)`（或宿主事件用
   `ctx.rpc.bridgeEvent` 一行转发）。
2. 渲染端消费一律 `subscribeFrame(link, 'demo/event', schema, cb)`——
   禁止 `payload as` 手写判形。

### 三、新增一个现场驱动（工业协议实现）

1. 驱动 = 纯协议适配器：`ctx.equipment.registerDriver(ctx, { id, title,
   schemas, createConnection, probe? })`。schemas 是 device/point 两个
   zod object（point 校验 `{type, ...config}`；`.meta({title})` 给统一
   表单中文标签）；照抄 `driver-modbus`（范本，`requires:
   ['@snap-rail/equipment']`）。驱动多活并存。`probe` 是可选的
   **一次性只读连接测试**（设置页「测试连接」）：底座用驱动 schema
   校验 config 后调用它，返回 `{ ok, latencyMs, detail?, sample?,
   error? }`；`equipment.devices.test` 是它唯一的 wire 面，不落库、
   不创建连接。没有 `probe` 的驱动仍可正常收发，只是不提供测试按钮。
2. `createConnection(device, points, handle)` 返回
   `{ update(config, points), dispose() }`——底座决定何时调，驱动决定
   怎么落地（热调 vs 重连）。handle 上报 `status` / `sample` / `onWrite`；
   点表注册是底座的事，驱动永不 setPoints。
3. 设备/组/点 CRUD 全部走底座（`equipment.devices.*` 等），驱动**没有**
   自己的存储、RPC 子命名空间和渲染端页面。写路径 await 到 I/O 完成。

### 四、新增一个页面插件（渲染端住户）

1. manifest 在 `requires` 里声明框架包
   （`'@snap-rail/framework-shadcn@^0.2'`，绑定即依赖、启用预检的一部分）
   + `clientOnly: true` + `client:
   { entry }`（纯渲染包），或带宿主面的双面包；tsdown 配置加
   `clientBundle('<包名>', 'src/index.tsx')`。
2. 页面只组合 `@snap-rail/framework-shadcn/ui` 原语（client bundle 经
   种子表共享框架实例）；`useRefresh(ctx, events)` 做事件驱动重渲染；
   错误文案 `rpcErrorText`；时间 `formatClock`/`formatDuration`；色值用
   theme 令牌。
3. 流程页经 `ctx.workflows.register` 声明 `requires` 门控；设置页经
   `ctx.settingsPages.register`；需求变量经 `ctx.variables.register`，
   消费走 `usePoint`/`useBinding`。
4. 调 station 域方法（audit/settings/session）的住户 import
   `@snap-rail/station-rpc/contract`；调 plugins 域的 import
   `@snap-rail/app-boot/contract`（都是 base 种子）。
5. dev 调试：包名临时加入 `apps/desktop/src-host/main/renderer-packages.ts`
   与客户端 `dev-harness.tsx` 的 OCCUPANTS（静态住户，仅 dev 生效）；
   发行走 zip，池面天然覆盖。

### 五、打包发布一个可安装插件

1. 包内两份面：宿主面是 node ESM（`@snap-rail/*`/zod/drizzle-orm 锚定
   external，驱动内部第三方库打进 bundle）；渲染面用 plugin-kit 的
   `clientBundle`（CJS 浏览器包——焊 `__ModuleLoader__` 工厂壳、种子
   external、三方库全内联、`.css` 变内联样式注入、位图/SVG 以
   `snap-plugin://pool/<目录>/…` URL 发射到包旁）。package.json 声明
   `snapRail`：`kind`、`layer`（仓内门禁用）、`title`（人面显示名，
   未声明回退包名）、`category`（开放分类
   标记，作者随意命名）、`exclusive`（互斥组，可选）、`framework`
   （渲染面绑定）、`requires`（依赖预检：包名/`service:` 条目）、
   `clientOnly`（纯渲染包无宿主面）、`client: { entry, seeds? }`、
   `permissions`（安装时展示）。
2. `pnpm run build && pnpm run pack:plugins -- --sign-key <private.pem> --key-id <id>` 产出
   `dist-plugins/<包名>.zip`——**最终格式**：精简 manifest（`main` 指
   宿主面或 client 入口 + `exports` 映射子路径）+ 构建好的面目录，
   无源码。装配规则单源在 `@snap-rail/plugin-kit/pack`；出货清单在
   `scripts/pack-plugins.ts`。
3. 安装链：设置页「安装插件」（或无框架时的引导页拖拽）→ 取 zip 路径
   （`window.pick-zip` / 拖放 `zipPathOf` 桥）→ `plugins.inspect`
   （不落盘预检，`missing` 列出未装的包依赖作警告）→ 确认弹框 →
   `plugins.install`（fflate 解压进 `<home>/plugins/<包名>`；**与内置行
   重名的 zip 解压前拒绝**——冒充内置的第二道闸，第一道是保护集本身
   按层文件来源计算）→ 池扫描；启用经 `plugins.set-enabled`（requires
   正向预检），渲染行重启生效。
4. 运行期解析：宿主侧 `module.registerHooks` 仅对**池内文件**的
   `zod`/`drizzle-orm`/`@snap-rail/*`（含子路径）裸导入生效，顺序
   **appRoot 优先、池内回退**——应用自带的规范与库永不被 zip 遮蔽
   （防伪），不随包的包（equipment 等）由池副本提供单一实例；其余
   第三方库打进宿主面 bundle。渲染端面经 `snap-plugin://pool/…`
   特权协议以 classic script 到达，`__ModuleLoader__` + 种子表还原
   单实例。
5. 渲染面依赖纪律：client bundle 运行时 require 的 id ⊆
   `CLIENT_EXTERNALS`（= base 种子 `SEED_MODULES` ∪ 框架贡献种子
   `CONTRIBUTED_SEED_MODULES`；宿主入口永不入表；套件有 vitest 门禁
   扫描页面导入）。卸载：`plugins.uninstall` = 删池目录 + 删
   `data/<ns>.db`（分域数据随包走；反向依赖预检先行）。互斥组启停与
   切换见「两层组合」节。

## 安装与渲染端装载（机制总览）

- **snap-plugin:// 特权协议**（desktop 主进程）：`registerSchemesAsPrivileged`
  （standard/fetch/stream）+ `protocol.handle` 映射 `snap-plugin://pool/<…>`
  → `<home>/plugins/<…>`；越出池根的路径 403。dev 与 prod 同一条路径。
- **宿主解析钩子**（`app-boot/resolve-hooks`）：仅当导入方文件位于池内
  时，把 `@snap-rail/*`/`zod`/`drizzle-orm`（含子路径）的裸导入按
  **appRoot 优先、池内回退**解析——应用树先答（自带规范与共享库永不被
  zip 遮蔽），应用不带的 id 落到 `<pool>/<pkg__>/` 的 release exports/
  main 声音（纯文件系统查找，钩子永不自递归）。池插件之间因此共享
  已装包的单一实例（第二份 equipment 会撕裂服务身份）。
- **渲染端模块系统**（`base/modules` + desktop 客户端入口）：种子两层。
  **base 层**（`SEED_MODULES`）由客户端入口静态播种并 parity fail-loud
  ——react 家族、cordis、timer、kernel/modules、connection/protocol、
  station-rpc/app-boot/equipment 的 `./contract`、util、zod（契约
  面随应用发布；场景契约住在套件包内，不入种子）。**贡献层**
  （`CONTRIBUTED_SEED_MODULES` + 消费方 `client.externalSeeds`）由已安装
  框架/扩展库的 client 面提供：框架入口默认导出 `{ seeds: { ui, slots, …,
  runtime } }`，壳 require 该面后逐 id `system.seed('<包>/<子路径>', 实例)`
  ——每个 Component 与框架共享同一份原语/槽位/运行时实例。装载顺序：
  framework 行 → 其他种子提供方（`client.seeds` 非空）→ 普通住户面。
- **无框架引导**：没有已启用的 framework 行时渲染 `kernel` 的引导安装页
  （统一插件列表：已装池包行启用/禁用/卸载与插件源目录条目安装/更新按
  包名合并成一张表，内置行不出现；拖拽 zip → `zipPathOf` 桥 →
  inspect/confirm → install 与源地址配置为次级操作；变更后「重启生效」），
  关闭回到连接页、角落入口重开——base 永远是救生艇。框架运行时抛异常
  时 `showBootstrapAfterFailure` 重植 React root 带错误横幅回到此页，
  操作员永远保有插件管理入口（配置错插件不再等于锁死终端）。
- **装载纪律**（三条硬边界）：渲染面永不 import 双面包的宿主入口
  （跨端类型/schema 走该包 `./contract` 纯面）；渲染面运行时 require 的
  id ⊆ `CLIENT_EXTERNALS`（= base ∪ 贡献种子；种子表 = 客户端入口播种 =
  `clientBundle` external，三处单源；加 base id 是 base 层决策，框架
  贡献自己的 id）；池内包单宿主入口。**种子消费只准 named/star
  导入**——default 导入经 rolldown CJS node-mode interop 会把 `.default`
  变成整个命名空间对象而非模块自身的 default，`clientBundle` 的
  `seedImportGuard` 构建期硬错（r1 黑屏事故的根因）。**seedAbi 握手**：
  pack 盖章（bundle 实际 require 的种子 + 本包解析到的版本 + revision）→
  安装期 `plugins.install` 对照宿主活表拒装（`resolveSeedAbi(appRoot)`，
  appRoot 缺失降级为仅 revision）→ 渲染端 boot 经 `client-config.list`
  附带宿主表、面加载前比对（不符 skip + console.error，框架被拒即回退
  引导页）；缺章的存量 zip 放行（过渡宽限）。
- **管理页**（框架设置外壳的一方「插件」页，随框架 zip 走）：按 `snapRail.category` 标记动态分组
  （开放词汇，作者命名；声明即归组、不问来源——dev overlay 住户也各归
  其标记；未声明落「其他」；**内置来源的行不显示**——全部操作都被
  拒绝的行是噪音，保护语义不变；行上无来源徽标）+ 分节折叠与全部
  折叠/展开（带图标按钮，顶栏与安装插件并排）+ 条目平铺（无包组合卡，
  一行一开关）+ `snapRail.title` 两行式身份（标题为主、包名小字次要，
  未声明回退包名）+ 套件 radio 卡 + 安装流（inspect 警告缺依赖，
  重名内置拒装）+ 待重启徽标 + 套件切换弹框。

## 打包决策

- asar 关闭：插件经 `file://`/`snap-plugin://` URL 动态 import、内置层
  文件需可 watch。防篡改需求出现时再评估自定义协议方案。
- **出厂净身**：desktop 生产依赖 = base 包 + 纯类型规范包
  `@snap-rail/store` + 共享库（zod/drizzle-orm/electron-updater）；
  equipment 的 `./contract` 以 base 种子形态随客户端 bundle 发布（场景
  契约住在套件包内）。
  一切可替换实现（store-sqlite、equipment、驱动、framework、两 station、
  套件）不在生产依赖里——只能 zip 安装。
- 发行插件 zip 由 `pnpm run pack:plugins` 产出（`dist-plugins/`），
  **最终格式 = 精简 manifest（含 exports 映射）+ 构建产物，无源码**。
  `scripts/install-dev-plugins.ts <home>` 把全量 zip 装进任意 home 并启用
  （dogfooding 安装管线）。
- 更新通道：electron-updater 座位已接线（无 publish 配置时静默）。
- **线上四件套**：官网 + 插件源 + 离线组合包 + 更新源全静态（公网基准是
  GitHub 滚动 Release，内网基准是 Gitea）；`pnpm run publish` 一条命令装配
  并同步（流程、组合包与社区发布模型见 deploy.md）。插件页消费
  `plugins.remote-list`/`remote-install`；组合包按内容识别后走
  `plugins.install-combo`（缺失/需更新的成员逐个安装 → 预设原子落地热
  生效）；下载带 sha256 校验。官网由 `pnpm run site:build` 从同一份
  `catalog.json` 生成，卡片直接链到 Release 资产。

## 一期不做、留座位的

权限执行层（manifest 已声明+安装展示，未拦截）、tool 层规范缝（第三个
工具出现时再抽象）、i18n、遥测、deep link 唤起安装、完整开发者文档站、
web/头部双入口 profile、as 化部署、套件热激活（当前重启生效）、套件内
条目级裁剪。
# Plugin platform direction

The runtime is split into an Electron shell, a Node Host and a Renderer. The
shell owns windows, IPC and recovery; the Host owns Cordis, plugin discovery,
installation, signatures, storage, device communication and RPC; the Renderer
only mounts the selected UI framework and consumes contracts over the typed
bridge. A plugin package may ship a Host face, a Renderer face, or both, but it
cannot cross the boundary with private imports.

Plugin manifests declare compatibility through one vocabulary: `requires`
entries are a package name, a `name@range` version-constrained package (the
framework binding IS such an entry; range semantics live in
`@snap-rail/util/semver`), or a `service:` id — enable/install/uninstall
resolve them before composition. `engines` records the supported snap-rail,
Host protocol and Renderer ranges so an incompatible artifact is rejected at
the install boundary, and the pack-stamped `client.seedAbi` gates the
renderer seed contract. (The retired `framework`/`capabilities` fields strip
off legacy zips at manifest validation and are never read.)

The UI framework exposes a semantic contract (`@snap-rail/framework-shadcn/semantic`)
on top of the slot registry. Layouts register which semantic slots they render;
component plugins register views and navigation entries by stable ids such as
`shell.titlebar.actions`, `shell.sidebar`, `shell.view` and
`shell.statusbar`. A layout may publish a namespaced extension slot only as
`custom:<publisher>.<name>`; malformed or undeclared slots produce a semantic
diagnostic and never become an implicit global vocabulary. Layout packages
therefore do not own component packages, and a component can move between
layouts without changing its implementation.

Independent plugin repositories use `@snap-rail/plugin-sdk` and the
`snap-rail-plugin` CLI from public npm. Each generated repository contains its
own `AGENTS.md`, manifest schema, build preset and release inspection commands.
The release packer emits only built faces and the trimmed manifest; source files
never enter the plugin pool. Authors publish their own rolling `feed` release
and tag the repository `snap-rail-plugin`; there is no central market repo, no
PR gate and no official aggregation of community bytes.

Installable releases are signed with Ed25519. `META-INF/release.json` contains
canonical metadata and SHA-256 digests for every payload file;
`META-INF/signature.json` contains the publisher key id and detached signature.
The Host loads public keys from the host-owned `trusted-release-keys.json`
outside the plugin pool. The install gate is three-state: a signature whose
key is registered verifies hard (any failure — digest, identity, publisher —
refuses, it is tamper evidence), an unsigned archive or an unregistered key
reads as `unverified` and installs under the default `open` policy behind an
explicit risk confirmation the UI must surface. `plugins.signaturePolicy:
'strict'` restores the closed-fleet behavior; the `@snap-rail/*` namespace
refuses unless verified whatever the policy. The trust file is only ever
edited by a human — an install never writes to it. Update anchoring rides the
installed envelope's key id: a feed entry signed by a different key is
flagged `keyChanged`, skipped by the auto-apply sweep, and confirmed by hand.
Community plugins publish from their own repositories with their own keys;
discovery is a GitHub topic plus user-added static feeds, and federated catalog
entries point at the author's release by absolute `url`.

Offline combo packages are plain zips: `recipe.yml` at the root plus one
signed member zip per referenced package under `plugins/`. The archive carries
no signature of its own — every member keeps its release envelope, and the
install transaction lands all missing/outdated members before writing the
combo preset. Inspection reports the member verdicts and the aggregate missing
requirements; content (not the URL) decides plugin vs combo.

The Host exposes `plugins.diagnostics` for recovery and support tooling. It
reports the Host/Renderer protocol versions, enabled packages, unsatisfied
package or service requirements, the key ids observed in installed release
envelopes, and the latest failed layer refresh.
