# snap-rail 插件平台执行计划

这份计划是当前插件平台的目标合同。项目尚未正式发布，迁移采用直接切换，
不保留旧 manifest、旧槽位或旧安装协议的兼容桥。

## 已落地的基线

1. Electron Shell、Node Host、Renderer 的边界已经明确。当前 Host 与 Shell
   同进程运行，`apps/desktop/src-host/main/host.ts` 是生命周期入口，未来可
   移入 utility process；Renderer 只通过 HostLink 消费契约。
2. manifest 增加版本化 `capabilities.provides/requires` 和 `engines`。
   安装、启用、禁用、卸载会检查能力提供者与反向依赖，安装器拒绝不兼容
   的 Host/Renderer 版本。
3. UI 框架提供语义契约和统一槽位命名：`shell.titlebar`、
   `shell.titlebar.actions`、`shell.menu`、`shell.sidebar`、`shell.main`、
   `shell.view`、`shell.statusbar`、`shell.overlay`、`shell.layout`。
   `uiContract` 注册 view、layout、navigation，布局和组件不再互相 import。
4. 发布物拥有 Ed25519 签名 envelope。`META-INF/release.json` 签署规范化
   manifest 和所有 payload 摘要，`META-INF/signature.json` 携带 key id。
   Host 从 `<home>/trusted-release-keys.json` 读取信任根，签名缺失、未知
   key、publisher 不匹配、摘要不匹配、路径穿越或身份不匹配都会拒绝安装；
   feed 的每条目录记录还必须带 zip 的 sha256、size 和签名 key id。
5. `@snap-rail/plugin-sdk` 与 `snap-rail-plugin` CLI 可在独立仓库运行：
   `init` 生成 package、manifest、tsconfig、tsdown 配置和 `AGENTS.md`；
   `doctor` 检查独立仓库合同，`pack` 生成发行 zip；`inspect`、`verify`
   提供发布前检查。Agent 只需
   阅读插件仓库的 `AGENTS.md` 与 SDK 类型声明，不需要扫描主仓库。
6. 发布链路要求签名参数，Gitea 负责源码/tag/PR，Nginx 只托管静态 feed。
   feed 的 zip 条目带 sha256、size、签名 key id 和能力元数据；recipe 安装
   只有在所有插件成功安装后才原子写入预设。
7. `plugins.diagnostics` 提供 Host/Renderer 协议版本、启用包、缺失依赖、
   已识别签名 key id 和最近一次层刷新失败；`LayerAdmin` 在 compose/refresh
   失败时保留这条诊断，成功应用后清除。

## 已落地后的收口工作

### A. Host 边界收紧

- 将 `app-boot`、plugin manager、RPC、store、equipment、logger 归入 Host
  public API；Electron 主进程只调用 `startDesktopHost`、carrier 和窗口服务。
- `StartupPage` 已读取 `plugins.diagnostics`；没有框架时也能在 kernel recovery
  页面展示最近一次层失败或缺失依赖。
- 保留插件同进程执行作为默认；需要不可信第三方插件时，再增加 utility
  process provider，协议面保持不变。

### B. Contract-first 插件 SDK

- 每个能力必须有 Definition、Provider、Consumer 三件套；契约放在
  `./contract`，实现放在独立插件，组件通过 Cordis service/RPC/frame 协作。
- SDK 已提供每类插件的最小模板：driver、store-provider、ui-view、
  ui-layout、tool、suite，并提供可运行的 `doctor`/`pack` 示例。
- 在 Gitea 模板仓中固定 `AGENTS.md`、变更日志、manifest 示例、权限说明、
  能力版本策略和签名发布工作流。

### C. UI 生态

- 把设置页、流程页、菜单、状态栏、弹窗全部投影为 semantic contribution，
  组件只声明 `slot`、`viewId`、`navigation` 和 order。
- 每个布局发布自己的 slot manifest；框架启动时校验布局声明的 slot 是否
  是标准槽位或 `custom:<publisher>.<name>`，未知槽位只产生诊断数据。
- 为第二套 UI 框架复刻同一 semantic contract，框架包只替换 renderer
  provider，不修改设备、store 或业务组件契约。

### D. 安装、市场和供应链

- 安装动作已经拆成 inspect → trust/sha256 → staging → atomic swap →
  compose → audit；单包更新和 recipe 多包安装失败都会保留旧版本并回滚，
  recipe 的 preset 写入和最终 compose 也在同一个事务内。
- 为信任根增加密钥轮换：同一 publisher 可并列多个 key，feed 提供 key id，
  删除旧 key 前先完成所有终端升级；私钥永不进入 Gitea 或 Nginx。
- 本地验证顺序：生成 key → 配置 trust file → Gitea 建插件仓 → 生成签名
  feed → Nginx 托管 → 客户端安装 zip → feed 安装 → recipe → 错误签名/哈希
  → 版本更新/回滚 → feed 离线恢复。

### E. 质量门禁

- `pnpm run build`、`pnpm run typecheck`、`pnpm test`、层依赖门禁、wire
  catalog 检查都必须在发布 CI 通过。
- 新能力必须附带 contract schema、一个 Provider、一个 Consumer、一个
  可运行例子和失败诊断；禁止只提交“约定文档”而没有机器可检验的 schema。
- plugin SDK 的独立仓库 CI 必须能在没有 snap-rail 主仓 checkout 的环境中
  完成 install、typecheck、build、pack、inspect、verify。
