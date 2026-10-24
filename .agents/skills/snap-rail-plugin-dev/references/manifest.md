# Manifest：`package.json` 的 `snapRail` 块

manifest 是插件的协议入口。安装器、池扫描、管理页都从这里读事实；必须过
`definePluginManifest`（即 `snapRailManifestSchema`）校验。本章字段与
`@snap-rail/plugin-kit/manifest` 单源一致，冲突时以安装的 SDK 类型为准。

## 完整字段表

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `kind` | `suite \| driver \| framework \| plugin` | 角色声明；`suite` 与 `framework` 单活。缺省 = `plugin`。 |
| `layer` | `base \| store \| equipment \| ui \| tool \| suite` | 层词汇，仓内门禁用；可安装插件照模板填即可。 |
| `title` | string ≤64 | 管理页显示名，随意命名（中文可用）；缺省回退包名。 |
| `category` | string ≤64 | 开放分类标记，声明即归组（管理页按原文分组，无枚举校验）；缺省落「其他」。 |
| `exclusive` | string | 互斥组：启用本包自动停用同组其他已启用包。`suite` 默认 `'suite'`，`framework` 默认 `'framework'`，store 后端必须 `'store-backend'`。 |
| `requires` | string[] | **唯一兼容声明**，见下节。 |
| `clientOnly` | boolean | 纯渲染包（无宿主面）：行不进宿主树，经 `client-config.list` 下发给渲染端。必须声明 `client.entry`。 |
| `client` | object | 渲染面声明：`entry`（CJS 工厂包路径；schema 默认 `lib/client.js`，init 模板显式写 `lib-client/client.js`，以模板/doctor 为准）、`surfaces`（辅助面映射）、`seeds`（贡献的种子子路径）、`externalSeeds`（消费的贡献种子 id）。`seedAbi` 由 pack 盖章，**永不手写**。 |
| `permissions` | string[] | 安装期展示用（如 `shell:notify` / `shell:tray` / `shell:surface`），暂不强制。 |
| `engines` | object | 兼容的宿主/协议/渲染端版本范围：`snapRail` / `hostProtocol` / `renderer`。 |

## `requires` 三种条目

```jsonc
// 示意：JSON 不支持注释，照抄时去掉注释行
"requires": [
  "@snap-rail/equipment",                    // 包名：已安装且启用
  "@snap-rail/framework-shadcn@^0.2",        // name@range：还要版本合范围（框架绑定就是这条）
  "service:store"                            // service:id：运行时存在该 cordis 服务
]
```

- 启用做**正向校验**：缺依赖或版本不合 → 拒绝启用；
- 禁用/卸载做**反向校验**：还有依赖方 → 拒绝；
- 语义版本单源 `@snap-rail/util/semver`。
- **`requires` 只放可安装插件包 / `service:`**。npm 类型包（SDK 的 `/api`
  门面、`@snap-rail/protocol`）不是插件，放 `dependencies` /
  `devDependencies`；`@snap-rail/gateway` / `connection` / `settings` 是
  SDK 依赖/base 运行时，永远不进 `requires`。
- 错误永远不会留到下次开机才爆——这是设计目标，不要想办法绕过预检。

## 渲染面 `client` 块

```json
"client": {
  "entry": "lib-client/client.js",
  "surfaces": { "ball": "lib-client/ball.js" },
  "seeds": ["widget"],
  "externalSeeds": [
    "@snap-rail/framework-shadcn/slots",
    "@snap-rail/framework-shadcn/semantic",
    "@snap-rail/framework-shadcn/ui"
  ]
}
```

- `entry`：主窗口的面，模块 id = **包名**；`main` 不允许出现在 `surfaces`。
- `surfaces`：每个辅助窗口一条（目前辅助面只有 `ball`），模块 id =
  `<包名>/<surface>`，`clientBundle` 的第三个参数决定 `outName`/`moduleId`。
  ⚠ **版本陷阱**：plugin-kit `0.2.2`（官方 npm）起 schema 才收 `surfaces`；
  更早安装版、或 npmmirror 滞后解析出的旧版会当场拒绝——以安装的
  `node_modules/@snap-rail/plugin-kit/lib/types/manifest.d.ts` 为准；另外
  `plugin-sdk@0.2.3` 的内联类型按旧 schema 生成，字面量写 `surfaces` 会被
  类型拒——升 plugin-sdk `0.2.4+`。
- `seeds`：本包贡献给别人的共享组件子路径（每个键成为 `<包名>/<键>` 种子
  id，跨插件共享同一实例）。
- `externalSeeds`：只列**贡献种子**（框架或其他插件的 `<包>/<子路径>`）。
  base 种子（connection / protocol / util / shell-contract /
  equipment-contract / react / zod）由 shell 自动播种，**不能写**——写了
  启用预检会报“提供方未安装”。它同时是构建期外部化清单和启用期提供方
  检查清单，**不是**兼容声明——版本兼容永远走 `requires`。
- `seedAbi`：pack 自动盖章（构建时真实 require 到的种子 + 版本 + ABI 修订
  号），安装期与渲染端 boot 双向比对，不符则拒装/skip + fail-loud。

## 一个真实驱动插件的完整 manifest

```json
{
  "name": "@my-scope/my-driver",
  "version": "1.0.0",
  "description": "我的温度采集驱动",
  "license": "Apache-2.0",
  "type": "module",
  "main": "lib-host/host.js",
  "snapRail": {
    "kind": "driver",
    "layer": "equipment",
    "title": "我的驱动",
    "category": "设备",
    "requires": ["@snap-rail/equipment"]
  }
}
```

## 一个真实套件的 manifest（双面 + 球）

> 下例含 `surfaces`（球）——plugin-kit `0.2.2` + plugin-sdk `0.2.4` 起类型
> 才放行该字段（更早安装版会拒，见上）；届时其余照写。

```json
{
  "name": "@my-scope/my-suite",
  "snapRail": {
    "kind": "suite",
    "layer": "suite",
    "title": "我的套件",
    "exclusive": "suite",
    "requires": [
      "@snap-rail/framework-shadcn@^0.2",
      "@snap-rail/equipment",
      "service:store",
      "service:shell"
    ],
    "client": {
      "entry": "lib-client/client.js",
      "surfaces": { "ball": "lib-client/ball.js" },
      "externalSeeds": [
        "@snap-rail/framework-shadcn/slots",
        "@snap-rail/framework-shadcn/semantic",
        "@snap-rail/framework-shadcn/ui"
      ]
    }
  }
}
```

## 退役词汇

`snapRail.framework` 与 `snapRail.capabilities` 已退役。旧 zip 里残留的这
类字段在校验时被剥离（放行安装），宿主永不再读；新 manifest 直接不要写。

## 校验习惯

改完 manifest 就跑 `pnpm run doctor`——它内部就是对 `package.json` 跑
`definePluginManifest`（即 `snapRailManifestSchema.parse`），红 = 不合 schema。

测试里也应有一条（init 生成的 `tests/manifest.spec.ts` 就是模板）：
`definePluginManifest` 解析 `package.json` 并断言 `kind`。
