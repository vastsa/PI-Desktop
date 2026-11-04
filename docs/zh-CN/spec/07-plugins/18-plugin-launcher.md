# 18. 插件启动器

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/18-plugin-launcher) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

> 状态：已为 issue #2085 实现（全局插件启动器重写）。
> 范围：启动器界面、插件触发器贡献、本机应用发现，以及二者周围的 IPC 与安全边界。
> 相关：[09-plugin-command-palette.md](09-plugin-command-palette.md)、[02-plugin-manifest-schema.md](02-plugin-manifest-schema.md) §4、ADR 0034、ADR 0072、ADR 0080、ADR 0090、ADR 0343。

## 1. 目的与非目标

启动器是应用级的“现在要打开点什么”面板：一个无边框、始终置顶的窗口，列出用户可以打开的面板插件、本机已安装的应用，以及最近使用和已固定的条目。它是*启动器*，不是搜索产品。

范围内：打开插件面板、把用户输入的文本交给该面板、启动已安装的应用。

范围外：会话、文件、设置、命令。这些仍然属于全局搜索对话框（`Cmd/Ctrl+K`）以及 [09-plugin-command-palette.md](09-plugin-command-palette.md) 描述的命令界面。§13 记录这条分工；启动器从不读取会话或工作区数据。

## 2. 入口与窗口

- 快捷键在 Windows/Linux 上是 `Alt+Space`，在 macOS 上是 `⌥+Space`。它是可配置的应用快捷键（`openPluginLauncher`），用户可以像其他快捷键一样改键或禁用。
- 窗口由主进程在 `apps/desktop/electron/main/bootstrap/launcher.ts` 中创建并预热：无边框、透明、`alwaysOnTop`、不可最小化/最大化、不出现在任务栏；在 macOS 上加入所有 Space，并浮在本应用自己的全屏窗口之上。
- 它加载普通渲染包并附加 `?surface=plugin-launcher`；渲染端在 `apps/desktop/src/main.tsx` 中识别该 surface，只挂载 `PluginLauncher`（`apps/desktop/src/components/PluginLauncher.tsx`）。
- 失去焦点时面板隐藏。它是隐藏而非销毁，因此再次打开很快，用户拖动过的尺寸也会保留。

窗口预热与 macOS 激活规则沿用 ADR 0080 与 ADR 0086。

## 3. 布局

面板顶部只有一个搜索框，下面是结果区域，底部是键盘提示。搜索框旁显示快捷键提示（`⌥ Space` / `Alt + Space`）。

网格几何（`apps/desktop/src/lib/launcher-search.ts`）：

| 区域 | 行数 | 磁贴数 | 头部动作 |
|---|---|---|---|
| `Recently used`（空输入） | 2 | 16 | `Show all {count} →`——`count` 是真实的已记住条目数；`All plugins →`——全部插件列表 |
| `Pinned`（空输入） | 1 | 8 | 无 |
| 匹配结果（有输入） | 3 | 24 | `{count} more — keep typing to narrow it down` |
| 全部插件（视图） | — | 所有已安装插件 | 无 |

每行都是八列；列数不随结果数量变化，因此网格不会在输入或缩放时重排。

`Show all {count} →` 会进入展开视图，此时该动作变为 `Collapse`。没有任何固定项时固定区整块不渲染（连标题也不显示），且它从不带头部动作——固定区始终只有一行。

`All plugins →` 会用单个网格替换最近使用与固定两区，列出所有已安装**插件**（不含本机应用）。最近使用过的插件排在前面，其余按目录顺序；窗口达到高度上限后网格继续滚动，且其中每个磁贴都能用 `Enter` 打开或固定。继续输入会回到命中视图，`Esc` 先退出该视图再关闭面板。

输入非空时只显示命中视图：头部动作报告匹配总数，因此被裁掉的磁贴会被明确说明，而不是静默截断。

空状态：目录加载中显示 `Loading plugins…`；后台应用扫描未结束时显示 `Looking for installed applications…`；没有可启动项时显示 `No plugins with panels are ready to open.`；查询无命中时显示 `No matching plugins`。查询无命中——以及既无最近使用也无固定项时——还会提供 `Browse the plugin market`，点击后关闭面板、聚焦主窗口并打开插件市场页（§12）。

## 4. 磁贴

每个磁贴都只有同样的三部分：

- 图标——应用使用平台图标；插件、以及读不到图标的应用使用首字母色块；`<img>` 加载失败也回退到色块，不会留下空洞；
- 名称，放不下时以省略号截断；
- 与名称同一行的类型徽标——`Plugin` 或 `App`。

磁贴不再解释命中的原因：没有第二行，因此每个磁贴高度一致，八列网格保持对齐。`title` 提示为 `名称 · 类型`（应用还会附上可执行文件名），绝不包含启动载荷。

插件使用方形磁贴，应用使用圆形磁贴。因此同名插件与应用会同时列出并且在视觉上可区分，而不是被去重。

每个磁贴右上角有一个图钉，带 `aria-pressed` 与 `Pin to panel` / `Unpin` 标签。它只在悬停、激活或聚焦时显示，已固定的磁贴常显，且不进入 Tab 序列——面板只由搜索框驱动。

## 5. 匹配与排序

实现在 `apps/desktop/src/lib/launcher-search.ts` 中，是基于宿主目录与本地存储的纯函数。

得分顺序，由好到差：

1. 整段输入命中声明触发器（§6）
2. 名称完全一致
3. 名称前缀
4. 拼音前缀
5. 首字母前缀
6. 名称子串
7. 拼音／首字母子串
8. 描述子串

排序档位是内部的：它只决定磁贴顺序，从不渲染，因为磁贴没有详情行。触发器命中独占该条目，因此同时按模式与名称命中的插件只出现一次，并排在所有名称匹配之前。

同分时依次比较：最近使用（越新越前）、插件先于应用、名称、目录顺序，因此同一份目录与状态每次都会产生相同顺序。

比较前会做文本归一化（大小写、全角形式、分隔符），拼音与拼音首字母来自 `pinyin-pro`（`apps/desktop/src/lib/launcher-text.ts`）。因此 `wx`、`weixin` 和 `微信` 都能到达同一个应用，`pi` 既能按名称找到名为 `PI-Desktop` 的插件，也能按拼音和首字母找到它。

## 6. 声明触发器

插件通过 `contributes.launcherTriggers` 认领启动器输入（清单契约见 [02-plugin-manifest-schema.md](02-plugin-manifest-schema.md) §4）。

对声明强制执行的规则：

- 模式匹配**整段去除首尾空白的输入**，绝不是 `includes`；匹配必须覆盖整个字符串（`match[0] === input`）；
- 长于 `LAUNCHER_TRIGGER_INPUT_MAX_LENGTH`（256）的输入永不参与匹配，因此粘贴长文本只付出一次长度检查，而不是跑正则；
- 长于 200 字符的模式永不被编译；
- 无法编译的模式是惰性的——它不匹配任何内容，也不会破坏面板。

触发器命中排在所有名称匹配之前。这正是插件可以声明算术或类命令形状（`1+1`）而不与任何只是包含 `1` 的名称竞争的原因。面板不再显示插件将收到的文本——载荷只随打开请求投递（§7）。

## 7. 载荷投递

只有用户选中的那个磁贴会收到输入，且只收到一次：

```text
磁贴点击 / Enter
  → pluginOpenPanel({ pluginId, triggerId, payload })   (main)
  → 面板页面加载完成
  → webContents.send("pi-plugin-panel-event:launcher:payload", { triggerId, payload })
  → window.pluginBridge.consumeLauncherPayload()        (页面，一次)
```

- `pi-desktop/pluginOpenPanel` 既接受裸插件 id（所有既有调用方），也接受 `{ pluginId, triggerId, payload }`；对象形式只在触发器产生载荷时携带载荷，插件因此可以区分“用户带着这段文本叫我”和“用户只是打开我的面板”。
- 事件在 `loadURL` 结算之后、窗口显示之前发送，因此不会与文档竞争。启动器重新指向一个已打开的面板时，该面板同样会收到。
- `consumeLauncherPayload()` 读取即清空，第二次调用返回 `null`。载荷绝不会投递给第二个插件，也绝不会重放。
- 长于 `LAUNCHER_PAYLOAD_MAX_LENGTH`（512）的载荷会被丢弃：面板以无载荷方式打开，而不是让打开失败。

## 8. 固定与最近使用

条目级偏好存放在渲染端的 `localStorage` 中，键为 `pi.desktop.launcher.state`（`apps/desktop/src/lib/launcher-store.ts`）。首次读取会迁移旧面板的 `pi.desktop.pluginLaunchHistory` 键，因此升级后仍保留原有顺序。

| 条目 | 上限 |
|---|---|
| 最近使用 | 每项一条，最多 60 条 |
| 固定 | 8（恰好一行） |

固定就是点击磁贴上的图钉，面板没有条目菜单。也不存在重命名能力：磁贴显示插件或操作系统声明的名称。

固定位已满时会拒绝新的固定，而不是静默挤掉较早的固定：底部提示 `All 8 pin slots are taken`，固定区抖动一次（`prefers-reduced-motion: reduce` 时不动画）。取消固定即可腾出位置。

每次读取都是防御性的：无法解析的记录被丢弃，存储的 id 会按实时目录裁剪；旧版本或新版本写入的未知字段——例如已废弃的 `aliases`——会被忽略并保留原样，读取时绝不回写。因此被禁用或卸载的插件会从最近使用、固定和匹配结果中消失。把插件从启动器隐藏只是启动器范围的偏好——插件仍会加载，其命令仍然可用。

存储按渲染端 origin 隔离，而启动器窗口与主窗口共享同一 origin，因此在一个窗口中写入的固定项会通过普通 `storage` 事件同步到另一个窗口。

## 9. 本机应用

`apps/desktop/electron/main/local-apps.ts` 负责发现已安装的应用：

- Windows：开始菜单程序目录下的 `.lnk` 快捷方式，递归展开（有深度上限）。
- macOS：`/Applications`、`/System/Applications` 及其 `Utilities` 子目录下的应用包。
- Linux：`/usr/share/applications`、`/usr/local/share/applications` 与 `~/.local/share/applications` 下的 freedesktop `.desktop` 条目。

上限：扫描结果缓存 5 分钟，最多 600 条，只为前 200 条提取图标。图标取平台的 `large` 变体，每个 data URL 不超过 32 KiB，并按条目 id 与图标路径缓存跨扫描复用；条目消失时其缓存图标也会被清理，因此重复扫描不会重复付出同一次查询。目标已不存在的条目会被丢弃。

渲染端只会收到显示名称、可执行文件名、来源标签（`start-menu` / `app-bundle` / `desktop-entry`）、图标和不透明的 `app:<slug>` id——永远没有路径。打开磁贴时发送该 id；`pi-desktop/pluginLauncher/openApp` 会在宿主自己的扫描结果中解析它，并在启动前重新检查目标仍然存在，因此该界面无法被变成“启动我指定的任意程序”。ADR 0343 记录了这个决定。

## 10. 窗口尺寸、位置与状态

- 窗口宽度可在 560 与 1280 DIP 之间缩放；最小宽度是八列仍能完整排布的最小宽度，最大值保证八列磁贴仍可扫读。
- 高度始终贴合内容。渲染端测量搜索行、结果内容的自然高度、底部栏以及面板内边距，并通过 `pi-desktop/pluginLauncher/contentHeight` 上报总高度；主进程将其钳制在 120–940 DIP 后设置内容尺寸，因此面板既不会带着空白打开，也不会裁掉一行。
- 宽度与位置持久化在 `<data dir>/plugin-launcher-state.json`，由主进程尽力写入并做防抖（`apps/desktop/electron/main/plugin-launcher-state.ts`）。高度不是用户偏好：记住的高度只是首次测量到达前的起点。
- 只有整个面板仍能落在即将打开的工作区内时，才会采用记住的位置；否则在該工作区重新居中。
- 这是主进程的 shell 状态，遵循 ADR 0090 与 `window-state.json`：不涉及 host-core schema、迁移或用户数据。

## 11. 键盘

| 按键 | 行为 |
|---|---|
| `↑` / `↓` | 移动一行 |
| `←` / `→` | 移动一个磁贴 |
| `Enter` | 打开当前磁贴 |
| `Esc` | 先退出全部插件视图，否则关闭面板 |

输入法合成进行中（`event.isComposing` 或 `keyCode === 229`）时任何按键都不生效，因此中文输入法的候选回车或方向键不会打开或移动磁贴。

## 12. IPC 与安全边界

| 通道 | 方向 | 说明 |
|---|---|---|
| `pi-desktop/pluginLauncher/catalog` | 渲染端 → 主进程 | 插件 + 应用 + `appsScanning` |
| `pi-desktop/pluginLauncher/openApp` | 渲染端 → 主进程 | 只接受不透明的 `app:<slug>` id |
| `pi-desktop/pluginLauncher/contentHeight` | 渲染端 → 主进程 | 测量出的内容高度；只接受有限正数，并钳制到 120–940 DIP |
| `pi-desktop/pluginLauncher/openMarket` | 渲染端 → 主进程 | 隐藏面板、聚焦主窗口、打开插件市场页 |
| `pi-desktop/pluginLauncher/dismiss` | 渲染端 → 主进程 | 隐藏面板 |
| `pi-desktop/pluginLauncher/toggle` | 主进程 → 渲染端 | 显示/隐藏请求 |
| `pi-desktop/pluginLauncher/event/shown` | 主进程 → 渲染端 | 每次打开时重置面板 |
| `pi-plugin-panel-event:launcher:payload` | 主进程 → 面板页面 | 见 §7 |

启动器的每个处理器都会校验发送方是启动器窗口自己的 `webContents`；其他发送方一律以 `PERMISSION_DENIED` 拒绝。它们都是仅主进程可用的能力：

- 没有任何插件桥暴露这些通道，插件运行时也不存在启动应用的 API；
- 启动器窗口自身与其他渲染界面一样启用 `contextIsolation`、`sandbox`，且不启用 Node 集成；
- `contentHeight` 只接受有限正数并钳制到支持区间，因此被攻破的渲染端最多只能要求更大或更小的面板，无法要求一个用户救不回来的窗口。

`openMarket` 不自己导航 shell：它隐藏面板，并向编排层请求应用菜单的 `openPluginMarket` 命令，由后者把主窗口带到前台并落到插件市场页（`apps/desktop/electron/main/ipc/plugin-launcher-ipc.ts`、`apps/desktop/src/features/app/useAppShellRuntime.tsx`）。

## 13. 与全局搜索的关系

命令面板已合并进全局搜索（ADR 0034）；该决定继续有效，本界面不改变它。启动器是独立窗口，目的也不同：

| 界面 | 快捷键 | 内容 |
|---|---|---|
| 全局搜索 | `Cmd/Ctrl+K` | 会话、文件、设置、命令 |
| 插件启动器 | `Alt+Space` / `⌥+Space` | 面板插件、本机应用、最近使用/固定 |

命令面板规格（[09-plugin-command-palette.md](09-plugin-command-palette.md)）继续描述全局搜索中的命令列表；本文档描述启动器。

## 14. 实现索引

| 关注点 | 证据 |
|---|---|
| 窗口、快捷键、边界持久化、预热 | `apps/desktop/electron/main/bootstrap/launcher.ts` |
| 边界解析/钳制（纯函数） | `apps/desktop/electron/main/plugin-launcher-state.ts`、`apps/desktop/test/plugin-launcher-state.test.mjs` |
| 目录、`openApp`、`contentHeight`、`openMarket` IPC、发送方校验、触发器净化 | `apps/desktop/electron/main/ipc/plugin-launcher-ipc.ts` |
| 应用发现、图标预算与图标缓存 | `apps/desktop/electron/main/local-apps.ts`、`local-apps-platform.ts`、`local-app-parse.ts`、`apps/desktop/test/local-apps.test.mjs` |
| 匹配、排序、区域划分、全部插件视图 | `apps/desktop/src/lib/launcher-search.ts`、`apps/desktop/test/launcher-search.test.mjs` |
| 固定、最近使用、迁移 | `apps/desktop/src/lib/launcher-store.ts`、`apps/desktop/test/launcher-store.test.mjs` |
| 内容高度换算与钳制（纯函数） | `apps/desktop/src/lib/launcher-height.ts`、`apps/desktop/electron/main/plugin-launcher-state.ts`、`apps/desktop/test/plugin-launcher-height.test.mjs` |
| 界面渲染与键盘 | `apps/desktop/src/components/PluginLauncher.tsx`、`apps/desktop/src/components/launcher/LauncherTileButton.tsx`、`apps/desktop/src/styles/plugin-launcher.css` |
| 载荷传输 | `apps/desktop/electron/main/plugin-panel-host.ts`、`apps/desktop/electron/preload/plugin-panel.ts` |
| 触发器校验（宿主） | `crates/host-core/src/plugins/validation/launcher_triggers.rs` |
| 共享契约 | `packages/shared/src/types/launcher.ts` |

## 15. 验收

1. 空输入打开启动器时显示 `Recently used`（两行），若用户有固定项则显示 `Pinned`（一行），每行八个磁贴，最近使用头部报告真实的已记住条目数。
2. 声明了触发器的插件以第一个磁贴的形式收到输入，只出现一次，其面板显示相同文本。
3. `wx`、`weixin` 和 `微信` 都能到达同一个应用。
4. 同名插件与应用都作为独立磁贴出现。
5. `pi` 能按名称找到 PI-Desktop，也能按拼音和首字母找到同一项。
6. 拖动加宽窗口时每行仍是八列并在重启后保留；高度始终匹配面板实际渲染的内容。
7. 匹配超过 24 项的查询不会把窗口撑过上限；头部报告被裁掉的数量并提示继续输入。
8. 禁用或卸载插件后，它从最近使用、固定和匹配中消失，且不会留下失效磁贴。
9. 粘贴 500 字符的输入既不会卡住面板，也不会命中任何触发器。
10. 固定的应用在重启后仍然处于固定状态。
11. 固定满 8 项后，第 9 次固定会提示固定位已满、抖动固定区，且不会挤掉已有的固定项。
12. `All plugins →` 列出所有已安装插件（不含应用），最近使用的插件在前，`Esc` 返回上一个视图。
13. 查询无命中时提供 `Browse the plugin market`，点击后关闭面板并在主窗口打开插件市场页。
14. 磁贴不再显示第二行文字，启动器内任何界面都不能重命名插件或应用。
