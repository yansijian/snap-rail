# 发布：签名、feed、滚动 Release 与信任模型

## 本地命令全解（`snap-rail-plugin` CLI，随 `@snap-rail/plugin-sdk` 安装）

| 命令 | 作用 |
| --- | --- |
| `doctor <目录>` | 校验仓库契约（manifest、requires 形态、构建入口落盘）。红 = 契约违约（阻断），warning = 建议（放行）。 |
| `pack <目录> --out dist --sign-key <pem> --key-id <id> [--publisher <名>]` | 装配并签名发行 zip。**拒绝无签名**（缺 key 参数直接报错）；输出 sha256 与 size。zip 内容 = 精简 manifest + 构建面，永不带 src。 |
| `feed <zip目录> [--out <目录>] [--repository <url>]` | 读目录内**已签名** zip，产出 `index.json`（条目含包名/版本/文件名/sha256/size/签名 keyId）。拒绝未签名 zip 与重名包——**同目录每个包名只留最新版**。 |
| `inspect <zip>` | 身份、面、文件数、签名 keyId 概览（无需公钥）。收货方快速查验用。 |
| `verify <zip> --public-key <pem> --key-id <id>` | 用发布者公钥完整验签（摘要/身份/publisher）。 |

npm scripts 里 init 已预置 `doctor` / `pack` / `feed`（pack 的 key-id 记得
改成自己的）。

## zip 里有什么

- 精简 manifest：`main` 指宿主面（clientOnly 包指 client 入口）+ `exports`
  只保留落在面目录内的子路径映射。
- 构建面目录：`lib-host/`、`lib-client/`。
- `META-INF/release.json`（身份/时间/publisher）+ `META-INF/signature.json`
  （Ed25519 签名 + 每文件 SHA-256 摘要）。
- **没有** `src/`、`node_modules`、私钥。

注意：宿主面运行时 `@snap-rail/*`、`zod`、`drizzle-orm` 由终端按 appRoot
优先、池内回退解析（这些包不随 zip 分发）；其余第三方库已被打进 bundle。
所以 devDependencies 里的契约包**不进 zip**，dependencies 也一样——别指望
zip 带库。

## 发布者身份（一次性）

```sh
openssl genpkey -algorithm ed25519 -out .keys/release.private.pem
openssl pkey -in .keys/release.private.pem -pubout -out .keys/release.public.pem
```

- 没有 openssl 的 Windows 用 Node 等价生成：
  `crypto.generateKeyPairSync('ed25519')`，私钥导 pkcs8 PEM、公钥导 spki
  PEM。
- **私钥只留在发布机与 CI secret**；`.public.pem` 交给客户登记进终端。
- keyId 是稳定标识（如 `my-key`）：换 key 是大事件（见 keyChanged）。

## 信任模型（客户侧怎么判你的包）

安装门三态：

| 状态 | 条件 | 结果 |
| --- | --- | --- |
| **verified** | keyId 在客户信任根里且验签通过 | 正常安装 |
| **unverified** | 无签名或 keyId 未登记 | 默认放行 + 显著警告 + 额外风险确认；`plugins.signaturePolicy: 'strict'` 的现场直接拒 |
| **硬拒** | 验签失败 | = 篡改证据，任何策略都拒 |

- 客户信任根 = 终端数据目录 `trusted-release-keys.json` ∪ 出厂 trusted
  keys，按 keyId 本机覆盖；文件住池外，**安装流程永不自动写信任文件**。
- `@snap-rail/*` 命名空间无论策略必须 verified——冒名官方命名空间装不上。
- **keyChanged 锚定**：feed 条目的签名 key 与已装包不同 → 后台自动更新跳
  过，手动更新先弹密钥变更确认。所以尽量别换 key；必须换时提前公告。

## 发布 = 你仓库的滚动 Release

1. `pack` 出签名 zip，`feed` 出 `index.json`；
2. 把 `index.json` + 全部 zip **平铺**上传到你仓库固定 tag **`feed`** 的
   Release（每次发布**删旧建新**，滚动）；
3. 给仓库打 GitHub topic **`snap-rail-plugin`**——这就是发现入口；
4. 用户把
   `https://github.com/<you>/<repo>/releases/download/feed/`
   加进终端「插件页 → ⚙ 插件源」。

- 没有集中市场、没有 PR 上架、官方不转存你的字节；任何聚合列表只是发现层，
  完整性锚永远是你的签名。
- `index.json` 条目可用绝对 `url` 指回你的 Release（联邦形态）；客户端下载
  先验哈希。
- 用户手填直链安装走 `plugins.inspect-from-url`（有界 + 同样过三态判定）。
- 同目录同名 zip 覆盖前确认版本号真的变了；旧版本想留档就删掉本地 dist 或
  归档到别处，feed 目录里永远只有最新。

## CI 自动发布

官方工作流模板
<https://github.com/yansijian/snap-rail/blob/master/docs/plugin-publish-ci.yml>
复制进你仓库的 `.github/workflows/publish.yml`；secret 只需
`RELEASE_PRIVATE_PEM` 与 `RELEASE_KEY_ID`。打 tag（如 `v1.0.0`）即构建、
打包、签名、更新滚动 Release。

## 组合包（combo，可选）

一次交付一组插件（离线/整厂部署用）：

- zip 根目录 `recipe.yml`：`id` / `version` / `title` / `kind` /
  `description` / `plugins`（行与 `plugins.yml` 同形，子路径行归其包）；
- `plugins/` 下每个被引用包一个**已签名**成员 zip；
- 可选 `readme.md`；**没有 `bundle.json`；组合包本身不签名**（信任随成员
  走，任一成员 unverified 就多一步组合级确认）。
- 客户端按内容识别：根有 `package.json` 且无 `recipe.yml` = 插件；有
  `recipe.yml` 且无 `package.json` = 组合；两者都有/都没有 = 报错。
- 安装 = 一个池事务装齐缺失/需更新成员 + 原子写 `<home>/presets/recipe-<id>.yml`
  并热应用；删预设文件即停用（没有组合管理 UI）。
- 和插件 zip 放进同一个 Release 即可。

## 用户侧验证回路（发布后自己做一遍）

1. 找一台干净终端（或测试 home），把你的 feed 地址加进插件源；
2. 搜索 → 安装 → 启用，观察 requires 预检与管理页分组（`category`
   原文归组、`title` 行上标题）；
3. 禁用/卸载一次，确认反向预检与数据清理行为符合预期；
4. 更新一个版本，确认滚动 Release 的自动更新与 keyId 锚定路径通畅。
