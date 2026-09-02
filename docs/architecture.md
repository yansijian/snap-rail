# snap-rail 架构

工业终端的开源底座：OT 现场数据与 IT 工具链在一个"一切皆插件"的宿主里汇合。
本文是缝（seam）目录与关键决策的单一权威；代码 JSDoc 是各包契约的权威。

## 产品宪法

不复现组态画布与传统工业 HMI。那是社区与 Agent 的领域——底座只提供
进程模型、插件机制、数据缝与最小 UI 骨架；创新界面由插件生态生长。

## 进程模型

```
Electron 主进程                        renderer（每窗口）
┌───────────────────────────┐          ┌─────────────────────────┐
│ Cordis 宿主树（boot 产物）  │  invoke  │ client Cordis 树         │
│  loader → include(合成清单) │ ───────▶ │  kernel → runtime → 住户 │
│  gateway ── 点表/管理方法    │ ◀─────── │  React root（槽位驱动）   │
│  field / driver-mock …     │  帧流端口 │                         │
└───────────────────────────┘          └─────────────────────────┘
```

- 主进程是宿主：一切能力插件跑在这里；renderer 是纯投影客户端
  （contextIsolation 开、nodeIntegration 关、preload 只暴露两原语）。
- renderer 内跑一棵轻量 client Cordis 树：kernel 引导（启动页 + HostLink），
  runtime 接管 React root 并挂住户插件。
- **文件即接口**：`plugins.yml` 同时被页面按钮、手编、Agent 编辑——一条
  热重载路径服务全部三种来源。

## 能力缝目录

每条缝 = Service Definition（类型与事件）+ Provider（实现）+ Consumer（消费），
三者齐备才算完整；仅当角色独立演化时才拆包。

| 缝 | 包 | 说明 |
| --- | --- | --- |
| 启动/组合 | `boot/app-boot` | 两层合成、boot()、LayerAdmin 热重载、`./rpc` 管理桥（认领 `plugins` 域；`./contract` 是方法行与 schema 的家）；`rendererPackages` 让渲染端住户行只作配置不进宿主树 |
| 工作站桥 | `boot/station-rpc` | `session.*`/`settings.*`/`audit.*`/`client-config.list`（登录态落 settings + 审计；`./contract` 是方法/帧行与 schema 的家，渲染住户 import 它获得类型） |
| RPC 协议 | `protocol/protocol` | **信封封闭、内容开放**：四象限消息模型、RpcMethodMap/FrameMap 两个开放合并基座（只有平台行 `host.*`/`rpc.*`/`window.*` 留在这里）、zod 信封校验、AbstractApiClient 双 overload（已知方法全类型、未知方法 `(string, unknown)`） |
| RPC 宿主侧 | `protocol/gateway` | `ctx.rpc`：域名认领（`claimDomain` 首认即得、冲突 fail-loud）、`method`（请求 schema 必须随注册）、`frame`（载荷 schema 注册）、`bridgeEvent`（宿主事件→帧的标准桥）、`rpc.describe` 能力发现、帧泵 |
| RPC 客户端侧 | `protocol/connection` | HostLink：两原语之上的类型化客户端；`subscribeFrame(link, method, schema, cb)` 是消费帧的标准姿势（一次 zod 解析，坏帧丢弃并记录）；`rpcErrorText` 统一错误文案 |
| 工业通讯协议域 | `field/field` | **设备连接底座**：`data/field.db` 三表（设备/组/点 + 方言 config blob）+ 点表运行面 + 驱动注册面 + 统一「设备管理」设置页（`./station`，schema 驱动表单）。`ctx.field.registerDriver` 上交 `{id, title, schemas, createConnection}`——驱动是纯协议适配器（零存储、零渲染端）；底座编排（reconcile：配置×驱动→连接），驱动决策（update 内热调或重连）。`field.config.list`/`field.devices|groups|points.*` CRUD、`field/structure-changed` 帧；`field.mappings.list` 读底座表投影（消费方零改动） |
| 模拟驱动 | `field/driver-mock` | 范本驱动（新驱动作者的活文档）：极简 schema（离线/周期）+ 模拟点流 + 写回显，点表走底座 |
| ModbusTCP 驱动 | `field/driver-modbus` | 纯协议适配器：块轮询/编解码；方言 schema（`.meta` 中文标题 → JSON Schema → 底座 SchemaForm）；无存储无渲染端，配置全在底座表 |
| 槽位词表 | `client/slots` | `ctx.uiSlots`：well-known slot ids + 缺槽降级 |
| UI 原语 | `client/ui` | 主题令牌（theme.css，Tailwind v4）+ shadcn 共享组件 + `SchemaForm`（JSON Schema→触屏表单：enum=TouchSelect、数字=NumberPad、布尔=Switch）+ `useRefresh`（ctx 事件→重渲染的标准 tick）；页面组件必须组合此包原语，缺原语按 shadcn 官方实现移植，不在页面手写交互组件 |
| 操作人会话 | `client/session` | `ctx.session`：登录态镜像（宿主持久化，重启保持登录）、`session/changed` 事件；经 `settings/changed` 帧热跟随宿主侧换人 |
| 作业流程 | `client/workflows` | `ctx.workflows`：流程注册、声明式 `requires` 门控（`operator-day`/`day` 两 scope，事件集求值）、侧栏告警、active 页状态 |
| 渲染宿主 | `client/runtime` | 接管 React root、先挂 timer/slots/settings/variables/session/workflows 再挂住户（逐插件 config）、槽位驱动 Shell、引入唯一主题 |
| 变量声明 | `client/variables` | `ctx.variables`：需求方声明业务变量（三元组+类型）；`watchBinding`/`useBinding`/`usePoint` 消费配方经 `field.mappings.list` + `field/mappings-changed` 解析绑定——对具体驱动零知识 |
| 设置页 | `client/settings` | `ctx.settingsPages`：设置对话框的可扩展页注册表 |
| 引导 | `client/kernel` | 启动页、carrier 握手、root 移交 |
| 业务套件 | `suites/terminal-ops` | **套件 = 单包多入口**（`snapRail.kind='suite'`）：一个渲染行挂全套成员（layout 槽+titlebar 槽+五个流程页+产量采集设置页，成员为子 fiber，跨页 action 常量收在包内）+ 一个宿主行 `./stats`（班产计数：跟随计数绑定的正增量、按三班 8-16/16-24/0-8 落 `ctx.store`、登录时刻锚定班次、`production/stats-changed` 帧广播快照兼作渲染端初值心跳）。套件单活：启用一个套件经 `plugins.set-enabled` 自动停用其他套件包的全部行（一次批量写）——工业终端一次服务一个场景 |
| 设置外壳 | `client/settings-station` | 设置对话框壳 + 插件管理页（三分区：套件/驱动/核心）+ 主题页；核心内置，不可外移（卸了无法自恢复） |
| AI 创造工坊 | `tools/forge` | **常驻外部可装插件**（`kind:'plugin'`，zip 发行，与业务套件共存）：OpenAI 兼容流式 Agent 循环 + `rail_inspect/read/define/run/stop` 五工具造**运行时插件**（宿主/渲染两半纯 JS 函数体，require 白名单=宿主锚定表/`SEED_MODULES`，无 JSX）；版本不可变、`data/forge.db`（`forge` 命名空间）持久、boot 重挂；预检→挂载诊断→渲染端 `forge.client-report` 三段错误回喂修复环；渲染半经 `forge/gen-mounted` 帧下发，由模块系统全局 `require` 面喂种子实例后 `ctx.plugin` 挂为 forge 子 fiber；工作台=流程页+设置页（会话流式/版本卡回滚/源码复制），LLM 端点配置走 `forge.llm` 设置键热生效 |
| 统一设备管理页 | `field/field` 的 `./station` | 核心静态渲染面：设备 Tabs、连接灯、分组健康、点位表（方言列+实时值）、SchemaForm 配置对话框（见 field 语义节） |
| 设置持久化 | `settings/settings` | 原子 JSON 持久化（`settings.json`）；`settings.get/set` RPC + `settings/changed` 帧让渲染端简单配置即时生效 |
| 持久化 | `store/store` | `ctx.store`：drizzle over node:sqlite（自写适配器，零原生模块），**按命名空间分库**（`data/<ns>.db`）——文件隔离即插件时代的信任边界；schema 用 drizzle table 对象声明，注册即建表 + append-only 加列；跨命名空间协作走服务，永不共享表 |
| 审计 | `audit/audit` | 追加式 JSONL：启停/配置/控制写全记录；`list(filter)` 读回（工作站业务事件的真相源）；wire 类型（`AuditEntryInfo`）由它导出，单一来源 |
| 工具 | `util/util` | Branded、assertNever、`formatClock`/`formatDuration`；`./manifest` 是脊柱/住户名单与门禁的单源 |
| 渲染端模块系统 | `client/modules` | 已安装插件的渲染面装载器：`__ModuleLoader__`（queue→live 门面）+ 种子表（共享实例：react/cordis/client-ui…，`SEED_MODULES` 单源在 plugin-kit）+ `loadPluginBundle`（classic script）；CJS 工厂包经 `snap-plugin://pool/…` 到达 |
| 插件作者工具 | `util/plugin-kit` | `snapRail` manifest 词汇表（zod）、种子白名单 `SEED_MODULES`、tsdown preset：`hostBundle`（ESM node）+ `clientBundle`（CJS 浏览器包，焊 `window.__ModuleLoader__.load` 工厂壳、种子 external、位图/SVG 以 `snap-plugin://` URL 发射到包旁）、最终格式打包器 `./pack`（精简 manifest + 构建产物，装配规则单源） |
| 兜底壳 | `client/fallback` | 核心内置的极简 layout：零套件时的空态指引 + 极简标题栏（窗口控制+设置入口）；套件 layout 注册即让位 |
| 安装器 | `boot/app-boot` 的 `installer` | zip → 校验（manifest/名字/snapRail 形状）→ 解压进池；`inspectPluginZip` 不落盘预检；`plugins.install/inspect/uninstall` RPC（uninstall 删行+目录+分域数据）；宿主侧 zip 解析用 fflate |

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
  停机可并发。
- **班产统计（实际计数）**：计数在宿主侧运行——生产包的 `./stats` 面
  （`@snap-rail/process-production/stats` 挂载条目）：监听 field 的
  `point/updated`、只累计正增量（负增量=计数器复位忽略、
  `null`=异常重播种基线），按三班（8-16 早 / 16-24 中 / 0-8 晚）分桶落
  `snap-rail.db`（班行 + 小时桶 + 登录锚），页面开闭/注销/重启都不丢。
  班次以**登录时刻**锚定：整个登录会话计入登录时所在班，只有退出重登
  才换班（同班交接延续同一班行，重启按持久化锚恢复原班次，未登录期间
  不归班）。生产页是纯投影：宿主每个 flush 周期广播
  `production/stats-changed` 全量快照（兼作渲染端初值心跳），页面显示
  当前班徽标、本班实际产量、今日三班与 24 小时图表。绑定地址
  （`(device, group, name)` 三元组）持久化在 settings.json
  （`production.countBinding`），在设置对话框「产量采集」页按
  设备/组/点位 级联选择；保存后经 `settings/changed` 帧当场热换绑
  （重声明计数变量、宿主计数器自新点位首样本重新播种），未映射恒 0。
- **侧栏注意效果**：抽检光晕提前 5 分钟亮起（黄→红线性、2.4s→0.7s 加速、
  逾期钉在深红最快档），故障红匀速、停机黄匀速呼吸；调度与告警在插件
  apply 作用域运行，切页/重启后依然生效。

## 两层组合与热重载

- 内置层（`resources/builtins.cordis.yml`，随应用只读）+ 用户层
  （userData `plugins.yml`，**按包名**寻址：`enabled`/`config`）→
  `composeEntries` 重算 → 原子写派生物 `.composed.cordis.yml` →
  include `refresh()` 事务性对账（逐条 create/update/remove，失败回滚）。
- 渲染端住户的行也写在同一个 `plugins.yml`：boot 的 `rendererPackages`
  名单把这些行挡在宿主树外，`client-config.list` 在渲染端启动时下发
  （行变更重启生效）——用户只认识一个文件、一套按包名寻址的语义。
  需要即时生效的简单配置（点位绑定之类）不走行，走 settings.json 的
  `settings.get/set` + `settings/changed` 帧（见设置行）。
- LayerAdmin 串行化所有变更；watch 层文件与池目录（150ms 去抖）。
- 包是管理单元：`plugins.list` 给每行带 `packageName` 与 `kind`
  （`snapRail.kind`，经池清单或 appRoot 解析），插件管理页把同一包的
  多行（如套件的渲染行与 `./stats` 宿主行）归为一张组卡、一个总开关
  一并启停；单行包保持平铺。**套件单活**：启用 kind=suite 的包时，
  `plugins.set-enabled` 在同一次 `setUserRows` 批量写里停用其他套件包
  的全部行。退役行名（包合并遗留）在 `loadUserLayer` 内存态改名到后
  继行、彻底退役的行直接丢弃，老文件升级不炸组合，下次写回自然收敛。
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
   `field.modbus` 这类子空间由驱动认领（field 域先被 field-rpc 认领，
   驱动桥在其后挂载）。命名规则：方法 `域.资源.动词`（全 kebab-case，
   2-4 段），帧 `域/事件`（kebab 段），帧域与方法域共用词汇。
2. **方法注册**：`ctx.rpc.method(ctx, 'demo.add', { request: zod,
   response?: zod }, handler)`——请求 schema **必须**（信任边界用它
   校验）；可选 response schema 出站自检；返回 disposer、注册随插件
   卸载自动撤销（caller effect 所有权）。
3. **帧注册**：`ctx.rpc.frame(ctx, 'demo/tick', { payload: zod })`——
   帧域须已被认领（任意认领者：域的帧是该域缝与提供者的协作面）；
   跨插件同名帧 fail-loud。schema 服务 `rpc.describe` 与客户端解析；
   `broadcast` 热路径不重复校验（宿主输出可信）。
4. **事件桥接**：`ctx.rpc.bridgeEvent(ctx, 'point/added',
   'field/point-added', point => ({ point }))`——宿主 cordis 事件转发
   为帧的标准姿势，别再手写。
5. **能力发现**：`rpc.describe` 列出活的域认领（含认领者）、方法
   （含 JSON Schema）、帧——设置页/Agent/未来插件安装器的内省面。
6. **类型可见性 = 消费方 import 提供方 contract**：合并行只进入
   import 了该 contract 的程序（modbus 设置页 → 同包的
   `./contract`，渲染住户 → `@snap-rail/station-rpc/contract`，
   点表消费 → `@snap-rail/field`）。
   "谁能调什么域"显式落在 package.json。

### 高频点值与帧消费

- `field.points.subscribe` 按 (device, group, name) 三元组登记，引用
  计数——同一地址多个消费者各自持有一份引用，任一退订只减计数，
  最后一个退订者才停帧。`field/point-updated` 仅对计数 > 0 的地址
  广播；结构帧（增删/状态/映射变化）永远全播。渲染端整页刷新跳过
  退订会漏计数，只浪费广播不丢帧，v1 单窗口可接受。
- 渲染端消费帧一律 `subscribeFrame(link, method, schema, listener)`
  （connection 包）：载荷一次 zod 解析、坏帧丢弃并记录，禁止手写
  `payload as {...}` 判形。`settings/changed` 帧跟随每次 settings.json
  写入（含会话工号）；消费方按 key 过滤、zod 校验后热应用。
- 下行端口重开是替换语义：carrier 对已存在端口的 `open-stream` 关旧
  建新回包；preload 扇出对单个抛错的 listener 隔离 try/catch。

## field 语义（设备连接底座）

field 是设备连接底座：**底座拥有配置表与统一 UI，驱动是纯协议适配器**。
三层切分——`data/field.db`（设备/组/点 + 方言 config blob）、点表运行面
（points/connections）、驱动注册面（`registerDriver`：schema +
连接工厂）。底座编排“什么时候变”（reconcile：配置表 × 已注册驱动 → 连接
集合，任何变更或驱动装卸都重算），驱动决策“怎么变”
（`update(config, points)` 内部自决热调或重连；`dispose` 拆除）。

- 点位寻址统一为三元组 `(device, group, name)`：缝定义、rpc 方法
  （`field.points.read/write/subscribe/unsubscribe`）与帧载荷都只讲
  三元组，没有不透明 id 过线。`pointKey`（`设备/分组/名字`）只是
  宿主侧 Map 键与审计主体的内部组合串（组名与点位名拒含 `/`）。
- **点位的类型来自分组**（同组同类型是底座结构约束）；驱动 point schema
  校验合并对象 `{type, ...config}`（底座注入 type，存储剥离之）。
- 设备 id 从名称铸造（重名加 `-2` 后缀）；改名不改 id（绑定不漂移），
  改名重建连接（descriptor 不可变）。删除级联：设备→组→点。
- 值为 `null` 即点位异常；连接级故障看连接状态（`connecting/online/
  offline` + 消息），没有质量码。
- 总线语义四类型：`bool` / `int`（BigInt 承载 int64）/ `float`（double）/
  `string`。协议方言（Modbus 功能码/地址/编码/字序）住在驱动自己的
  `./contract`，经 zod `.meta({title})` 携带表单标题；JSON Schema 投影
  （`z.toJSONSchema`，input 形态）随 `field.drivers.list` 下发，底座
  SchemaForm（client-ui）渲染——驱动零渲染端代码。
- 配置面 RPC：`field.config.list`（整棵配置树）、
  `field.devices|groups|points.upsert/remove`；任何变更广播
  `field/structure-changed`，且映射文档随之重投影。
- **通用映射面**：`field.mappings.list` 读底座表投影（设备[{id, driver}]/
  组[{deviceId, name, type}]/点[{deviceId, group, name}]，仅含驱动在线
  的设备）——绑定解析（client-variables）只消费这一个面，对具体驱动
  零知识，多驱动映射自动成立。
- 写入路由到拥有连接的驱动，按声明类型做 typeof 校验；驱动侧写路径
  await 化——`field.points.write` 在驱动 I/O 完成后才 resolve，审计
  记录的是真实结果。

## 业务点位与分组

- 点位身份是三元组 `(device, group, var)`：名字只在组内唯一，字段缝
  以同一三元组寻址（见 field 语义节）。点位名即页面展示的业务名，无独立标题列。
- 分组是显式实体（表 `driver_modbus__groups`，文档字段 `groups`），
  组身份是 `(device, group)`，创建先于点位：没有默认分组，先对设备
  建组、再在组内加点。组携带唯一数据类型，`field.modbus.points.upsert`
  在信任边界校验组存在且类型一致（not-found/conflict）——同组同类型
  是结构约束不是约定。删组级联删组内点位，删设备级联删组与点位。
- 字序（abcd/cdab）是设备级链路属性（设备表 `byte_order`，默认
  abcd），点位不再携带；改字序按设备 shape 变化热重建该设备连接。
- 需求组件的声明即三段地址：`ctx.variables.register(ctx, [{device,
  group, name, type}])`（`client-variables` 登记缝，唯一键 = 三元组）；
  消费必须同样三段——`usePoint(ctx, {device, group, name})`、
  `useBinding(ctx, {device, group, name})` 或组聚合 `useBinding(ctx,
  {device, group})`。裸名与"仅设备+点位"形态已移除（名字组内唯一，
  裸名无法寻址）；设置页新增点位对话框以本组已声明未映射的名字作
  候选。
- 绑定解析以 `field.mappings.list` 的通用映射文档为准（设备存在 →
  组实体存在 → 点位在该组内）；`field/mappings-changed` 帧触发重拉
  重解析——改映射即时生效，无需重挂页面。组聚合 v1 仅"任一激活"：
  bool 真 / 数值非 0 / 非空字符串即激活，`null` 分量列入通讯异常、
  未观测（`time` 0）列入 pending；成员顺序是驱动投影定义的文档序
  （modbus 按功能码/地址/名字排序），首个激活可作主故障展示。
- 组是点位身份的一部分：移动点位 = 删除重建，触发该设备重建。设置页
  按"设备 tab + 分组折叠面板"组织，连接健康以呼吸灯呈现：设备灯随
  连接在线/离线（绿/红），组灯按成员取值健康度（全好绿 / 部分失败
  黄 / 全失败红），不展示业务激活态。
- 遗留数据：分组实体化与三元组主键之前落库的行不再读取（dev 期数据，
  重建配置即可）。

## 开发配方（Agent/人共用 checklist）

四张配方覆盖全部扩展点。共同纪律：**schema 跟着 owner 走**（contract
模块是方法/帧行与 zod 的唯一家）、**注册即 effect**（caller 首参、
返回 disposer）、**跨包 import 用包名**、改动配 vitest 直测装配链路。

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

1. 驱动 = 纯协议适配器：`ctx.field.registerDriver(ctx, { id, title,
   schemas, createConnection })`。schemas 是 device/point 两个
   zod object（point 校验 `{type, ...config}`；`.meta({title})` 给统一
   表单中文标签）；mock 是最小范本。
2. `createConnection(device, points, handle)` 返回
   `{ update(config, points), dispose() }`——底座决定何时调（配置/点表/
   驱动装卸），驱动决定怎么落地（热调 vs 重连）。handle 上报
   `status(state, message?)` / `sample(ref, value)` / `onWrite(cb)`；
   点表注册是底座的事，驱动永不 setPoints。
3. 设备/组/点 CRUD 全部走底座（`field.devices.*` 等），驱动**没有**
   自己的存储、RPC 子命名空间和渲染端页面。写路径 await 到 I/O 完成。

### 四、新增一个页面插件（渲染端住户）

1. 包名入 `apps/desktop/src-host/main/renderer-packages.ts`（单源，
   客户端装配断言配对）。
2. 页面只组合 `@snap-rail/client-ui` 原语；`useRefresh(ctx, events)`
   做事件驱动重渲染；错误文案 `rpcErrorText`；时间 `formatClock`/
   `formatDuration`；色值用 theme 令牌（`text-warning`…）。
3. 流程页经 `ctx.workflows.register` 声明 `requires` 门控；设置页经
   `ctx.settingsPages.register`；需求变量经 `ctx.variables.register`，
   消费走 `usePoint`/`useBinding`。
4. 调 station 域方法（audit/settings/session）的住户 import
   `@snap-rail/station-rpc/contract`；调 plugins 域的 import
   `@snap-rail/app-boot/contract`。

### 五、打包发布一个可安装插件

1. 包内两份面：宿主面是 node ESM（脊柱裸导入 external，驱动内部
   第三方库打进 bundle）；渲染面用 plugin-kit 的 `clientBundle`
   （CJS 浏览器包——焊 `__ModuleLoader__` 工厂壳、种子 external、
   位图/SVG 以 `snap-plugin://pool/<目录>/…` URL 发射到包旁）。
   package.json 声明 `snapRail`：`kind`（suite/driver/plugin）、
   `client: { entry }`（渲染面包路径）、`permissions`（安装时展示）。
2. `pnpm run build && pnpm run pack:plugins` 产出
   `dist-plugins/<包名>.zip`——**最终格式**：精简 manifest（`main` 指
   宿主面）+ 构建好的宿主面目录（多入口的共享 chunk 一并随包；
   声明/sourcemap 永不入包）+ `lib-client/`（渲染面与资产），无源码。
   装配规则单源在 `@snap-rail/plugin-kit/pack`；多入口包（套件）的
   zip manifest 由打包脚本把 `main` 改写为宿主面（池内包单宿主
   入口），同一行名既驱动宿主挂载又作为 `client-config.list` 的渲染行。
3. 安装链：设置页「安装插件」→ `window.pick-zip`（原生对话框）→
   `plugins.inspect`（不落盘预检：包名/版本/类型/权限）→ 确认弹框 →
   `plugins.install`（fflate 解压进 `<home>/plugins/<包名>`，manifest
   校验 fail-loud）→ 池扫描热挂载。
4. 运行期解析：宿主侧 `module.registerHooks` 把**池内文件**的
   `zod`/`drizzle-orm`/`@snap-rail/*`（含子路径）裸导入锚到应用根
   （共享同一批实例——cordis 分裂 fiber、zod 分裂 schema 身份、
   drizzle table 跨 store 缝；对应包必须在 desktop `dependencies`
   里才会随包发布）；其余第三方库打进宿主面 bundle，不入锚定名单。
   渲染端面经 `snap-plugin://pool/…` 特权协议以 classic script 到达
   （生产 CSP 的 script-src/img-src 含 `snap-plugin:`），
   `__ModuleLoader__` + 种子表还原单实例。
5. 渲染面依赖纪律：client bundle 运行时 require 的 id ⊆
   `SEED_MODULES`（脊柱 contract 面、纯工具面、timer 原语可入表，
   宿主入口永不入表；套件有 vitest 门禁扫描页面导入）。卸载：
   `plugins.uninstall` = 删池目录 + 删 `data/<ns>.db`（分域数据随包
   走）。套件启停与切换见「两层组合」节的单活语义。

## 安装与渲染端装载（Phase C 机制总览）

- **snap-plugin:// 特权协议**（desktop 主进程）：`registerSchemesAsPrivileged`
  （standard/fetch/stream）+ `protocol.handle` 映射 `snap-plugin://pool/<…>`
  → `<home>/plugins/<…>`；越出池根的路径 403。dev（http 页面）与
  prod（file 页面）同一条路径——插件作者不遇 dev/prod 分裂。签名/缓存/
  权限执行的座位都在这一层。
- **宿主解析钩子**（`app-boot/resolve-hooks`）：仅当导入方文件位于池内
  时，把 `@snap-rail/*`/`zod`/`drizzle-orm`（含子路径）的裸导入重锚到
  appRoot——池插件与宿主共享 cordis/zod/drizzle 单实例；app 树与测试
  进程不受影响。锚定名单只收"对象跨缝传递"的共享词汇，驱动内部协议库
  打进宿主面 bundle，不入名单。
- **渲染端模块系统**（`client/modules` + desktop 客户端入口）：
  `installModuleLoader` 装 queue→live 门面，客户端入口 `create()` 后按
  `SEED_MODULES` 播种共享实例（表驱动 + boot 期 parity fail-loud——
  播种表与白名单漂移立刻抛错），再对 `client-config.list` 下发的
  `clientUrl` 逐个 `loadPluginBundle`，`system.require(name)` 取回插件
  对象交 runtime 挂载（失败仅记日志，不拖垮页面）。
- **装载纪律**（三条硬边界）：渲染面永不 import 双面包的宿主入口
  （跨端类型/schema 走该包 `./contract` 纯面，node 侧实现不进
  浏览器图）；渲染面运行时 require 的 id ⊆ `SEED_MODULES`
  （种子表 = 客户端入口播种 = `clientBundle` external，三处单源；
  加 id 是脊柱决策）；池内包单宿主入口（zip manifest 的 `main`）。
- **管理页**（settings-station）：三分区（套件 radio 卡/驱动多活/核心与
  其他）+ 安装流 + 待重启徽标 + 套件切换弹框（立即重启=
  `window.relaunch` → `app.relaunch`）。

## 打包决策

- asar 关闭：插件经 `file://`/`snap-plugin://` URL 动态 import、内置层
  文件需可 watch。防篡改需求出现时再评估自定义协议方案。
- 宿主面插件包声明在 `dependencies`（打包器只收生产依赖）；
  renderer 住户构建期打进 `dist/client`，保持 dev 依赖。
- 发行插件 zip 由 `pnpm run pack:plugins` 产出（`dist-plugins/`），
  **最终格式 = 精简 manifest + 构建产物，无源码**；插件市场=同格式
  zip 的下载源（留座位）。锚定名单里的共享词汇包（drizzle-orm）
  同样必须在 `dependencies` 里。
- 更新通道：electron-updater 座位已接线（无 publish 配置时静默），
  blockmap 随安装包产出。

## 一期不做、留座位的

权限执行层（manifest 已声明+安装展示，未拦截）、i18n、遥测、
npm 分发源/插件市场 UI、web/头部双入口 profile、as 化部署、
套件热激活（当前重启生效）、套件内条目级裁剪。
