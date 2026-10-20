# snap-rail

工业终端的开源底座：把 OT 现场数据与 IT 工具链装进一个"一切皆插件"的
Electron 宿主。基于 vendored Cordis 元框架；一期交付核心 + 插件机制。

不复现组态画布与传统 HMI——底座提供进程模型、数据缝与最小 UI 骨架，
界面创新留给社区与 Agent（见 [docs/architecture.md](docs/architecture.md)）。
插件开发与自发布见 [docs/plugin-development.md](docs/plugin-development.md)，
部署、组合包与信任模型见 [docs/deploy.md](docs/deploy.md)。

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
- **独立插件开发**：插件仓库使用公共 npm 的 `@snap-rail/plugin-sdk` 和
  `snap-rail-plugin` CLI，不需要放进本仓库；manifest 依赖声明、Host/Renderer
  面、语义 UI 槽位和 Ed25519 发布签名见
  [docs/plugin-development.md](docs/plugin-development.md)（官网版：
  [www.snap-rail.top/dev.html](https://www.snap-rail.top/dev.html)）。发布是去中心化
  的：作者自持钥、发自己的滚动 Release，仓库打 GitHub topic
  `snap-rail-plugin` 即可被发现；没有集中市场仓、没有 PR 上架。一条命令开始：

  ```sh
  pnpm dlx @snap-rail/plugin-sdk init my-driver --template driver
  ```

## 布局

```
vendor/      vendored Cordis（rescope @snap-rail/*，见 vendor/README.md）
packages/    层组 packages/<层>/<包>（snapRail.layer 声明，层序 base→store→equipment→ui→tool→suite）：
  base/        util / plugin-kit / plugin-sdk / settings / audit / protocol /
               gateway / connection / app-boot / station-rpc / kernel / modules
               （出厂全集，替换经源码重建）
  store/       store（规范：drizzle 查询构建器即规范，随应用发布）+ store-sqlite（实现，zip 安装，单活）
  equipment/   equipment（设备连接底座缝，zip 安装）
  ui/          equipment-station（界面住户，zip、clientOnly；设置外壳随框架包发布）
  tool/        暂无住户（场景逻辑收进套件，不再拆跨包场景工具）
apps/desktop  Electron 应用（无框窗口、IPC 载体、打包配置；dev overlay 见 dev/）
docs/         architecture.md（缝目录与决策）、split-runbook.md（多仓拆分）
独立插件仓（GitHub `yansijian`，内网 Gitea 作镜像；feed 由主仓从源码统一打包）：
  snap-rail-framework-shadcn（UI 框架插件）、snap-rail-driver-modbus /
  snap-rail-driver-enip（驱动范本）、snap-rail-suite-terminal-ops（业务套件）
```

## 命令

```sh
node scripts/setup-external.mjs   # 首次/CI：拆分仓拉到 external/ 作 workspace 链接
                                  # feed 打包时用 SNAP_RAIL_EXTERNAL_REPOS 追加 enip/suite
pnpm install
pnpm run build        # tsc -b (lib/types) + tsdown (lib)
pnpm run typecheck
pnpm test             # vitest 全量（先构建）+ 层依赖门禁 + wire-catalog 门禁
pnpm run pack:plugins -- --sign-key .keys/release.private.pem --key-id release-2026
pnpm run plugin:generate-key -- .keys gitea-main-2026 --publisher snap-rail
pnpm run collect:feed -- --provider gitea
pnpm run publish:local -- --collect collect-out --sign-key .keys/gitea-main-2026.private.pem --key-id gitea-main-2026 --publisher snap-rail
pnpm run verify:feed -- --feed dist-publish/plugins --trust apps/desktop/resources/trusted-release-keys.json
pnpm exec tsx scripts/stamp-feed-default.ts   # feed 基址单源（feed-base.json）盖章；--check 进 pnpm test
pnpm run feed:sync-oss  # dist-publish → OSS <bucket>/feed/（SNAP_RAIL_OSS_BUCKET 环境变量）
pnpm run site:build   # 官网：catalog + 开发文档页 + vite build（产物 website/dist）
pnpm run site:sync-oss  # website/dist → OSS 桶根（官网；永不 delete，不碰 feed/）
pnpm app:dev          # Vite dev server + Electron（全量 overlay），热重载开发
pnpm app:pack         # win-unpacked 目录形态（release-out/）
pnpm app:dist         # NSIS 安装包 + blockmap
```

License: Apache-2.0（vendored Cordis 包保留上游 MIT 许可文件）。
