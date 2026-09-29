# ui-view 组件脚手架

一个 Component 插件：绑定一个 UI 框架、占其槽位、渲染自己的页面。

```sh
snap-rail-plugin init my-view --template ui-view --framework @snap-rail/framework-shadcn
```

`--framework` 换成任意框架包名——脚手架会写入该框架的 devDependency、
`snapRail.framework` 绑定、`client.externalSeeds`（本组件 require 的贡献
种子 id），源码里的 import 也指向该框架。

要点：
- 页面只组合框架的共享原语（构建期 external、运行期种子表单实例）；
- 页面自身的数据接入订阅统一 wire 帧（`subscribeFrame`），不 import 其他
  插件的面；
- 词汇常量（`UI_SLOT_IDS` 等）来自框架包的 `/slots` 面，禁止裸字符串槽 id。
