# 主题与图表色规范

单源在 `packages/client/ui/src/theme.css`；本文件是使用规范。设计出处见
`docs/design/theme-samples.html`（明暗各 9 款候选，最终选钴蓝）。

## 两种模式，一套令牌

Tailwind v4 `@theme` 里的令牌就是黑夜模式（石墨钢面板 + 钴蓝）；
`html[data-mode='light']` 用同名令牌覆盖为白天模式（雾白面板 + 加深钴蓝）。
运行时切模式只是改 `<html>` 上的 `data-mode` 属性：

- 模式选择存 settings.json 键 `ui.theme`（`{ mode: 'system' | 'light' | 'dark' }`），
  由设置站「主题」页写入，`settings/changed` 帧当场热应用（见
  `packages/client/settings-station`）。
- 读写走 `@snap-rail/client-ui` 导出的 `themeSettingsSchema` / `applyTheme`，
  不要在别处再写一套。

页面代码永远只用令牌工具类（`bg-card`、`text-muted-foreground`…），**不得出现
硬编码色值或 `dark:` 变体**——模式切换靠令牌自动生效。

## 类扫描（工具类从哪来）

全仓唯一样式表就是 `theme.css`，工具类靠 Tailwind 扫源码生成。`@source`
按 **CSS 文件自身位置** 解析（不是 Vite cwd，自动探测只覆盖
`apps/desktop/src/client`）：一条宽 glob `../../../**/src/**/*.{ts,tsx}`
覆盖 `packages/` 下所有包的 src（脊柱 client 面、套件、field 站点一起），
住户名单不在此复列；构建产物被 gitignore 天然排除。**放进 `packages/` 的
新渲染包无需改扫描**；但把渲染源码挪出 `packages/` 的 src 会让它独有的
类静默消失——`packages/client/ui/tests/theme-scan.spec.ts` 的门禁（每条
`@source` 前缀真实存在 + 覆盖每个包）会当场红。

## 调色板

| 令牌 | 黑夜 | 白天 | 用途 |
| --- | --- | --- | --- |
| background | `#0b0f14` | `#e4e9ef` | 页面底（叠加柔和渐变） |
| card / popover | `#11161d` / `#161b22` | `#f3f6f9` / `#ffffff` | 卡片 / 浮层面 |
| secondary / accent | `#1c2430` | `#dde4ec` | 次级按钮面、选中面 |
| foreground | `#ced8e3` | `#26323e` | 正文 |
| muted-foreground | `#8b949e` | `#5d6d7e` | 说明文字、表头 |
| primary | `#4a6cff` | `#3857e8` | 主题色（钴蓝）、选中、键线 |
| success / warning / destructive | `#3fb950` / `#d29922` / `#f85149` | `#15803d` / `#b45309` / `#dc2626` | 状态语义专用 |
| border / input | `#1f2933` | `#c7d0da` | 描边、输入框边 |

状态色（success/warning/destructive）只表达设备/流程状态，**不进数据系列**。

## 图表系列色模板

系列色是独立的一组令牌 `--color-chart-1 … --color-chart-6`（工具类
`bg-chart-1` 等），随模式联动派生：

| 系列 | 黑夜 | 白天 | 派生规则 |
| --- | --- | --- | --- |
| chart-1 | `#4a6cff` | `#3857e8` | 主题色本体 |
| chart-2 | `#3147a1` | `#7088ee` | 主题色加深/提亮 |
| chart-3 | `#667fcd` | `#667dd0` | 主题色 × 钢灰 |
| chart-4…6 | `#7d8fa5` → `#33414f` | `#94a3b8` → `#ccd6e0` | 钢灰梯度（次要系列） |

规则：

1. 数据系列按 1→6 顺序取色，**上限 6 系列**；超过先问设计。
2. 「实际 vs 目标」类对比：实际 = chart-1 实心 + `glow-bar`；理论/目标 =
   chart-2 虚线描边（`border-dashed border-chart-2`，无填充）。见
   process-production 的每小时产量图。
3. 数字读数统一 `font-mono tabular-nums`；主角数字（hero）用 `glow-number`
   + `text-4xl` 以上。

## 光晕与渐变

- `glow-number`：主角数字的主题色光晕（强度随模式自动收敛）。
- `glow-bar`：chart-1 柱体的柔光。
- `channel-keyline`：选中态的 3px 主题色内侧键线（侧栏、设置导航、选中行）。
- 页面背景是 `--app-gradient`（顶部中心向外、主题色 ≤8% 晕染的径向渐变）；
  卡片/浮层保持不透明，靠实底分层。不要再叠加别的背景图。

光晕三件套**只用在主角读数、chart-1 柱体和选中键线**上，别当装饰撒。

## 触控尺寸基线

一体机触屏，最小点击目标 48px：Button default h-12 / lg h-14 / xl h-16 /
icon 48×48；Input h-12；表格行 py-3。字号令牌已放大（xs 13 / sm 15 /
base 17px），页面里不得再缩回 `text-xs` 以下。数值输入一律
`NumberInput`（弹数字键盘），单选列表一律 `TouchSelect`（弹模态列表），
滚动容器一律 `DragScroll`（支持按住拖动）。

## 新增主题色

改 `theme.css`：`@theme` 里改黑夜值（或 chart 令牌），`html[data-mode='light']`
块里改白天值；两处成对改。不要新增只改一面的主题色。
