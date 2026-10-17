# 拆仓执行手册（snap-rail → 多仓）

状态：**已执行完毕**。主仓 `snap-rail` 保留 base 出厂全集 + 两个 station
（settings/equipment），四个可安装插件住独立仓（GitHub `yansijian`；内网
Gitea 作镜像/构建）：

| 仓 | 内容 | 发版 |
| --- | --- | --- |
| `snap-rail-framework-shadcn` | UI 框架（clientOnly + tailwind 构建链 + ./templates ./docs） | Gitea tag v* → CI；GitHub 由主仓 feed 从源码打包 |
| `snap-rail-driver-modbus` | ModbusTCP 驱动（范本） | 同上 |
| `snap-rail-driver-enip` | EtherNet/IP 驱动（编解码自带） | 同上 |
| `snap-rail-suite-terminal-ops` | 生产作业套件（双面：lib/stats.js + lib-client） | 同上 |

各独立仓的机械形状（新插件仓照抄）：

- `package.json`：npm 名不变；peerDeps 用已发布区间（`@snap-rail/cordis ^4.0.1`、
  `@snap-rail/equipment ^0.2.0`…）——公共 npm 上的闭包；devDeps
  `@snap-rail/plugin-sdk`；clientOnly/双面包的 `snapRail` 块原样搬；
- `tsconfig.json`：独立（不 extends 主仓），必须含
  `allowImportingTsExtensions: true, rewriteRelativeImportExtensions: true`；
- `tsdown.config.ts`：宿主面用裸 `defineConfig`（入口用**对象**形式钉输出名，
  数组形式会让 `lib/types/ui/index.js` 覆写 `lib/index.js`）；client 面用
  `clientBundle`（来自公共 npm 的 `@snap-rail/plugin-kit`——独立仓里按名导入
  是稳定的，主仓才需要按源码路径导入防陈旧耦合）；
- `.npmrc`：公共 npm（`registry=https://registry.npmjs.org/`）；
- `AGENTS.md`（必配，见主仓 AGENTS.md 平台扩展约定）；
- 仓库打 topic `snap-rail-plugin`；作者自持钥时可按
  `docs/plugin-publish-ci.yml` 发自己的滚动 Release（社区分发路径）。

主仓侧对应关系（已落地）：

- `packages/` 只剩 base/store/equipment/ui（两 station）；stations 对框架的
  依赖改为 npm 区间（`^0.2.0`），类型走公共 npm 的 d.ts；
- `apps/desktop`：dev harness 与 `rendererPackages` 挡板整体移除——dev 与
  生产同路，渲染面一律来自插件池（`install-dev-plugins` 装 zip）；
- 主仓构建期只链接 framework / driver-modbus（`node scripts/setup-external.mjs`
  → `external/`，gitignored；CI 用 `SNAP_RAIL_EXTERNAL_REF` 固定 ref）；
- `scripts/pack-plugins.ts` 只装 base 三包；独立仓 zip 经
  `scripts/collect-feed.ts`（来源清单 `feed-sources.json`，`--provider
  gitea|github`）合流；
- `scripts/publish.ts` 装配滚动 Release + 离线组合包 + 官网目录；
  `--collect <dir>` 只合并**一方**拆分仓产物。

## feed 收集（机制）

GitHub 是主发布链，**从源码打包全部一方插件**，不依赖拆分仓自己的 Release
节奏：

1. `.github/workflows/feed.yml` 用
   `SNAP_RAIL_EXTERNAL_REPOS=snap-rail-framework-shadcn,snap-rail-driver-modbus,snap-rail-driver-enip,snap-rail-suite-terminal-ops`
   把四仓 stage 进 `external/`；
2. `prepare-workspace` 安装依赖并构建 framework/modbus；feed 作业再构建
   enip/suite；
3. `node packages/base/plugin-sdk/lib/cli.js pack external/<repo> --out
   external/<repo>/dist --sign-key … --key-id …` 逐个签名打包，复制进
   `collect-dl/`；
4. `collect-feed.ts --from collect-dl` 从 zip 回填目录条目（manifest + 签名 +
   sha256）→ `publish --collect collect-out` 与 base 三包 + 组合合流 → 发布
   滚动 Release → `verify:feed`（信任
   `apps/desktop/resources/trusted-release-keys.json`）。

Gitea 镜像保留原有路径：各独立仓 `tag v*` → 本仓 CI 构建签名 zip 挂 Release；
主仓 `.gitea/workflows/collect-feed.yml` 拉各仓最新 Release 的 zip → 同一
`collect-feed.ts --from`。GitHub 侧不再需要这条前置。

本地等价流程：

```sh
SNAP_RAIL_EXTERNAL_LOCAL=1 \
SNAP_RAIL_EXTERNAL_REPOS=snap-rail-framework-shadcn,snap-rail-driver-modbus,snap-rail-driver-enip,snap-rail-suite-terminal-ops \
  node scripts/setup-external.mjs
pnpm install
pnpm --filter @snap-rail/framework-shadcn run build
pnpm --filter @snap-rail/driver-modbus run build
pnpm --filter @snap-rail/driver-enip run build
pnpm --filter @snap-rail/suite-terminal-ops run build
# 每仓签名打包到 external/<repo>/dist，复制 zip 到 collect-dl/
pnpm run collect:feed -- --from collect-dl --provider github
pnpm run publish -- --collect collect-out --sign-key … --key-id … --skip-sync
```

终端侧零改动：bootstrap 页填 feed 源 → 逐个装 → 更新走同一条 feed；组合包
直接拖入。

## 验收（对照方案）

- [x] 四仓独立仓与 GitHub 镜像（`yansijian/*`）
- [x] 外部仓仅凭 npm 类型面 + SDK 文档可编译（pnpm install + build + test 全绿）
- [x] GitHub feed 从源码打包四仓并签名（本地等价链路已跑通：7 插件 + 2 组合）
- [x] 卸默认布局装 fallback → 卸载回退（框架仓 fallback.spec）
- [ ] 终端侧 E2E：裸装 → bootstrap 填源 → 逐个装 → 应用/插件双更新（待实机）
