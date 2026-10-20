# 独立开发插件

插件不需要放进 snap-rail 工作区开发。每个插件独立维护一个仓库，安装公共
npm 上的 `@snap-rail/plugin-sdk`，用 SDK 的 manifest schema、构建预设和
`snap-rail-plugin` CLI 完成开发、验证、签名与发布。你只需要
**Node 22+ 与 pnpm（或 npm）**，不需要克隆 snap-rail 源码。

`init` 生成的 `AGENTS.md` 是插件仓库的短规范：它列出允许的 SDK 入口、
manifest、依赖声明、Host/Renderer 边界和发行物规则。用 AI 辅助开发时，
把这份文件喂给 Agent 即可——不需要扫描 snap-rail 主仓库。

## 30 秒开始

```sh
pnpm dlx @snap-rail/plugin-sdk init my-driver --template driver
cd my-driver
pnpm install
pnpm build          # 宿主面 → lib-host/，渲染面 → lib-client/
pnpm run test
pnpm run doctor     # 发布前的仓库契约自检
```

生成项目包含 `package.json`（manifest 与依赖已配好）、`src/` 骨架、
`tsdown.config.ts`、`tsconfig.json`、一个能通过的冒烟测试和 `.gitignore`。
包名默认是 `@local/<目录名>`，发布前改成你自己的 scope。

国内一般用 npmmirror（多数环境已默认配置）。镜像同步有分钟级到小时级的
延迟：遇到 `404` / `ETARGET`（新版本还没同步过去）时，把 registry 临时切
到公共 npm 重试：

```sh
npm config set registry https://registry.npmjs.org/
pnpm dlx @snap-rail/plugin-sdk init my-driver --template driver
```

## 八种模板

| 模板 | 面 | 产出 |
| --- | --- | --- |
| `driver` | 宿主 | 设备驱动：纯协议适配器，向 `ctx.equipment` 注册 |
| `store-provider` | 宿主 | 存储后端实现（全局单活 `store-backend`） |
| `host-service` | 宿主 | 宿主服务：注册能力、声明 wire 方法与帧 |
| `tool` | 宿主 | 独立工具（工具之间互不依赖） |
| `suite` | 双面 | 业务套件：场景私有宿主逻辑 + 场景界面，单活 |
| `ui-view` | 渲染 | 挂进 `shell.view` 槽位的界面（React + 框架原语） |
| `ui-layout` | 渲染 | 布局：接管槽位编排 |
| `ui-extension` | 渲染 | 共享组件贡献（`client.seeds`，供其他组件插件复用） |

UI 模板默认绑定 `@snap-rail/framework-shadcn@^0.2`。`--framework` 接受
包名或「包名@范围」换绑第三方框架——**框架绑定就是 manifest
`requires` 里的一条 `name@range`**，没有独立的 framework 字段；绑定即
生态依赖，换框架 = 换生态，这是设计决策不是限制。

## Manifest 是插件的协议入口

`package.json` 的 `snapRail` 必须通过 `snapRailManifestSchema` 校验。作者
声明的字段：`kind`（driver / plugin / framework / suite）、`layer`、
`title`（管理页显示名，中文可用）、`category`（开放分类标记，声明即归
组）、`clientOnly`、`client.entry`、`exclusive`（互斥组）、`permissions`
与 `engines`，以及**唯一兼容声明** `requires`：

- 包名：`@snap-rail/equipment` —— 该包已安装并启用；
- 带版本范围：`@snap-rail/framework-shadcn@^0.2` —— 语义单源
  `@snap-rail/util/semver`，渲染面的框架绑定就是这一条；
- 服务名：`service:store` —— 运行时存在该 cordis 服务。

启用做正向校验（缺依赖或版本不合则拒绝）；禁用/卸载做反向校验（还有依
赖方则拒绝）。缺依赖永远不会留到下次开机才失败。

```json
{
  "name": "@my-scope/my-driver",
  "version": "1.0.0",
  "snapRail": {
    "kind": "driver",
    "layer": "equipment",
    "title": "我的驱动",
    "category": "设备",
    "requires": ["service:store", "@snap-rail/equipment"]
  }
}
```

历史上的 `snapRail.framework` 与 `snapRail.capabilities` 词汇已退役；旧
zip 里残留的字段在 manifest 校验时被剥离，宿主永不再读它们。

## 双面与构建

- **宿主面**用 `hostBundle` 构建，产物 `lib-host/host.js`（ESM node 包；
  `package.json` 依赖保持外部，其余打进包内），即 zip 的 `main`。
- **渲染面**用 `clientBundle` 构建，产物 `lib-client/client.js`——一个焊
  进 `__ModuleLoader__` 工厂的 CJS 包。种子模块（框架原语、base 契约）
  外部化到运行时种子表，跨插件共享单实例；第三方库全部内联；位图与 SVG
  以 `snap-plugin://` 地址随包发射；`.css` 导入变成幂等的样式注入模块。
- **种子消费只准 named/star 导入**：default 导入经 CJS interop 会把
  `.default` 变成整个命名空间对象，运行时挂载即崩——构建期护栏会硬错。
- `clientBundle` 打包时自动盖 `snapRail.client.seedAbi` 章（构建时真实
  require 到的种子与其版本），安装期与渲染端 boot 双向校验，作者永不手写。
- 页面组件只组合 `@snap-rail/framework-shadcn/ui` 的 shadcn 原语
  （Button/Card/Dialog/Table/Tabs/SchemaForm…）；缺原语把它移植进框架包，
  不在页面里手搓交互组件。触屏基线：数值输入用 `NumberInput`，单选用
  `TouchSelect`，滚动容器用 `DragScroll`。

驱动骨架说明：驱动只上交 zod schema（`.meta({ title })` 做表单标签）+
可选 `probe`（一次性只读连接测试，设置页的「测试连接」按钮）+
`createConnection`（返回 `{ update, dispose }`，经 handle 上报
status/sample/write）。设备/组/点住在底座表里，驱动零自有存储。

## 本地命令

| 命令 | 作用 |
| --- | --- |
| `snap-rail-plugin doctor .` | 校验 manifest、requires 形态、构建入口落盘；警告写为 warnings，不阻断 |
| `snap-rail-plugin pack . --out dist --sign-key release.private.pem --key-id my-key` | 装配并签名发行 zip；拒绝无签名发布，输出 sha256 与 size |
| `snap-rail-plugin feed dist` | 读目录内已签名 zip，产出 `index.json`（含 sha256/size/签名 keyId）；拒绝未签名与重名包 |
| `snap-rail-plugin inspect dist/xxx.zip` | 身份、面、文件数、签名 keyId 概览（无需公钥） |
| `snap-rail-plugin verify dist/xxx.zip --public-key .keys/my-key.public.pem --key-id my-key` | 用发布者公钥完整验签 |

## 签名与信任

发布者用 Ed25519 私钥对发行 manifest 与每个发行文件的 SHA-256 摘要签名。
签名发行物包含 `META-INF/release.json` 与 `META-INF/signature.json`。安装
门三态：受信 key → **verified**（摘要/身份/publisher 全验，任何失败硬拒）；
无签名或 keyId 未登记 → **unverified**（默认放行，预览显著警告并多一步风
险确认；`plugins.signaturePolicy: 'strict'` 的现场只认受信签名）；
**验证失败 = 篡改证据，硬拒**。`@snap-rail/*` 命名空间无论策略必须
verified——社区包请使用你自己的 scope，冒名官方命名空间装不上。

首次建立发布者身份：

```sh
openssl genpkey -algorithm ed25519 -out release.private.pem
openssl pkey -in release.private.pem -pubout -out release.public.pem
```

没有 openssl 的 Windows 机器可以用 Node 生成同一对密钥：调用
`crypto.generateKeyPairSync('ed25519')`，私钥导出为 `pkcs8` PEM、公钥导出
为 `spki` PEM，分别存成 `release.private.pem` / `release.public.pem` 即可。
不需要克隆 snap-rail 主仓。

私钥只留在你的发布机与 CI secret；`.public.pem` 交给客户登记进终端：

```sh
snap-rail-plugin verify dist/@you__plugin.zip --public-key .keys/my-key.public.pem --key-id my-key
```

客户端信任根位于终端数据目录的 `trusted-release-keys.json`（∪ 出厂
`resources/trusted-release-keys.json`，本机按 keyId 覆盖）。它住在插件池
外——插件不能通过安装自己来授权自己；安装流程也永不自动写信任文件。用户
验证过你的插件后手工登记你的公钥，此后你的更新即有完整性锚；**换 key 的
更新会被单独拦下确认**（keyChanged 锚定）。文件形状：

```json
{
  "keys": [
    {
      "keyId": "my-key",
      "publisher": "my-company",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----..."
    }
  ]
}
```

## 发布为滚动 Release（自持源）

没有集中市场上架流程：你的仓库就是发布源。

1. `snap-rail-plugin pack` 产出签名 zip，`snap-rail-plugin feed` 产出
   `index.json`；
2. 把 `index.json` 与全部 zip **平铺**上传到你仓库固定 tag `feed` 的滚动
   Release（每次发布删旧建新）；
3. 给仓库打上 GitHub topic **`snap-rail-plugin`** —— 这就是发现入口；
4. 用户把你的 Release 地址加进终端「插件页 → ⚙ 插件源」：
   `https://github.com/you/your-plugin/releases/download/feed/`。

工作流模板见仓库 `docs/plugin-publish-ci.yml`（复制到你仓库的
`.github/workflows/publish.yml`，secret 只需 `RELEASE_PRIVATE_PEM` 与
`RELEASE_KEY_ID`）。官方不维护聚合仓、不转存你的 zip、不需要 PR 上架；
任何第三方聚合列表都只是发现层，完整性锚仍是你的签名。

`index.json` 条目携带包名、版本、文件名、sha256、size 与签名 keyId；条目
也可以用绝对 `url` 指回你的 Release（联邦形态）。客户端下载先验哈希，同
场 `file` 强制纯文件名。用户手填的直链走 `plugins.inspect-from-url`，有界
且同样过三态签名判定。

## 组合包（可选）

组合包是离线交付单位：zip 根目录放 `recipe.yml`（`id` / `version` /
`title` / `kind` / `description` / `plugins`，行与 `plugins.yml` 同形）+
`plugins/` 下每个被引用包一个**已签名**成员 zip，可选 `readme.md`。把它和
插件 zip 放进同一个 Release 即可；终端按内容识别（根目录有 `recipe.yml`
且无 `package.json` = 组合），拖入后批量安装成员并写入组合预设。组合包本
身不签名——信任随成员 zip 走，任一成员 unverified 就多一步组合级确认。

## 公共 npm 闭包

独立插件仓库只依赖这些公共 npm 包：`@snap-rail/plugin-sdk`（含
`snap-rail-plugin` CLI）、`plugin-kit`、`util`、`protocol`、`store`、
`equipment`、`cordis`、`cosmokit`，UI 模板另需
`@snap-rail/framework-shadcn`。发行 zip 的运行时依赖由终端提供
（`@snap-rail/*` 经 resolve-hooks 按 appRoot 优先、池内回退解析），不随包
分发。

## 排错

- **pack 报 missing its host face**：先 `pnpm run build`；`main` 必须与
  产物一致（模板默认 `lib-host/host.js`）。
- **构建期「种子默认导入」硬错**：把 `import x from 'seed'` 改成
  `import { … } from` 或 `import * as`——CJS interop 下 default 导入运行
  时即崩。
- **install 报未发布包 E404**：升级到 SDK 0.2.3+ / 框架 0.2.0+（旧模板把
  未发布的内部包写进了 peer）；用 `pnpm dlx @snap-rail/plugin-sdk@latest
  init` 重新生成。
- **运行 CLI 时弹「选择应用打开 .js」**：0.2.2 及更早的发行 `lib/cli.js`
  缺少 shebang，npm 生成的 bin shim 会把 `.js` 当文档交给 Windows。
  升级到 0.2.3+（或临时用 `node node_modules/@snap-rail/plugin-sdk/lib/cli.js`）。
- **渲染面构建后无法 require 框架组件**：确认 manifest 的
  `client.externalSeeds` 声明了你 import 的每个 `框架包/子路径`。
- **驱动表单没有字段**：给 zod schema 的字段加 `.meta({ title: '标签' })`，
  设置页的 SchemaForm 按 JSON Schema 投影渲染。

## 进一步阅读

- [架构与缝目录](https://github.com/yansijian/snap-rail/blob/master/docs/architecture.md)
- [部署：插件源、组合包与更新源](https://github.com/yansijian/snap-rail/blob/master/docs/deploy.md)
- [snap-rail 官网](https://www.snap-rail.top/) ·
  [插件生态](https://www.snap-rail.top/plugins.html) ·
  [社区 topic](https://github.com/topics/snap-rail-plugin)
