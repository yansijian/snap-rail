# 主题、皮肤与语义部件规范

单源在 `@snap-rail/ui`：

- 语义组件与 `data-snap-part` 解剖：`packages/base/ui/src/contract.ts` 的 `UI_COMPONENTS`；
- 默认钴蓝皮肤的 token 与 CSS：`packages/base/ui/src/skins.tsx`、`src/styles/default.css`；
- 皮肤注册服务：`ctx.skins`；页面/布局只消费 `useSkinTokens()` / `useChartTheme()`。

## 两层：token 与 part

**token** 是皮肤填的值（颜色/字体/间距/圆角/密度/动效/z-index），以
`--snap-*` CSS 变量注入 `<html>`；**part** 是组件暴露的稳定 DOM 部位
（`button.root`、`dialog.panel`、`field.error`…）。皮肤只命中 part，页面不写
视觉 CSS，也不依赖组件内部结构。

```css
[data-snap-skin='industrial'] [data-snap-part='button.root'] {
  background: var(--snap-color-primary);
  border-radius: var(--snap-radius-md);
}
```

- 每个皮肤必须把规则作用域到 `[data-snap-skin='<id>']`；未激活皮肤的 CSS
  即使还在 DOM 中也不会命中。
- 明暗模式由 `html[data-snap-mode='light'|'dark']` 切换（设置键
  `ui.theme`，`system/light/dark`）；运行时同时写 `data-mode` 供兼容读取。
- 皮肤通过 `ctx.skins.register(ctx, { id, title, tokens, presentations })` 注册；
  默认皮肤 id 为 `default`，池皮肤单活（`exclusive: 'skin'`），加载失败回退默认。
- `presentations` 选择核心实现的展示变体（`dialog: modal|sheet|fullscreen`、
  `select: popover|modal` 等），页面仍可显式覆盖。

## 图表与状态色

- 数据系列只用 `--snap-chart-1…6`；实际/目标对比沿用系列 1/2 的语义。
- 红/黄/绿（`--snap-color-danger/success/warning`）只表达设备/流程状态，
  不进数据系列。
- 第三方图表必须包在 `ChartFrame`/`Visualization` 内，从 `useChartTheme()`
  取 ECharts/D3 主题；皮肤覆盖外框/标题/图例容器与色板，不覆盖图表库内部 DOM。
- 数字读数统一 `font-mono tabular-nums`；主角数字用 `glow-number` 类。

## 触控基线

一体机触屏，最小点击目标 48px：`Button` default h-12 / lg h-14 / icon 48×48；
`Input` h-12；表格行 py-3。数值输入用 `NumberInput`，单选用 `TouchSelect`，
滚动容器用 `DragScroll`。这些组件的 part 由默认皮肤保证触控尺寸；custom
皮肤必须维持最小目标，`uiProfile: custom` 的插件自担其责。

## 窗口与悬浮球

- 主窗口：活动 layout/suite 的 `LayoutContribution.window` 声明
  `WindowProfile`；用户可在「外观与显示」写 `ui.window` 覆盖，手动调整
  由宿主持久化。窗口尺寸不是响应式布局的替代品，页面仍用布局原语。
- 悬浮球：活动 layout/suite 的 `LayoutContribution.ball` 声明 `BallProfile`
  （尺寸/启用/停泊行为）。几何不变量：方形窗口、8px 余量固定、
  `orb = size - 16`、阴影必须画在余量内；`resolveBallProfile` 是宿主与
  球面共用的单源。球内内容由球面插件（`shell.ball`）决定，颜色由皮肤决定。

## 新皮肤清单

1. 从 `DEFAULT_SKIN.tokens` 复制 dark/light 两套 token，填满 `SkinTokens`；
2. 为 `UI_COMPONENTS` 的每个 part 写规则（至少覆盖 root/label/field/panel）；
3. 所有规则作用域到 `[data-snap-skin='<id>']`；
4. 设置 `snapRail.kind: 'skin'`、`exclusive: 'skin'`、`clientOnly: true`；
5. 用默认皮肤做对照，在「外观与显示」启用后重启验证设置/设备/表单/对话框。