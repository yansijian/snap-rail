# 排错对照表

先跑 `pnpm run doctor`，再对号入座。doctor 的红 = 契约违约（必须修），
warning = 建议（放行但要逐条确认）。

## doctor 会拦下的事

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| `doctor: package.json 不存在` / `缺少 tsconfig.json / tsdown.config.ts / AGENTS.md` | 不在插件仓根目录跑，或仓库被手工裁剪 | 在仓库根目录跑；别删 init 生成的契约文件（AGENTS.md 是仓库规范，doctor 会查它存在） |
| `doctor: clientOnly 插件必须声明 snapRail.client.entry` | 纯渲染包没写渲染面入口 | manifest 补 `"client": { "entry": "lib-client/client.js" }` |
| `doctor: Host 插件必须在 package.json.main 声明宿主入口` | 宿主面没声明 `main` | 补 `"main": "lib-host/host.js"` |
| `doctor: requires 条目不合法：<条目>` | requires 里混进了包名之外的写法 | 只允许 包名 / `name@range` / `service:id` 三种形态 |
| warning `宿主入口尚未构建` / `渲染入口尚未构建` | 还没 `pnpm run build` | 先 build；不 build 的 pack 会被拒 |
| warning `渲染面插件应声明框架绑定` | 有 `client` 块但 requires 没有 `name@range` 条目 | UI 包补框架绑定 `@snap-rail/framework-shadcn@^0.2`（绑定即生态依赖） |
| warning `@snap-rail/* 命名空间…社区包请使用你自己的 scope` | 包名冒用官方命名空间 | 换成自己的 scope（`@snap-rail/*` 无论策略强制 verified，装不上） |

## 构建期

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| 「种子默认导入」构建硬错 | `import x from '@snap-rail/framework-shadcn/ui'` 这类 default 导入 | 改 `import { … } from` 或 `import * as`——CJS interop 下 default 导入运行时即崩，护栏故意硬错 |
| pack 报 missing its host face | 先 build 后 pack 的顺序反了，或 `main` 与产物不一致 | `pnpm run build`；确认 `main` = `lib-host/host.js`（模板默认） |
| 渲染面构建后无法 require 框架组件 | import 到的**框架/其他插件贡献**种子没进 manifest `externalSeeds` | 每个贡献子路径（`/slots` `/semantic` `/ui`…）都要在 `client.externalSeeds` 里声明；base 种子（connection/protocol/util/shell-contract）不写 |
| `clientBundle` 打进 node 侧代码报错 | client bundle 里 import 了宿主入口 / node-only 模块 | 跨端消费类型/schema 走 `./contract` 纯面；宿主实现永不进渲染图 |
| 构建警告 `Could not resolve 'zod'`（契约模块） | 契约 import 了 zod，但没放 `dependencies` | `pnpm add zod`；契约是 host value import，app 的 resolve-hooks 会外部化 zod |
| `Cannot find module '@snap-rail/plugin-sdk/api'` | SDK 低于 0.2.5，没有作者 API 门面 | 升级 `@snap-rail/plugin-sdk` 到 `^0.2.5`；宿主类型从 `/api`、渲染 link/帧从 `/api/client` 取 |
| `Property 'rpc' does not exist on type 'Context'` | 没引入 gateway 类型增强 | `import type { GatewayService } from '@snap-rail/plugin-sdk/api'`；不要直接 import gateway |
| `Property 'client' does not exist on type 'Context'` | 没引入框架 runtime 的 `Context` 增强 | `import type {} from '@snap-rail/framework-shadcn/runtime'`（type-only，不产生运行时代码） |
| `Cannot find module '@snap-rail/connection'` | 绕过 SDK 直接 import 了未单列的包 | 改用 `@snap-rail/plugin-sdk/api/client`；确实要直接用时才加 devDependency |
| `Cannot find module '@snap-rail/client-kernel'`（框架 d.ts 里） | 框架 d.ts 引用了未发布的内部包 | `skipLibCheck` 会跳过；不要直接 import kernel，需要 `ClientHandle` 从框架 runtime 的 re-export 取 |

## init / 安装依赖

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| `pnpm dlx … init` 报 `404` / `ETARGET` | npmmirror 同步有分钟到小时级延迟 | `npm config set registry https://registry.npmjs.org/` 后重试，完事可切回 |
| 装到的版本比官方 npm 旧（如 `^0.2.1` 解析出 0.2.1 而非 0.2.2） | 镜像元数据滞后：同步期内解析不到新版本 | 切官方 registry 重装（`npm config set registry https://registry.npmjs.org/`），再判断是真缺还是没同步 |
| `init: <目录> 不是空目录` | 目录已有 package.json 或 src | 换目录或确认后 `--force` 覆盖 |
| `init: --framework applies to …` | 对非 UI 模板传了 `--framework` | 该参数只对 `ui-view` / `ui-layout` / `ui-extension` / `suite` 生效 |
| install 报未发布包 E404 | 旧模板把未发布的内部包写进了 peer | 升级 SDK：`pnpm dlx @snap-rail/plugin-sdk@latest init` 重新生成 |
| 运行 CLI 弹「选择应用打开 .js」 | SDK 0.2.2 及更早缺 shebang | 升级到 0.2.3+；临时用 `node node_modules/@snap-rail/plugin-sdk/lib/cli.js` |
| `pnpm install` 报 `ERR_PNPM_IGNORED_BUILDS`（pnpm ≥10） | 依赖的构建脚本默认不跑（esbuild 等） | 按提示把 `pnpm-workspace.yaml` 的 `allowBuilds.<pkg>` 改成 `true`（pnpm 10 用 `onlyBuiltDependencies`），或跑 `pnpm approve-builds` |
| `pnpm exec tsc` 报 not found | 模板只带 tsdown，不带 typescript | `pnpm add -D typescript` 后再 `pnpm exec tsc --noEmit`；tsdown 只转译不检查类型 |
| 改 package.json 依赖段后 install 挂死 | 弱网/受限环境下 lockfile 重解析的元数据请求超时 | 避免频繁动依赖段；离线机器用 `--offline` 与本地 registry 镜像 |

## 构建产物

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| host.js 上百 kB | 契约包在 devDependencies 被内联，或入口 value 导入了 plugin-sdk（definePlugin） | 契约包挪进 dependencies；入口改 `satisfies Plugin` + type-only 导入（见 host-face.md 构建纪律） |
| client bundle 体积异常 / 含 node 内置 | 渲染面 value import 了 settings/gateway，或入口 value import plugin-sdk | 宿主包只 type-only；入口用 `satisfies Plugin`；宿主 link/帧走 SDK `/api/client` |
| zip 里混进已删代码的旧 chunk | hostBundle 不清产物目录、pack 整目录收编 | 重发布前清空 `lib-host/`、`lib-client/`、`dist/` 再 build/pack |
| manifest 类型/schema 拒绝 `client.surfaces` / `probe` 等字段 | 两个来源：安装版确实旧（plugin-kit <0.2.2 / equipment <0.1.5），或 `plugin-sdk@0.2.3` 的内联类型按旧 schema 生成 | 升级 `@snap-rail/plugin-sdk` 到 0.2.4+、`@snap-rail/equipment` 到 0.1.5+；仍被拒就查镜像是否给了旧版（见上「装到的版本比官方 npm 旧」），并以安装的 d.ts 为准先不写该字段 |

## 运行期（装进终端后）

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| 安装预检列 `missing` | requires 的包没装/没启用 | 先装依赖包（如设备底座、框架），再启用本包 |
| 启用被拒：`缺少贡献面：@snap-rail/shell/contract（提供方未安装）` | 把 base 种子写进了 `client.externalSeeds` | 删掉该条；base 种子由 shell 自动播种，不进 externalSeeds |
| 启用被拒：版本不合 | `name@range` 与已装版本冲突 | 放宽 range 或升级依赖包 |
| 卸载/禁用被拒 | 还有别的包依赖它 | 先停用依赖方 |
| 管理页找不到我的包 | clientOnly 行不在宿主树 | 正常：纯渲染包经渲染端下发行展示；检查 `client-config.list` |
| 分类落「其他」 | 没声明 `category` | manifest 补 `category`（开放词汇，声明即归组） |
| 驱动表单没有字段 | zod 字段缺 `.meta({ title })` | 每个字段补 `.meta({ title: '中文标签' })`，SchemaForm 才有得渲染 |
| 「测试连接」按钮不存在 | 驱动没实现 `probe`，或安装的 equipment 版本类型里还没有 probe（发布滞后） | 先按 SKILL.md「已知发布滞后」查安装的类型；有字段再实现 |
| 球拖到边缘拽不回来 | 收起形态没自留拖拽区 | collapsed 形态加 `-webkit-app-region: drag` |
| 球阴影出现灰色硬边 | 用了 `box-shadow`（被窗口边界切） | 改径向渐变画进 8px 余量并衰减到零 |
| 退出确认框 10s 后自己退了 | 渲染面没应答 `shell.exit.resolve` | 确认订阅 `shell/exit-requested` 并应答；10s 兜底是设计行为 |
| 通知没弹出来 | 触发全局节流（5 条/10s）或超 `SHELL_LIMITS` | 看 `{applied:false, reason}` 返回值；同 tag 合并、控制频率 |
| 更新了但自动更新没生效 | 版本号没变，或换 key 触发 keyChanged 拦截 | 升版本号重发；换 key 走手动更新确认 |

## 自检顺序（卡住时）

1. `pnpm run doctor` —— 红的一定要修；
2. `pnpm exec snap-rail-plugin inspect dist/<包名>.zip` —— 确认 zip 里
   的面/签名/manifest 与预期一致；
3. 对照 [manifest.md](manifest.md) 核字段、
   [client-face.md](client-face.md) 核种子；
4. 还不行：最小复现（init 一个干净模板 + 只贴你的 diff），看是模板升级
   引入还是自己的改动引入。
