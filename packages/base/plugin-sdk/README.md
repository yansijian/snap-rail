# @snap-rail/plugin-sdk

**snap-rail 插件的公共开发套件** —— 在你自己的仓库里开发、验证、构建、签名、
发布 snap-rail 插件，不需要克隆 snap-rail 源码。

The public authoring surface for [snap-rail](https://github.com/yansijian/snap-rail)
plugins: an `init` scaffold for all eight plugin shapes, a `doctor` for the
repository contract, the release packer, and the Ed25519 signing helpers —
everything an independent plugin repository needs, from public npm only.

## 快速开始 / Quick start

需要 Node 22+ 与 pnpm（或 npm）。

```sh
pnpm dlx @snap-rail/plugin-sdk init my-driver --template driver
cd my-driver
pnpm install
pnpm build
```

国内镜像（npmmirror）同步新版本有延迟；`pnpm dlx` 报 `404` / `ETARGET`
时临时切公共 npm 重试：`npm config set registry https://registry.npmjs.org/`。

生成的仓库自带：`package.json`（manifest + 依赖已配好）、`src/` 骨架、
`tsdown.config.ts`、`tsconfig.json`、一个能通过的冒烟测试、`.gitignore`，
以及最重要的 **`AGENTS.md`** —— 插件仓库的短规范，AI 辅助开发时喂给
Agent 即可，无需阅读 snap-rail 源码。

## 模板 / Templates

| template | 面 | 产物 |
| --- | --- | --- |
| `driver` | 宿主 | 设备驱动（纯协议适配器，注册进 `ctx.equipment`） |
| `store-provider` | 宿主 | 存储后端实现（全局单活 `store-backend`） |
| `host-service` | 宿主 | 宿主服务（注册能力 / wire 方法与帧） |
| `tool` | 宿主 | 独立工具（工具互不依赖） |
| `suite` | 双面 | 业务套件（场景私有宿主逻辑 + 场景界面，单活） |
| `ui-view` | 渲染 | 一个挂进 `shell.view` 的界面（React + 框架原语） |
| `ui-layout` | 渲染 | 布局（接管槽位编排） |
| `ui-extension` | 渲染 | 共享组件贡献（`client.seeds`，供其他组件插件复用） |

UI 模板默认绑定 `@snap-rail/framework-shadcn@^0.2`；`--framework
<package[@range]>` 可换绑（框架绑定就是 manifest `requires` 里的一条
`name@range`，没有独立的 framework 字段）。

## CLI / 命令

```
snap-rail-plugin init <dir> --template <t> [--framework <pkg[@range]>] [--force]
snap-rail-plugin doctor <dir>                  # 发布前契约自检
snap-rail-plugin pack <dir> --out dist --sign-key key.pem --key-id my-key
snap-rail-plugin feed <dir>                    # 由已签名 zip 产出 index.json
snap-rail-plugin inspect <zip>                 # 身份/面/签名概览
snap-rail-plugin verify <zip> --public-key pub.pem --key-id my-key
```

发布 = 签名 zip + `index.json` 平铺上传到**你自己仓库**的滚动 Release
（tag `feed`），仓库打上 GitHub topic `snap-rail-plugin` 即被发现——
没有集中市场、没有 PR 上架，你的 Release 就是你的插件源。

## 作者 API 门面 / Authoring API

宿主面服务类型与渲染面 link/帧助手都从 SDK 子路径导入，不需要单独安装底层包：

```ts
import type { GatewayService, SettingsService } from '@snap-rail/plugin-sdk/api'
import { subscribeFrame, rpcErrorText } from '@snap-rail/plugin-sdk/api/client'
```

底层 `@snap-rail/gateway` / `@snap-rail/connection` / `@snap-rail/settings` 是
SDK 的 dependencies 与终端 base 运行时，不是可安装插件：不要写进
`requires` 或 `client.externalSeeds`。

## 公共闭包 / The public closure

独立插件仓库的直接作者依赖：

`@snap-rail/plugin-sdk`（含 `/api` 与 `/api/client`）、`@snap-rail/protocol`
（wire 契约）、`@snap-rail/store`、`@snap-rail/equipment`、
`@snap-rail/cordis`、`@snap-rail/cosmokit`；UI 模板另需
`@snap-rail/framework-shadcn`。

`@snap-rail/gateway` / `@snap-rail/connection` / `@snap-rail/settings` 由
SDK 传递安装，作者不需要在 `package.json` 里单列。

## 签名与信任 / Signing & trust

发布者用 Ed25519 私钥签名发行 zip（`META-INF/release.json` + 每文件
SHA-256 摘要）。终端安装门三态：受信 key → verified；无签名 / keyId 未
登记 → unverified（默认放行 + 显著警告与二次确认）；验证失败 = 篡改证据，
硬拒。`@snap-rail/*` 命名空间无论策略必须受信签名。用户把你的
`.public.pem` 登记进本机信任文件后，你的后续更新即有完整性锚（换 key 会
被单独确认）。

## 文档 / Docs

- 官网《插件开发》：https://www.snap-rail.top/dev.html
- 仓库文档：https://github.com/yansijian/snap-rail/blob/master/docs/plugin-development.md
- 发布工作流模板：`docs/plugin-publish-ci.yml`（复制进你自己的仓库）

## License

Apache-2.0
