---
name: snap-rail-plugin-dev
description: 开发、构建、验证、签名与发布 snap-rail 可安装插件的完整指南——在独立插件仓库里用公共 @snap-rail/plugin-sdk 完成，不需要 snap-rail 源码。覆盖全部 9 种模板：设备驱动 driver、存储后端 store-provider、宿主服务 host-service、工具 tool、业务套件 suite、UI 页面 ui-view、布局 ui-layout、共享组件 ui-extension、皮肤 ui-skin，以及宿主 RPC（ctx.rpc / serveContract）、渲染面 link 与帧订阅（subscribeFrame）。只要用户想写/改/发 snap-rail 插件、snap-rail driver、snap-rail suite、snapRail manifest、snap-rail-plugin CLI、插件 zip 签名或 feed 滚动发布，就用本 skill；哪怕用户只说「给 snap-rail 做个××」，也应触发。
---

# snap-rail 插件开发（独立仓库）

指导思路：snap-rail 的插件在**独立仓库**里开发，全部依赖公共 npm 闭包
（`@snap-rail/plugin-sdk` 及其契约包），**不需要克隆 snap-rail 源码**。
缺任何契约都不要去复制主仓 `packages/*/src` 或 `apps/desktop` 的文件——
先查能力地图（[references/faces-and-wire.md](references/faces-and-wire.md)）
与安装的 SDK 类型；地图里没有的能力才是真的没有，不要发明导入路径。

## 一分钟心智模型

- 插件 = 一个 npm 包；发行形态是**签名的 zip**：精简 manifest
  （`package.json` 的 `snapRail` 块 + `main`/`exports`）+ 构建好的运行面，
  **永不带 src/**。
- 安装后住进终端的插件池 `<home>/plugins/<包名>/`；启用/禁用/卸载都过
  `requires` 依赖解析，缺依赖当场被拒，不留到下次开机。
- 两种运行面：
  - **宿主面**：node ESM 包，`hostBundle` 构建 → `lib-host/host.js`，
    即 package.json 的 `main`。设备通讯、存储、服务、wire 方法都在这。
  - **渲染面**：浏览器 CJS 工厂包，`clientBundle` 构建 →
    `lib-client/client.js`，焊进 `__ModuleLoader__` 工厂壳执行；`@snap-rail/ui`
    语义原语、插槽/皮肤/设置/runtime 与契约等**种子模块**运行时从共享种子表
    取单实例。
- 插件之间**永不互相 import**：协作只走 cordis 服务（`ctx.provide` /
  `inject`）、wire 帧和 store 服务缝。
- **三张表别混**：npm 依赖表决定 TypeScript 能 resolve 什么；运行时种子表
  决定渲染面能 `require` 什么；`requires` 决定终端里必须装/启用哪些插件。
  种子 id 不是 npm 包，npm 类型包也不是可安装插件。

## 铁律（违反 = 装不上 / 崩 / 被 pack 拒绝）

1. **`snapRail.requires` 是唯一兼容声明**。三种条目：包名
   （`@snap-rail/equipment`）、带版本范围的包名
   （`@snap-rail/equipment@^0.1.5`）、服务名（`service:store`）。
   `@snap-rail/ui` 是 base 种子，**不是** requires 条目；渲染面插件用
   `snapRail.uiProfile` 声明 native/integrated/custom。
   `snapRail.framework` / `snapRail.capabilities` 已退役，宿主不再读。
2. **种子消费只准 named/star 导入，且分 base / 贡献两层**。default 导入经
   CJS interop 会把 `.default` 变成整个命名空间对象，运行时挂载即崩——
   `clientBundle` 构建期会故意硬错。base 种子（connection / protocol /
   util / shell-contract / equipment-contract / react / zod、`@snap-rail/ui`
   及其 components/charts/contract/slots/skins/settings/runtime/pages/fallback
   子路径等）由 shell 自动播种，**不能写** `client.externalSeeds`（写了启用
   预检会报“提供方未安装”）；
   只有其他插件贡献的 `<包>/<子路径>` 才写。只 type-only 导入的贡献
   种子不产生运行时 require，也不用写。自己贡献给别人的组件进 `client.seeds`。
3. **`snapRail.client.seedAbi` 永不手写**——pack 时自动盖章，安装期与渲染
   端 boot 双向校验。**终端升级后必须用当前 plugin-kit 重新 build + pack**：
   旧包带的种子 ABI 章（如 r1）与宿主修订号（当前 r2）不符时，安装期拒装、
   渲染端 skip + fail-loud（报「插件构建于种子 ABI r1，宿主为 r2」）。
4. **注册皆 effect，缝方法自带回收**。缝注册方法（首参 caller 上下文，如
   `ctx.equipment.registerDriver(ctx, driver)`）的处置随 caller 的 fiber 自
   动跟踪——插件停用/卸载时自动回收，**模板骨架的裸调用就是完整写法**，
   不要再手动包一层自管的生命周期。`ctx.effect()` / `ctx.on()` 用于包装
   非缝的自定义副作用与事件订阅；`register()` 类方法返回的处置函数不要自己
   另存另管。把函数本身传进 `ctx.effect()`（而不是调它）等于立即执行。
5. **状态放构造期闭包，不放 Service 子类字段**。cordis 可追踪代理每次访问
   重绑 `this`，字段状态会「每读一次一个世界」。
6. **页面组件只用内置语义原语**（`@snap-rail/ui/components` 的
   Button/Card/Dialog/Table/Tabs/Page/Stack/Grid…）。缺原语补进
   `@snap-rail/ui`，不要在页面里手搓交互组件、不要写裸 Tailwind。
7. **主题只用 skin token**。页面禁止硬编码色值和 `dark:` 变体；图表系列
   只用 `--snap-chart-1…6`；红/黄/绿是状态语义，不进数据系列。第三方图表
   包在 `ChartFrame`/`Visualization` 内，用 `useChartTheme()` 取色。
8. **触屏基线**：数值输入用 `NumberInput`，单选用 `TouchSelect`，滚动容器
   用 `DragScroll`。
9. **OS 资源只走 shell 缝，插件永不 import `electron`**。通知、托盘、窗口
   surface、悬浮球、退出策略一律经 `ctx.shell`（宿主面）或
   `@snap-rail/shell/contract`（渲染面）。
10. **驱动是纯协议适配器**。设备/组/点住在底座表里，驱动零自有存储、无
    RPC 子命名空间、无渲染端页面；只上交 zod schema + 可选探测 +
    `createConnection`。驱动**多活并存**。
11. **结构化数据走 store 缝**。`ctx.store.register(ctx, '<ns>', drizzle表)`
    得到类型安全 db；只用 drizzle 查询构建器，无裸 SQL；跨命名空间协作走
    服务，永不共享表。简单键值配置走 settings.json，别建表。
12. **`main` 不出现在 `client.surfaces` 里**（主窗口的面就是
    `client.entry`）；辅助面（球等）**不订阅工业点**，只消费宿主聚合帧。
13. **`@snap-rail/*` 命名空间是官方保留的**（无论签名策略强制 verified）。
    社区包用自己的 scope；冒名包装不上。
14. **zip 永不带 src**，`pack` 会拒；`main` 必须与构建产物一致。

## 标准工作流

```sh
# 0. 环境：Node 22+，pnpm 或 npm。国内镜像同步新版本有延迟，
#    pnpm dlx 报 404 / ETARGET 时：npm config set registry https://registry.npmjs.org/
pnpm dlx @snap-rail/plugin-sdk init my-driver --template driver
cd my-driver
pnpm install

# 1. 起名：默认包名是 @local/<目录名>，发布前改成你自己的 scope。
#    要同步改的地方（漏一处 doctor/测试就红）：
#    ① package.json 的 name ② 入口对象里的 name（satisfies Plugin 的那份）
#    ③ tests/manifest.spec.ts 断言里的包名
#    ④ tsdown.config.ts 里的包名字符串（仅 ui-*/suite 模板有；driver 等宿主
#       单面模板没有）

# 1.5 宿主面构建纪律（driver/store-provider/host-service/tool/suite 宿主）：
#    - 把宿主运行时要 resolve 的契约包（如 @snap-rail/equipment、wire 用的
#      @snap-rail/protocol）从 devDependencies 挪进 dependencies——hostBundle
#      只外部化 dependencies，devDependencies 会被整套内联进 host.js
#      （体积暴涨 + 绕开池内单实例）。
#    - 入口源码对 @snap-rail/plugin-sdk 只准 type-only 导入；模板已用
#      `import type { Plugin } from '@snap-rail/cordis'` + `satisfies Plugin`，
#      手写时照做。不要把 definePlugin 当值导入。
#    - build 后看一眼 lib-host/host.js 体积：正常几 kB～几十 kB；上百 kB
#      就是有东西被内联了。

# 1.6 要跨面协作（suite / host-service / 有帧订阅的 UI）：
#    - 宿主 RPC：`import type { GatewayService } from '@snap-rail/plugin-sdk/api'`
#      + `inject: ['rpc']` + `ctx.rpc.claimDomain/serveContract`；不需要单独
#      安装 gateway，也不要写进 requires。
#    - 渲染 link/帧：`import { subscribeFrame, rpcErrorText } from
#      '@snap-rail/plugin-sdk/api/client'`；`ctx.client` 由内置 @snap-rail/ui
#      runtime 提供，用 `import type {} from '@snap-rail/ui/runtime'` 引入增强。
#    - wire 契约模块 import zod：`@snap-rail/protocol` 与 `zod` 都放
#      dependencies（host value import；zod 由 app 的 resolve-hooks 外部化）。
#    - UI 用 `formatClock`/`formatDuration` 时把 `@snap-rail/util` 加
#      devDependency（base 种子；模板默认不带）。
#    - 完整骨架见 references/faces-and-wire.md。

# 2. 实现（按模板读 references/ 对应文件），然后：
pnpm run build      # 宿主面 → lib-host/，渲染面 → lib-client/
pnpm run test

# 2.1 建议加一次类型检查（模板不带 typescript；tsdown 只转译不检查类型）：
pnpm add -D typescript && pnpm exec tsc --noEmit

# 3. 快速反馈环（写循环里随时跑；红 = 契约违约，warning = 建议）：
pnpm run doctor

# 4. 一次性建立发布者身份（Ed25519；.keys/ 已被 .gitignore）：
openssl genpkey -algorithm ed25519 -out .keys/release.private.pem
openssl pkey -in .keys/release.private.pem -pubout -out .keys/release.public.pem
#    没有 openssl 的 Windows 可用 node:crypto 的 generateKeyPairSync('ed25519')，
#    私钥导出 pkcs8 PEM、公钥导出 spki PEM。

# 5. 打包签名（无签名 zip 不可安装）：
pnpm exec snap-rail-plugin pack . --out dist --sign-key .keys/release.private.pem --key-id my-key
pnpm exec snap-rail-plugin inspect dist/<包名>.zip        # 身份/面/签名概览
pnpm exec snap-rail-plugin verify dist/<包名>.zip --public-key .keys/release.public.pem --key-id my-key

# 6. 产出 feed 清单并发布：
pnpm exec snap-rail-plugin feed dist
#    把 dist/ 里 index.json + 全部 zip 平铺上传到你仓库固定 tag `feed` 的
#    滚动 Release（每次发布删旧建新），给仓库打 GitHub topic: snap-rail-plugin。
#    用户把 https://github.com/<you>/<repo>/releases/download/feed/ 加进
#    终端「插件页 → ⚙ 插件源」，或直接拖 zip 进「安装插件」。
```

## 选模板（9 选 1）

| template | 面 | 什么时候选 |
| --- | --- | --- |
| `driver` | 宿主 | 接一种现场协议/设备（modbus、enip…）。纯协议适配器，多活。 |
| `store-provider` | 宿主 | 换/补全局存储后端（全局单活 `store-backend`）。一般不碰。 |
| `host-service` | 宿主 | 在宿主进程贡献一个 cordis 能力服务（无界面）。 |
| `tool` | 宿主 | 独立工具；工具互不依赖（层门禁强制）。跨包场景逻辑请用 suite。 |
| `suite` | 双面 | 一个业务场景的**全部**：场景私有宿主逻辑 + 场景界面，单活。 |
| `ui-view` | 渲染 | 注册进 `ctx.pages` 的页面（React + `@snap-rail/ui/components`）。 |
| `ui-layout` | 渲染 | 布局：声明 `provides` + `window`/`ball` profile。 |
| `ui-extension` | 渲染 | 贡献共享组件（`client.seeds`），供其他组件插件复用。 |
| `ui-skin` | 渲染 | 皮肤：token + part CSS + 展示变体，单活 `exclusive: 'skin'`。 |

UI 模板以 base 种子 `@snap-rail/ui` 为语义基座；它不是 requires 条目，
也不需要 framework 绑定。`--framework <包名[@范围]>` 仅作为类型/构建包覆盖
入口保留。设置页不需要单独模板：用 `ui-view` 模板，在 `apply` 里多调一次
`ctx.settings.registerPage`（片段见
[references/client-face.md](references/client-face.md)）。

## 深入参考（何时读哪个）

| 文件 | 何时读 |
| --- | --- |
| [references/manifest.md](references/manifest.md) | 动 `package.json` 的 `snapRail` 块之前；拿不准 `requires`/`exclusive`/`client` 字段怎么写时。 |
| [references/templates.md](references/templates.md) | init 之后、动手实现之前；确认所选模板的 manifest、构建与骨架要点。 |
| [references/host-face.md](references/host-face.md) | 写宿主面代码：cordis 纪律、驱动、store、宿主服务、shell 宿主面 API。 |
| [references/client-face.md](references/client-face.md) | 写渲染面代码：种子纪律、语义原语、页面/布局/扩展/皮肤写法、球面与退出策略。 |
| [references/faces-and-wire.md](references/faces-and-wire.md) | 写宿主 RPC、渲染面 link/帧，或分不清 npm 包 / 种子 / requires 时。 |
| [references/publish.md](references/publish.md) | 发布前：密钥、pack/feed/verify 细节、滚动 Release 规则、信任模型、组合包、CI。 |
| [references/troubleshooting.md](references/troubleshooting.md) | 报错时：doctor 警告语义、常见构建/安装错误对照表。 |

## 真相源与版本锚

- **优先级**：安装的 SDK 类型（`node_modules/@snap-rail/plugin-sdk/lib/types/`
  及各契约包的 `lib/types/*.d.ts`）＞ init 生成仓库自带的 `AGENTS.md` ＞
  官方文档 <https://www.snap-rail.top/dev.html> ·
  <https://github.com/yansijian/snap-rail/blob/master/docs/plugin-development.md>。
- **先查能力地图**：[faces-and-wire.md](references/faces-and-wire.md)。能力
  存在但类型包没装 → 按地图升级 SDK；地图里没有的才是真的没有。不要从已装
  插件的编译产物反推 API，也不要在插件里 `as any`——那是 skill/闭包缺口的
  信号。
- **版本锚**（本 skill 快照对应）：plugin-sdk `^0.2.6`、plugin-kit `^0.2.3`、
  cordis `^4.0.1`、equipment `^0.1.6`、store `^0.1.0`、`@snap-rail/ui`
  `^0.1.0`（已随 r2 闭包发布到公共 npm）、zod `^4`、react `^19`、
  tsdown `^0.22`。`@snap-rail/shell` 随公共闭包发布（当前 0.2.2），
  `npm view @snap-rail/shell version` 查最新。
  base 服务门面 `@snap-rail/plugin-sdk/api` 与 `/api/client` 从 `0.2.5`
  起提供；底层 gateway/connection/settings 由 SDK 传递安装，作者不单列。
  `SEED_ABI_REVISION` 当前为 **r2**（以 `@snap-rail/plugin-kit` 导出为准）；
  终端升级后旧 zip 需用当前 plugin-kit 重打包才能过渲染端 ABI 校验。
- **时代分界（先查这个）**：npm 的 `plugin-sdk ≤ 0.2.5` / `plugin-kit ≤
  0.2.2` 是 UI 基座内置化**之前**的旧时代产物——没有 `ui-skin` 模板、UI
  模板默认依赖已退役的 `@snap-rail/framework-shadcn`、pack 盖 seed ABI r1
  章（当前宿主安装期拒装）。r2 时代从 `plugin-sdk 0.2.6` / `plugin-kit
  0.2.3` 起：9 模板齐、UI 模板默认内置 `@snap-rail/ui`。装到旧版按上面
  版本锚升级重装，不要照旧骨架写。
- **版本陷阱（以 plugin-sdk 0.2.3 / equipment 0.1.4 为界，之后消除）**：
  - `probe`（驱动「测试连接」）：主仓已实现，但 npm
    `@snap-rail/equipment@0.1.4` 的类型里**没有**该字段——`0.1.5` 起恢复；
  - `client.surfaces`（辅助窗口多渲染面）：官方 npm 的 plugin-kit
    `0.2.2` 已支持；但 `plugin-sdk@0.2.3` 的 d.ts 按旧 schema 内联生成，
    manifest 字面量里写 `surfaces` 会被 excess property check 拒——
    `0.2.4` 起恢复；
  - `@snap-rail/ui` 是 base 内置包，版本随终端走；插件只把它放
    devDependencies 供类型/构建，运行时由 base 种子提供。`ClientServices`
    由内置 runtime 提供（`ctx.client.link` / `surface`），不再有可替换的
    独立 UI 框架插件；
  - npmmirror 元数据同步滞后还可能让版本范围解析到旧版本——遇到「文档说有、
    类型说没有」，先切官方 registry 重装再判断；
  - 对策恒定：**以安装的 d.ts/schema 为准**——
    `Select-String -Path node_modules/@snap-rail/*/lib/types/*.d.ts -Pattern <字段名>`
    查得到才写；查不到就不写（写了类型/schema 当场拒绝），并优先升级
    `@snap-rail/plugin-sdk` / `@snap-rail/equipment` 到上面锚定的版本。
- **`snap-rail-plugin doctor` 是最快的事实核查器**：manifest、requires
  形态、构建入口落盘；红 = 契约违约必须修，warning 是建议。
- 版本漂移时：先看 `npm view @snap-rail/plugin-sdk`，再以 init 新生成的
  骨架为准修订本 skill 的过时细节。

## 发布前检查清单

- [ ] 包名用了自己的 scope（非 `@local/`、非 `@snap-rail/*`）；改名四处
      （package.json / 入口 name / 测试断言 / tsdown 包名字符串）都改了
- [ ] 宿主面运行时契约包在 dependencies（非 devDependencies）；host.js
      体积正常（无底座/打包机器被内联）
- [ ] 重新发布前清空 `lib-host/`、`lib-client/`、`dist/` 再 build/pack
      （hostBundle 不清产物目录，pack 按面目录整目录收编——旧 chunk 会混进 zip）
- [ ] `pnpm run build` 后 `main`（与 `client.entry`）产物真实存在
- [ ] `pnpm run doctor` 全绿（warning 逐条确认过）
- [ ] `requires` 与真实依赖一致；渲染面声明了 `uiProfile` 与全部**贡献**
      种子（`@snap-rail/ui` 等 base 种子不写）
- [ ] zod schema 字段都有 `.meta({ title })`（驱动/配置表单才有中文标签）
- [ ] 无 `import … from 'electron'`；无种子 default 导入
- [ ] 宿主 RPC 用 `@snap-rail/plugin-sdk/api` 的 type-only 导入；渲染面帧用
      `@snap-rail/plugin-sdk/api/client`；gateway/connection/settings 没有
      出现在 `requires` / `externalSeeds` / `package.json`
- [ ] `externalSeeds` 只列其他插件贡献种子，没有 base 种子
- [ ] `lib-host/host.js` 不含 plugin-sdk（入口是 `satisfies Plugin`）；
      `lib-client/client.js` 不含 plugin-sdk / node 内置
- [ ] vitest 冒烟测试通过（manifest 校验 + 装配链路）
- [ ] pack 产出 sha256/size；`verify` 用公钥验签通过
- [ ] dist 里同包名只保留最新版（feed 拒绝重名）
- [ ] Release 资产平铺（index.json + zip 同级）、tag `feed`、topic
      `snap-rail-plugin` 已打
