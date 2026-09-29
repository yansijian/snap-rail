# 拆仓执行手册（snap-rail → 多仓）

状态：**已执行完毕**。主仓 `snap-rail` 保留 base 出厂全集 + 两个 station
（settings/equipment），四个可安装插件迁独立仓（Gitea org `snap-rail`）：

| 仓 | 内容 | 发版 |
| --- | --- | --- |
| `snap-rail-framework-shadcn` | UI 框架（clientOnly + tailwind 构建链 + ./templates ./docs） | tag v* → CI |
| `snap-rail-driver-modbus` | ModbusTCP 驱动（范本） | 同上 |
| `snap-rail-driver-enip` | EtherNet/IP 驱动（编解码自带） | 同上 |
| `snap-rail-suite-terminal-ops` | 生产作业套件（双面：lib/stats.js + lib-client） | 同上 |

各独立仓的机械形状（新插件仓照抄）：

- `package.json`：npm 名不变；peerDeps 用已发布区间（`@snap-rail/cordis ^4.0.1`、
  `@snap-rail/equipment ^0.1.0`…）；devDeps `@snap-rail/plugin-sdk`；
  clientOnly/双面包的 `snapRail` 块原样搬；
- `tsconfig.json`：独立（不 extends 主仓），必须含
  `allowImportingTsExtensions: true, rewriteRelativeImportExtensions: true`；
- `tsdown.config.ts`：宿主面用裸 `defineConfig`（入口用**对象**形式钉输出名，
  数组形式会让 `lib/types/ui/index.js` 覆写 `lib/index.js`）；client 面用
  `clientBundle`（来自 npm 的 `@snap-rail/plugin-kit`——独立仓里按名导入是
  稳定的，主仓才需要按源码路径导入防陈旧耦合）；
- `.npmrc`：`@snap-rail:registry=http://192.168.1.9:3000/api/packages/snap-rail/npm/`；
- `AGENTS.md`（必配，见主仓 AGENTS.md 平台扩展约定）；
- `.gitea/workflows/release.yml`：tag v* → build → test →
  `snap-rail-plugin pack`（secrets：`RELEASE_PRIVATE_PEM`（pem 的 base64）、
  `RELEASE_KEY_ID`、`FEED_TOKEN`）→ 上传本仓 Release；
- secrets 名 `GITEA_TOKEN` 是 Gitea 保留名，用 `FEED_TOKEN`。

主仓侧对应关系（已落地）：

- `packages/` 只剩 base/store/equipment/ui（两 station）；stations 对框架的
  依赖改为 npm 区间（`^0.1.3`），类型走 Gitea npm 的 d.ts；
- `apps/desktop`：dev harness 与 `rendererPackages` 挡板整体移除——dev 与
  生产同路，渲染面一律来自插件池（`install-dev-plugins` 装 zip）；
- `scripts/pack-plugins.ts` 只装 base 四包；独立仓 zip 经
  `scripts/collect-feed.ts`（来源清单 `feed-sources.json`）合流。

## feed 收集（机制）

1. 各独立仓打 `v*` tag → CI 构建签名 zip 挂本仓 Release；
2. 主仓 `.gitea/workflows/collect-feed.yml`（每日/手动/主分支触发）用
   `FEED_TOKEN` 拉各仓最新 Release 的 zip → `collect-feed.ts --from` 读 zip
   回填目录条目（manifest + 签名 + sha256）→ `pnpm run publish -- --market
   collect-out` 与 base 四包 + recipes 合流 → 推 feed 分支 →
   `verify:market`（信任 `keys/gitea-main-2026.trust.json`，公钥入库）；
3. 本地等价流程：各仓 `pnpm build && pnpm exec snap-rail-plugin pack . --out dist`
   → 主仓 `pnpm exec tsx scripts/collect-feed.ts`（读 `local` 路径）→
   `pnpm run publish -- --market collect-out --sign-key … --key-id …`。

终端侧零改动：bootstrap 页填 feed 源 → 逐个装 → 更新走同一条 feed。

## 验收（对照方案）

- [x] 四仓独立 tag 发版进 feed（CI 未接 act_runner 前由本地 pack 顶上）
- [x] 外部仓仅凭 npm 类型面 + SDK 文档可编译（pnpm install + build + test 全绿）
- [x] 卸默认布局装 fallback → 卸载回退（框架仓 fallback.spec）
- [ ] 终端侧 E2E：裸装 → bootstrap 填源 → 逐个装 → 应用/插件双更新（待实机）
