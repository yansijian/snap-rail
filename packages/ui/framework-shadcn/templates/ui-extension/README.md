# ui-extension 扩展库脚手架

站在一个 UI 框架之上、向所有 Component 插件贡献**共享组件**的插件：
client 面导出 `seeds` 映射，壳把每个 `<package>/<key>` 播种进种子表，
所有消费者共享同一份实例。

```sh
snap-rail-plugin init my-ext --template ui-extension --framework @snap-rail/framework-shadcn
```

要点：
- 组件构建在框架贡献的原语之上（`client.externalSeeds` 声明你 require 的
  框架面，如 `@snap-rail/framework-shadcn/ui`）——绝不内联私有副本；
- manifest 的 `client.seeds` 声明你贡献的子路径（如 `widget`），消费者
  以 `<你的包>/widget` require；
- 组件样式只用框架的 theme 令牌，随框架 zip 的预编译 CSS 生效；
- 框架不在场时扩展不挂载（绑定预检 fail-loud）——这是特性。
