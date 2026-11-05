# 主题、皮肤与语义部件规范

单源在 `@snap-rail/ui`：

- 语义组件与 `data-snap-part` 解剖：`packages/base/ui/src/contract.ts` 的 `UI_COMPONENTS`；
- 出厂钴蓝双主题（白天/黑夜）的 token 与部件 CSS：`packages/base/ui/src/skins.tsx`、
  `src/styles/default.css`；
- 主题注册服务：`ctx.skins`；页面/布局只消费 `useSkinTokens()` / `useChartTheme()`。

## 主题模型

**一个主题 = 一套完整观感 = 单套 token + 可选 part CSS，纯样式。** 没有明暗
维度、没有「跟随系统」：出厂内置「钴蓝·白天」（`default-light`）与
「钴蓝·黑夜」（`default-dark`）两个主题，随 UI 基座走、始终可选、不可卸载；
装一个皮肤插件（`kind: 'skin'`、`exclusive: 'skin'`）就多一个可选主题，
一个包也可以注册多个主题（首主题 id 约定用包名）。

- 激活单源是设置键 `ui.theme = { id }`：点选已装载主题只写这一行，
  runtime 订阅 `settings/changed` 当场对**所有窗口**（主窗 + 悬浮球）重注
  token，无重载；点选未装载的皮肤包会先启用该包，主窗自动重载一次后按
  id 激活。选中的主题不在注册表时回退 `default-dark`。
- 主题只管样式：组件定义（解剖/行为/形态）归 `@snap-rail/ui/components`，
  区域插槽归 layout/插件（皮肤摸不到槽），主题从不携带这两类信息。
- 插件池里皮肤行的「启用」只表示**已装载可选**，与「正在使用」无关；
  `exclusive: 'skin'` 保证至多装载一个皮肤包。

## 两层：token 与 part

**token** 是主题填的值（颜色/字体/间距/圆角/密度/动效/z-index），以
`--snap-*` CSS 变量注入 `<html>`；**part** 是组件暴露的稳定 DOM 部位
（`button.root`、`dialog.panel`、`field.error`…）。主题只命中 part，页面不写
视觉 CSS，也不依赖组件内部结构。

```css
[data-snap-skin='industrial'] [data-snap-part='button.root'] {
  background: var(--snap-color-primary);
  border-radius: var(--snap-radius-md);
}
```

- 每个主题必须把规则作用域到 `[data-snap-skin='<id>']`；未激活主题的 CSS
  即使还在 DOM 中也不会命中。

## 图表与状态色

- 数据系列只用 `--snap-chart-1…6`；实际/目标对比沿用系列 1/2 的语义。
- 红/黄/绿（`--snap-color-danger/success/warning`）只表达设备/流程状态，
  不进数据系列。
- 第三方图表必须包在 `ChartFrame`/`Visualization` 内，从 `useChartTheme()`
  取 ECharts/D3 主题；主题覆盖外框/标题/图例容器与色板，不覆盖图表库内部 DOM。
- 数字读数用等宽字体 token（`fontMono` → `--snap-font-mono`）防跳动；没有
  专用的「主角数字」part 或类名——要强调就用字号/字重 token（`textXl` /
  `weightStrong`），不自造 CSS 类。

## 触控基线

一体机触屏，最小点击目标 48px：控件高度是主题 token
`controlHeightSm/Md/Lg` = 40/48/56px，`Button`/`Input` 默认 `md`（48）即满足
基线、`lg`（56）给主操作，`sm`（40）低于触控基线只用于非主要触控路径；
表格行间距走 `spaceMd`。数值输入用 `NumberInput`（`number-input.step-up/
step-down` 步进钮），单选用 `TouchSelect`，滚动容器用 `DragScroll`，设定值
粗调用 `Slider`（`slider.thumb` 是触控目标）。这些组件的 part 由出厂主题保证
触控尺寸；custom 主题必须维持最小目标，`uiProfile: custom` 的插件自担其责。
戴手套的终端可让 `ScrollArea` 的滚动条常显（`scrollbarType="always"`），
主题经 `scroll-area.scrollbar/thumb` 定粗细。

## 状态、浮层与表单布局

`@snap-rail/ui` 0.2 起组件面镜像 shadcn，主题要覆盖的 part 随之增加
（全表见 `UI_COMPONENTS`）：

- **语义色走 `data-intent`**：`button.root`、`badge.root`、`alert.root`、
  `toast.root` 都带 `data-intent`（`neutral`/`primary`/`danger`/`success`/
  `warning`），主题按属性选择器映射到 `--snap-color-*`，不自造类名。
- **浮层**：`tooltip.content`、`popover.content`、`menu.content`/`menu.item`
  （高亮态 `[data-highlighted]`）、`toast.viewport`/`toast.root`；层级只用
  `--snap-z-overlay`（提示/弹出/菜单）与 `--snap-z-modal`（对话框/通知），
  不写裸 z-index。浮层经 portal 挂在 `<body>` 下，`data-snap-skin` 在
  `<html>` 上，`[data-snap-skin='<id>'] …` 作用域照常命中。
- **注意力原语**：`alert.root/title/description`、`separator.root`
  （`data-orientation`）、`skeleton.root`（`data-variant`：block/text/circle）、
  `list.root`（`data-divided`）/`list.item`（`data-selected`/`data-disabled`，
  `list.leading/content/trailing` 三槽）、`slider.track/range/thumb`。
- **表单排布是结构不是皮肤**：`field.root[data-orientation='horizontal']` 的
  横排与 `form.root[data-orientation]` 的 stack/inline/grid 排布由 base 结构层
  给出；主题只调 `field.label` 的字号/颜色与间距 token，不改排布方向。

## 窗口与悬浮球

- 主窗口：活动 layout/suite 的 `LayoutContribution.window` 声明
  `WindowProfile`；用户可在「外观与显示」写 `ui.window` 覆盖，手动调整
  由宿主持久化。窗口尺寸不是响应式布局的替代品，页面仍用布局原语。
- 悬浮球：活动 layout/suite 的 `LayoutContribution.ball` 声明 `BallProfile`
  （尺寸/启用/停泊行为）。几何不变量：方形窗口、8px 余量固定、
  `orb = size - 16`、阴影必须画在余量内；`resolveBallProfile` 是宿主与
  球面共用的单源。球内内容由球面插件（`shell.ball`）决定，颜色由主题决定。

## 新主题清单

1. 从 `DEFAULT_DARK.tokens`（或 `DEFAULT_LIGHT.tokens`）复制单套 token，
   填满 `SkinTokens`；
2. 为 `UI_COMPONENTS` 的每个 part 写规则（至少覆盖 root/label/field/panel）；
3. 所有规则作用域到 `[data-snap-skin='<id>']`（主题 id 用包名）；
4. 设置 `snapRail.kind: 'skin'`、`exclusive: 'skin'`、`clientOnly: true`；
5. 在「外观与显示」主题列表点选——已装载即时热切，首启经主窗自动重载；
   用出厂双主题做对照验证设置/设备/表单/对话框，以及提示/菜单/通知等浮层。
