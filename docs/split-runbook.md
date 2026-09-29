# 拆仓执行手册（snap-rail → 多仓）

前置状态（已完成）：主仓已瘦身改造完毕——trend/forge 已删、套件双面化、
externals 推导、CLI `--framework`、CI 模板齐备；本手册是把 4 个包搬成独立
仓的最后机械步骤。**需要你提供**：Gitea token（建仓 + npm 发布 +
Release 推送）；有 token 后我可以全自动执行。

## 0. 一次性准备

1. Gitea 建仓（org `snap-rail`）：`snap-rail-framework-shadcn`、
   `snap-rail-driver-modbus`、`snap-rail-driver-enip`、
   `snap-rail-suite-terminal-ops`；
2. Gitea → 用户设置 → 应用 → 生成 token（repo 写 + packages 写），
   `export GITEA_TOKEN=<token>`；
3. 发布机 `.npmrc`（仓库根或全局）：
   ```
   @snap-rail:registry=http://192.168.1.9:3000/api/packages/snap-rail/npm/
   //192.168.1.9:3000/api/packages/snap-rail/npm/:_authToken=<base64(user:token)>
   ```

## 1. 发布 npm（解锁一切跨仓构建）

客户端仓发布 base 面（CI 亦可）：
```sh
pnpm -r --filter './packages/base/*' --filter './packages/store/store' \
  --filter './packages/equipment/equipment' publish --access public --no-git-checks
```
校准清单：以 `packages/base/plugin-sdk` 模板的依赖闭包为准
（protocol/connection/station-rpc/app-boot/settings/audit/util/gateway/
kernel/modules/scope/cordis 包装/plugin-kit/plugin-sdk + equipment）。
框架仓发布自己（含 ./templates ./docs）。semver：契约破坏 = major。

## 2. 逐仓搬迁（以 driver-modbus 为例，其余同构）

```sh
mkdir ../snap-rail-driver-modbus && cd ../snap-rail-driver-modbus
# 拷贝：packages/equipment/driver-modbus/{src,tests,tsconfig.json,tsdown.config.ts,LICENSE}
# 新写：package.json（name 不变；peerDeps: @snap-rail/equipment, cordis；
#       deps: zod, modbus-serial）、pnpm-workspace.yaml、.npmrc、AGENTS.md、
#       .gitea/workflows/release.yml（tag → build/test → pack → Release）
git init && git add -A && git commit -m "chore: extract from snap-rail"
git remote add gitea http://192.168.1.9:3000/snap-rail/snap-rail-driver-modbus.git
git push -u gitea master && git tag v0.1.0 && git push gitea v0.1.0
```
主仓侧同步删：`packages/equipment/driver-modbus/`、tsconfig 引用、
desktop devDeps、dev overlay 行、`install-dev-plugins.ts` 行、
`PLUGIN_PACKAGES` 条目（8 → 7）。

顺序：framework-shadcn（stations 改 npm 区间依赖 + CI 矩阵）→
driver-modbus → driver-enip → suite-terminal-ops（recipe 随仓）。

## 3. feed 收集（已有机制）

各仓 tag 后：CI 打 zip 挂本仓 Release → 客户端仓
`feed-sources.json` 列出四仓 → 客户端 release.yml 用 Gitea API 拉
附件装配 index.json → `verify:market`（三把公钥）→ 单 commit 推
feed 分支。终端侧零改动。

## 4. 验收（对照方案）

- [ ] 四仓独立 tag 发版进 feed
- [ ] 外部仓仅凭 npm 类型面 + SDK 文档可编译
- [ ] 装框架 + 装别人组件 → 运行；卸默认 titlebar 装新件 → 卸载回退
