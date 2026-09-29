# snap-rail

工业终端的开源底座：把 OT 现场数据与 IT 工具链装进一个"一切皆插件"的
Electron 宿主。基于 vendored Cordis 元框架；一期交付核心 + 插件机制。

不复现组态画布与传统 HMI——底座提供进程模型、数据缝与最小 UI 骨架，
界面创新留给社区与 Agent（见 [docs/architecture.md](docs/architecture.md)）。
完整插件平台实施顺序见 [docs/plugin-platform-plan.md](docs/plugin-platform-plan.md)。

## 一分钟看懂

- **主进程**跑 Cordis 宿主树：内置层清单（只读，**随包只带 base**）+
  用户层 userData `plugins.yml`（可被页面按钮、手编、Agent 编辑——文件即
  接口）合成出实际挂载的插件集，watch 热重载、坏配置保持旧树并报错。
- **其余一切 zip 安装**：store 后端、设备底座、驱动、UI 框架、设置页、
  工具、业务套件都从 `dist-plugins/*.zip` 装进 `<home>/plugins/` 池
  （设置页按钮或无框架时的拖拽引导页）；包内 `snapRail.category` 是
  作者自定义的分类标记，管理页按标记分组；`snapRail.requires` 驱动
  启用/卸载的依赖预检。
- **点表缝** `ctx.points`：连接注册点位、推送样本（`null`=异常）、
  路由写入；modbus 驱动是纯协议适配器的范本。
- **renderer** 是投影客户端：preload 只暴露 `invoke`/`openStream`/
  `zipPathOf` 三原语，四象限 RPC 协议在此之上类型化；框架、布局、
  标题栏、看板、管理页全部是插件，没有框架时内置引导页兜底安装。
- **独立插件开发**：插件仓库使用 `@snap-rail/plugin-sdk` 和
  `snap-rail-plugin` CLI，不需要放进本仓库；manifest 能力、Host/Renderer
  面、语义 UI 槽位和 Ed25519 发布签名见
  [docs/plugin-development.md](docs/plugin-development.md)。

## 布局

```
vendor/      vendored Cordis（rescope @snap-rail/*，见 vendor/README.md）
packages/    层组 packages/<层>/<包>（snapRail.layer 声明，层序 base→store→equipment→ui→tool→suite）：
  base/        util / plugin-kit / plugin-sdk / settings / audit / protocol /
               gateway / connection / app-boot / station-rpc / kernel / modules
               （出厂全集，替换经源码重建）
  store/       store（规范：drizzle 查询构建器即规范，随应用发布）+ store-sqlite（实现，zip 安装，单活）
  equipment/   equipment（设备连接底座缝，zip 安装）+ driver-modbus（驱动多活，范本）
  ui/          framework-shadcn（UI 框架插件，zip、clientOnly、单活）+ equipment-station / settings-station
  tool/        forge（AI 创造）+ trend（班产趋势）
  suite/       terminal-ops（业务套件，clientOnly、单活）
apps/desktop  Electron 应用（无框窗口、IPC 载体、打包配置；dev overlay 见 dev/）
docs/         architecture.md（缝目录与决策）
```

## 命令

```sh
pnpm install
pnpm run build        # tsc -b (lib/types) + tailwind（框架主题预编译）+ tsdown (lib)
pnpm run typecheck
pnpm test             # vitest 全量（先构建）+ 层依赖门禁
pnpm run pack:plugins -- --sign-key .keys/release.private.pem --key-id release-2026
pnpm run plugin:generate-key -- .keys gitea-main-2026 --publisher snap-rail
pnpm run publish:local -- --sign-key .keys/gitea-main-2026.private.pem --key-id gitea-main-2026 --publisher snap-rail
pnpm run verify:market -- --feed dist-publish/plugins --trust .keys/gitea-main-2026.trust.json
pnpm app:dev          # Vite dev server + Electron（全量 overlay），热重载开发
pnpm app:pack         # win-unpacked 目录形态（release-out/）
pnpm app:dist         # NSIS 安装包 + blockmap
```

License: Apache-2.0（vendored Cordis 包保留上游 MIT 许可文件）。
