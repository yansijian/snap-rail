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
| 启动/组合 | `boot/app-boot` | 两层合成、boot()、LayerAdmin 热重载、`./rpc` 管理桥 |
| RPC 协议 | `protocol/protocol` | 四象限消息、RpcMethodMap、zod 两级校验、AbstractApiClient |
| RPC 宿主侧 | `protocol/gateway` | `ctx.gateway`：方法注册、边界校验、帧泵 |
| RPC 客户端侧 | `protocol/connection` | HostLink：两原语之上的类型化客户端 |
| 点表/连接 | `field/field` | `ctx.points` / `ctx.connections`；`./rpc` 线桥 |
| 模拟驱动 | `field/driver-mock` | 首方 Provider：四类型点流、离线模拟、写回显 |
| 槽位词表 | `client/slots` | `ctx.uiSlots`：well-known slot ids + 缺槽降级 |
| UI 原语 | `client/ui` | 主题令牌（theme.css，Tailwind v4）+ shadcn 风格共享组件（Button/Card/Badge/Switch/Tooltip/ScrollArea），所有 UI 插件与社区插件的公共底座 |
| 渲染宿主 | `client/runtime` | 接管 React root、槽位驱动 Shell、引入唯一主题 |
| 引导 | `client/kernel` | 启动页、carrier 握手、root 移交 |
| 布局/住户 | `client/layout-default` 等 | 全部是插件；布局也由插件提供 |
| 设置 | `settings/settings` | 原子 JSON 持久化 |
| 审计 | `audit/audit` | 追加式 JSONL：启停/配置/控制写全记录 |
| 工具 | `util/util` | Branded、assertNever |

## 两层组合与热重载

- 内置层（`resources/builtins.cordis.yml`，随应用只读）+ 用户层
  （userData `plugins.yml`，**按包名**寻址：`enabled`/`config`）→
  `composeEntries` 重算 → 原子写派生物 `.composed.cordis.yml` →
  include `refresh()` 事务性对账（逐条 create/update/remove，失败回滚）。
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
- 高频点值走订阅制帧流：`points.subscribe` 登记服务端集合，
  `point/updated` 仅对已订阅 id 广播；结构帧（增删/状态）永远全播。
- BigInt 经结构化克隆无损过线。

## field 语义

- 值为 `null` 即点位异常；连接级故障看连接状态。没有质量码。
- 总线语义四类型：`bool` / `int`（BigInt 承载 int64）/ `float`（double）/
  `string`。协议方言（Modbus 字数、OPC UA nodeId、MQTT topic）属于
  各驱动自己的点表配置 schema，不进定义层。
- 写入路由到拥有连接的驱动，按声明类型做 typeof 校验。

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
