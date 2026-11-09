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
| warning `渲染面插件建议声明 snapRail.uiProfile` | 有 `client` 块但没声明 `uiProfile` | 补 `uiProfile: native \| integrated \| custom`（管理页徽标，不做门禁） |
| warning `@snap-rail/* 命名空间…社区包请使用你自己的 scope` | 包名冒用官方命名空间 | 换成自己的 scope（`@snap-rail/*` 无论策略强制 verified，装不上） |

## 构建期

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| 「种子默认导入」构建硬错 | `import x from '@snap-rail/ui/components'` 这类 default 导入 | 改 `import { … } from` 或 `import * as`——CJS interop 下 default 导入运行时即崩，护栏故意硬错 |
| pack 报 missing its host face | 先 build 后 pack 的顺序反了，或 `main` 与产物不一致 | `pnpm run build`；确认 `main` = `lib-host/host.js`（模板默认） |
| 渲染面构建后无法 require UI 组件 | `@snap-rail/ui` 是 base 种子，却写进了 `externalSeeds`，或真正贡献种子没写 | `@snap-rail/ui` 子路径不写；其他插件的 `<包>/<子路径>` 才写 |
| `clientBundle` 打进 node 侧代码报错 | client bundle 里 import 了宿主入口 / node-only 模块 | 跨端消费类型/schema 走 `./contract` 纯面；宿主实现永不进渲染图 |
| 构建警告 `Could not resolve 'zod'`（契约模块） | 契约 import 了 zod，但没放 `dependencies` | `pnpm add zod`；契约是 host value import，app 的 resolve-hooks 会外部化 zod |
| `Cannot find module '@snap-rail/plugin-sdk/api'` | SDK 低于 0.2.5，没有作者 API 门面 | 升级 `@snap-rail/plugin-sdk` 到 `^0.3.0`（当前闭包）；宿主类型从 `/api`、渲染 link/帧从 `/api/client` 取 |
| `Property 'rpc' does not exist on type 'Context'` | 没引入 gateway 类型增强 | `import type { GatewayService } from '@snap-rail/plugin-sdk/api'`；不要直接 import gateway |
| `Property 'client' does not exist on type 'Context'` | 没引入 UI runtime 的 `Context` 增强 | `import type {} from '@snap-rail/ui/runtime'`（type-only，不产生运行时代码） |
| `Cannot find module '@snap-rail/connection'` | 绕过 SDK 直接 import 了未单列的包 | 改用 `@snap-rail/plugin-sdk/api/client`；确实要直接用时才加 devDependency |
| `Cannot find module '@snap-rail/client-kernel'`（UI d.ts 里） | 内置 UI 的 d.ts 引用了内部包 | `skipLibCheck` 会跳过；**不要** import kernel——`ClientHandle` 是 app-internal，插件不需要也不应引用（容器启动由内置 runtime 负责）；球拖拽从 `@snap-rail/ui/runtime` 导入 `attachBallDrag` |
| `Module '"@snap-rail/ui/runtime"' has no exported member 'attachBallDrag'` | 安装的 `@snap-rail/ui` < 0.1.1（r3 闭包前的发布没有这个转出） | `pnpm add -D @snap-rail/ui@^0.1.1`；连带把 plugin-sdk/plugin-kit 升到 r3 闭包（见 SKILL.md 时代分界） |
| `Module '"@snap-rail/ui/components"' has no exported member 'Tooltip'/'FormField'/'Alert'/'toast'` | 安装的 `@snap-rail/ui` 是 0.1.x，没有 0.2 组件 | `pnpm add -D @snap-rail/ui@^0.3.0`（plugin-sdk ≥ 0.3.0 的 init 默认生成）；构建出的 zip 需终端 ≥ v0.7.0 |
| `Module '"@snap-rail/ui/components"' has no exported member 'Combobox'`，或 `PopoverContent` 没有 `autoFocusOnOpen` | 安装的 `@snap-rail/ui` 是 0.2.x | `pnpm add -D @snap-rail/ui@^0.3.0`，连带 plugin-sdk/plugin-kit 升到 `^0.3.0`（见 SKILL.md 时代分界）；zip 需终端 ≥ v0.7.0 |
| 锚定下拉（输入框 + 候选浮层）一输入就丢焦点、键盘全部落空 | 旧基座的浮层打开时把焦点抢进浮层第一项，关闭时回焦空转、焦点落在 body | 换 `Combobox`（ui ≥ 0.3.0）；旧终端上手搓时 `PopoverContent` 传 `onOpenAutoFocus`/`onCloseAutoFocus` 两个 `e => e.preventDefault()`，选项行 `onMouseDown={e => e.preventDefault()}` |
| 表单读不到状态：`useFormContext()` 为 null、`Cannot read properties of null (reading 'control')` | RHF hooks 从 `react-hook-form` 直接导入——私有副本与终端种子不是同一 context | hooks 改从 `@snap-rail/ui/components` 导入（`useForm`/`zodResolver`/`FormField`…），`package.json` 删掉 `react-hook-form` |

## init / 安装依赖

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| `pnpm dlx … init` 报 `404` / `ETARGET` | npmmirror 同步有分钟到小时级延迟 | `npm config set registry https://registry.npmjs.org/` 后重试，完事可切回 |
| 装到的版本比官方 npm 旧（如 `^0.2.1` 解析出 0.2.1 而非 0.2.2） | 镜像元数据滞后：同步期内解析不到新版本 | 切官方 registry 重装（`npm config set registry https://registry.npmjs.org/`），再判断是真缺还是没同步 |
| `init: <目录> 不是空目录` | 目录已有 package.json 或 src | 换目录或确认后 `--force` 覆盖 |
| `init: --framework applies to …` | 对非 UI 模板传了 `--framework` | 该参数只对 `ui-view` / `ui-layout` / `ui-extension` / `ui-skin` / `suite` 生效 |
| install 报未发布包 E404 | 旧模板把未发布的内部包写进了 peer | 升级 SDK：`pnpm dlx @snap-rail/plugin-sdk@latest init` 重新生成 |
| 运行 CLI 弹「选择应用打开 .js」 | SDK 0.2.2 及更早缺 shebang | 升级到 0.2.3+；临时用 `node node_modules/@snap-rail/plugin-sdk/lib/cli.js` |
| `pnpm install` 报 `ERR_PNPM_IGNORED_BUILDS`（pnpm ≥10） | 依赖的构建脚本默认不跑（esbuild 等） | 按提示把 `pnpm-workspace.yaml` 的 `allowBuilds.<pkg>` 改成 `true`（pnpm 10 用 `onlyBuiltDependencies`），或跑 `pnpm approve-builds` |
| `pnpm install` 报 `published … within the minimumReleaseAge cutoff` / 装不到刚发布的 SDK（pnpm 11） | pnpm 11 默认 `minimumReleaseAge: 1440`——刚发布 24h 内的版本被冷却跳过或压回旧版（防供应链攻击，官方 registry 也生效） | 项目 `pnpm-workspace.yaml` 里设 `minimumReleaseAge: 0`，或 `minimumReleaseAgeExclude` 列出 `@snap-rail/*`；不急就等 24h 自然解冻 |
| `pnpm exec tsc` 报 not found | 模板只带 tsdown，不带 typescript | `pnpm add -D typescript` 后再 `pnpm exec tsc --noEmit`；tsdown 只转译不检查类型 |
| 改 package.json 依赖段后 install 挂死 | 弱网/受限环境下 lockfile 重解析的元数据请求超时 | 避免频繁动依赖段；离线机器用 `--offline` 与本地 registry 镜像 |

## 构建产物

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| host.js 上百 kB | 契约包在 devDependencies 被内联，或入口 value 导入了 plugin-sdk（definePlugin） | 契约包挪进 dependencies；入口改 `satisfies Plugin` + type-only 导入（见 host-face.md 构建纪律） |
| client bundle 体积异常 / 含 node 内置 | 渲染面 value import 了 settings/gateway，或入口 value import plugin-sdk | 宿主包只 type-only；入口用 `satisfies Plugin`；宿主 link/帧走 SDK `/api/client` |
| zip 里混进已删代码的旧 chunk | hostBundle 不清产物目录、pack 整目录收编 | 重发布前清空 `lib-host/`、`lib-client/`、`dist/` 再 build/pack |
| manifest 类型/schema 拒绝 `client.surfaces` / `probe` 等字段 | 两个来源：安装版确实旧（plugin-kit <0.2.2 / equipment <0.1.5），或 `plugin-sdk@0.2.3` 的内联类型按旧 schema 生成 | 升级 `@snap-rail/plugin-sdk` 到 0.2.4+、`@snap-rail/equipment` 到 0.1.5+；仍被拒就查镜像是否给了旧版（见上「装到的版本比官方 npm 旧」），并以安装的 d.ts 为准先不写该字段 |

## dev 模式（本地迭代，`snap-rail-plugin dev`）

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| 同步输出正常，客户端里没反应 | 客户端没在运行（同步只落盘），或该行被禁用 | 启动客户端后看效果；管理页确认该包行是启用态。`--launch` 可让 dev 自动拉起 |
| 改了宿主面代码，重挂的还是旧行为 | 终端版本旧于此机制（entryUrl 内容哈希击穿 ESM 缓存） | 升级终端后重试；应急就重启客户端 |
| `--launch` 报「只在目标是安装版 home 时可用」 | `--home` 指向了别的 home（如主仓开发版） | 安装版 exe 的 home 固定，它读不到别处——去掉 `--launch` 自己启动，或把 `--home` 指回安装版 home |
| `--launch` 输出「未找到客户端可执行文件」 | 未安装客户端；或 plugin-sdk < 0.3.0（旧探测只认默认目录，自定义安装目录一律找不到） | 升级 `@snap-rail/plugin-sdk` 到 `^0.3.0`（从卸载注册表项推导安装目录）；仍找不到按输出列出的探测位置核对，或 `--launch <exe 路径>` 直接指定 |
| Ctrl+C 后客户端里该插件不见了/回到旧版 | 设计行为：会话结束恢复原状（备份的正式版挪回池、行回到会话前） | 想保留 dev 副本用 `--no-watch`（清理再跑 `--reset`） |
| 池里是 dev 副本、正式版不见了（没在跑 dev） | 上次会话崩溃/杀进程，恢复没执行 | `snap-rail-plugin dev . --reset` 恢复；下次 `dev` 启动也会自动恢复 |
| 会话中经管理页手动停用/卸载了 dev 行，退出时又变了 | 恢复以会话前快照为准 | 正常语义：退出恢复「dev 之前」的状态 |

## 运行期（装进终端后）

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| 安装预检列 `missing` | requires 的包没装/没启用 | 先装依赖包（如设备底座、其他套件），再启用本包 |
| 启用被拒：`缺少贡献面：@snap-rail/shell/contract（提供方 <包> 未安装）` | 把 base 种子写进了 `client.externalSeeds` | 删掉该条；base 种子由 shell 自动播种，不进 externalSeeds（安装预检的同族 warning 不带提供方名，格式 `…（提供方未安装）`） |
| 启用被拒：版本不合 | `name@range` 与已装版本冲突（range 按 npm 语义：`^0.2.0` 不接受 0.3.x） | 放宽 range 或升级依赖包 |
| 卸载/禁用被拒 | 还有别的包依赖它 | 先停用依赖方 |
| 管理页找不到我的包 | clientOnly 行不在宿主树 | 正常：纯渲染包经渲染端下发行展示；检查 `client-config.list` |
| 分类落「其他」 | 没声明 `category` | manifest 补 `category`（开放词汇，声明即归组） |
| 驱动表单字段标签显示成键名（如 `host`） | zod 字段缺 `.meta({ title })`——字段仍渲染，只是没中文标签 | 每个字段补 `.meta({ title: '中文标签' })`；枚举/字面量联合想要下拉就写 `z.enum` 或 `z.union([z.literal…])`（映射见 client-face.md「SchemaForm」） |
| 「测试连接」按钮不存在 | 驱动没实现 `probe`，或安装的 equipment 版本类型里还没有 probe（发布滞后） | 先按 SKILL.md「版本陷阱」查安装的类型；有字段再实现 |
| 「测试连接」总是超时 | probe 内部建了长连接/等待无上限；底座硬超时 10s | probe 只做一次性只读探测并在 10s 内返回；需要更长的握手就缩短或返回 `ok:false` + `error.hint` |
| 球拖不动 / 拖动抖动不跟手 | 拖拽用了 CSS `-webkit-app-region`（透明窗命中不可靠）或自己流式上报坐标（窗动则坐标系动） | 换 `attachBallDrag`（`import { attachBallDrag } from '@snap-rail/ui/runtime'`，ui ≥ 0.1.1）：整球一个 drag/click 表面，只发 `shell.ball.move` 的 `begin`/`end`，宿主以光标为锚接管跟随与贴边落定 |
| 球拖到边缘拽不回来 | 拖拽没有交给宿主（`shell.ball.move` 未接） | 同上用 `attachBallDrag`；贴边、收起、滑出全由宿主负责，面只按 `shell/ball-dock-changed`（`{ edge, collapsed, visiblePx }`）画形态 |
| 球阴影出现灰色硬边 | 用了 `box-shadow`（被窗口边界切） | 改径向渐变画进 8px 余量并衰减到零 |
| 退出确认框 10s 后自己退了 | 渲染面没应答 `shell.exit.resolve` | 确认订阅 `shell/exit-requested` 并应答；10s 兜底是设计行为 |
| 通知没弹出来 | 触发全局节流（5 条/10s）或超 `SHELL_LIMITS` | 看 `{applied:false, reason}` 返回值；同 tag 合并、控制频率 |
| `shell.window.configure` / `setProfile` 请求的舞台尺寸没生效 | 返回 `{applied:false, source:'user'}` = 操作员在外观页固定了窗口（唯一会拒绝的来源；记住的历史尺寸不锁请求）；或终端 < v0.7.0——Windows 无框窗上约束先于尺寸写入，目标尺寸被 OS 纠正吞掉（如 1280×800 落成 960×768） | **检查返回值**（`link.call` 对业务拒绝不抛异常）；固定态让操作员恢复「跟随布局」；旧终端升级 |
| 安装被拒「<包> 的种子依赖与宿主不匹配：插件构建于种子 ABI r2，宿主为 r3 —— 请更新插件包或桌面应用」，或渲染面没加载、控制台 `client: face "<包>" refused — …` | zip 是用 r2 时代工具链（npm `plugin-kit 0.2.3` / `plugin-sdk 0.2.6`，锁文件钉住最常见）打的，章与 ≥ v0.5.3 终端不符 | 按 SKILL.md 版本锚升到当前闭包（`pnpm update` 让锁文件跟上）后重新 `pnpm run build` + `pack`；**不要**手改 `seedAbi`（pack 自动盖章，手写会被拒） |
| 安装被拒「插件构建于 <id>@<ver>，宿主提供 <live>（兼容版本线不一致，请用新版 SDK 重新构建插件）」 | 种子版本按 npm caret 兼容线比较（终端 ≥ v0.7.0）：0.x 看次版本，如 ui 0.2 构建的 zip 装 ui 0.3 终端 | 按版本锚升级闭包（ui `^0.3.0` 等）后重新 build + pack |
| 安装被拒「…（宿主版本较旧，请更新桌面应用）」 | 第一方 `@snap-rail/*` 种子要求宿主 ≥ 构建版本：插件用了比终端新的 SDK（可能用到了终端没有的组件） | 升级终端；或把插件的闭包降回终端对应的版本线重新打包 |
| 设置页不出现 | 没注册、注册在 `apply` 之外，或插件没 `inject: ['settings']` | 这是**渲染面** API：在 `apply(ctx)` 里 `ctx.settings.registerPage(ctx, { id, title, group, order, render })`（宿主面的 settings 只有 get/set）；确认 `inject` 含 `settings` |
| 更新了但自动更新没生效 | 版本号没变，或换 key 触发 keyChanged 拦截 | 升版本号重发；换 key 走手动更新确认 |

## 自检顺序（卡住时）

1. `pnpm run doctor` —— 红的一定要修；
2. `pnpm exec snap-rail-plugin inspect dist/<包名>.zip` —— 确认 zip 里
   的面/签名/manifest 与预期一致；
3. 对照 [manifest.md](manifest.md) 核字段、
   [client-face.md](client-face.md) 核种子；
4. 还不行：最小复现（init 一个干净模板 + 只贴你的 diff），看是模板升级
   引入还是自己的改动引入。

dev 会话里的问题先看 dev 自己的输出（目标 home、同步/恢复动作都在里面），
再回到这张表的「dev 模式」节；运行期行为异常把 dev 停掉、换发布链
（pack → 安装）复测，排除 dev 副本因素。
