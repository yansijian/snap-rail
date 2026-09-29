# 部署：插件源与更新源（Gitea / 静态托管）

snap-rail 的线上存在是**纯静态**——插件源（含组合）与应用更新源就是一组
普通文件，服务器零逻辑，所有校验都在终端侧完成。基准部署是**内网 Gitea**：
发布产物由 publish 提交到客户端仓的专用 feed 分支（Gitea raw 按字节直出），
安装包另挂 Gitea Release 供人工下载；官网仍走任意静态文件服务器（nginx 等，
不在 Gitea 测试范围）。未来迁云（阿里云 OSS+CDN 等）只换发布目标与两个
feed 地址，客户端零改动（两个 feed 地址是设置键，热切换）。

## Gitea 部署（推荐路径）

### 一次性准备

1. Gitea 建组织 `snap-rail` 与客户端仓 `snap-rail`（本仓推上去）；
2. 建一个对该仓有写权限的 token（Gitea → 设置 → 应用 → 生成新令牌），
   通过环境变量 `GITEA_TOKEN`（或配置的 `gitea.token`）提供给发布机；
3. 复制 `deploy.config.example.json` 为 `deploy.config.json`，按现场填
   `gitea` 块（url / owner / repo / feedBranch，缺省分支 `feed`）；
   `sshTarget` 块仅在仍要同步 nginx 官网时保留（`gitea` 块存在时优先）。

### 发布

```sh
pnpm run plugin:generate-key -- .keys gitea-main-2026 --publisher snap-rail   # 一次性
pnpm run publish -- --sign-key .keys/gitea-main-2026.private.pem --key-id gitea-main-2026 --publisher snap-rail
```

publish 依次：构建 → 打包插件 zip（Ed25519 签名 + index.json）→ 装配组合
与目录 → 把 `plugins/` 与 `desktop/` 整树提交到 feed 分支（孤儿分支自动
播种，整树替换）→ 建 Release 并上传安装包三件套。产物地址：

| 通道 | 地址（feedBranch=feed） |
| --- | --- |
| 应用更新 `update.feedUrl` | `http://<gitea>/snap-rail/snap-rail/raw/branch/feed/desktop/` |
| 插件市场 `plugins.feedUrl` | `http://<gitea>/snap-rail/snap-rail/raw/branch/feed/plugins/` |
| 人工下载 | `http://<gitea>/snap-rail/snap-rail/releases/tag/v<版本>` |

`--release-tag` 可覆盖默认 tag（`v<desktop 版本>`）；`--skip-sync` 只在
本地 `dist-publish/` 装配（gitea 目标下不构建官网）。

### 验证（发布后、指终端前）

```sh
pnpm exec tsx scripts/check-feed-endpoint.ts \
  --update http://<gitea>/snap-rail/snap-rail/raw/branch/feed/desktop/ \
  --plugins http://<gitea>/snap-rail/snap-rail/raw/branch/feed/plugins/
```

脚本核对四件事：feed 文件字节一致（zip 的 sha256/size 对清单）、
latest.yml 是 electron-builder 清单而非错误页伪装 200、安装包支持 Range
（决定 blockmap 差量下载可用性）、以及该 Gitea 实际服务的 raw URL 形状
（`/raw/branch/<ref>/` 与 `/raw/<ref>/` 两者谁生效）。通过后再把终端的
两个设置键指过来，各走一次「检查更新 → 后台下载 → 确认重启」与「市场
安装一个插件」，即完成 Phase 0 验收。

## 目录布局（nginx 兼容变体；Gitea 目标只提交其中 plugins/ 与 desktop/ 到 feed 分支）

```
<web 根>\                          ← 官网（website/ 构建产物）
│  index.html  plugins.html  recipes.html  assets\
└─ snap-rail\
   ├─ desktop\                     ← 应用更新通道（electron-updater，generic provider）
   │  ├─ latest.yml                ← electron-builder 产出，版本清单
   │  ├─ snap-rail-<版本>-x64-setup.exe
   │  └─ snap-rail-<版本>-x64-setup.exe.blockmap   ← 差量下载用
   └─ plugins\                     ← 插件源（插件市场 + 组合）
      ├─ index.json                ← 插件目录清单（含 title/category/requires/framework/sha256/size）
      ├─ recipes.json              ← 组合目录清单（基座/场景）
      ├─ catalog.json              ← 官网目录页数据（feed 事实 + readme/作者/仓库）
      ├─ standard-base.yml         ← 组合文档（与 plugins.yml 同形状）
      ├─ production-board.yml
      ├─ @snap-rail__*.zip         ← 插件包（zip 内的发行 manifest 是唯一事实）
      └─ assets\recipes\<id>\      ← 组合截图（官网按同源绝对路径引用）
```

三个地址（终端在设置页里填写，存 `settings.json`，改动即时生效）：

| 通道 | settings 键 | 地址（基准部署） |
| --- | --- | --- |
| 应用更新 | `update.feedUrl` | `http://192.168.1.10/snap-rail/desktop/` |
| 插件市场 | `plugins.feedUrl` | `http://192.168.1.10/snap-rail/plugins/` |
| 官网 | （浏览器直接访问） | `http://192.168.1.10/` |

## 发布：一条命令

```sh
# 一次性：复制 deploy.config.example.json 为 deploy.config.json，按现场填写
#   sshTarget: "root@192.168.1.10"
#   remote: { site, plugins, desktop } 三个远端绝对路径
pnpm run publish -- --sign-key .keys/gitea-main-2026.private.pem --key-id gitea-main-2026 --publisher snap-rail
```

`pnpm run publish` 依次完成：

1. `pnpm run build`（构建全部库与客户端面）；
2. `pnpm run pack:plugins`（由 publish 传入 Ed25519 私钥）——10 个一方包各出一个 zip + `index.json`
   （条目从 zip 内发行 manifest 回读：feed 永不广告 zip 没有的东西；
   同时写入 sha256 与字节数，供终端下载后校验完整性）；
3. 装配组合：`recipes/<id>/recipe.yml`（version/title/kind/description +
   plugins 行）→ feed 里的 `<id>.yml`（仅 strict 的 plugins 块）与
   `recipes.json`；readme 与 `assets/` 截图并入 `catalog.json`；
4. 装配 `catalog.json`（官网数据：feed 事实 + 仓库源里的 author/repository/
   license/readme）——支持 `--market <dir>` 合并 snap-rail-market 仓的
   pack 产物（社区插件同场上架）；
5. 生成官网目录数据模块（`scripts/gen-website-catalog.ts`）并
   `pnpm run website:build`；
6. 同步到服务器：官网解压覆盖到 web 根；`plugins/` 与 `desktop/` 先清空
   再整树同步（rsync 可用则 rsync，否则 tar-over-ssh）。

变体：`pnpm run publish -- --skip-sync` 只在本地 `dist-publish/` 装配不
上传（检查产物用）；`--market <dir>` 合并社区仓 feed。

### 应用更新（不跑 publish 时）

```sh
pnpm run build && pnpm app:dist
# 产物在 apps/desktop/release-out/；publish 会自动把三件套并入 staging，
# 手工发布则直接拷贝 latest.yml + setup.exe + blockmap 到 desktop 目录。
```

注意：`electron-builder.yml` 的 `publish.url`（现为内网基准源）是打包进
终端的内置缺省源；部署现场随时可用 `update.feedUrl` 覆盖，无需重打包。

## 组合（recipes）

组合 = 「哪几个插件放在一起、实现什么效果」的可分发答案：

- **源**：主仓 `recipes/<id>/`（一方首发：`standard-base` 标准基座、
  `production-board` 产线看板）；社区组合住在 snap-rail-market 仓，发布
  时合流进同一 feed。
- **文档形状**：`recipe.yml` 的 `plugins` 块与 `plugins.yml` 完全同形
  （客户端 strict 校验）；`kind: base`（基座组合，公共前缀/靶台）或
  `scenario`（场景组合，承载演示效果）。
- **落地**：终端「插件市场 → 组合」区一键安装——缺失插件先逐个从源下载
  走标准安装管线，全部成功后写 `<home>/presets/recipe-<id>.yml`（预设层
  热生效，卸载保护自动覆盖）；「移除」只删预设文件，池包保留。
- **演示数据**：场景组合不带设备数据——设备/组/点由用户照组合 readme 的
  指引在设备管理页手动创建（如 production-board 的三步演示）。

## 终端侧行为

- **应用更新**：打包态启动自动检查（`update.autoCheck` 可关）→ 发现新
  版本后台自动下载 → 「软件更新」页提示重启安装，安装永远由用户确认。
- **插件市场**：设置 →「插件市场」→ 填插件源地址 → 保存后列出目录
  （按作者分类标记分组 + 文本过滤），每行带本地判定（可安装 / 可更新 /
  已是最新 / 本地更新）；安装走与本地 zip 完全相同的管线（manifest 校验
  → 仅严格更高版本可覆盖更新 → 热重组合 → 审计 `plugin.update`/
  `plugin.install`，detail 带 `via:"market"`）。
- **完整性校验**：`index.json` 的每个条目都必须带 `sha256` 与字节数，下载
  字节先验哈希再进安装管线，不匹配即拒绝（`bad-checksum`）。
- **安全边界**：终端只从「已配置源 + 目录清单里的相对文件名」下载，
  wire 上永远不出现客户端自选的下载地址；清单的 `file` 字段强制纯文件名
  （无路径、无遍历）。

## 社区发布模型（snap-rail-market）

- 三方插件以**源码**提交到独立市场仓（pnpm workspace，结构同主仓
  packages/），PR review 合入即上架；主仓保持一方出厂纯净。
- 命名门禁：市场仓包名**不得**以 `@snap-rail/` 开头（自有 npm 作用域或
  裸名）；基座兼容以 `requires` / `snapRail.framework` 展示（终端与官网
  据此打「标准基座生态」标），暂无版本硬门禁。
- 构建：市场仓 checkout 与主仓 checkout 同机相邻，`pnpm run publish
  -- --market <市场仓>/dist-plugins` 合流上架；plugin-kit 发 npm 后可
  解除同机约束。

## 内网 → 云迁移清单

1. 云上对象存储 + CDN 建同名目录结构，官网解压到站点根；
2. 换 `deploy.config.json` 的 sshTarget/remote（或改用 ossutil 同步）；
3. 终端侧把两个 feed 设置键改成新域名（或出厂前改 electron-builder.yml
   的 publish.url 重打包）；
4. 官网完全自包含（无外部 CDN 字体/脚本），内网外网表现一致。

## 部署变体与验证清单

- **nginx 文件服务（兼容路径）**：deploy.config.json 删掉 `gitea` 块、
  只留 `sshTarget` + `remote`，即回到 ssh/rsync 同步 nginx 的旧流程
  （官网 + `snap-rail/plugins|desktop/`）；终端地址相应为
  `http://<server>/snap-rail/desktop|plugins/`。
- **贡献仓合流**：独立插件仓的构建产物可经 `--market <仓>/dist-plugins`
  并入同一次发布（拆仓后由 feed 装配的 Release 收集取代，见拆仓阶段）。
- 验证顺序应覆盖：本地 zip 安装、feed 安装、recipe 组合、哈希或签名错误、
  版本更新、回滚、feed 离线启动和 Host 恢复。
