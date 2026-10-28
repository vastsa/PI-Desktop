# 文件管理器（File Manager）

## SSH workspaces

Remote directory browsing and text/image previews use the Host's scoped
`pi.fs.list` / `pi.fs.readPreview` service, rather than this computer's Node
filesystem. The panel labels remote projects as read-only. Text previews are
limited to 512 KiB and images to 5 MiB; unsupported and oversized files report
their status explicitly. Search, Git, watch, editing and local application
actions are unavailable remotely. Returning to a local project restores the
ordinary local features. Failed directory requests show their error and a Retry
button instead of remaining on Loading.

This requires Desktop remote workspace metadata and the paired Host's
`workspacePluginFiles` capability from the companion fix for
[PI-Desktop #1711](https://github.com/vastsa/PI-Desktop/issues/1711). Older Hosts
report an upgrade error; remote requests never substitute local files. Local
projects remain compatible with the existing minimum Desktop version.

Run `pnpm verify:remote` and `pnpm verify:tree` in `views-src` for isolated
regressions. Cross-repository Electron validation runs the production view and
plugin process through Desktop's broker, a loopback RACP server and the real
Host filesystem service; see `scripts/e2e-remote-file-manager.mjs` in the
companion Desktop branch. It does not connect to user SSH servers or profiles.

### Paired release for #1711

Version 0.9.1 keeps this repair distinct from the existing v0.9.0 tag.
Delivery through the companion
[Desktop PR #1824](https://github.com/vastsa/PI-Desktop/pull/1824) requires a
plugin release and a bundled update. Tag the accepted plugin commit and
publish the same runtime bytes to the marketplace; preserve the existing
v0.9.0 tag.

Prepare the runtime with `node scripts/prepare-package.mjs`, then run the
official `pi-plugin check dist/runtime` and `pi-plugin pack dist/runtime`.
The runtime includes `remote-workspace.js` and
`views/assets/pdfjs-LICENSES.txt` as well as the main process, manifest,
built view, README and changelog; omitting either new runtime file makes the
vendored update incomplete.

After publication, Desktop must copy the released runtime, preserve its local
MIT license and CommonJS marker, and update `UPSTREAM.md` and the bundled
provenance tests using the real tag, commit, marketplace artifact checksum
and per-file checksums. Run the cross-repository Electron journey against
`apps/desktop/resources/plugins/pi.file-manager` on the updated Desktop PR
integration candidate. A separate development-plugin run does not validate
the shipped bundle.

在 PI-Desktop 的**右侧工作面板**里浏览、查看并编辑当前项目的文件：完整目录树（图标随文件类型变化）、左右分栏（左侧文件列表可整块收起）、代码高亮编辑与保存、PDF 预览、图片与音视频查看、CSV/JSON 结构化查看、在项目组注册了多个本地文件夹时切换当前浏览的那个 folder（按项目记住），以及新建、重命名/移动、右键复制路径、**通过…打开**（二级子菜单列出这台机器上真的装了的程序，按文件类型过滤，选中即用那个程序打开）、按文件名搜索、**git 联动**（文件列表里直接标出哪些文件被修改、哪些是新增，并能逐行查看它相对上次提交的具体变更）、**文件监听**（文件在编辑器之外被改动会自动重新读取并刷新列表）；宿主还可以让视图直接打开某个文件——包括它自己选定的项目外路径（会话临时目录 / 附件）。

## 功能

- **完整目录树**：懒加载、可按层展开、目录在前。每一行的图标随文件类型变化——文件夹、代码、JSON、Markdown、样式、HTML/Vue/Svelte、YAML/TOML、Shell、SQL、图片、压缩包、字体、锁文件等各有自己的字形与配色；`package.json`、`Dockerfile`、`LICENSE`、`.gitignore` 这类特殊文件名优先于扩展名判定。
- **选中态与悬停态明确区分**：悬停是淡淡的中性底色（只表示鼠标位置）；选中是强调色底 + 左侧强调色竖条 + 前景色文字 + 中等字重，鼠标移开也保持，悬停到选中行上还会再加深一档，不会让人误以为选中丢了。
- **右键菜单**：按打开方式、创建、文件管理、复制路径、查看变更/在文件夹中显示、刷新分组排序；HTML、HTM 与 XHTML 文件可在「通过…打开」里选择宿主内置浏览器。列表空白处只提供新建与刷新，文件和文件夹按类型显示操作。支持 ↑↓ / Home / End / Enter / Esc；带子菜单的项鼠标移上去即展开，`→` 进入、`←` 返回上一层。
- **复制相对路径 / 复制绝对路径**：右键任一文件或文件夹即可。相对路径以当前浏览的文件夹为基准（正斜杠）；绝对路径是能直接贴到别处的完整路径（基点不是主文件夹时按那个文件夹拼）。成功与失败都给一条 toast 并带上复制的内容，不会静默地什么都没发生。
- **通过…打开（二级子菜单）**：鼠标停在菜单项上即展开，列出**这台机器上真的装了的**程序：系统默认应用，以及 VS Code、Zed、Chrome、Edge 等（装了哪几个就列哪几个），选中就用那个程序打开当前条目。**按文件类型过滤**——编辑器什么都能打开（文件与文件夹都行），浏览器只出现在它真能渲染的网页类文件上（`.html` / `.htm` / `.shtml` / `.xhtml` / `.mhtml` / `.svg` / `.pdf` / `.xml`）：拿 Chrome 打开 `App.tsx` 只会看到一个纯文本加载页，那是噪音，所以干脆不列。探测只在启动时做一次、**按天缓存**（同一台机器同一天里，第二个窗口、第二次启动都直接读那份缓存），并且**不遍历目录**：只读注册表 `App Paths` 与 `StartMenuInternet`、在 `PATH` 上按候选命令名找可执行文件、再对少数固定安装位置各做一次 `stat`，每条都是 O(候选数)。一个程序都没探到时只留「系统默认应用」这一项，不放点了没反应的条目。
- **左右分栏，左侧列表可收起**：左侧文件列表，右侧内容。中间分隔条可拖拽，宽度会记住；工具栏最左边的按钮可以把左侧整块收起（收起时编辑器占满整个面板，重新展开按原宽度恢复，收起状态会被记住）。宿主请求打开文件时会自动收起，之后你手动展开就一直保持到下一次宿主请求。
- **项目组里的多文件夹切换**：宿主把一个项目注册成多个本地文件夹（`workspace.get` / 首次握手的 `roots`、`projectId`）时，面板左上角的文件夹名就是切换器——点开是这组 folder 的菜单，标出主文件夹、当前在看的那个打勾；键盘可达（`aria-haspopup` / `aria-expanded`，Escape 与点到外面都能关），树收起时也照常能用。**只有一个文件夹（或老宿主不送组信息）时，头部与以前完全一样**，不留一个点了没反应的入口。切换会把树、展开、选中、搜索与已打开的文件整体重来，并照旧先过「未保存改动」确认——取消就什么都不换。看的是哪个 folder **按项目记住**（宿主给了 `projectId` 就按项目 id，否则按主文件夹路径；记忆里的路径必须命中当前的 `roots` 才被信任，否则退回主文件夹；最多记 20 个项目、按最近写入淘汰），新项目从主文件夹开始。
- **代码高亮编辑**：CodeMirror 6，行号、查找替换、多光标、括号匹配、代码折叠。按文件名加载对应语言的语法高亮，覆盖 TypeScript/TSX、JavaScript/JSX、JSON、Markdown、CSS/SCSS/Sass/Less、HTML、Vue、XML、YAML、TOML、Properties、Python、Go、Rust、Java、C/C++、C#、Kotlin、Scala、Dart、Objective-C、PHP、Ruby、Lua、Shell、PowerShell、SQL、Dockerfile、Diff。全部随包内置、离线可用，不请求网络。`Ctrl/Cmd+S` 或工具栏按钮保存；**没有改动时不写盘**，保存后光标与滚动位置留在原处（不会跳回开头），界面显示的始终是磁盘上那份内容。焦点不在编辑器里（刚点过工具栏、或停在预览 / 表格 / 树视图）时 `Ctrl/Cmd+S` 同样有效。
- **Markdown 预览 / 编辑切换**：打开 `.md` / `.markdown` / `.mdx` 时，工具栏出现「编辑 / 预览」切换。预览支持标题、围栏代码块（带同样的语法高亮）、引用、分隔线、有序/无序/任务列表（按缩进嵌套）、表格（含对齐）、行内 code / 粗体 / 斜体 / 删除线 / 链接 / 图片。切换会记住。
- **PDF 预览（只读）**：打开 `.pdf` 即可连续上下滚动阅读，支持「单页 / 双页 / 双页（封面单独）」布局、上一页 / 下一页、输入页码跳转、缩放（10%–400%）、适应宽度与 100% 实际大小；适应宽度会跟随面板和分栏尺寸，按当前布局中已知最宽页面组的实际尺寸计算。滚动切页保持比例，封面和末尾落单页不会自动放大；惰性加载发现更宽页面时扩展宽度依据。点击「导航」展开侧栏：**缩略图**定位页面并标记当前页，**目录**展示 PDF 内置的嵌套书签并跳转，**文档信息**展示文件名、体积、页数、标题、作者与日期等元数据；没有内置书签时明确提示。有文字层的 PDF 可以选择并复制文字，并可全文查找（中英文命中高亮与计数、上一个 / 下一个匹配，支持区分大小写、全字匹配和正则表达式三种开关组合；无效正则会提示并清除命中，修正后恢复；Enter / Shift+Enter 跳转、Escape 关闭）；清空查询或关闭后清除高亮。焦点位于 PDF 阅读区时 Ctrl/Cmd+F 打开查找。扫描件显示原始图像，不提供 OCR。PDF.js、Worker、字体映射与图像 / 色彩解码资源全部随包内置，离线可用。主视图缓存邻近页面，缩略图按可见范围渲染并释放不再使用的页资源；窄面板的导航侧栏覆盖显示，跳转后自动收起，也可按 Escape 关闭。切换文件后释放文档与 Worker；单文件上限 **24 MiB**。

  正则查找按页在独立 Worker 中执行，不重复解析 PDF；单页运算超过 1 秒或命中超过 10 万个时停止、清除本次命中并显示提示，可简化表达式后继续查找。清空、关闭、切换查找模式或文档会取消旧任务。Worker 无回应时，文档销毁也有 1 秒等待上限，并清理该文档的字体、滤镜和监听。
- **图片查看**：png / jpg / jpeg / gif / webp / avif / bmp / ico / svg。默认适应窗口，可切「实际大小」；底部显示像素尺寸与文件体积，舞台铺棋盘格，透明区域一眼可见。
- **音视频播放**：mp4 / m4v / mov / webm / ogv / mkv 用播放器，mp3 / m4a / aac / wav / flac / ogg / opus / weba 用音频条。**不自动播放**；编码或封装不被支持时给明确提示，而不是留一块黑框。
- **CSV / TSV 表格（分页）**：打开 `.csv` / `.tsv` 就是表格，默认**每页 1000 行**；底部工具条可以翻页（首页/上一页/下一页/末页）、看「当前范围 / 总行数」，也能改每页行数（100–5000，选择会记住）。首行当表头且吸顶，最左一列是行号且吸左，整行悬停高亮，整列都是数字时自动右对齐，被省略号截断的值悬停可看全。**点表头排序**：升序 → 降序 → 取消（回到文件原序）；整列都是数字按数值比，否则按自然序文本比，空值永远沉底。解析支持引号包裹、`""` 转义、字段内换行、CRLF 与参差的行；列数上限 60、解析上限 20 万行，超出会在底部说明。工具栏可切回源码编辑。
- **JSON 折叠树**：`.json` / `.jsonc` / `.json5` 可切树视图，默认展开两层、单节点最多直接铺 100 个键，长字符串截断（完整值在悬停提示里）。`//` 注释、尾逗号这类非严格 JSON 不会炸面板，只显示「解析失败 + 原因」，源码视图照常可编辑。
- **SQLite 数据库（只读）**：`.db` / `.sqlite` / `.sqlite3` / `.db3` 打开即用——顶部概览（体积、页大小 × 页数、编码、SQLite 库版本、WAL 提示），「浏览」页签里选表或视图看数据（分页、点表头排序、最左 `rowid`、`NULL` 灰显、BLOB 只显示体积）、「结构」按钮看列与类型/索引/触发器/`CREATE` 原文，以及「SQL」页签里的**只读查询框**（`Ctrl/Cmd+Enter` 运行，可选行数上限，显示耗时与截断提示）。
  这是插件里**唯一能打开大文件**的预览类型：数据库的字节根本不进视图，主进程每次只取一页。
- **二进制说清楚**：zip / apk / exe 这类没有可预览形态的文件，提示「二进制文件（zip、apk、exe 等），暂不支持预览」，不做魔法识别，也不假装能解压。
- **文件操作**：新建文件、新建文件夹、重命名、移动到指定目录。
- **用默认应用打开 / 在文件夹中显示**：文件右键即可（`fs.openDefault` / `fs.reveal`）。这两个动作由宿主执行，权限与范围同内置的 Files 视图。项目里换过文件夹之后，基点不是主文件夹时改送绝对路径——宿主这两条通道只接受工作区相对路径，送相对路径会被按主文件夹解析，两个文件夹里有同名文件就会打开另一个；宿主对「本项目已注册文件夹根」下的绝对路径有对应的窄放行（ADR 0253）。
- **按文件名搜索**：整个项目范围内分页搜索，点击结果直接跳转并展开到该文件。
- **宿主请求打开文件**：宿主可以要求视图打开某个文件，两条投递路径（视图入口 URL 的 `?piViewOpen=` 载荷、`view:open` 推送）都已接住，同一条请求重复投递只处理一次。三种路径形态各有各的基准：**项目内相对路径**以主文件夹为基准（当前看的若不是主文件夹，会先切回主文件夹再打开）；**落在同项目另一个 root 下的绝对路径**会先切到包含它的那个 root、再按「相对该 root」打开（祖先目录照旧展开、行照旧高亮，效果与点击搜索结果一致）；**组外的绝对路径**（会话临时目录 / 附件）照旧走 0.4.0 的外部行为——不进树、不高亮任何行、基点不动。打开前照旧走「未保存改动」确认，不会静默丢弃编辑。
- **git 联动（状态 + 变更内容）**：文件列表里每一行带一个 git 徽标——**绿 `A` 新增**（含未跟踪的新文件）、**琥珀 `M` 已修改**、**红 `D` 已删除**、**蓝 `R` 已重命名**、**紫 `U` 冲突**——文件行尾再给出相对上次提交的增删行数（`+N` / `−N`）；**目录上给的是整棵子树的汇总**（取子树里最值得注意的那个状态 + 受影响文件数），所以不展开也能看出「哪个目录脏了」。悬停能看到完整说法（是否已暂存、是不是未跟踪）。左侧列表顶部一句话概览当前分支与各类变化的文件数（干净时显示「工作区干净」）。
  打开一个有改动的文件后，工具栏出现「变更」按钮（右键菜单里也有「查看变更」），点开是**逐行对照的 unified diff**：新增行绿底、删除行红底、两侧行号、hunk 头保留所在函数名，**已暂存（HEAD → 暂存区）与未暂存（暂存区 → 磁盘）分段标注**；未跟踪的新文件按「全文都是新增」展示，被删除的文件仍能看它删掉了什么。保存之后徽标与差异立刻跟上（主进程那边的状态快照被当场作废）。
  状态与差异都来自**工作区里真实存在的 git**（只读子命令 `status` / `diff` / `rev-parse`，不写索引、不联网、不碰 `.git/**`）：这样索引格式、rename 检测、`.gitattributes` 的换行与 filters 归一化全都跟着用户的 git 版本走，不会和 `git status` 对不上。**没有 git、当前文件夹不是仓库、git 超时或缺失时，所有标记整体消失**，列目录 / 读 / 写 / 保存 / 删除一条都不受影响。
- **文件监听（自动刷新）**：文件在本视图之外被改动——外部编辑器、`git checkout`、构建产物、另一个窗口——会在一秒多内被自动发现并**重新读取**，树与列表也跟着刷新（体积、mtime、git 徽标、新建与删除一起跟上），不用再点「刷新」。主进程用 Node 的 `fs.watch` 对**当前浏览的文件夹**开一只递归监听（`persistent: false`，面板不常驻后台；`.git/` 与 `node_modules/` 的事件丢弃，凭据类路径照旧不上报），变化去抖 250ms 后并入有界历史，视图每 1.2 秒取一次增量（宿主没给插件向视图推送的通道，面板不可见时跳过这一轮）。
  三条边界写清楚：① **没有未保存改动时**才自动重新读取打开的文件；**有未保存改动时只亮一条提示条、绝不覆盖**（静默丢掉刚敲的字是最糟的一种「自动」），提示条上的「重新加载」仍走既有的未保存确认框；② 本插件自己的保存先记一笔，同名事件在 1.5 秒内不算「外部改动」——否则每按一次 `Ctrl+S` 都会把自己的文档重装一遍（光标与滚动位置一起丢）；③ 批量改动时最多顺手刷新 8 个目录，剩下的留给下一次或手动刷新。
  顶部有一个「自动刷新」开关可以随时关掉（运行时不支持递归监听时整颗按钮禁用并说明原因），**两个手动刷新按钮原样保留**——监听只是省掉那一下点击，从来不是它的替代品。换项目 / 换文件夹时监听跟着换，插件卸载时一并关闭。
- **编辑 / 预览 / 变更 是一组互斥页签**：打开有 git 变化的文件时，工具栏是同一个 tablist——「变更」与「编辑 / 预览」同组，因此从任何一侧都能点进去、再点回来，内容区**一次只会有一种视图**（0.8.0 时「变更」是 tablist 之外的独立开关，于是「预览 + 变更」能同时成立，两个整块高的视图会压在一起；0.8.1 把判定收进 `lib/pane.ts` 的单值 `contentKind()` 后不可能再发生）。变更页签只对文本文件给出。
- **忽略规则**：项目里有 `.gitignore` / `.ignore` 就按规则隐藏条目（可用工具栏的眼睛按钮切回显示）；**一个规则文件都没有时，目录树展示全部条目**。
- **跟随宿主外观**：亮/暗配色与界面语言（中文 / English）跟随 PI-Desktop 主体，编辑器与预览的高亮配色一并跟随。

## 安装

在 PI-Desktop 的 Plugins 页面：

1. **Load development plugin** → 选择本目录；或
2. 用 `.piplug` 安装包走 **Install plugin package**。安装更新后关闭并重新打开整个「文件管理器」页签，或重启 PI-Desktop，让视图载入新代码；PDF 文件的刷新按钮只重读文档。

装好后打开一个项目，在**右侧工作面板头部的切换菜单 → “Plugin views / 插件视图”** 分组里点击「文件管理器」。

> 这个插件没有命令面板入口，也不注册面板窗口——它只提供一个停靠在右侧栏的视图（`contributes.views`）。宿主没有提供「用命令打开视图」的通道，所以这里也不声明误导性的命令。

## 开发

```bash
cd views-src
pnpm install
pnpm typecheck
pnpm build      # 产物输出到 ../views（入库，宿主加载 views/index.html）
```

`views-src` 是源码（React + TypeScript + Tailwind + CodeMirror 6）；`views` 是构建产物，直接入库。构建为 **IIFE 单文件**并内联全部动态 import——宿主的视图用 `file://` 加载页面，`type="module"` 与 `crossorigin` 会被 Chromium 拦掉，所以 `vite.config.ts` 里有一个 `fileProtocolCompat` 插件负责改写 `index.html`。

PDF 使用 `pdfjs-dist` 的兼容构建与 `PDFViewer` 多页组件，并由 `pdf-assets-plugin.ts` 将 classic Worker、CMaps、标准字体、WASM 与 ICC 资源嵌入产物。`lib/pdfViewer.ts` 负责连续滚动、双页布局、缩放与页面缓存；`lib/pdfFit.ts` 独立记录各布局的已知最宽页面组，使适应宽度不依赖滚动页码，仅收集 PDF.js 已经初始化的页面尺寸，避免为了计算宽度额外预取整篇。`PdfSidebar.tsx` 提供虚拟化缩略图、书签与元数据，复用主视图的清理事件避免释放正在显示的页面。Worker 内的资源读取映射到 data URL，因此无需 CDN、本地服务器或 `file://` 下的模块加载；源码中的 `https://pi-file-manager.invalid/pdfjs/` 仅是包内资源标识，不会访问该地址。

`pdf-find-plugin.ts` 对固定 PDF.js 版本的查找接口加入异步等待和过期结果保护，正则 Worker 随 IIFE 内置；`pdf-lifecycle-plugin.ts` 为主 API 的启动、页面取消和销毁加入有限等待与前端资源清理。两者都检查版本与唯一源码锚点，库升级后必须重新核对。

桌面 PDF 与文件监听回归检查见 `tests/electron/README.md`，运行隔离的 Electron 实例与合成文档，检查实际生产 `file://` 界面及资源释放。后续修改相关行为时需要一并执行。

`main.js` 是手写、零依赖的 CommonJS，插件的依赖不会被安装，所以不要往它里面 `require` 第三方包。

### 打包

完成构建与桌面检查后，在仓库根目录运行 `node scripts/prepare-package.mjs`。脚本生成 `dist/runtime`，只复制 `manifest.json`、`main.js`、生产 `views/`（含第三方许可）、README 与 CHANGELOG；源码、测试夹具、QA 脚本和依赖均不进入运行包。

再对 **`dist/runtime`** 使用 PI-Desktop 官方 `PluginCheck` 和 `PluginPack`。开发加载仍可选择仓库根目录；正式安装包使用准备好的运行目录，避免将整个测试目录打进包内。

### 校验

```bash
cd views-src
pnpm typecheck
pnpm verify        # 项目组 / 路径限制 + 高亮 + Markdown + 查看器 + git + 监听 + PDF
```

`pnpm verify` 跑九个不需要 DOM 的校验脚本，用于覆盖「静默失败」的九条链路：

- **`verify-roots.mjs`**：断言 `lib/roots.ts` 里那套纯规则——组形状（老宿主退化成单根、名字按
  路径末段补、`primary` 标记与顺序）、记忆键（`p:` / `r:`）、选中的 root（记忆命中才信，指向已被移出
  `Beta-old` 这种「名字有前缀关系」的目录不算命中）、记忆的 LRU 有界与「重写挪到末尾」。最后回头核对
  `Beta-old` 这种「名字有前缀关系」的目录不算命中）、记忆的 LRU 有界与「重写挪到末尾」。最后回头核对
  `main.js` 里那份同名常量与记忆键前缀：视图与主进程是两份独立实现，漂移了就会界面和越狱各按一个
  基点解析。
- **`verify-jail.mjs`**：桩宿主驱动**真实的 `main.js`**，在「项目组里选中的不是主根」的两文件夹项目上
  把包含基点当观测量断言：切到兄弟文件夹后目录树与根相对读取都跟着换、主根的文件从兄弟文件夹根相对
  读不到、`..` 与凭据文件照旧被拒、另一个已注册根下的绝对路径按组内归一化而不是当外部文件、淘汰与
  单键写入之后基点仍然是记住的那个文件夹、以及不带 `roots` 的老宿主照旧。
- **`verify-highlight.mjs`**：对 17 种真实文件走完整的
  `文件名 → 语言解析 → 载入 → 语法树 → 高亮 token` 链路，断言每种都产出足够多的
  不同高亮 class，并反向断言 `.txt` / `.bin` / `.zip` / `.png` / `LICENSE` 不会被误认领。
  CodeMirror 的高亮是「解析不出来就什么都不报」的典型——只 grep 产物字符串会漏掉
  运行时问题（本插件第一版就踩过：`basicSetup` 自带的 fallback 高亮器把自己的样式盖住了）。
- **`verify-markdown.mjs`**：断言预览真实产出的元素树（标题/列表/表格/任务列表/嵌套
  强调），链接协议白名单，以及**不存在 `dangerouslySetInnerHTML`**、原始 HTML 被转义。
  其中一个回归用例专门盯住「行内解析递归时共享带 `g` 的正则」——那会让预览卡死并吃光内存。
- **`verify-viewers.mjs`**：断言 CSV 解析的 12 个用例（引号包裹、`""` 转义、字段内换行、
  CRLF、参差的行、截断与列数封顶）、分页切片（页码越界夹紧、末页不满、空表也有 1 页）、
  数字列识别、JSON 合法/非法两条路径，以及「哪个文件有哪几种看法、默认落在哪一侧」的判定。
  表格与树都是「把文件内容变成界面」的路径，解析器错了不会抛异常、只会静默显示错。
- **`verify-git.mjs`**：两层。① 用固定夹具钉住 git 三种输出格式的**解析**——`status --porcelain=v1 -z`（含重命名在 `-z` 下是「新路径 + 一条裸的原路径」两条记录）、`diff --numstat -z`（含二进制是 `-\t-`、重命名把路径留空再补两条裸路径）、unified diff（hunk 头、两侧行号、多个 hunk、二进制提示）；解析错了界面上就是「已修改」显示成「已新增」这种静默的错。② 起一个**真的临时仓库**，用桩宿主驱动**真实的 `main.js`**，断言 `fm.list` 的徽标（已修改 / 新增 / 已暂存 / 目录汇总 / 未改动的行是 `null`）、`fm.read` 带回来的状态、`fm.git.diff` 给出的具体改动行（替换、未跟踪文件的全文新增、已暂存分段、已删除文件）、凭据与越界路径照旧被拒、保存后状态立刻作废缓存、以及**非仓库目录下降级成「没有状态」而读文件照旧**。
  本机没装 git 时整层跳过（第一层仍然跑）。
- **`verify-editors.mjs`**：三层。① 解析夹具钉住编辑器探测的几种文本形态——注册表 `App Paths` 的 `(Default)` 取值、`StartMenuInternet` 的 `shell\open\command`（`"C:\…\chrome.exe" -- "%1"` 这种带引号带参数的写法要剥得干净）、`PATH` 上候选文件名的顺序（Windows 只认 `.exe`，排在第一位且只出现一次），以及注册表键名的精确优先 / 前缀兜底（Firefox 的子键带客户端哈希后缀，`FIREFOX.EXE-308046b0af4a39cb` 得能命中）。② 端到端：桩宿主驱动**真实的 `main.js`**，断言 `fm.editors` 的形状、落盘缓存的路径与内容、以及**视图拿不到可执行文件路径**（只给 id 与显示名）这条边界；再起**第二个真进程**读同一份缓存，断言结果一致且缓存文件没有被重写——这就是「一天只探一次、多开共享」要保证的东西。③ 路径守卫：未知编辑器 id、越出根的相对路径、凭据文件、`external` 形态、缺参数全部被拒。最后还有一条**真的启动一次**的用例：把「编辑器」设成 `node` 自己、被打开的是一段小脚本，断语由那个真实子进程写出来——它收到的参数正是被点开那个文件的绝对路径。
- **`verify-watch.mjs`**：三层。① 噪声与抑制的纯判定：`.git/`、任意层级的 `node_modules/`、凭据路径、本插件原子写的临时文件（`.README.md.<ts>.<rand>.tmp`）都不上报，而同名的真实文件照报；「这是我自己写的吗」这条抑制的记一笔 / 判定。② 端到端：临时目录 + 桩宿主驱动**真实的 `main.js`**，断言**操作系统真的把事件送到了**——外部改 / 外部建 / 外部删都出现在游标增量里、同一游标重复问幂等、`.git/` 与 `node_modules/` 的变化不进增量、**插件自己的保存不进增量**、抑制窗口过后同名改动照旧上报（监听不会慢慢失灵）、换文件夹后监听跟着换、没有项目时报告不可用而不抛错、`onUnload` 之后监听真的停了。③ 视图的判定（`lib/watch.ts` 纯函数）：变化在别处只刷目录、打开的文件被改且无未保存改动才自动重读、有未保存改动只提示不覆盖、刷新目录数有上限、游标落到历史之外时保守处理。
- **`verify-pdf.mjs`**：桩宿主驱动真实 `main.js`，验证 `.PDF` 大小写识别、base64 字节无损传递、24 MiB 边界与超限处理、空 / 损坏文件进入 PDF 查看器的路径，以及根外路径、符号链接、凭据限制与多文件夹切换；同时校验双页封面 / 末页的稳定宽度、混合尺寸分组、惰性 / 乱序加载及文档间隔离。PDF 的内容路由与只读行为还由 `verify-viewers.mjs` 覆盖；渲染和交互需使用真实浏览器验证。

PDF 浏览器验收应使用生产构建和离线 `file://` 页面：长文档连续滚动与页面底部可达、页码同步、三种布局与混合横竖页适应宽度、在封面 / 末页的单与双页交界处往返滚动和拖动后缩放不变且渲染事件停止、惰性加载新尺寸后比例稳定、缩略图与嵌套 / 命名书签跳转、无目录提示、页码标签与 Info / XMP 元数据、真实鼠标文字选择、旋转页与特殊页面单位、中文字体映射与扫描件 / CMYK 解码、360px 窄面板、主题与语言、快速切页后缩放、快速切换文件，以及加载 / Worker 失败后的恢复。关闭 PDF 后确认 Worker 和 Blob URL 均释放；浏览器模拟宿主桥通过后，仍需在 PI-Desktop 安装包中检查实际面板交互。

冒烟测试（在仓库根目录运行）：

```bash
node ../pi-file-manager-smoke-test.cjs
```

## 数据与安全

**这个插件用自己的 Node `fs` 读写当前项目里的文件，而不是宿主的 `pi.fs` 网关。**

为什么必须这样：宿主的 `manifest.fs` 在语法上就**禁止整树写入**（写入 scope 不能是 `**`），任何一个能通过校验的窄 scope 都会让「保存」变成每次都弹权限确认；而且 `pi.fs.*` 没有创建/重命名/移动，`fs.glob` 与 `fs.list` 还有条数上限、会跳过 `node_modules`、屏蔽凭据路径。与之对应的代价是：**宿主的权限网关不介入这些调用**，所以安全责任由插件自己承担。manifest 里因此没有申报 `fs.write`（写权限根本无法诚实申报），只申报了 `ui.view` 与 `fs.read`——**后者仅用于「用默认应用打开」与「在文件夹中显示」这两个只能由宿主代为执行的动作**（`fs.openDefault` / `fs.reveal`，权限与范围同内置的 Files 视图：root `workspace`、scope `**`）。这两个通道由宿主按声明的范围校验，越界会被宿主自己拒掉。

插件自己实施的全部限制：

| 限制 | 说明 |
|---|---|
| 路径包含 | 相对路径只接受相对**当前选中的那个已注册文件夹根**（folder root）的路径；绝对路径、`..`、以及 realpath 后落到该根之外的**符号链接 / junction** 一律拒绝。项目注册了多个文件夹时，包含基点仍然是**其中一个** root、绝不放大成整个组的并集（换基点只是换一扇门，门后的规则一条不变）；宿主请求打开的绝对路径若落在同项目的另一个 root 下，会先把基点切到包含它的那个 root、再按「相对该 root」解析，包含校验照旧全量生效。唯一的例外是宿主请求打开的项目外绝对路径（会话临时目录 / 附件）：视图带 `external: true` 时才放行，**不做根内包含校验**（它本来就在根外），黑名单与 realpath 检查照旧全量生效 |
| 敏感路径 | `.env*`、`.ssh`、`.aws`、`.gnupg`、`.git/**`、`*.pem`、`*.key`、`*.p12` 等读写全拒；`node_modules` 可读不可写 |
| 原子写 | 先写同目录临时文件 → `fsync` → 保留原文件权限位 → `rename` 覆盖，中断不会留下半写文件 |
| 冲突检测 | 以 `mtimeMs` + 文件大小作为乐观锁；文件在编辑器之外被改动过时**不会静默覆盖**，会先弹对话框让你选择覆盖 / 放弃 / 重新加载 |
| 写入审计 | 每次写入追加一行到插件数据目录的 `write-audit.jsonl`（约 1 MiB 后轮转），因为宿主审计不到这条路径 |
| 数据库只读 | 以 `readOnly` 打开 + `PRAGMA query_only = 1`（实测 `DROP`/`INSERT` 会被 SQLite 自己拒绝），再叠一层语句白名单：只放行 `select` / `with` / `values` / `explain` 与只读 `pragma`，且必须是**单条**语句——`node:sqlite` 的 prepare 对多语句是放行的（实测 `select 1; select 2` 只执行第一条、不报错），所以必须自己拦。表名/列名先与 `sqlite_schema` 核对再拼引号，绝不直接插值 |
| 体积上限 | 文本预览 2 MiB、图片 8 MiB、音视频与 PDF 各 24 MiB、写入 8 MiB。图片、音视频与 PDF 的字节要以 base64 随响应发给视图（膨胀约 1/3），因此单独设限；超限时提示里会带上具体上限 |
| 外部编辑器 | 「通过…打开」由插件主进程 `spawn` 目标程序：可执行文件**只能来自插件自己探测出来的列表**（视图只递 id，递不了路径），被打开的条目先过与其它通道同一套根内包含校验与凭据黑名单；`spawn` 不经 shell、参数只有一条绝对路径，子进程 `detached` + `stdio: ignore` + `unref`，编辑器不随面板关闭而消失、也不吊住插件进程；每次打开记一条写入审计。Windows 上只认真正的 `.exe`（`.cmd` / `.bat` shim 要经 `cmd.exe`，那是多余的注入面）。浏览器只对网页类文件出现（`lib/editors.ts` 纯函数按扩展名过滤）。探测只读注册表与 `PATH`、不写任何东西，结果按天缓存在插件数据目录的 `editors.json` |

行为上的两点说明：

- `.git` 目录**不会出现在树里**（体量巨大且永远无用）。
- 忽略规则来自 `.gitignore` 与 `.ignore`（支持 `!` 取反、末尾 `/`、前导 `/` 锚定、`*` / `?` / `**`）。这是 gitignore 的一个子集，不支持 `\` 转义和 `[a-z]` 字符类；偏差只影响「显不显示」，且随时可以用工具栏的眼睛按钮翻盘。

**Markdown 预览的安全做法**：预览**不使用** `dangerouslySetInnerHTML`，而是把 Markdown 解析成 React 元素——节点由 React 转义，结构上不存在注入面，因此也不需要额外的 sanitizer。原因很直接：这个视图的 bridge 通向一个能读写项目文件的插件主进程，预览里的 XSS 就等于任意文件写入。预览中的链接也不会导航（点一下就离开插件页面回不来了），点击只会把地址显示出来。

**不访问网络**：没有 `net.domains`，运行时不发起任何请求。插件数据目录里只放设置（分栏宽度、左侧列表是否收起、显示开关、Markdown 默认视图、每个项目在看哪个 folder）、上面那份审计日志，以及编辑器探测的当日缓存（`editors.json`，只存探测到的程序路径，一天一份）。

## 已知限制

- **删除会先弹确认框**：目录整体递归删除，路径限制与写操作一致（限在当前选中的 folder root 内、拒绝根目录本身与凭据类路径），并记入写入审计；删除不可撤销。
- **「用默认应用打开」与「在文件夹中显示」只对文件有效**（宿主对目录返回 `INVALID_ARGUMENT`），入口在文件树的右键菜单里。
- **Markdown 预览里的图片仍是占位块**：`![](path)` 显示成带文件名的占位符。文件级的图片查看走 data URI 已经可用，但预览里的图片要逐张按相对路径去读，本轮没做。原因还是那条：面板以 `file://` 加载，相对路径指向视图自身而不是项目。
- **文件监听**：宿主只有一条推给视图的通道（`view:open`，用于「打开这个文件」的请求），没有文件变更事件，所以外部改动不是实时的；保存后会刷新目录，工具栏的「从磁盘重新加载」随时可点，用来把别处改动拉进来（当前有未保存改动时会先确认）。
- **项目外路径只能靠宿主指名**：只有宿主请求打开的文件可以落在项目根之外（会话临时目录 / 附件），并且要视图显式声明 `external`；目录树本身仍然只显示当前项目，插件不会自己去翻项目之外的路径。
- **一次只看一个文件夹根**：项目注册了多个 folder 时，目录树、搜索、SQLite 与所有路径校验都是相对**当前选中的那个 root** 解析的——要看另一个 folder 就在左上角切过去（切换会重建视图状态）。组里的文件夹不会合并成一棵树：包含基点任何时候都只有一个。
- **二进制不可预览**：zip / apk / exe / tiff 只给提示——不解压、不列归档内容、不做十六进制查看。TIFF 单独说明：Chromium 解不了它，所以按二进制处理，而不是显示一张破图。
- **图片、音视频与 PDF 只读**：只做查看，不进编辑器、不能改（不影响其它文件的编辑）。
- **大文件不预览**：图片超过 8 MiB、音视频或 PDF 超过 24 MiB 只提示上限。
- **PDF 密码与扫描件**：需要密码的 PDF 提示改用默认应用解锁，本版不提供密码输入。扫描件可以查看，但不会进行 OCR，也不会凭空生成可选择的文字；损坏或不支持的 PDF 会明确报错。
- **`.avi` 这类按二进制处理**（Chromium 放不了）；`.mkv` / `.mov` 能不能播放取决于里面的编码，放不了会明确提示。
- **SQLite 只读**：不写入、不 VACUUM、不建 `-shm`。**WAL 模式下尚未合并回主文件的内容看不到**（顶部有提示）；加密库（SQLCipher）与损坏文件都明确报「读不了」，不会静默空白。
- **数据库深翻页有上限**（OFFSET ≤ 10 万行）：`node:sqlite` 是同步 API、没有中断接口，只能让查询天生有界——要看更远就在 SQL 框里加条件收窄。
- **表清单里的行数是估算**（`max(rowid)`）：精确 `COUNT(*)` 在大表上是全表扫描，请按需在 SQL 框里执行。
- **需要宿主运行时带 `node:sqlite`**（Node ≥ 22.5；当前宿主 Electron 43 / Node 24 满足）。探测不到时插件不会崩，只显示概览并说明原因。

## 许可

MIT。PDF.js 与随附字体、解码资源的许可声明见构建产物 `views/assets/pdfjs-LICENSES.txt`。
