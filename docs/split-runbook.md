# 拆仓执行手册（snap-rail → 多仓）

状态：**已收敛**。主仓 `snap-rail` 保留 base 启动链 + 内置默认
store-sqlite/equipment + 内置 `@snap-rail/ui`、默认皮肤、设置/插件管理/
外观/设备管理页；**没有 framework/suite 拆分仓依赖**。可安装插件只剩
驱动与作者自己的业务页/套件（GitHub `yansijian`；内网 Gitea 作镜像/构建）。

| 仓 | 内容 | 发版 |
| --- | --- | --- |
| `snap-rail-driver-modbus` | ModbusTCP 驱动（范本） | Gitea tag v* → CI；GitHub 由主仓 feed 从源码打包 |
| `snap-rail-driver-enip` | EtherNet/IP 驱动（编解码自带） | 同上 |

各独立仓的机械形状（新插件仓照抄）：

- `package.json`：npm 名不变；peerDeps 用已发布区间（`@snap-rail/cordis ^4.0.1`、
  `@snap-rail/equipment ^0.1.5`…）——公共 npm 上的闭包；devDeps
  `@snap-rail/plugin-sdk`；clientOnly/双面包的 `snapRail` 块原样搬；
- `tsconfig.json`：独立（不 extends 主仓），必须含
  `allowImportingTsExtensions: true, rewriteRelativeImportExtensions: true`；
- `tsdown.config.ts`：宿主面用裸 `defineConfig`（入口用**对象**形式钉输出名，
  数组形式会让 `lib/types/ui/index.js` 覆写 `lib/index.js`）；client 面用
  `clientBundle`（来自公共 npm 的 `@snap-rail/plugin-kit`）；
- `.npmrc`：公共 npm（`registry=https://registry.npmjs.org/`）；
- `AGENTS.md`（必配，见主仓 AGENTS.md 平台扩展约定）；
- 仓库打 topic `snap-rail-plugin`；作者自持钥时可按
  `docs/plugin-publish-ci.yml` 发自己的滚动 Release。

主仓侧对应关系：

- `packages/` 保留 base/store/equipment/ui（两 station）；UI 页面/皮肤不再
  作为可安装 zip；
- `apps/desktop`：dev harness 与 `rendererPackages` 挡板移除——dev 与生产
  同路，可安装插件来自插件池；内置 UI 由 `@snap-rail/ui` 提供；
- 主仓构建期只链接 driver-modbus（`node scripts/setup-external.mjs` →
  `external/`，gitignored；CI 用 `SNAP_RAIL_EXTERNAL_REF` 固定 ref）；
- `scripts/pack-plugins.ts` 的 base 清单**当前为空**（store-sqlite /
  equipment / equipment-station 与 UI 基座已内置，不再发 zip）；独立仓 zip
  经 `scripts/collect-feed.ts`（来源清单 `feed-sources.json`，`--provider
  gitea|github`）合流；
- `scripts/publish.ts` 装配滚动 Release + 离线组合包 + 官网目录；
  `--collect <dir>` 只合并**一方**拆分仓产物。

## feed 收集（机制）

GitHub 是主发布链，**从源码打包全部一方插件**：

1. `.github/workflows/feed.yml` 用
   `SNAP_RAIL_EXTERNAL_REPOS=snap-rail-driver-modbus,snap-rail-driver-enip`
   把驱动仓 stage 进 `external/`；
2. `prepare-workspace` 安装依赖并构建 modbus；feed 作业再构建 enip；
3. `node packages/base/plugin-sdk/lib/cli.js pack external/<repo> --out
   external/<repo>/dist --sign-key … --key-id …` 逐个签名打包，复制进
   `collect-dl/`；
4. `collect-feed.ts --from collect-dl` 从 zip 回填目录条目（manifest + 签名 +
   sha256）→ `publish --collect collect-out` 与 base 包 + 组合合流 → 发布
   滚动 Release → `verify:feed`（信任
   `apps/desktop/resources/trusted-release-keys.json`）。

Gitea 镜像保留原有路径：各驱动仓 `tag v*` → 本仓 CI 构建签名 zip 挂
Release；主仓 `.gitea/workflows/collect-feed.yml` 拉各仓最新 Release 的 zip
→ 同一 `collect-feed.ts --from`。

本地等价流程：

```sh
SNAP_RAIL_EXTERNAL_LOCAL=1 \
SNAP_RAIL_EXTERNAL_REPOS=snap-rail-driver-modbus,snap-rail-driver-enip \
  node scripts/setup-external.mjs
pnpm install
pnpm --filter @snap-rail/driver-modbus run build
pnpm --filter @snap-rail/driver-enip run build
# 每仓签名打包到 external/<repo>/dist，复制 zip 到 collect-dl/
pnpm run collect:feed -- --from collect-dl --provider github
pnpm run publish -- --collect collect-out --sign-key … --key-id … --skip-sync
```

终端侧零改动：bootstrap 页填 feed 源 → 逐个装 → 更新走同一条 feed；组合包
直接拖入。

## 验收

- `pnpm test`：层依赖、wire-catalog、feed-base 门禁全绿；
- `pnpm app:pack`：`verify-packaged-app` 必须 clean（内置 UI/默认
  store/equipment 都在生产依赖里）；
- 新驱动仓 `snap-rail-plugin doctor` 全绿；zip 经 `inspect`/`verify` 通过。