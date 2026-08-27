# snap-rail

工业终端的开源底座：把 OT 现场数据与 IT 工具链装进一个"一切皆插件"的
Electron 宿主。基于 vendored Cordis 元框架；一期交付核心 + 插件机制。

不复现组态画布与传统 HMI——底座提供进程模型、数据缝与最小 UI 骨架，
界面创新留给社区与 Agent（见 [docs/architecture.md](docs/architecture.md)）。

## 一分钟看懂

- **主进程**跑 Cordis 宿主树：内置层清单（只读）+ 用户层
  userData `plugins.yml`（可被页面按钮、手编、Agent 编辑——文件即接口）
  合成出实际挂载的插件集，watch 热重载、坏配置保持旧树并报错。
- **点表缝** `ctx.points`：连接注册点位、推送样本（`null`=异常）、
  路由写入；mock 驱动模拟 float/BigInt/bool/ISO 时间戳点流与离线。
- **renderer** 是投影客户端：preload 只暴露 `invoke`/`openStream` 两原语，
  四象限 RPC 协议在此之上类型化；布局/标题栏/看板/管理页全部是插件。
- **看板**实时跳动、插件管理页禁用/启用即时生效、模拟离线值变 null。

## 布局

```
vendor/      vendored Cordis（rescope @snap-rail/*，见 vendor/README.md）
packages/    能力组 packages/<组>/<包>：
  boot/        app-boot（扫描/两层合成/boot/层管理热重载）
  protocol/    protocol / gateway / connection（RPC 缝）
  field/       field（点表缝）+ driver-mock（首方驱动）
  client/      kernel / slots / runtime（脊柱）+ 布局/标题栏/看板/管理页（住户）
  audit/ settings/ util/
apps/desktop  Electron 应用（无框窗口、IPC 载体、打包配置）
docs/         architecture.md（缝目录与决策）
```

## 命令

```sh
pnpm install
pnpm run build        # tsc -b (lib/types) + tsdown (lib)
pnpm run typecheck
pnpm test             # vitest 全量（先构建）
pnpm app:dev          # Vite dev server + Electron，热重载开发
pnpm app:pack         # win-unpacked 目录形态（release-out/）
pnpm app:dist         # NSIS 安装包 + blockmap
```

License: Apache-2.0（vendored Cordis 包保留上游 MIT 许可文件）。
