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
| 班产统计 | `production/stats` | 宿主侧计数器：跟随计数绑定的正增量，按三班（8-16/16-24/0-8）落 `ctx.store`，登录时刻锚定班次；`production/stats-changed` 帧广播快照，`./contract` 子路径是渲染端共享的纯契约（合并进 FrameMap） |
| RPC 协议 | `protocol/protocol` | **信封封闭、内容开放**：四象限消息模型、RpcMethodMap/FrameMap 两个开放合并基座（只有平台行 `host.*`/`rpc.*`/`window.*` 留在这里）、zod 信封校验、AbstractApiClient 双 overload（已知方法全类型、未知方法 `(string, unknown)`） |
| RPC 宿主侧 | `protocol/gateway` | `ctx.rpc`：域名认领（`claimDomain` 首认即得、冲突 fail-loud）、`method`（请求 schema 必须随注册）、`frame`（载荷 schema 注册）、`bridgeEvent`（宿主事件→帧的标准桥）、`rpc.describe` 能力发现、帧泵 |
| RPC 客户端侧 | `protocol/connection` | HostLink：两原语之上的类型化客户端；`subscribeFrame(link, method, schema, cb)` 是消费帧的标准姿势（一次 zod 解析，坏帧丢弃并记录）；`rpcErrorText` 统一错误文案 |
| 工业通讯协议域 | `field/field` | `ctx.points`/`ctx.connections`/`ctx.field`：点表运行面 + 驱动注册面（`registerDriver`：身份 + `field.<id>.*` 子命名空间 + 可选通用映射投影）；`field.mappings.list` 跨驱动聚合方言无关的点表映射文档；`./rpc` 桥认领 `field` 域，`./wire` 是方法/帧行与 schema 的家 |
| 模拟驱动 | `field/driver-mock` | 首方 Provider：四类型点流、离线模拟、写回显；经 `ctx.field.registerDriver` 登记身份 |
| ModbusTCP 驱动 | `field/driver-modbus` | `field.modbus.*` 子域（设备/组/映射 CRUD + 连接探测）；方言 schema 与类型住在 `./contract` 子路径，不进 protocol |
| 槽位词表 | `client/slots` | `ctx.uiSlots`：well-known slot ids + 缺槽降级 |
| UI 原语 | `client/ui` | 主题令牌（theme.css，Tailwind v4）+ shadcn 共享组件 + `useRefresh`（ctx 事件→重渲染的标准 tick）；页面组件必须组合此包原语，缺原语按 shadcn 官方实现移植，不在页面手写交互组件 |
| 操作人会话 | `client/session` | `ctx.session`：登录态镜像（宿主持久化，重启保持登录）、`session/changed` 事件；经 `settings/changed` 帧热跟随宿主侧换人 |
| 作业流程 | `client/workflows` | `ctx.workflows`：流程注册、声明式 `requires` 门控（`operator-day`/`day` 两 scope，事件集求值）、侧栏告警、active 页状态 |
| 渲染宿主 | `client/runtime` | 接管 React root、先挂 timer/slots/settings/variables/session/workflows 再挂住户（逐插件 config）、槽位驱动 Shell、引入唯一主题 |
| 变量声明 | `client/variables` | `ctx.variables`：需求方声明业务变量（三元组+类型）；`watchBinding`/`useBinding`/`usePoint` 消费配方经 `field.mappings.list` + `field/mappings-changed` 解析绑定——对具体驱动零知识 |
| 设置页 | `client/settings` | `ctx.settingsPages`：设置对话框的可扩展页注册表 |
| 引导 | `client/kernel` | 启动页、carrier 握手、root 移交 |
| 布局/住户 | `client/layout-station` 等 | 全部是插件：layout-station（登录门控+流程列表+内容区）、chrome-titlebar、settings-station、modbus-station（ModbusTCP 设置页）、process-maintenance/production/sampling/fault/downtime 五个流程页 |
| 设置持久化 | `settings/settings` | 原子 JSON 持久化（`settings.json`）；`settings.get/set` RPC + `settings/changed` 帧让渲染端简单配置即时生效 |
| 审计 | `audit/audit` | 追加式 JSONL：启停/配置/控制写全记录；`list(filter)` 读回（工作站业务事件的真相源）；wire 类型（`AuditEntryInfo`）由它导出，单一来源 |
| 工具 | `util/util` | Branded、assertNever、`formatClock`/`formatDuration`；`./manifest` 是脊柱/住户名单与门禁的单源 |

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
- **班产统计（实际计数）**：计数在宿主侧 `production/stats` 插件运行——
  监听 field 的 `point/updated`、只累计正增量（负增量=计数器复位忽略、
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
   import 了该 contract 的程序（modbus-station →
   `@snap-rail/driver-modbus/contract`，渲染住户 →
   `@snap-rail/station-rpc/contract`，点表消费 → `@snap-rail/field`）。
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

## field 语义（工业通讯协议域）

field 缝就是工业通讯协议域本身：点表运行面（points/connections）+
驱动注册面（`ctx.field.registerDriver`）。每个驱动是该域的 Provider，
不是一个独立域——ModbusTCP 的配置面住在 `field.modbus.*` 子空间，
未来的 OPC UA/MQTT 同构接入（`field.opcua.*`…）。

- 点位寻址统一为三元组 `(device, group, name)`：缝定义、rpc 方法
  （`field.points.read/write/subscribe/unsubscribe`）与帧载荷都只讲
  三元组，没有不透明 id 过线。`pointKey`（`设备/分组/名字`）只是
  宿主侧 Map 键与审计主体的内部组合串（组名与点位名拒含 `/`）。
- 值为 `null` 即点位异常；连接级故障看连接状态。没有质量码。
- 总线语义四类型：`bool` / `int`（BigInt 承载 int64）/ `float`（double）/
  `string`。协议方言（Modbus 功能码/地址/编码/字序）住在各驱动自己的
  `./contract`，绝不进定义层。
- 写入路由到拥有连接的驱动，按声明类型做 typeof 校验；驱动侧写路径
  await 化——`field.points.write` 在驱动 I/O 完成后才 resolve，审计
  记录的是真实结果。
- **通用映射面**：`field.drivers.list` 列已装驱动；`field.mappings.list`
  聚合各驱动投影出的方言无关点表映射文档（设备[{id, driver}]/
  组[{deviceId, name, type?}]/点[{deviceId, group, name}]），任一驱动
  配置变化广播 `field/mappings-changed`——绑定解析（client-variables）
  只消费这一个面，对具体驱动零知识，多驱动映射自动成立。

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

1. `ctx.field.registerDriver(ctx, { id, title, mappings? })` 登记
   身份；有映射表的驱动提供投影 `mappings: () => MappingDocument`
   （方言字段绝不进投影；modbus 的 `projectMapping` 是范本）。
2. 连接照旧走 `ctx.connections.register`；方言 CRUD 注册在
   `field.<id>.*`（`ctx.rpc.claimDomain(ctx, 'field.<id>')`，须在
   field-rpc 之后挂载）；方言 schema/类型住驱动自己的 `./contract`。
3. 设置页住户 import 驱动 `./contract` 获得类型；写路径 await 到
   I/O 完成再返回（审计记录真实结果）。

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

## 打包决策

- asar 关闭：插件经 `file://` URL 动态 import、内置层文件需可 watch。
  防篡改需求出现时再评估自定义协议方案。
- 宿主面插件包声明在 `dependencies`（打包器只收生产依赖）；
  renderer 住户构建期打进 `dist/client`，保持 dev 依赖。
- 更新通道：electron-updater 座位已接线（无 publish 配置时静默），
  blockmap 随安装包产出。

## 一期不做、留座位的

权限执行层、i18n、遥测、外部插件包规范（npm 分发的插件格式）、
web/头部双入口 profile、as 化部署。清单的 `permissions` 字段已预留。
