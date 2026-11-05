# 发布：签名、feed、滚动 Release 与信任模型

## 本地命令全解（`snap-rail-plugin` CLI，随 `@snap-rail/plugin-sdk` 安装）

| 命令 | 作用 |
| --- | --- |
| `doctor <目录>` | 校验仓库契约（manifest、requires 形态、构建入口落盘）。红 = 契约违约（阻断），warning = 建议（放行）。 |
| `dev <目录> [--launch [exe]] [--home <目录>] [--no-watch] [--reset]` | **本地迭代**用（不属于发布链）：持续构建并把产物热同步进终端插件池，免打包免签名；Ctrl+C 恢复原状。细节见 SKILL.md 步骤 3.5 与 docs/plugin-development.md「dev 模式」。 |
| `pack <目录> --out dist --sign-key <pem> --key-id <id> [--publisher <名>]` | 装配并签名发行 zip。**拒绝无签名**（缺 key 参数直接报错）；输出 sha256 与 size。产物名 = 包名把 `/` 换成 `__`（`@my-scope/my-driver` → `dist/@my-scope__my-driver.zip`）。zip 内容 = 精简 manifest + 构建面，永不带 src。 |
| `feed <zip目录> [--out <目录>] [--repository <url>]` | 读目录内**已签名** zip，产出 `index.json`（条目含包名/版本/文件名/sha256/size/签名 keyId）。拒绝未签名 zip 与重名包——**同目录每个包名只留最新版**。 |
| `inspect <zip>` | 身份、面、文件数、签名 keyId 概览（无需公钥）。收货方快速查验用。 |
| `verify <zip> --public-key <pem> --key-id <id>` | 用发布者公钥完整验签（摘要/身份/publisher）。 |

dev 与发布链的关系：dev 副本无签名、无 `seedAbi` 章（渲染端按缺章宽限加载），
**只用于本机迭代**；发布以 `pack` 产物 + `verify` 为准，两者不互相替代。

npm scripts 里 init 已预置 `dev` / `doctor` / `pack` / `feed`（pack 的
key-id 记得改成自己的）。

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
  完整性锚永远是你的签名。出厂默认源
  `https://snap-rail-feed.oss-cn-shenzhen.aliyuncs.com/feed/` **只收一方
  产物**（终端 `plugins.feedUrls` 列表的默认项，用户可追加任意静态源）——
  社区包一律走自己的 Release 地址，不要指望被收进官方源。
- `index.json` 条目可用绝对 `url` 指回你的 Release（联邦形态）；客户端下载
  先验哈希。条目必带 `sha256`（64 hex）/ `size` / `signature.keyId`，`file`
  与 `url` 二选一。
- 用户手填直链安装走 `plugins.inspect-from-url`：只接受 http(s)、下载超时
  120s、单包上限 256 MiB，字节落地后同样过三态判定。
- 同目录同名 zip 覆盖前确认版本号真的变了；旧版本想留档就删掉本地 dist 或
  归档到别处，feed 目录里永远只有最新。

## CI 自动发布

官方工作流模板
<https://github.com/yansijian/snap-rail/blob/master/docs/plugin-publish-ci.yml>
复制进你仓库的 `.github/workflows/publish.yml`；secret 只需
`RELEASE_PRIVATE_PEM` 与 `RELEASE_KEY_ID`。推送到 master（改动涉及
`packages/**`、`scripts/**` 或工作流文件本身）时自动构建、打包、签名、
更新滚动 Release；也可在 Actions 页手动触发（`workflow_dispatch`）。

## 组合包（combo，可选）

一次交付一组插件（离线/整厂部署用）。**CLI 没有 combo 命令**——组合包就是
手打的 zip（任何 zip 工具），schema 可用 `@snap-rail/plugin-kit/recipe` 的
`recipeDocumentSchema` 在脚本里校验：

- zip 根目录 `recipe.yml`（或 `recipe.yaml`）：`id`（`^[a-z0-9-]+$`）/
  `version` / `title` / `kind`（`'base' | 'scenario'`）/ `description?` /
  `plugins`（≥1 行，每行 `{ name, enabled?, config? }` strict，与
  `plugins.yml` 同形；子路径行如 `@x/suite/stats` 归其包）；
- `plugins/` 下每个被引用包**恰好一个已签名**成员 zip（`pack` 的产物原样
  放入），不许多余、重复或缺失；
- 可选 `readme.md` / `README.md`；根目录只允许这三类内容。**没有
  `bundle.json`；组合包本身不签名**（信任随成员走，任一成员 unverified 就
  多一步组合级确认）。
- 上限：组合 zip ≤ 256 MiB，成员解压总量 ≤ 512 MiB。
- 客户端按内容识别：根有 `package.json` 且无 `recipe.yml` = 插件；有
  `recipe.yml` 且无 `package.json` = 组合；两者都有/都没有 = 报错。
- 安装 = 一个池事务只装缺失/需更新的成员（同版本或本机更新者保留）+ 原子写
  `<home>/presets/recipe-<id>.yml` 并热应用；任何失败回滚池与旧预设。删预设
  文件即停用（没有组合管理 UI）。
- **预设引用的包拒绝卸载**（`预设正在使用 <name>，无法卸载`）：用户要卸载
  你的成员包，得先删/改预设文件——交付文档里讲清楚这一步。
- 和插件 zip 放进同一个 Release 即可。

## 用户侧验证回路（发布后自己做一遍）

1. 找一台干净终端（或测试 home），把你的 feed 地址加进插件源；
2. 搜索 → 安装 → 启用，观察 requires 预检与管理页分组（`category`
   原文归组、`title` 行上标题）；
3. 禁用/卸载一次，确认反向预检与数据清理行为符合预期；
4. 更新一个版本，确认滚动 Release 的自动更新与 keyId 锚定路径通畅。
