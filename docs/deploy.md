# 部署：更新源与插件源（nginx 静态托管）

snap-rail 的应用更新与插件更新共用一个静态文件服务器（任意能吐文件
的 HTTP 服务即可，本仓以本地 nginx `D:\nginx\html` 为基准）。服务器上
没有任何逻辑——只有目录、zip、和一个目录清单；所有校验都在终端侧完成。

## 目录布局

```
D:\nginx\html\
└─ snap-rail\
   ├─ desktop\                          ← 应用更新通道（electron-updater，generic provider）
   │  ├─ latest.yml                     ← electron-builder 产出，版本清单
   │  ├─ snap-rail-<版本>-x64-setup.exe
   │  └─ snap-rail-<版本>-x64-setup.exe.blockmap   ← 差量下载用
   └─ plugins\                          ← 插件源（插件市场）
      ├─ index.json                     ← 插件目录清单（pack:plugins 产出）
      ├─ @snap-rail__suite-terminal-ops.zip
      ├─ @snap-rail__driver-mock.zip
      ├─ @snap-rail__driver-modbus.zip
      ├─ @snap-rail__forge.zip
      └─ @snap-rail__trend.zip
```

两个源地址（终端在设置页里填写，存 `settings.json`，改动即时生效）：

| 通道 | settings 键 | 地址示例 |
| --- | --- | --- |
| 应用更新 | `update.feedUrl` | `http://<服务器>/snap-rail/desktop/` |
| 插件市场 | `plugins.feedUrl` | `http://<服务器>/snap-rail/plugins/` |

本机访问即 `http://127.0.0.1/snap-rail/desktop/`（nginx 默认 80 端口）。

## 发布流程

### 应用更新

```sh
pnpm run build && pnpm app:dist
# 产物在 apps/desktop/release-out/，拷贝三件套到更新通道：
cp apps/desktop/release-out/latest.yml \
   apps/desktop/release-out/snap-rail-*-setup.exe \
   apps/desktop/release-out/snap-rail-*-setup.exe.blockmap \
   D:/nginx/html/snap-rail/desktop/
```

注意：`electron-builder.yml` 的 `publish.url` 是打包进终端的内置缺省
源；部署现场随时可用 `update.feedUrl` 覆盖，无需重打包。

### 插件包

```sh
pnpm run build
# 直接打进插件源目录（同时产出 index.json）：
pnpm run pack:plugins -- --out "D:/nginx/html/snap-rail/plugins"
# 不带 --out 时默认落在仓库 dist-plugins/，再自行拷贝
```

`index.json` 由插件 zip 内的发行 manifest 回读生成（name / version /
description / kind / file），市场页展示什么、终端就装到什么，永不漂移。

## 终端侧行为

- **应用更新**：打包态启动自动检查（`update.autoCheck` 可关）→ 发现新
  版本后台自动下载 → 「软件更新」页提示重启安装，安装永远由用户确认。
- **插件市场**：设置 →「插件市场」→ 填插件源地址 → 保存后列出目录，
  每行带本地判定（可安装 / 可更新 / 已是最新 / 本地更新）；安装走与
  本地 zip 完全相同的管线（manifest 校验 → 仅严格更高版本可覆盖更新 →
  热重组合 → 审计 `plugin.update`/`plugin.install`，detail 带 `via:"market"`）。
- **安全边界**：终端只从「已配置源 + 目录清单里的相对文件名」下载，
  wire 上永远不出现客户端自选的下载地址；目录清单的 `file` 字段强制
  纯文件名（无路径、无遍历）。

## nginx 参考配置

默认静态托管即可，无需任何特殊配置；若要禁止目录列举：

```nginx
location /snap-rail/ {
    autoindex off;   # 默认即 off；只允许按确切文件名取
}
```
