# 部署：插件源、组合包与更新源（滚动 Release / Gitea / GitHub）

snap-rail 的线上存在是**纯静态**——插件源、离线组合包与应用更新源就是一组
普通文件，服务器零逻辑，所有校验都在终端侧完成。发布形态是**滚动
Release**：一个固定 tag（默认 `feed`）的 Release 资产，每次发布删旧建新，
资产**平铺**（`index.json`、`catalog.json`、`*.zip`、`latest.yml`、`setup.exe`
同级），因此**一个基址同时服务插件源与应用更新源**。两类目标同机制（下载
URL 形状一致，终端换源只改设置键）：

- **Gitea**（内网基准）：`http://<gitea>/<owner>/<repo>/releases/download/feed/<file>`
- **GitHub**（公网发布）：`https://github.com/<owner>/<repo>/releases/download/feed/<file>`

未来迁云（OSS+CDN 等）只换发布目标与 feed 地址，客户端零改动（feed 地址
是设置键，热切换）。

## 一次性准备

1. 建仓（GitHub 公网 owner `yansijian`；内网 Gitea owner `snap-rail`；可同时配多目标）；
2. 建一个对该仓有写权限的 token（GitHub: repo 权限 classic token 或
   fine-grained Contents:write），经环境变量 `GITEA_TOKEN` / `GITHUB_TOKEN`
   （或配置里各 target 的 `token` 字段）提供给发布机；
3. 复制 `deploy.config.example.json` 为 `deploy.config.json`：

```json
{
  "targets": [
    { "kind": "gitea", "url": "http://192.168.1.9:3000", "owner": "snap-rail", "repo": "snap-rail" },
    { "kind": "github", "owner": "yansijian", "repo": "snap-rail" }
  ],
  "feedTag": "feed"
}
```

4. org 签名密钥（一次性）：`pnpm run plugin:generate-key -- .keys <key-id>
   --publisher snap-rail`；公钥随应用出厂（`apps/desktop/resources/
   trusted-release-keys.json`），私钥只存发布机与 CI secret。
5. 公网发布：`.github/workflows/feed.yml` 会自行启用 GitHub Pages（source =
   **GitHub Actions**）；仓库 secret 需配 `RELEASE_PRIVATE_PEM`（base64
   私钥）、`RELEASE_KEY_ID`、`RELEASE_PUBLISHER`、`NPM_TOKEN` 四个。
   `feed.yml` 是滚动 Release 与官网的唯一写者；`release.yml` 只做版本化
   Release 并在安装包上传后触发 feed；`npm.yml` 在配置 `NPM_TOKEN` 后手动
   触发，发布公开 SDK。
6. **拆分仓进入工作区**：主仓 `equipment-station` 的构建期依赖（framework /
   driver-modbus）以 workspace 链接提供，CI 在 install 前执行
   `node scripts/setup-external.mjs`（克隆到 `external/`，可用
   `SNAP_RAIL_EXTERNAL_REF` 固定 ref）——**公开构建不需要任何私有
   registry**。feed 作业把 `SNAP_RAIL_EXTERNAL_REPOS` 扩到四个仓
   （framework / modbus / enip / suite），从源码构建并签名全部一方插件；
   主仓应用构建仍只 stage 前两个。本地首次构建同样先跑这条命令；
   `external/` 已 gitignore。

## 发布：一条命令

```sh
# 可选：本地先收一方拆分仓产物（GitHub feed 自己从源码打包，不需要这步）
pnpm run collect:feed -- --from collect-dl --provider github
pnpm run publish -- --collect collect-out \
  --sign-key .keys/<key-id>.private.pem --key-id <key-id> --publisher snap-rail
```

publish 依次：构建 → 打包一方插件 zip（Ed25519 签名）→ 合并 `--collect`
目录里的一方拆分仓 pack 产物 → 装配离线组合包（`<id>.zip`：`recipe.yml` +
`plugins/*.zip`，成员取 feed 里的原样 zip）→ 汇总平铺资产（`plugins/` 全部
平面文件 + `desktop/` 三件套；组合截图 `assets/` 只进本地 staging 供官网构建，
不上 Release）→ 对每个 target 删旧 Release 与 tag、重建并逐个上传资产。

| 通道 | settings 键 | 地址 |
| --- | --- | --- |
| 应用更新 | `update.feedUrl` | `<基址>/releases/download/feed/` |
| 插件源 | `plugins.feedUrls`（列表；旧 `plugins.feedUrl` 读作单元素） | 同上一地址（平铺同址） |

- `--skip-sync`：只在本地 `dist-publish/` 装配，不上传；
- `--collect <dir>`：合并**一方**拆分仓（framework/driver/suite）的 pack
  产物（`index.json` + zip），可重复。社区插件**不**走这里——作者在自己的
  Release 发布，用户自行添加源；
- `--feed-tag <t>`：覆盖滚动 tag（默认 `feed`）。

### 出厂默认源（CI 盖章）

`apps/desktop/resources/defaults.json` 携带 `plugins.feedUrls` 出厂默认
（仓库里的默认值是公网 GitHub 滚动 Release；内网构建现场盖章）。CI 打包
桌面应用前执行：

```sh
pnpm exec tsx scripts/stamp-feed-default.ts https://github.com/<owner>/<repo>/releases/download/feed/
# 内网 CI 同时把 electron-builder.yml 的 publish.url 改成同一基址
```

新装机零配置即可搜索安装插件（用户后续在「插件页 → ⚙」编辑的源列表存本机
`settings.json`，优先于出厂默认）。

### 验证（发布后、指终端前）

```sh
pnpm exec tsx scripts/check-feed-endpoint.ts \
  --update <基址>/releases/download/feed/ \
  --plugins <基址>/releases/download/feed/
pnpm run verify:feed -- --feed dist-publish/plugins --trust apps/desktop/resources/trusted-release-keys.json
```

`check-feed-endpoint` 核对 feed 文件字节一致（zip 的 sha256/size 对清单）、
latest.yml 是 electron-builder 清单而非错误页伪装 200、安装包支持 Range（决定
blockmap 差量下载可用性）。`verify:feed` 逐个校验插件 zip 的摘要/大小/签名；
当 feed 同时带 `catalog.json` 时，也会逐个校验组合包：`recipe.yml` 严格可解析、
成员 zip 与 feed 发布的同名 zip 字节一致。通过后把终端的插件源设置键指过来
（应用更新键同址），走一次「检查更新」「搜索安装一个插件」「拖入一个组合包」
即完成验收。

### 官网

```sh
pnpm run site:build
# = gen-website-catalog → copy-site-assets → vite build（产物 website/dist）
```

- `SNAP_RAIL_FEED_BASE`、`SNAP_RAIL_REPO_URL` 覆盖生成数据里的下载基址与源码
  地址（默认公网 GitHub）；内网构建可指向 Gitea 镜像；
- GitHub Pages 由 `feed.yml` 在每次滚动发布后自动部署（artifact =
  `website/dist`），资源路径全是相对路径，项目页子路径也能直接用；
- 页面上的插件卡片下载 `FEED_BASE + <zip 文件名>`，组合卡片下载
  `FEED_BASE + <id>.zip`——官网只做下载入口，不代理安装。

### 应用更新（不跑 publish 时）

```sh
pnpm run build && pnpm app:dist
# 产物在 apps/desktop/release-out/；publish 自动把三件套并入 staging。
# 手工发布则把 latest.yml + setup.exe + blockmap 作为 Release 资产上传。
```

注意：`electron-builder.yml` 的 `publish.url` 是打包进终端的内置缺省更新源
（仓库默认公网 GitHub；内网 CI 在打包前盖章为本机 Gitea）；部署现场随时可用
`update.feedUrl` 覆盖，无需重打包。

## 信任模型（签名是身份锚与防篡改，不是准入门槛）

签名的诚实价值有三条：**完整性**（直链安装无目录 sha256，签名是唯一防
传输篡改锚）、**更新链锚定**（装过的发布者，后续更新包应同 keyId）、
**可追责的发布者身份**。它不是恶意代码防线——恶意但签名合法的插件照样
危险，那要靠安装预览的权限/来源展示和客户自己的验证。

- **两层信任文件**：出厂 `apps/desktop/resources/trusted-release-keys.json`
  （随应用分发，新装机零配置可验 org 签名）∪ 本机
  `<home>/trusted-release-keys.json`，本机按 keyId 覆盖（含 publisher remap）。
  文件住在插件池外——**插件永不给自己授权**；安装流程**永不自动写信任
  文件**，登记某个作者的公钥只能由人手/管理面完成。
- **安装门三态**：受信 key 的签名 → `verified`（digest/身份/publisher 全
  验，任何失败=篡改证据，硬拒）；无签名或 keyId 未登记 → `unverified`。
  默认 `open` 策略放行 unverified——安装预览显著展示「未验证 · keyId …/
  未签名」，且多一步明确的风险确认。受控现场可设
  `plugins.signaturePolicy: 'strict'`（settings 或出厂 defaults 层）恢复
  「只认受信签名」。
- **命名空间**：`@snap-rail/*` 包名无论策略必须 verified——社区包冒充不了
  官方（org 自发件全部带 org 签名，不受影响）。
- **更新 keyId 锚定**：feed 条目的签名 key 与已装包携带的 key 不同
  （`keyChanged`）→ 后台自动更新跳过该包，手动更新先弹「发布者密钥已变更」
  确认。客户验过某社区作者后把其公钥加进本机信任文件，该作者后续更新即有
  完整性锚。
- **轮换**：新 key 的公钥随下一版应用出厂（更新内置信任文件），过渡期
  feed 同批用新旧两钥签名或分批重签；终端 `settings.json` 层永不自动改写。
- **组合包的信任**：组合 zip 本身**不签名**（它只是容器）——每个成员 zip
  保留自己的发布签名，安装时逐个过上面的安装门；预览里逐成员显示三态，
  任一成员 unverified 就多一步组合级风险确认。

## 组合包（离线安装单元）

组合 = 「哪几个插件放在一起、实现什么效果」的可分发答案，也是内网首选的
交付单位：

- **源**：主仓 `recipes/<id>/`（一方首发）；组合是 `recipe.yml` 一份清单
  （`id`/`version`/`title`/`kind`/`description`/`plugins`），发布时装配成
  `<id>.zip`。
- **zip 形状**：根目录 `recipe.yml` + `plugins/*.zip`（每个被引用的真实包名
  一个成员 zip，子路径行如 `@snap-rail/equipment/rpc` 归属其包
  `@snap-rail/equipment`）+ 可选 `readme.md`；没有 `bundle.json`。
- **识别**：客户端按内容判定——根目录 `package.json` 且无 `recipe.yml` =
  插件；根目录 `recipe.yml` 且无 `package.json` = 组合；两者都有/都没有 = 报错。
- **落地**：`plugins.inspect` 返回组合预览（成员版本/签名/动作、缺失依赖），
  确认后 `plugins.install-combo` 在一个池事务里安装缺失或需更新的成员（已装
  同版本或本机更新版本保留），全部成功后原子写
  `<home>/presets/recipe-<id>.yml`；任何失败恢复池与旧预设。
- **移除**：不提供组合管理 UI。删除对应预设文件即停用组合；池里的插件包
  按普通插件逐个卸载。
- **社区组合**：作者把自己的组合 zip 放进自仓 Release 即可；官网/README 给
  下载链接，不经过任何官方仓库。

## 社区发布模型（自住仓库 + 自持钥，去中心化）

- **发布**：插件住**作者自己的仓库**，用**作者自己的 Ed25519 密钥**签名
  （CI secret 自持），发布为自仓的滚动 Release（工作流模板
  `docs/plugin-publish-ci.yml`，复制进自己仓库 `.github/workflows/publish.yml`）。
  Release 地址即一个插件源：`https://github.com/<author>/<plugin>/releases/
  download/feed/`——终端 ⚙ 添加后即可搜索安装与版本 pill 更新。
- **发现**：GitHub topic `snap-rail-plugin`——给仓库打 topic 即完成"注册"，
  零门槛、代码不出仓。官方**不维护集中市场仓、不做 PR 上架、不转存 zip**；
  官网只解释发现方式与提供 topic 链接。
- **SDK 分发**：`@snap-rail/plugin-sdk`、`plugin-kit`、`util`、`protocol`、
  `store`、`equipment` 与 vendored Cordis 发布到公共 npm；
  `snap-rail-plugin` CLI 随 SDK 安装。作者仓库不依赖本仓源码。
- **诚实的信任声明**：topic 只是发现层；真正的锚是**作者公钥进本机信任
  文件**——客户验证过作者一次，该作者此后的一切更新都有完整性锚，换 key 的
  更新会被单独拦下确认。
- **命名门禁**：`@snap-rail/*` 命名空间由终端强制 verified（见信任模型节）
  ——社区包用作者自己的 scope/name；基座兼容以 `requires`（框架条目即生态
  绑定）展示。
- **一方侧不变**：主仓发布链照旧 org 强制签名、照旧出厂内置 org 公钥；
  主仓保持出厂纯净，社区内容零进入。

## 终端侧行为

- **插件页**（设置 → 插件，融合页）：三合一输入（本地路径/网络地址/拖拽
  → 预览确认安装；非地址文本 → 全部已配源合并搜索，行带来源标签）；组合包
  同样走拖拽/选择文件，预览按成员列出；版本列即更新交互（可更新时绿色 pill
  点击即更新；keyChanged 的更新先弹密钥变更确认）；⚙ 小图标维护源列表。
- **预览的签名行**：`✓ 已验证 · <publisher>` / `⚠ 未验证 · keyId …（未登
  记）` / `⚠ 未签名`（直链加注「无完整性校验」）；unverified 的安装多一步
  「我知晓风险，仍要安装」。组合包逐成员显示同样的三态。
- **地址直装**：`plugins.inspect-from-url` 是唯一接受客户端自选 URL 的
  面——有界（仅 http(s)、超时、大小上限）；无目录 sha256，完整性全靠签名
  （无签名 = 无任何完整性校验，预览会写明）。
- **目录安装**：安装走与本地 zip 完全相同的管线（manifest 校验 → 仅严格
  更高版本可覆盖 → 热重组合 → 审计）；`index.json` 条目强制 sha256/size/
  signature.keyId，下载先验哈希；同场 `file` 强制纯文件名，联邦条目的绝对
  `url` 仅 http(s)。

## 迁移与验证清单

- **换目标**：`deploy.config.json` 的 targets 增删即可（多目标同发）；
  终端侧改插件源设置键（应用更新键同址跟随）。
- **内网 → 云**：云上目标追加进 targets；或在云对象存储镜像同一平铺布局，
  终端改键指向；官网用 `SNAP_RAIL_FEED_BASE` 指向镜像后重建。
- 验证顺序应覆盖：本地 zip 安装、组合包拖拽安装（含重复安装/本机更新版本
  跳过/成员缺失拒绝/事务回滚）、URL 直装、搜索安装（多源合并 + 来源
  标签）、联邦 url 条目安装、版本 pill 更新、keyChanged 更新确认、未签名
  zip 的风险两段式、哈希或签名错误、strict 策略拒装、版本回退拒绝、feed
  离线启动和 Host 恢复。
