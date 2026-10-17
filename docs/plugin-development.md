# 独立开发插件

插件不需要放在 snap-rail 工作区内开发。推荐每个插件独立维护一个 GitHub
仓库，在仓库中安装公共 npm 上的 `@snap-rail/plugin-sdk`，用 SDK 提供的
manifest schema、tsdown 构建预设和 CLI 完成开发、签名与发布。

```sh
pnpm dlx @snap-rail/plugin-sdk init my-driver --template driver
cd my-driver
pnpm install
pnpm build
snap-rail-plugin doctor .
snap-rail-plugin pack . --sign-key release.private.pem --key-id my-key
```

CLI 生成的 `AGENTS.md` 是插件仓库的短规范：它列出允许的 SDK 入口、manifest、
依赖声明、Host/Renderer 边界和发行物规则。Agent 只需阅读该文件与
`@snap-rail/plugin-sdk` 的类型声明，不需要扫描 snap-rail 主仓库。

公开 npm 闭包：`@snap-rail/plugin-sdk`、`plugin-kit`、`util`、`protocol`、
`store`、`equipment`、`@snap-rail/cordis`（及 vendored `cosmokit`）。

## Manifest 是插件的协议入口

`package.json` 的 `snapRail` 必须通过 `snapRailManifestSchema` 校验。作者要
声明的字段：`kind`、`layer`、`title`、`category`、`clientOnly`、
`client.entry`、`engines`，以及**唯一兼容声明** `requires`：

- 包名：`@snap-rail/equipment`——该包已安装并启用；
- 带版本范围：`@snap-rail/framework-shadcn@^0.2`——语义单源
  `@snap-rail/util/semver`；渲染面的框架绑定就是这一条，没有独立的
  framework 字段；
- 服务名：`service:store`——运行时存在该 cordis 服务。

驱动示例：

```json
{
  "name": "@my-scope/my-driver",
  "version": "1.0.0",
  "snapRail": {
    "kind": "driver",
    "layer": "equipment",
    "title": "我的驱动",
    "category": "设备",
    "requires": ["service:store", "@snap-rail/equipment@^0.2"]
  }
}
```

历史上出现的 `snapRail.framework` / `snapRail.capabilities` 词汇已退役；
旧 zip 里残留的字段在 manifest 校验时被剥离，宿主永不再读它们。

Host 侧使用 `hostBundle`，Renderer 侧使用 `clientBundle`；Renderer 只允许
使用 SDK 文档列出的种子模块和 `./contract` 纯契约面（named/star 导入）。
驱动使用纯类型的 `@snap-rail/equipment/driver` 注册契约，只有 Host 面导入
`@snap-rail/equipment` 服务。`clientBundle` 会在打包时盖
`snapRail.client.seedAbi` 章，安装与渲染端 boot 双重校验种子契约。

## 发布签名

发布者用 Ed25519 私钥对发行 manifest 和每个发行文件的 SHA-256 摘要签名。
签名发行物包含 `META-INF/release.json` 与 `META-INF/signature.json`。客户端
安装时先判签名三态：受信 key → 完整验证（摘要/身份/publisher，任何失败硬
拒）；无签名或 keyId 未登记 → unverified——默认 open 策略仍可安装，但预览
显著警告并多一步风险确认（`plugins.signaturePolicy: 'strict'` 的现场恢复
只认受信签名；`@snap-rail/*` 命名空间无论策略必须受信签名）。

首次建立发布者身份：

```sh
# 任一方式生成 Ed25519 私钥：
openssl genpkey -algorithm ed25519 -out release.private.pem
# 或使用主仓脚本（会一并写出公钥与 trust JSON）：
pnpm run plugin:generate-key -- .keys my-key --publisher <你的发布者名>
```

私钥只留在你的发布机/CI secret，`.public.pem` 才交给客户登记进终端：

```sh
snap-rail-plugin verify dist/@you__plugin.zip --public-key .keys/my-key.public.pem --key-id my-key
```

客户端的信任根位于 `<home>/trusted-release-keys.json`（∪ 出厂
`resources/trusted-release-keys.json`，本机按 keyId 覆盖），它不在插件池中，
因此插件不能通过安装自身来授权自身；安装流程也永不自动写信任文件——用户
验证过你的插件后手工登记你的公钥，此后你的更新即有完整性锚。文件形状：

```json
{
  "keys": [
    {
      "keyId": "my-key",
      "publisher": "my-company",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----\\n...\\n-----END PUBLIC KEY-----"
    }
  ]
}
```

## 发布为滚动 Release（自持源）

没有集中市场上架流程：你的仓库就是发布源。

1. 用你自己的密钥签好 zip，产出 `index.json` + `*.zip`（`snap-rail-plugin
   pack` 或你仓库的 pack 脚本）；
2. 发布到本仓固定 tag `feed` 的滚动 Release（资产平铺，删旧建新）；
3. 给仓库打 GitHub topic **`snap-rail-plugin`**——这就是发现入口；
4. 用户把你的 Release 地址加进终端「插件页 → ⚙ 插件源」：
   `https://github.com/<you>/<your-plugin>/releases/download/feed/`。

工作流模板见 `docs/plugin-publish-ci.yml`（复制到你仓库的
`.github/workflows/publish.yml`，secret 只需 `RELEASE_PRIVATE_PEM` 与
`RELEASE_KEY_ID`）。官方**不**维护聚合仓、**不**转存你的 zip、**不**需要
PR 上架；任何第三方聚合列表都只是发现层，完整性锚仍是你的签名。

`index.json` 条目携带包名、版本、文件名（或指回你 Release 的绝对 `url`——
联邦形态）、sha256、size、签名 key id 和元数据。客户端同场文件名解析到该
条目所属 feed 根地址（多源搜索合并、条目带来源标签），用户手填的直链地址
走 `plugins.inspect-from-url`，有界且同样过三态签名判定。

## 组合包（可选）

组合包是离线交付单位：`<id>.zip` 根目录 `recipe.yml`（`id`/`version`/
`title`/`kind`/`plugins`，与 `plugins.yml` 同形的插件行）+ `plugins/*.zip`
（每个被引用包一个成员 zip）+ 可选 `readme.md`。把它和插件 zip 一起放进同一
个 Release 即可；终端按内容识别，拖入后批量安装成员并写入组合预设。组合包
本身不签名，成员 zip 必须各自带签名。

## 本地验证

```sh
pnpm build
snap-rail-plugin inspect dist/<zip>        # 预览身份/依赖/签名
snap-rail-plugin verify dist/<zip> --public-key .keys/my-key.public.pem --key-id my-key
pnpm exec tsx scripts/verify-plugin-feed.ts --feed dist-plugins --trust .keys/my-key.trust.json
```

`verify-plugin-feed`（主仓脚本；也可复制进你的仓）会逐个校验目录条目的
sha256/size、manifest 身份和签名；若目录同时带 `catalog.json`，还会校验组合
包 `recipe.yml` 严格可解析、成员 zip 与 feed 发布字节一致。
