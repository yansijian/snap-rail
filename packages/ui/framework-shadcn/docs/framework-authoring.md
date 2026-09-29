# 框架作者指南

snap-rail 的 UI 框架是**普通插件**：zip 发行、互斥组 `framework` 单活、
clientOnly。任何满足这份契约的包都能与官方框架平权竞争——换框架 = 换生态
是双向的。本指南是一个框架包要对外承诺的全部面。

## 一、框架包 = 一包一体两面

- **运行时（终端 zip）**：clientOnly，client 入口默认导出
  `{ seeds: { ui, slots, semantic, settings-pages?, session?, workflows?,
  variables?, runtime, fallback? } }`——壳 require 后逐 id
  `system.seed('<包>/<key>', 实例)`，所有 Component 与你共享同一份实例。
  词汇表是**运行时值**（`register(ctx, IDS.menu, …)` 的参数），所以 SDK
  不是附带类型，就是这份代码。
- **开发期 SDK（npm 包）**：同一个包的 `exports` 子路径——
  `./slots`（词汇 + 类型）、`./semantic`（view/layout/navigation 贡献
  契约）、`./ui`（原语类型）、`./templates`（脚手架）、`./docs`（本指南
  与 token 参考）。组件作者 devDependency 你的包，构建期拿类型，运行期
  从种子表拿实例。

## 二、插槽词汇与占位模式

- 词汇用 `as const` 对象 + 字面量联合声明（新框架用
  `@snap-rail/plugin-kit` 的 `defineSlotVocabulary`——定义即校验形状，
  消费者得到自动补全与编译期防错；`custom:<publisher>.<name>` 是保留的
  扩展命名空间）。
- 每个槽声明占位模式：`stack`（全部住户按 order 渲染——菜单、动作区）
  或 `single`（按 `precedence` 选出唯一胜者——titlebar、main）。single
  槽的内置默认注册 `precedence: 0`，三方覆盖者注册更高值，**卸载覆盖者
  自动回退默认**（默认只是被遮蔽，不被销毁）。
- 禁止裸字符串槽 id——一律走词汇常量（doctor 会扫）。

## 三、作者模式规约（重要）

框架包只含：Shell + 槽注册表 + runtime + fallback 兜底。**一切具体住户
（默认菜单组件、默认 titlebar）都是独立组件插件**——于是「卸掉默认
titlebar、装一个三方新 titlebar」就是普通插件装卸。fallback 是降解地板
（零布局时兜底、其他 layout 注册即让位），不算住户。

## 四、生态三层

1. 框架作者：发 zip（feed）+ 发 npm（SDK 面）。
2. 组件/扩展库作者：`snap-rail-plugin init --template ui-view|ui-extension
   --framework <你的包>`；manifest 声明 `snapRail.framework: '<你的包>'`
   （绑定视同依赖，启用预检强制）与 `client.externalSeeds`
   （require 的贡献种子 id——打包器据此 externalize，运行期共享你的单
   实例；提供方缺席时启用被拒绝）。
3. 终端用户：装你的框架 + 装任意绑定它的组件，即装即用；装了别的框架，
   绑定不匹配的组件不挂载（fail-loud，双向保护）。

## 五、发布检查单

- [ ] `snapRail.exclusive: 'framework'`、`clientOnly: true`、
      `client.seeds` 完整
- [ ] zip 内预编译 tailwind 输出（theme 令牌随 zip）
- [ ] npm 包 exports 齐全（slots/semantic/ui/templates/docs）
- [ ] 模板与指南随包（`snap-rail-plugin init --framework <你的包>` 可用）
- [ ] 版本 semver：种子 id 集或词汇变更 = minor+；破坏性 = major
      （组件的 externalSeeds 声明会因 major 不满足而拒绝启用）
