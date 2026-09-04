# 07. UI设计系统

> **翻译说明：** 本页是与 [英文源规格](/spec/04-ux/07-ui-design-system) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 目标

1. 为 PI-Desktop 中的视觉标记、组件基础和布局指标提供**单一事实来源**
2. 确保浅色和深色主题的**高可读性和对比度** - 这是开发人员工作站，而不是营销界面
3. 将所有设计决策映射到 **Tailwind CSS 标记**，以便规范 → 实现明确
4.启用**未来类似shadcn的原始提取**，无需重新指定基础

## 视觉基线（与 Codex 一致）

桌面外壳的目标是与本地 Codex 桌面客户端 (ChatGPT.app electro-dark) 进行 1:1 视觉匹配：木炭表面 (`#181818`)、中性灰度（不是蓝石板）、~275px 侧边栏、46px 工具栏节奏和浮动药丸编辑器。语义标记名称保持稳定；值遵循 Codex 灰色系统，带有**中性灰色强调**（无蓝色品牌强调）。

## 2. 非目标

1. 具有充满活力的渐变或有趣的插图的消费者品牌识别系统
2. 完整的组件库规范（即[08-component-spec.md](/zh-CN/spec/04-ux/08-component-spec)）
3. 自定义字体服务或 CDN 字体托管 — 使用本地捆绑
4. 复杂的主题市场或用户可自定义的调色板（仅限 MVP：仅限 system/light/dark）
5. 像素完美的 Figma 切换伪影

## 3. 视觉原则

| 原理 | 应用 |
|---|---|
| **清晰度优于装饰** | 没有装饰性边框、渐变或英雄图像。每个视觉元素都承载着信息。 |
| **开发者密度** | 紧凑的间距、小而易读的字体、最小的营销空白。信息丰富而不稀疏。 |
| **暗基默认值** | 深色主题是编码代理的主要主题。光必须得到充分支持，但是次要的。 |
| **克制** | 一种强调色系列。无彩虹状态颜色 - 使用语义标记名称（成功、警告、错误）。 |
| **运动作为反馈** | 动画传达状态变化（流、加载、expand/collapse）。从来不装饰。 |
| **键盘优先** | 焦点环、Tab 键顺序和快捷方式标签是主要的用户体验，而不是事后的想法。 |
| **连续 shell 镶边** | 标题栏与其表面保持无边框连续；仅在窗口控件侧缝等有助于说明归属的边界保留细微分隔线。 |

### 3. 1 文本选择

PI-Desktop 的行为类似于桌面应用程序 shell，因此意外拖动
默认情况下，chrome 会禁止选择。选择合同为：

- 导航、标题栏镶边、按钮、标签、徽章、菜单等
  控件不可通过文本选择。
- `input`、`textarea`、`select` 和可编辑内容仍然可选，因此
  用户可以编辑草稿、搜索和使用本机 `Cmd/Ctrl+A/C/V` 行为。
- 转录消息正文、渲染的 Markdown、代码块和工具
  input/output 仍然可以选择进行复制和检查。
- 新的类文档表面必须选择共享 `.selectable` 类（或
  等效的显式 `user-select: text` 规则）。
- Electron 渲染器设置 `user-select` 和 `-webkit-user-select`；
  选择规则不得删除焦点可见环或窗口拖动区域。
- 可复制的选择油漆使用单色口音合同通过
  `::selection`（`--ds-text-primary` 的 `color-mix` 位于表面约 18% 处，
  文本仍为 `--ds-text-primary`)。浏览器默认的蓝色突出显示不是
  允许在外壳表面。
- `caret-color` 和 `accent-color` 解析为 `--ds-text-primary` /
  `--ds-accent` 因此本机插入符和形式重音符号保持主题。
- 焦点可见环使用 `color-mix(in oklab, var(--ds-accent) 80%, transparent)`
  （没有从中性坡道上漂出的白色水洗）。

### 3. 2 区域设置感知的 Chrome 标签

使用拉丁微样式的部分标签 (`text-transform: uppercase` +
`letter-spacing: wide`）必须在 `:lang(zh-CN)` 下放宽：

- `letter-spacing` 返回 `--tracking-normal`
- `text-transform` 是 `none`（CJK 没有大小写且宽跟踪分割字形）

适用于侧边栏部分标签、设置栏组标签、目的地
部分标签和键盘快捷键组标签。

插件面板镶边遵循相同的外壳上下文：主机精确保留透明的 46px 拖拽带，
并只在右上角固定渲染带三个窗口控件的最简、页面自适应胶囊。胶囊始终
位于该拖拽带内，使用插件页面计算出的表面色和文字色；页面透明时以当前
主题作为回退，浅色插件页面不能被强制套用黑色表面。胶囊之外的拖拽带
不可点击；开发面板显示本地化提醒。插件负责自己的标题、工具栏和其他
所有可见面板表面。

插件页面使用稳定滚动条槽位时，应只将其放在页面实际的内容滚动容器上。
根级 `html`/`body` 视口不能再次预留滚动条槽位，因为 Windows 的经典滚动条
会把重复预留显示成面板表面外侧的空白侧栏。

### 3. 3 产品标识和标志

可见的产品标识是 **PI-Desktop**，即使外壳借用了
法典作为视觉参考。身份契约故意很小：

- 侧边栏外壳名称、设置副本和输入框占位符使用
  `PI-Desktop`； `Codex` 保留用于外部会话导入源或
历史设计参考文本。
- `build/icon_1024.png` 是规范的 shell 徽标母版；渲染器导入由其派生的
  192x192 标记，位于 `src/assets/brand/`（ADR 0125）。 `BrandLogo` 导入它们
  通过Vite所以渲染器捆绑，开发Dock，并打包
  应用程序都使用相同的视觉资产。
- 在 macOS 上，开发和打包发布均将 `PI-Desktop` 公开为
  本机应用程序菜单名称。本机“关于”面板使用 PI-Desktop
  名称、版本和规范图标；没有可见库存 Electron 名称或图标。
  开发启动使用生成的品牌主机包，因为 AppKit
  从主机包而不是 Electron 运行时 API 中读取此标识。
- 在 Windows、Electron 主寄存器上，规范的 `com.pi-desktop.app`
  准备就绪之前的 AppUserModelID。运行时 ID、打包的可执行文件名称、
  和 NSIS 快捷方式标识保持一致，以便本机通知，
  通知设置和任务栏组将应用程序标识为 `PI-Desktop`
  而不是 Electron。
- 空首页英雄使用 100px 的 `HomeMascotLogo` GIF：由八帧挥手动作
  合成，首帧短暂停留后循环播放。播放由 GIF 自身完成，
  没有随机姿势、JavaScript 定时器或悬停加速。减少动态效果时
  切换为首帧 PNG，槽位仍为 100px。
  `BrandLogo` 在 expanded/collapsed 侧边栏中保留 20px/18px，在
  启动水花。 Composer 提示行不呈现领先品牌图标
在主模式或线程对接模式下。
- 新会话控件使用 15–16 像素的专用消息加图标。的
  通用加号图标保留用于非会话添加，例如添加
  一个项目。
- 标记是装饰性的（`aria-hidden`）；周围的控件提供
  本地化的可访问名称和键盘行为。

## 4. 颜色标记

### 4. 1 语义标记命名

组件中的所有颜色引用都使用**语义标记名称**，而不是原始十六进制值。

```text
--color-bg-primary        → main background (chat area, panels)
--color-bg-secondary      → sidebar, cards, nested surfaces
--color-bg-tertiary       → hover states, elevated surfaces
--color-bg-inset          → code blocks, inset areas
--color-text-primary      → main body text
--color-text-secondary    → secondary/label text
--color-text-muted        → disabled, placeholder, hint
--color-border-default    → default borders
--color-border-subtle     → subtle separators (divider lines)
--color-accent            → primary accent (CTA, active states)
--color-accent-hover      → accent hover
--color-success           → success/run states
--color-warning           → warning/caution states
--color-error             → error/denied states
--color-info              → informational states
```

### 4. 2 深色主题（主要）

| 代币 | 十六进制 | Tailwind 映射 | 用途 |
|---|---|---|---|
| `--color-bg-primary` | `#181818` | 法典 `gray-900` | 主表面 |
| `--color-bg-sidebar`/下 | `#000000`（深色）/`#f3f3f3`（浅色） | 法典 `surface-under` / grey-75 | 侧栏导轨 |
| `--color-bg-secondary` | `#212121` | 法典 `gray-800` | 高架表面，输入框 |
| `--color-bg-tertiary` | `#282828` | 法典 `gray-750` | 悬停/不透明升高 |
| `--color-bg-inset` | `#0d0d0d` | 法典 `gray-1000` | 代码块，最深的插入 |
| `--color-text-primary` | `#FFFFFF` | 法典 `gray-0` | 正文 |
| `--color-text-secondary` | `rgba(255,255,255,0.70)` | 法典二级 | 标签，二级 |
| `--color-text-muted` | `#5d5d5d` | 法典 `gray-500` | 已禁用，提示 |
| `--color-border-default` | `rgba(255,255,255,0.08)` | 法典边框 | 默认边框 |
| `--color-border-subtle` | `rgba(255,255,255,0.05)` | 法典边框微妙 | 微妙的分隔符 |
| `--color-accent` | `#FFFFFF`（深色）/`#1a1c1f`（浅色） | 反转灰色墨水 | 主要口音，CTA |
| `--color-accent-hover` | `#EDEDED`（深色）/`#303030`（浅色） | 灰色-100 / 灰色-700 | 重音悬停 |
| `--color-accent-soft` | `#AFAFAF`（深色）/`#5d5d5d`（浅色） | 灰色-300 / 灰色-500 | 软口音、链接 |
| `--color-success` | `#22C55E` | `text-green-500` | 成功，运行完成 |
| `--color-warning` | `#F59E0B` | `text-amber-500` | 警告、小心 |
| `--color-error` | `#EF4444` | `text-red-500` | 错误，被拒绝 |
| `--color-info` | `#6366F1` | `text-indigo-500` | 信息性 |

### 4. 3 灯光主题（Codex electro-light）

仅中性灰度 - 无蓝石板表面。 Chrome 组件必须使用语义 `--ds-*` 标记，以便浅色墨水在 `#f3f3f3` / `#ffffff` 上保持深色。

| 代币 | 十六进制/值 | 用途 |
|---|---|---|
| `--color-bg-primary` | `#ffffff` | 主表面 |
| `--color-bg-secondary` / 侧边栏 | `#f3f3f3`（灰色-75） | 侧边栏表面 |
| `--color-bg-tertiary` | `#f3f3f3` | 嵌套/悬停底座 |
| `--color-bg-inset` | `#ededed`（灰色-100） | 代码块，插图 |
| `--color-text-primary` | `#1a1c1f` | 机身+品牌 |
| `--color-text-secondary` | `color-mix(#1a1c1f 70%, transparent)` | 导航项目、筹码、话题标题 |
| `--color-text-muted` | `#5d5d5d`（灰色-500） | 部分标签 |
| `--color-text-faint` | `#afafaf`（灰色-300） | 占位符 |
| `--color-border-default` | `color-mix(#1a1c1f 8%, transparent)` | 默认边框 |
| `--color-border-subtle` | `color-mix(#1a1c1f 5%, transparent)` | 侧边栏边缘/分隔线 |
| `--color-accent` | `#1a1c1f` | 主要强调、CTA、页脚徽章（中性墨水） |
| `--color-success`/警告/错误 | 绿色-500 / 橙色-500 / 红色-500 | 状态 |

**不变：**切勿在 `data-theme="light"` 下使用原始 `gray-0` (`#fff`) 绘制镀铬文本。使用 `--ds-text-primary` / `--ds-text-secondary`。

共享按钮的表面和墨迹必须使用语义主题标记：
主要操作将 `--ds-accent` 与 `--ds-bg-primary` 配对，而次要操作
操作使用不透明的 `--ds-bg-secondary` 表面，其中包含主要文本和
可见的语义边界。悬停状态使用相应的 accent/tertiary
令牌而不是仅不透明度的更改，因此操作在黑暗中仍然清晰可见
和浅色主题。

光表面抛光（D148）：

- 停靠工作面板使用安静的插页纸 (`#fafafa`)，带有白色标题带和标题中的组合创建触发器，因此工具栏保留在内容上，而无需沉重的分隔线。
- 共享表单字段、浏览器 URL、设置段轨道和快捷键键帽使用 `#f5f5f5` 插入填充 0.5px 墨迹笔划；焦点通过中性环提升至白色。未绑定快捷键显示本地化文字而不是空键帽，录制和恢复控件仍可通过键盘聚焦。
- 设置切换使近乎黑色的旋钮保持在轨道上，并强制白色旋钮处于浅色模式。
  Off/on 轨道和旋钮颜色来自 `--ds-switch-*` 主题标记；一个
每个主题 `:root[data-theme="…"] .settings-toggle` 背景覆盖
  out-指定 `.settings-toggle.on` 并将开启状态搁置在关闭填充上。
- 关闭状态带有暗淡填充加上 1px 插入环，因此有一个空轨道
  仍然作为控件读取；深色主题关闭旋钮保持浅色 (`--gray-300`)
  所以旋钮不会消失在轨道中。
- 对话稀松布软化至约 28% 墨水，因此升高的白色对话仍然可读。

### 4. 4 系统主题行为

- `system` 主题遵循 `prefers-color-scheme` 媒体查询
- 启动时切换为深色时，主题之间的过渡不得闪烁白色
- 初始负载：在第一次绘制之前检测系统偏好（Electron preload 可以中继此）
- 本机控件继承活动的 `color-scheme`。每个原生 `select`
  触发器及其打开的 `:root[data-theme="…"] .settings-toggle`/`.settings-toggle.on` 列表也使用不透明语义
  foreground/background 颜色，因此 Windows Chromium 不会回落到
  设置之外的系统调色板也不可读。

### 4. 5 侧边栏任务状态语义

紧凑任务行保留一个 `12px` 前导状态槽。国家从来都不是
仅通过颜色来传达，并且每种状态都消耗现有的语义
令牌而不是引入装饰调色板：

| 状态 | 语义色彩 | 形状/运动 | 含义 |
|---|---|---|---|
| 已选择 | 中性口音 | 静态轮廓环 | 当前对话 |
| 进行中 | 橙色警告 | 呼吸脉冲受限的实心点 | 代理人正在生产或执行 |
| 已完成 | 成功绿色 | 复选标记 | 最新未读任务轮已完成 |
| 失败 | 错误红色 | 带圆圈的警报标记 | 最新未读任务转失败 |

优先级为 `in progress → selected → completed/failed`。开始另一个
转清除先前的最终结果；中止清除实时指示器，无需
造成失败。打开对话会确认其未读终端
结果：终端标记立即清除并且匹配持久任务
通知被标记为已读，因此该标记在通知后无法返回
刷新或重新启动应用程序。已标记为已读的结果永远不会产生终端
标记。缩减运动模式会禁用呼吸动画，同时保留其
橙色填充和本地化的可访问名称。

### 4. 6 Tailwind CSS 变量存根

以下 CSS 自定义属性存根是规范标记和 Tailwind 类之间的规范桥梁。它**不是应用程序源文件** - 它记录了用于实现的预期映射。

```css
/* === Design System Token Bridge (spec reference, not runtime file) === */
/* Dark theme (default) */
:root[data-theme="dark"] {
  --color-bg-primary:       #181818;
  --color-bg-secondary:     #212121;
  --color-bg-tertiary:      #282828;
  --color-bg-inset:         #0d0d0d;
  --color-text-primary:     #FFFFFF;
  --color-text-secondary:   rgba(255,255,255,0.70);
  --color-text-muted:       #5d5d5d;
  --color-border-default:   #282828;
  --color-border-subtle:    #212121;
  --color-accent:           #FFFFFF;
  --color-accent-hover:     #EDEDED;
  --color-success:          #22C55E;
  --color-warning:          #F59E0B;
  --color-error:            #EF4444;
  --color-info:             #6366F1;
}

/* Light theme */
:root[data-theme="light"] {
  --color-bg-primary:       #FFFFFF;
  --color-bg-secondary:     #FFFFFF;
  --color-bg-tertiary:      #F1F5F9;
  --color-bg-inset:         #F1F5F9;
  --color-text-primary:     #181818;
  --color-text-secondary:   #475569;
  --color-text-muted:       #94A3B8;
  --color-border-default:   #E2E8F0;
  --color-border-subtle:    #F1F5F9;
  --color-accent:           #1a1c1f;
  --color-accent-hover:     #303030;
  --color-success:          #16A34A;
  --color-warning:          #D97706;
  --color-error:            #DC2626;
  --color-info:             #4F46E5;
}

/* Tailwind v4 theme extension (in tailwind config) */
/* Maps semantic tokens to utility classes */
/*
@theme {
  --color-bg-primary:    var(--color-bg-primary);
  --color-bg-secondary:  var(--color-bg-secondary);
  --color-bg-tertiary:   var(--color-bg-tertiary);
  --color-bg-inset:      var(--color-bg-inset);
  --color-text-primary:  var(--color-text-primary);
  --color-text-secondary: var(--color-text-secondary);
  --color-text-muted:    var(--color-text-muted);
  --color-border-default: var(--color-border-default);
  --color-border-subtle:  var(--color-border-subtle);
  --color-accent:        var(--color-accent);
  --color-accent-hover:  var(--color-accent-hover);
  --color-success:       var(--color-success);
  --color-warning:       var(--color-warning);
  --color-error:         var(--color-error);
  --color-info:          var(--color-info);
}
*/
```

实施说明：Tailwind v4 支持 CSS 优先配置。 `@theme` 指令将自定义属性映射到实用程序类（`bg-bg-primary`、`text-text-primary` 等）。实现应验证命名以避免双前缀冲突（例如，`bg-bg` 很尴尬 - 考虑在 Tailwind 级别别名为 `bg-primary`、`text-primary` 等）。

## 5. 版式

### 5. 1 字体堆栈

| 角色 | 小学 | 后备堆栈 | Tailwind |
|---|---|---|---|
| **用户界面（无字体）** | 国际米兰 | `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` | `font-sans` |
| **代码（单声道）** | JetBrains Mono | `"Fira Code", ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace` | `font-mono` |

UI 字体栈可从设置 → 基础 → 外观中由用户覆盖（ADR 0083）。字体行
将 CSS 字体栈持久化为 `AppSettings.fontFamily`；缺失值保持上述令牌栈。
内置开源字体（Geist、Inter、Noto Sans SC、LXGW WenKai — SIL OFL 1.1）
在 `apps/desktop/src/assets/fonts/` 下本地发布并附许可证文本，系统已安装
字体由 Electron 主进程枚举。每个自定义字体栈都会追加 CJK 回退层，
确保中文文本保持可读。等宽字体栈（`--font-mono`）不可由用户配置。

### 5. 2 类型规模

所有字体大小均来自 `styles/tokens.css` 的 `@theme` 块中定义的 `--text-*` 渐变（首先由 `styles/globals.css` 导入，现在只是一个导入序列 — 请参阅 D170）。 `font-size`、`font-weight`、`line-height` 和 `letter-spacing` 的原始 px 文字在组件 CSS 和 TSX 任意实用程序（`text-[13px]` 等）中**禁止** — 由 `scripts/check-style-tokens.mjs` 强制执行（在 `pnpm lint` 中运行）。 `-plus` 后缀标记是 Codex 命名大小之间的半步。

| 代币 | 尺寸 | 用途 |
|---|---|---|
| `--text-3xs` | 10.5像素 | 最小的镀铬（kbd 提示） |
| `--text-xs`（别名 `--text-2xs`） | 11像素 | 时间戳、徽章、工具状态 |
| `--text-xs-plus` | 11.5像素 | 静音元数据、菜单字幕 |
| `--text-sm` | 12像素 | 辅助标签、工具行、侧边栏部分标签 |
| `--text-sm-plus` | 12.5像素 | 芯片、工作指示灯、代码文本 |
| `--text-md` | 13像素 | 侧边栏 session/project 标题、空状态副本、紧凑镀铬 |
| `--text-md-plus` | 13.5像素 | 输入框标签、列表行 |
| `--text-base` | 14像素 | 正文、聊天消息、输入、主侧边栏镶边 |
| `--text-base-plus` | 15像素 | 品牌、显着标签 |
| `--text-lg` | 16像素 | 章节标题、卡片标题 |
| `--text-lg-plus` | 18像素 | 大卡片标题 |
| `--text-xl` | 20像素 | 页面级强调 |
| `--text-2xl` | 28像素 | 目标页面标题、主页英雄 |

行高标记：`--leading-none` 1、`--leading-heading` 1.15、`--leading-tighter` 1.2、`--leading-tight` 1.25、`--leading-compact` 1.3、`--leading-compact-plus` 1.35、`--leading-normal` 1.4、 `--leading-body` 1.45（应用默认值）、`--leading-relaxed` 1.5、`--leading-chat` 1.55、`--leading-prose` 1.6、`--leading-row` 18px（固定高度侧边栏行）。

字母间距标记：`--tracking-tighter` -0.03em、`--tracking-tight` -0.02em、`--tracking-normal` 0、`--tracking-wide` 0.02em。

> 注意：14px 底座是针对开发人员密度而设计的。不要达到默认值 16px。
>
> 侧边栏主要镶边（导航项、页脚标识、配置文件菜单操作）
> 使用 `--text-base`，因此左导轨与主体可读性相匹配。
> 会话标题、project/group 标题和空状态副本使用紧凑型
> `--text-md` 等级；仅部分标签和辅助元数据使用 `--text-sm`。
> 切勿将微型 `--text-xs` 手环用于主要列表内容。

### 5. 3 代码文本大小调整

- 代码块和工具输出：Tailwind/Tailwind 和 `font-mono`
- 消息中的内联代码：`--text-sm-plus` `font-mono`、软文本色调背景、无边框、圆形
- 聊天散文 (`.prose-chat`) 使用 `--text-base` / `--leading-prose` 作为正文，标题坡度为 `text-xl` → `text-lg-plus` → `text-lg` → `text-base-plus` → `text-base`，因此多块答案保持可扫描，无需文档规模的戏剧。标题不包含 rules/borders（层次结构来自大小、重量和上方的空间）；链接保留了柔和的永久下划线，悬停时会变硬，而不是仅仅依靠颜色； blockquotes 是一个安静的 2px 左栏，没有背景填充

### 5. 4 重量规则

权重仅使用 `--font-weight-*` 令牌（Codex 使用可变字体中间权重）：

- `--font-weight-normal` 400：默认 body/label 文本
- `--font-weight-medium` 500：强调、碎片、行标题
- `--font-weight-medium-plus` 520：选择 Codex 镀铬标签
- `--font-weight-strong` 560：目标页面标题（法典电子公制）
- `--font-weight-semibold` 600：品牌、CTA 按钮
- 切勿使用 700+

## 6. 间距、半径、高程、边界

### 6. 1 间距比例

| 代币 | 价值 | 用途 |
|---|---|---|
| `space-0.5` | 2像素 | 紧密的内嵌间隙 |
| `space-1` | 4像素 | 图标文本间隙、徽章填充 |
| `space-1.5` | 6像素 | 紧凑的内垫 |
| `space-2` | 8像素 | 标准内部填充，列出间隙 |
| `space-3` | 12像素 | 卡片内部填充、部分间隙 |
| `space-4` | 16像素 | 节边距、输入框填充 |
| `space-6` | 24像素 | 面板间隙、主要分离 |
| `space-8` | 32像素 | 页面级边距（罕见） |

### 6. 2 半径比例

所有半径均来自 `--radius-*` 令牌（禁止原始 px，与排版相同的保护）：

该比例遵循苹果当前的形状指导，同时保留密度
桌面编码工具的：

- 固定圆角矩形是紧凑型和中型控件的默认设置。
- 胶囊保留用于药丸、分段选择、状态标签和
  故意突出的行为；圆圈是为等宽图标保留的
  控件、头像和点。
- 嵌套表面应同心，其角在视觉上对齐：
  `outer radius = inner radius + the gap between their edges`。
- 半径随着表面尺寸和高程而增大。全宽结构板
  例如侧边栏、标题栏和工作面板在窗口中保持方形
  边缘。

| 代币 | 价值 | 用途 |
|---|---|---|
| `--radius-3xs` | 4像素 | 内联代码 |
| `--radius-2xs` | 6像素 | 小型直插芯片 |
| `--radius-xs` | 8像素 | 紧凑型按钮、复制按钮 |
| `--radius-sm` | 10像素 | 标准按钮、输入、菜单项、工具行、kbd |
| `--radius-md` | 12像素 | 菜单和紧凑卡 |
| `--radius-md-plus` | 14像素 | 卡片和代码块 |
| `--radius-lg` | 16像素 | 面板和设置卡 |
| `--radius-lg-plus` | 18像素 | 大面板和对话框 |
| `--radius-xl` | 20像素 | 消息气泡和输入框 |
| `--radius-2xl` | 24像素 | 输入框相邻的突出表面 |
| `--radius-full` | 9999像素 | 药丸、徽章、滚动拇指 |
| `--radius-round` | 50% | 圆形按钮、头像、圆点 |

### 6. 3 高度/阴影

深色主题：高度通过**背景表面分层**（bg-secondary → bg-tertiary）来表达，而不是盒子阴影。

浅色主题：仅在分层不足时使用最小阴影。

| 级别 | 黑暗 | 光 | 用途 |
|---|---|---|---|
| `elevation-0` | 平坦（bg-主要） | 平坦（bg-主要） | 默认表面 |
| `elevation-1` | BG-中学 | bg-次要 + `shadow-sm` | 卡片、侧边栏 |
| `elevation-2` | BG-第三级 | bg-三级 + `shadow-md` | 悬停、下拉菜单 |
| `elevation-3` | bg-第三级 + 边框重音 | bg-白色 + `shadow-lg` | 对话框、叠加层 |

侧边栏页脚：透明实用带，没有分隔符。设置，
插件和通知图标按钮仍然分组在左侧。的
build/version 芯片右对齐并保持更新 check/release 条目
点。悬停和活动状态使用语义侧边栏表面；双方都没有添加
永久卡片填充。

配置文件菜单为 `280px` 宽，在页脚上方打开 `8px`，并使用
标准的不透明提升菜单表面、微妙的边框和对话框阴影。其
第一个块使用相同的字形和两行文本重复本地标识，
接下来是分隔线和紧凑的设置/日志/主题行。

工具栏行为 46 像素。 macOS 将交通信号灯放置在 `{x:16,y:16}` 处并保持
展开侧边栏的搜索和折叠侧边栏图标按钮右对齐
在同一行。 macOS 行省略侧边栏 logo/title，保留 `76px`
在窗口模式下的本机 chrome 左侧，并回收该填充
全屏。 Windows/Linux 将身份和侧边栏操作保留在第一位置
行并为三个无框窗口控件保留最右边的 112px。每个
control 拥有 46px 高保留带的全部份额。主要、设置和
工作面板拖动区域必须在此保留之前终止，而不是
重叠它并仅依赖于后代 `no-drag`，因此每个可见控件
像素仍然可点击。乐队漂浮在目标页面上，等等
Windows/Linux 页框和任何右边缘详细信息表从其下方开始
而不是在窗口下放置自己的标题操作或关闭控件
控制。窗口内不呈现任何应用程序菜单。
其他菜单弹出窗口使用标准的不透明提升菜单表面 `radius-sm`，
微妙的边框和对话框阴影；它们永远不会是半透明的而不是可读的
内容。

输入框海拔（Codex `elevation-prominent`）：

- 笔画：`0 0 0 0.5px` 边框重混合
- 软：`0 3px 7.5px rgba(0,0,0,0.039)` + `0 0 20px rgba(0,0,0,0.051)`（Codex `#0000000a` / `#0000000d`，两个主题）

阴影标记值（仅限浅色主题）：

```text
shadow-sm:  0 1px 2px rgba(0,0,0,0.05)
shadow-md:  0 2px 8px rgba(0,0,0,0.08)
shadow-lg:  0 8px 24px rgba(0,0,0,0.12)
```

### 6. 4 边界规则

| 背景 | 代币 | 宽度 | 风格 |
|---|---|---|---|
| 默认分隔符 | `border-subtle` | 1像素 | 固体 |
| 卡片轮廓 | `border-default` | 1像素 | 固体 |
| 对焦环 | 强调色 | 2像素 | 实心，偏移 2px |
| Active/pressed | 强调色 | 1 像素插图 | 固体 |

## 7. 图像学

### 7. 1 图标集

- **主要：** Lucide（SVG，MIT 许可证，24×24 默认网格）
- **替代方案：** Heroicons v2（大纲变体）
- 切勿将两者混合在同一表面 - 每个实施文件选择一个
- **切勿使用表情符号作为图标** - 表情符号是文本内容，而不是 UI 可供性

### 7. 2 尺寸调整

| 背景 | 尺寸 | 笔划宽度 |
|---|---|---|
| 内嵌文本 | 16 像素（1 雷姆） | 1.5像素 |
| 按钮、工具栏 | 20 像素（1.25 雷姆） | 2像素 |
| 空状态 | 48 像素（3 雷姆） | 1.5像素 |

### 7. 3 颜色规则

- 默认：`text-secondary`
- Hover/active：`text-primary`
- 强调动作：`accent` 颜色
- 禁用：`text-muted`
- 切勿在按钮中使用彩色图标背景（无图标 circles/squares）

## 8. 运动

### 8. 1 持续时间范围

`:root` (D146) 上的 CSS 自定义属性：

| 代币 | CSS变量 | 持续时间 | 用途 |
|---|---|---|---|
| `duration-fast` | `--motion-duration-fast` | 150毫秒 | 悬停过渡、颜色变化 |
| `duration-normal` | `--motion-duration-normal` | 200毫秒 | Expand/collapse、滑入、toast/dialog 输入 |
| `duration-slow` | `--motion-duration-slow` | 300毫秒 | 面板转换、开机启动输入 |

交互式表面应该引用这些变量而不是硬编码
实用时为毫秒文字。

### 8. 2 宽松

`:root` (D146) 上的 CSS 自定义属性：

| 代币 | CSS变量 | 曲线 | 用途 |
|---|---|---|---|
| `ease-out` | `--motion-ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | 默认输入/悬停/填充过渡 |
| `ease-in` | `--motion-ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | 退出动画（Toast、溅出） |
| `ease-standard` | `--motion-ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | 连续进度指示器（启动栏） |

- 输入动画：`ease-out`
- 退出动画：`ease-in`
- drag/releases 类似弹簧：**不在 MVP 中**（使用 `ease-out`）

### 8. 3 启动启动画面（启动反馈）

虽然 Electron 引导程序尚未准备好，但渲染器会绘制全窗口
**启动启动**（`StartupSplash`、`data-testid="startup-splash"`）而不是
纯状态文本：

- 活动目录中的品牌标记 (`BrandLogo` 64px)、外壳名称和标语
- 通过 `app.starting`（仅限屏幕阅读器）可访问状态副本
  `role="status"` / `aria-live="polite"`
- 软不确定进度条作为加载反馈（≤1.1s循环）
- 正常运动时最短可见时间约为 420 毫秒，以避免快速启动时出现闪光
- 退出：一旦 `ready` 为 true，就会出现 280 毫秒不透明度淡出 (`startup-splash-out`)，显露出来
  下面已经安装好的外壳
- 减少运动：接近零的 enter/exit 和静态全宽条

这是启动状态反馈，而不是装饰性镀铬。

### 8. 4 覆盖/浮动表面输入

对话框、搜索聚光灯和模态背景使用共享输入关键帧：

稀松布：`overlay-in`（不透明度，`--motion-duration-normal` / `--motion-ease-out`）
- 深色主题稀松布保持约 45% 的黑色；浅色主题使用 ~28% `#1a1c1f` 所以白色
  对话并不隐藏在厚重的面纱之下（D148）
- 居中表面：`surface-in`（淡入淡出 + 8px 上升 + 轻微缩放）
- 顶部锚定表面（搜索）：`surface-in-top`

Toast enter/exit 保留现有移除合同（`animationend` 于
`toast-out`），同时使用运动标记和稍微柔和的音阶。

### 8. 5 减少运动

所有动议令牌必须遵守 `prefers-reduced-motion: reduce`：

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

启动启动画面、overlay/dialog 输入、流脉冲和连续条
也明确地抑制或折叠到静态状态。

> 另请参阅 [09-interaction-patterns.md](/zh-CN/spec/04-ux/09-interaction-patterns) §10。

### 8. 6 禁止运动

- 无视差
- 没有连续的背景动画（粒子、波浪）；有界的
  前台吉祥物循环是显式的空主异常
- shimmer/skeleton 动画的循环时间不超过 1 秒 — 使用简单的淡入来显示加载状态
- 无反弹效果
- 没有多秒的开机戏剧序列；准备好后立即退出（+最小停留时间）

### 8. 7 响应式交互反馈

高频工作站反馈必须保持对合成器友好且有界：

- 目标表面、工作面板、跳转到最新控件和内联
  错误通知使用 `opacity` 输入一次，加上最大 8px
  使用 `--motion-duration-normal` 的 `animationend`/enter/exit 偏移量和
  `--motion-ease-out`。
- 图标、导航、消息操作、选项卡、侧边栏工具和标准按钮
  控件在活动时提供微妙的按下比例。基础过渡
  包括 `transform`，因此按下和释放不会突然发生；悬停样式从不
  更改元素尺寸或周围布局。
- 输入框焦点提升 1 像素，并带有基于令牌的受限阴影。其
  近乎不透明的表面不得使用背景模糊：转录本在
  模糊层会在流式传输时强制执行可避免的 repaint/compositing 工作。
- 内联聊天错误通知包含长提供商详细信息并保留他们的操作
  无需引入水平页面溢出即可到达。
- 流驱动的更新永远不会重新启动路线或外壳动画。每次进入
  效果是 mount/state-transition 反馈，而不是对令牌到达的响应。
- 侧边栏和工作面板停靠转换为其分配的 `width` 进行动画处理并
  `flex-basis` 与有界的 opacity/transform 偏移量一起。主聊天必须
  在 150-200ms 过渡期间连续回流，永远不会跳到最后
  第一个绘制框架之前的停靠宽度。
- 可替换的流式 message/tool 部分可以合并到下一个
  动画帧；终端、权限、计划和错误状态首先刷新
  并保持同步。
- 减少运动模式保留每个状态变化和滚动目的地，但使用
  接近零的动画持续时间和即时而非流畅的程序化
  滚动。

## 8. 0 Home 空栈和底部 Composer (D111/D204/D206)

空输入框占位提示按当前页面和会话作用域保持稳定：首页从
`chat.placeholderHome` 开始，会话输入框从 `chat.placeholder` 开始。处于
同一页面和会话时文案不变；切换首页/会话视图或活动会话时，才推进到本地化的
命令/文件提示（`chat.placeholderHomeHint` / `chat.placeholderHint`）和快捷键提示
（`chat.placeholderShortcut`）。它不会因计时器、焦点、草稿或 IME 状态而轮换。
可见文案使用透明度渐变，并在浅色和深色输入框面板上保持可读。

空聊天主页将内容和输入框保留在单独的垂直区域中
`home-main-content` 内部（D111/D204/D206；取代 D047 双生长门户
模型）：

- `flex: 1; min-height: 0; overflow: hidden` 列
- 内滚动条（`.home-scroll`）是唯一的垂直溢出表面
英雄和可选清单
- 堆栈 (`.home-stack-inner`) 使用内容宽度 **`min(100%, 768px)`**，
  **`gap: 16px`**（工作站天花板）和自动边距以使列居中
  当视口很高时
- 内容顺序为 **英雄 → 可选的入门清单**。任务入口
  直接从底部输入框开始；没有启动提示网格或上下文
  呈现快速操作行 (D204/D206)。
- 短窗口（`max-height ≤ 760px`）顶部对齐堆栈并保留每个
  可通过滚动到达内容块；底部输入框仍然可见
  并且从不涵盖清单
- 主输入框是滚动器的底部保留兄弟。线程模式
  保持其绝对底部码头并保留其测量高度，无需
  全幅褪色头纱
- Composer 半径使用 Codex `radius-3xl-base` (**20px** / `1.25rem`)
- 空屋输入框的高度是内容驱动的：一行草稿呈现
  紧凑的外壳，随着吃水而增长，穿过七个可见的行，然后
  当文本区域在内部滚动时保持外壳稳定
- 轻型侧边栏没有独立的新任务行；范围会话创建
  控件仅保留图标并使用语义悬停清洗
- 空英雄标题使用`var(--ds-text-primary)`（轻覆盖`#1a1c1f`）；
  切勿对共享英雄样式的浅色墨水进行硬编码
- 空置房屋品牌保持安静：100 像素的八帧吉祥物 GIF 是唯一的
  动画英雄标记。它循环一段短挥手并在首帧稍作停留，
  因此输入框仍然是主要的任务表面。指针悬停不改变节奏；
  减少运动时显示静止首帧。
- 夜间家庭输入框板样式**仅限黑暗范围**（高架主
  `#212121f5` + 标准标高-突出）
- 空草稿行保持 **一条可见线/28 像素光学最小值**，因此
  占位符仍然可见；它会自动增长到七条视线并且
  从第八行开始内部滚动
- 主目录和线程对接提示行不包含领先品牌图标，因此
  草稿直接与输入槽对齐。浅色占位符 ~`#525355`
- 禁用发送是一个**实心灰色芯片**（`#8e8e90` 灯，白色箭头），而不是
  仅不透明度淡入淡出
- 浮动输入框板使用一个固体语义表面，没有内部
  渐变：亮处为 `--ds-bg-composer`，暗处为升高主色。一个
  发际线描边加上内敛的`--elevation-prominent`阴影提供
  分离；记录保留测量的码头高度而不是
  绘制全宽渐变面纱。
- 深色高架外壳读取为高架-初级 (`#212121f5` / grey-800 96%)
  在 `#181818` 上具有标准标高突出
- 入门卡在工作站宽度上使用两列网格，并折叠到
  低于 620 像素的一列。每张卡片都使用微妙的边框、小图标板、
  本地化的 title/description 和安静的箭头可供性； hover/focus
  使用共享的悬停填充、边框、阴影和运动标记。

## 8. 1 Composer 瞬态文件引用

被动项目/本地/分支铁路在 D095 下仍然被删除。当
草稿参考文件，编辑器内出现临时换行
位于文本区域上方。每个安静的文本芯片都使用嵌入表面，一种微妙的
边框、文件字形、椭圆形叶子名称和焦点可见删除
行动。没有引用意味着没有保留行或额外的输入框高度。的
规范路径是 tooltip/accessibility 元数据，而不是文本区域正文副本，
包括在无人应答的智能停止恢复之后。调度和持久化用户
消息仍然携带 D124 所需的规范路径。

大段文本粘贴使用第二种展示方式：不超过配置的
`largePasteThreshold` 的纯文本输入仍由文本区域原生处理；超过阈值的输入会以
UTF-8 写入活动会话的临时 `pasted/` 目录。文本区域会在粘贴插入符号处插入生成的
`@<temporary-name>` 标记，即使粘贴发生在已有草稿中间也会保留前后内容。渲染器
在可见文本之外保存标记到规范路径的映射，并在发送前只解析一次。该阈值位于
AI → 默认项中，默认为 600 个字符，只作用于纯文本粘贴；剪贴板文件和图像仍使用
芯片展示。

## 8. 2 Composer 运行时控件

编写器仅渲染连接到活动 pi 会话的控件：

- Agent / Plan / Goal 更新持久会话模式并更改下一个 pi
  工具集。 Plan 和 Goal 是同一 Agent 的合约状态。
- 模型触发器仅显示活动模型 ID。它的菜单选择一个
  为活动会话配置 provider/default-model 对并链接到
  Agent。
- 具有推理能力的模型会立即向您公开单独的思维触发器
  左侧工具栏组中 Agent / Plan / Goal 的右侧。触发器显示
  当前级别并打开模型的真实 `supportedThinkingLevels` 作为
  紧凑的单列列表，并选中所选行。菜单适合它
  内容、上限为 160px 和可用视口宽度，并截断标签
  超过该上限。它仅包含具体的支持级别，没有
  inherit/default 行；没有推理支持的模型不会渲染任何触发器。
- 当活动会话运行时，草稿和运行时控件保持不变
  可编辑为下一轮选择；仅发送被禁用。主机配置
仍然固定在飞行中的回合处，最新的排队选择是
  在其终止事件之后仍然存在。等待批准仍会阻止编辑。
- 文件、照片和应用程序快照控件保持隐藏状态，直到其有效负载收缩
  是端到端实施的。
- 思考菜单保留对活动会话的更改，并在一段时间后关闭
  选择。它准确渲染 pi-ai 为所选内容发布的级别
  模型。未知的 Custom/OpenAI-compatible 模型未暴露任何发明的推理
  行动或分级阶梯。更换供应商钳位或重置耐用性
  下一轮之前的会话值。
- 左侧输入 Composer Agent/Plan/Goal 芯片是唯一的活动会话模式
  控制和循环 Agent → Plan → Goal → Agent。顶部栏没有重复的模式或模型控件。
  Composer 组合选择器当存在有效的 `pending` Plan 或 Goal 批准时将关闭并被禁用；
  终端提案快照不会禁用它。批准选择器记住
  该设备上最后选择的模式并将其用于下一个待处理的提案。
  Live Host 事件更新最新的检查点或
  在当前渲染器生命周期内保留执行状态。渲染器
  reload 仅通过 `plans.pending` 重新水化挂起的行；终端卡
  没有恢复。

## 8. 3 全局插件启动器

`Option + Space` 位于 macOS 上，`Alt + Space` 位于 Windows/Linux 上，打开居中、
显示屏上最靠近指针的无框 620×440 实用程序窗口。表面
没有关闭、最小化、最大化、调整大小或任务栏控件并关闭
模糊或逃避。其坚固的升高标记表面适用于浅色和深色主题
没有背景模糊。

重点搜索字段过滤器启用，准备好贡献面板的插件。
中文显示名称与其原始字符相符，无声调完整拼音，
以及拼音声母；插件 ID、名称和描述仍然可搜索。
箭头键移动活动选项，Enter 或单击打开现有沙盒
插件面板和 IME 组合击键永远不会导航或调度。
- 本地和分支上下文是非交互式状态标签；项目名称
  仍然是一个操作，因为它会打开项目选择器。
- 运行时芯片标签（Agent/Plan/Goal、Thinking、权限模式、模型ID）使用
  `--text-sm` 和 `--leading-compact` 在 28 像素命中目标内。他们一定不能
  将 `leading-none` 与溢出剪辑一起使用：字形上的下降符，例如
  Agent/Plan/Goal/`--text-sm`/`--leading-compact` 保持完全可见。长模型 ID 仍然通过水平截断
  省略号而不破坏行框（D150）。

## 8. 3 思维披露

- 辅助思维在最终答案之前呈现为轻量级内联
  与工具活动行对齐的披露：透明的转录本表面，
  仅闪光提示、旋转 V 形、辅助文本和微妙的左规则
  围绕扩展推理。它使用语义主题和焦点环标记
  浅色和深色模式；它不得引入单独的插入卡。
- 披露是公开的，而仅思考的回应正在流动，并且可能
  之后可以独立切换。
- 触发器是带有 `aria-expanded`、`aria-controls` 和本地化按钮
  Show/Hide 标签。崩溃的推理隐藏在焦点和可访问性之外
  遍历；简化运动模式禁用闪烁和显示过渡。
- 思考永远不会进入答案气泡，答案复制动作，文字记录
小地图摘录，或可搜索的答案文本。
- 仅思考流打开文字记录表面，没有空答案
  气泡或重复的工作指示器。


## 9. Z 索引层

| 图层 | Z 指数 | 用途 |
|---|---|---|
| `z-base` | 0 | 默认内容 |
| `z-sticky` | 10 | 粘性标题、顶栏 |
| `z-dropdown` | 20 | 下拉菜单，选择弹出窗口 |
| `z-overlay` | 30 | 工具提示 |
| `z-dialog` | 40 | 设置和确认对话框 |
| `z-toast` | 50 | Toast 通知 |
| `z-command-palette` | 60 | 命令面板叠加，身体入口 menus/popovers |
| `z-devtools` | 100 | DevTools 覆盖（非生产） |

规则：

- 切勿使用 `z-index: 9999` 或类似的任意高值
- 每层都有一个固定的偏移量；这些层之外没有自定义 z-index
- 层内堆叠使用 DOM 顺序，而不是更高的 z 值

## 10. 布局 shell 指标

这些指标定义了 AppShell 框架。有关组件详细信息，请参阅 [08-component-spec.md](/zh-CN/spec/04-ux/08-component-spec)。
法典奇偶校验决策 (D034/D070) 取代此处的任何旧值。

| 公制 | 价值 | 注释 |
|---|---|---|
| 标题栏行高 | 46像素 | Codex 工具栏节奏 (D034)；交通灯 {x:16,y:16} |
| 侧边栏宽度（折叠） | 48像素 | 仅图标轨道 |
| 侧边栏宽度（展开） | `240px–520px`（默认 275px） | 右边缘调整大小手柄；持久化的首选宽度 |
| 主窗格最小可读宽度 | 360像素 | 目标同时固定窗口可以容纳面板+聊天；其下方的受限窗口回流聊天（D163、ADR 0033） |
| 工作面板宽度（闭合） | 0像素 | 默认隐藏 |
| 工作面板宽度（打开） | `244px–720px`（默认280px），固定为承诺宽度 | 组合的创建触发器保持内容的完整面板宽度；该面板是流入列，从不扩展操作系统窗口（D154/D163、ADR 0033） |
| Composer shell 最小 | 〜80像素 | 一行草稿+工具栏填充 |
| 输入框草稿高度 | 1–7 行文本 | 自动增长；超出第 7 行的内部滚动 |
| 聊天消息最大宽度 | 720px 助手/560px 用户板 | 防止眼距过度拉伸；用户轮流保持紧凑 |
| 窗口最小宽度 | 1040像素 | 由 Electron 强制执行作为基本聊天 shell 最小值；打开的工作面板会在固定窗口内重新排列聊天，并可能将聊天窗格缩小到 360 像素可读目标以下 |
| 窗户最小高度 | 700像素 | 由 Electron 强制执行 |

开放式工作面板是一个固定宽度的流入柱；它回流 MainChat 并
从不扩展操作系统窗口 (ADR 0033)。渲染器请求一个原生的
保留宽度为 0，因此聊天宽度仅通过回流而改变。当地人
浏览器视图遵循渲染器测量的面板矩形。持续正常范围
是用户的窗口大小。在折叠运动开始之前，任何本机浏览器
预览表面已分离，因为它无法参与渲染器 CSS
动画。 Windows 在有界滑动期间使退出的坞站保持不透明，因此
无框原生调整大小永远不会暴露全面板背景闪光； macOS 和
Linux 保留淡入淡出和滑动退出。

### 10. 1 响应式崩溃

- 工作面板从不参与响应式折叠。它保留了它的
  可见时提交的 `244..720px` 宽度（默认 280px）。
- 本机窗口和侧边栏更改回流 MainChat。 360px 聊天目标成立
当固定窗口可以容纳面板+聊天时；否则聊天会在其下方回流。
- 面板 open/collapse/final 关闭和分隔符提交更新已提交
  首选宽度。本机边缘调整窗口大小并重排 MainChat。
- 外层外壳在每个平台上都保留原生边缘/角落调整大小。无边框标题栏的
  拖动区域不会替代操作系统的调整大小所有权。300ms 的稳定边界等待窗口
  可避免恢复逻辑与慢速指针手势竞争，原生调整大小/移动事件停止 600ms 后
  才保存正常基础边界。宽度 < 1040 像素或高度 < 700 像素不受 Electron
  支持并会被阻止。

## 11. 组件基础

这些是通用原语的**令牌级基础**。详细的组件规格位于 [08-component-spec.md](/zh-CN/spec/04-ux/08-component-spec)。

### 11. 1 按钮

| 变体 | 填充 | 身高 | 字体 | 半径 | 边框 | 背景 |
|---|---|---|---|---|---|---|
| 小学 | px-3 py-1.5 | 32像素 | 短信-sm 500 | 半径-sm | 无 | 口音 |
| 中学 | px-3 py-1.5 | 32像素 | 短信-sm 400 | 半径-sm | 边框默认值 | BG-中学 |
| 幽灵 | px-2 py-1 | 28像素 | 短信-sm 400 | 半径-sm | 无 | 透明 |
| 危险 | px-3 py-1.5 | 32像素 | 短信-sm 500 | 半径-sm | 无 | 错误 |

### 11. 2 输入/文本区域

| 财产 | 价值 |
|---|---|
| 高度（单线） | 32像素 |
| 填充 | px-3 py-1.5 |
| 字体 | text-sm font-mono （用于输入框）； text-sm font-sans（用于设置） |
| 边框 | 1px 边框-默认；焦点 → 2px 重音环 offset-2 |
| 背景 | bg-主要 |
| 半径 | 半径-sm |
| 文本校正 (D145) | 每个文本上的 `spellCheck={false}`、`autoCorrect="off"`、`autoCapitalize="off"` input/textarea |

### 11. 3 卡

| 财产 | 价值 |
|---|---|
| 填充 | p-3 |
| 边框 | 1px 边框-默认 |
| 半径 | 半径-lg |
| 背景 | BG-中学 |
| 悬停（互动） | bg-tertiary，无阴影变化 |

### 11. 4 对话框/模态

| 财产 | 价值 |
|---|---|
| 最大宽度 | 480像素 |
| 填充 | p-6 |
| 半径 | 半径-lg-plus |
| 背景 | bg-次要（深色）； bg-白色（光）+阴影-lg |
| 背景 | rgba(0,0,0,0.5) 与 `z-dialog` |
| 关闭 | Escape 键 + X 按钮右上角 |

### 11. 5 标签

| 变体 | 指标 |
|---|---|
| 给标签下划线 | 活动选项卡下方 2px 重音线 |
| 填充 | px-3 py-2 文本-sm |
| 活跃 | 文本主线 + 重音下划线 |
| 不活跃 | 文本次要，悬停 → 文本主要 |

### 11. 6 徽章

| 变体 | 尺寸 | 字体 | 半径 | 填充 |
|---|---|---|---|---|
| 默认 | 汽车 | 文本-xs 500 | 半径-sm | px-1.5 py-0.5 |
| 状态点 | 8 像素圆 | — | 全半径 | — |

状态徽章颜色：成功（绿色）、警告（琥珀色）、错误（红色）、信息（靛蓝）、静音（石板色）。

### 11. 7 工具提示

| 财产 | 价值 |
|---|---|
| 字体 | 文本-xs |
| 填充 | px-2 py-1 |
| 半径 | 半径-sm |
| 背景 | bg-第三级（深色）； bg-slate-800（轻型） |
| 文字 | 文本为主 |
| 延迟 | 300ms 显示，100ms 隐藏 |
| 最大宽度 | 240像素 |

### 11. 8 Toast

完整的组件合同和使用规则：[08-component-spec.md §17](/zh-CN/spec/04-ux/08-component-spec#17-toast)。

| 财产 | 价值 |
|---|---|
| 职位 | 顶部中心视口，距顶部边缘 16 像素，`width: min(360px, 100vw − 32px)` |
| 表面 | `bg-elevated-opaque` + 1px `border-subtle` + `shadow-dialog`（与浮动菜单同族） |
| 半径 | 半径 md 加 |
| 字体 | 文本 md、前导紧凑加 |
| 变体 | `info` / `success` / `warning` / `error` — 16px Lucide 状态图标，带有语义标记；表面保持中立（约束原理） |
| 持续时间 | 4秒自动关闭；错误8s； `duration: 0` = 粘性；悬停暂停计时器 |
| 堆栈 | 垂直，最大 4（最旧的掉落），最新的最接近顶部中心锚点，将旧的向下推；相同的消息+变体重新引发重新启动而不是堆叠 |
| 解雇 | 每个 Toast 上的 X 按钮（`toast.dismiss` i18n 标签） |
| 运动 | 进入200ms缓出slide-down/fade，退出150ms缓入淡入淡出；减少运动 → 接近零持续时间（不是 `none`，移除监听 `animationend`） |
| Z 指数 | z-Toast (50) |

## 12. 状态模式

### 12. 1 交互状态

| 状态 | 背景 | 文字 | 边框 | 光标 | 运动 |
|---|---|---|---|---|---|
| 默认 | 每个变体 | 每个变体 | 每个变体 | 默认 | — |
| 悬停 | bg-第三级或重音悬停 | 文本为主 | — | 指针 | 150毫秒 |
| 焦点 | — | — | 2px 重音环 offset-2 | 默认 | — |
| 焦点可见 | 与焦点相同（仅在键盘焦点上） | — | 2px 重音环 offset-2 | 默认 | — |
| Active/pressed | 重音背景，文本倒置 | 文本为主（倒置） | — | 指针 | — |
| 残疾人 | BG-中学 | 文本静音 | 边界微妙 | 不允许 | — |
| 加载中 | 与默认+微调器相同 | 文本次要 | — | 等待 | 旋转器 1s 旋转 |

### 12. 2 语义状态

| 语义学 | 指标 | 颜色 |
|---|---|---|
| 成功 | 图标 ✓ 或绿点 | 成功令牌 |
| 错误 | 图标 ✗ 或红点 + 内嵌消息 | 错误标记 |
| 警告 | 图标 ⚠ 或琥珀色圆点 | 警告标记 |
| 跑步 | 旋转器（中性）+脉冲左边框 | 重音符号 |
| 待定 | 变暗+时钟图标 | 静音令牌 |
| 被拒绝 | 红色轮廓+“拒绝”标签 | 错误标记 |

### 12. 3 流媒体指示器

- 运行代理：顶栏中紧凑的警告状态点+最新助手消息左边框上的微妙脉冲
- 已完成：旋转图标被成功图标取代，持续 2 秒，然后消失
- 错误：微调器被错误图标取代，持续存在直至关闭

## 13. 内容密度规则

| 规则 | 应用 |
|---|---|
| **基础内边距 8px（空格-2）** | 列表项、表单组的默认内部填充 |
| **消息间隙10px** | 聊天消息行之间——更密集的类似 WorkBuddy 的文字记录 |
| **节间隙 16px（空间 4）** | 在不同的 UI 部分（侧边栏部分、设置组）之间 |
| **面板间隙0px** | 面板边对边接触，并带有微妙的边框分隔符 - 无排水沟 |
| **紧凑列表行 28 像素高度** | 侧边栏会话项目、设置列表行 |
| **按钮行 32px 高度** | 标准按钮 |
| **垂直间隙切勿超过 24 像素** | 即使是“呼吸空间”——这也是一个工作站 |
| **最大内容宽度 720 像素** | 聊天消息、工具披露行——防止眼距过宽 |

## 14. 做/不做

### 做

- 使用语义标记（`text-primary`、`bg-secondary`）——组件代码中切勿使用原始十六进制
- 对所有代码、文件路径、工具参数、终端输出使用 `font-mono`
- 在每个交互元素上提供可见的聚焦环
- 测试对比度：**正常文本最小为 4.5:1**，大文本最小为 3:1
- 保持运动低于 300 毫秒并尊重 `prefers-reduced-motion`
- 默认折叠长内容（工具结果、长消息）— 请参阅 [09-interaction-patterns.md](/zh-CN/spec/04-ux/09-interaction-patterns) §4
- 使用 Lucide/Heroicons SVG 图标 — 切勿使用表情符号作为 UI 可供性
- 使用紧凑的填充和紧密的间距——开发人员密度，而不是消费者间距
- 首次启动遵循系统主题（参见§主题切换）；深色是首要设计目标

### 不要

- 不要在组件 JSX 中硬编码 `#181818` 或任何十六进制值 — 使用令牌
- 不要使用表情符号作为图标替代品（🚀、✅、❌是文本，不是 UI 图标）
- 不要添加装饰性渐变、玻璃态射或霓虹灯效果
- 不要在定义的图层之外使用 `z-index` 值
- 不要为了装饰而制作动画——动作只是反馈
- 不要将 `font-size: 16px` 设置为基础 — 14px 是工作站默认值
- 不要使用大的英雄图像或营销风格的空状态
- 不要对全宽面板（侧边栏、顶栏）应用圆角
- 不要在按钮和输入上使用 `border-radius: 0`（至少使用 `radius-sm`）
- 不要在任何 UI 界面中显示原始 API 键

## 15. 验收标准

1. 所有颜色标记均通过 Tailwind `@theme` 映射定义为 CSS 自定义属性
2. 所有 text/background 对上的深色和浅色主题都能正确渲染，对比度≥4.5:1
3. `system` 主题遵循 `prefers-color-scheme`，暗启动时不会出现白闪
4. 版式使用 Inter (sans) 和 JetBrains Mono (mono) 以及已定义的后备堆栈
5. 基本字体大小为14px；没有组件默认为 16px 正文
6. 所有交互元素都有使用强调色的可见 `focus-visible` 环
7. 所有动议均尊重 `prefers-reduced-motion: reduce`
7b.启动时会显示品牌启动画面，直到准备就绪，然后顺利退出
8. React 组件源中没有原始十六进制颜色值（仅标记引用）
9. Z-index 的使用仅限于定义的层（无任意值）
10. 布局 shell 指标（顶栏、侧栏、输入框）与 CSS 中的规范值匹配
11. 图标组件使用 Lucide/Heroicons SVG — 没有表情符号图标可供性
12.间距值使用定义的比例（组件代码中没有任意像素值）
13. 流更新不会重新触发 destination/shell 输入动作或
    背景过滤器在输入框后面重画
14. 扩展侧边栏会话标题、project/group 标题和空状态副本
    使用 13px 紧凑令牌而不更改 28–32px 行距

## 深色浮动表面（Codex 奇偶校验）

- 主表面：`#181818` (`gray-900`)
侧边栏/表面下方：`#000000`
- 浮动输入框板：Codex 升高主线 (`#212121f5` / `color-mix(gray-800 96%, transparent)`) 和标准升高突出线 (`0 0 0 .5px` 笔画 + `0 3px 7.5px #0000000a` + `0 0 20px #0000000d`)；没有更重的夜间专用电梯
- 轻型工作空间芯片胶囊：升高的灰色 `#f4f4f4`（不是纯白底白字）
- 组合工作区芯片：在主板上升高半透明板，而不是平坦的主灰色
- 舞台管理器：主机在折叠时重新声明最小边界（永久看门狗）

## 目标页面

- **项目档案**：D066 Codex 索引表（搜索/展开/操作）
  嵌入“设置”中，没有重复的页面标题或外部页面填充；
  早期的独立项目目的地和卡片网格（D042）是
  被 D133 取代。根据 D267，该目的地的构成与智能体能力页面（D257）
  完全一致：一条仅含说明的安静引导行；
  一个工具栏（排序分段控件、搜索、主要操作）；以及一个高架面板，
  其固定/所有项目/已存档分组是面板内标题条，并承载页面上唯一的计数。
  它没有英雄区块、装饰渐变，也没有页面级计数器串
- **设置**：按照 D063/D090/D133/D166 的全页 Codex shell（275 像素紧凑型
  八个目的地铁路、`#f4f4f4` 灯、高架内容卡、返回应用程序）；
  根据 D092，内容卡填充当前可用的窗格宽度
  窗口而不是保留 D070 的固定 720px 上限 - 早期的 in-shell
  200px 轨道和广泛的分组目录被取代
- 浅色目的地卡使用白色高架板（不是平坦的灰色填充）
