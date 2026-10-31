# 04. 插件安全

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/04-plugin-security) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 威胁模型

插件可能来自：
- 用户自行开发
- 同事分享
- 未来市场中的第三方

主要风险：
1.恶意文件read/write
2、恶意命令执行
3.窃取API密钥/会话内容
4. 劫持代理工具
5. 通过用户界面进行网络钓鱼
6. 消耗用户的模型额度，或把对话发给另一个模型（`agent.complete` / `session.read`）

## 2. 默认拒绝原则

- 未声明的权限=不可用
- 禁用插件 = 代码未加载
- 未经确认的高风险行动=未执行
- 主机 API 不在允许名单上 = 不存在
- `pi.browser.cdp` 不在 CDP 白名单上的方法 = `PERMISSION_DENIED`（无
  cookies、storage、Target 或 Fetch；无 DevTools websocket）

## 3. 隔离策略

### 必须
1.插件UI与宿主UI DOM隔离
2. 插件不能直接请求主机模块
3.秘密商店不对插件开放。宿主代发的补全（`agent.complete`）在 Electron main
   解析凭据，从不把密钥、刷新令牌或 `ModelAuth` 交给插件进程
4.插件私有数据目录与主机核心库分离
5. `session.getLlmContext` 的会话转录只是进行中工具会话的有界投影（D336 / D019）

剪贴板历史由 Electron 主进程持有，仅保存在内存中，不会写入插件数据目录或主机
数据库。主机只记录明确的剪贴板写入和用户主动在 Composer 中粘贴的内容，不会在后台
轮询系统剪贴板。插件必须通过现有的 `clipboard.read` 权限读取；每次 `getHistory` 调用都会
记录审计及返回条目数。应用退出时历史会清空，保留上限也限制了隐私暴露范围。

### 宿主渲染的场景化设置目标

`contributes.scenicThemes` 只是数据。宿主在 Extensions 中渲染卡片之前，会校验两项授权、同插件主题归属、已声明的预览资源，以及精确且有界的 `--nexus-backdrop-blur` 变量。插件不能提供设置 HTML、CSS、JavaScript、选择器、DOM、任意操作或直接渲染器 IPC。透明画布、布局、焦点、原生控件、标题栏、Apply 操作以及回退到 General 的生命周期都由宿主拥有。

### 3.2 会话协作边界

当用户授予 `desktop.control` 时，Session Orchestrator 可以创建有界的工作会话、寻址现有 Agent 会话、检查有界的状态/结果投影，并取消工作。该能力刻意不授予插件直接访问 `session.create`、`agent.prompt`、宿主 RPC、SQLite、转录文件或 MCP token 的权限。发送或派生调用必须运行在插件当前正在执行的 Agent 工具调用内部；来自服务、面板或没有该上下文的普通插件代码的调用会失败关闭。插件面板可以请求取消该插件自己的投递，作为显式的用户控制，但取消不能创建或重新定位投递。

Host-core 会快照源权限上限并拒绝高于它的目标，在开始回合前重新检查目标模式，并强制执行收件箱、worker 和自主跳数限制。现有目标会话保留自己的项目/模型/上下文配置。完成回调是由宿主编写的、至多一次的会话消息，不能授权工具或触发另一个回调。重启恢复会保留持久的排队投递，但绝不会无人值守地启动被中断的回合。会话消息的来源在转录替换和重新生成之间不可变。

### 目标
1.插件main在单独的进程中运行
2. 碰撞隔离
3.资源限制（后来：CPU/memory/timeout）

## 3.1 贡献主题 CSS

主题贡献（`ui.theme`）通过主进程清理器把 CSS 发送到宿主渲染器。
另一个高风险权限 `renderer.extension` 会直接运行受信任的渲染器 JavaScript，不是沙盒：

- 只检查浏览器实际生效的 CSS：先按等长空白遮蔽注释体与字符串字面量
  （每个被遮蔽字符对应一个空格，偏移仍指向原文），`url(...)` 参数按原样保留
  并按目标判定。因此仅在注释或字符串里*提到*被禁关键字的样式表会被接受
- 拒绝：`@import`、既非 `data:` URI 也非已声明主题资源的 `url()` 目标、
  解析器无法解析的 `url(`、`javascript:`、`expression(` 和标记序列
  （`<style`、`</style`、`<!--`）；空样式表也会被拒绝
- 每个文件上限为 256 KiB，不限制每插件主题数量
- 主题可声明 `assets`，使用白名单图片/字体扩展名：插件包内相对路径（在插件根目录内解析，拒绝
  路径穿越和 `node_modules`）或绝对路径；所有资源总量上限为 4MB。命中的 `url()`
  会被改写为 `plugin-asset://<pluginId>/<path>`，由宿主处理器提供；该处理器
  只按已加载插件自己登记的清单解析，只读、带 `nosniff`，并在插件卸载时一并撤销。
  `pi.themes.upsert` 也可在运行时登记同类路径。未登记的引用仍会被拒绝，
  原始路径不会到达渲染器
- `contributes.windowAppearance`（`#rrggbb` / `#rrggbbaa`）需要
  `ui.window.appearance`，且只在该插件的某个主题被选中时生效；离开该主题即恢复
  宿主背景，因为颜色由实时主题目录推导。macOS 保持原生圆角，默认透明振动效果忽略颜色；
  关闭 Translucent window 后会把颜色应用到不透明窗口
- CSS 在加载时从磁盘读取并通过 IPC 整体交付；的
  渲染器将其注入到附加在后面的单个专用 `<style>` 元素中
  应用程序自己的样式表，因此它可以覆盖令牌但从不注入标记。
  后写的声明只有在选择器特异度相同时才胜出；应使用
  `:root[data-theme="light"]` 或 `:root[data-theme="dark"]` 匹配基础调色板的
  选择器，单独的 `:root` 特异度更低
- 选择主题是一个设置值（`plugin:<pluginId>:<themeId>`）；如果
  如果插件被禁用或卸载，设置将回退到 `system`

CSS 无法脚本化，但它可能会产生误导：主题仍然是第三方代码塑造
用户看到的内容，这就是为什么它是声明的、可撤销的权限。

## 4. 权限授予用户体验

在 install/load 时间，显示：

- 权限列表
- 风险描述
- 开发者信息
- 源路径

用户操作：
- 接受并启用
- 取消

首次使用高风险的 API 可能会再次确认。

## 5. 数据隔离

插件可以访问：
- 他们自己的设置
- 他们自己的数据路径

插件无法访问：
- 其他插件的数据
- 主机秘密
- 主机的完整会话数据库（除非将来存在受控的 API）

## 5.1 插件间消息总线

总线是两个插件之间的唯一通道，并且故意狭窄：

- 双方在清单中声明其流量 - `bus.publish` 列出了具体的流量
  主题，`bus.subscribe` 列出了模式 - 经纪人拒绝任何内容
  即使获得许可也未声明
- 路由完全存在于主机中；订户永远不会知道还有谁
  订阅，发布者被排除在自己的扇出之外
- 消息仅携带`topic`、`from`、`payload`和主机分配的`at`
- 上限：每个有效负载 64KB，每个插件 16 个订阅，每个滚动 100 个发布
  10秒窗口；超上限调用失败并显示 `LIMIT_EXCEEDED` / `RATE_LIMITED`
  与主题一起审核
- 有效负载是数据，而不是能力：接收消息并不授予任何功能
订户还没有

将主题视为应用程序内的公共主题：任何可以声明匹配的插件
模式并按住 `bus.subscribe` 就会看到它。不要在公交车上泄露秘密。

### Provider OAuth 凭据边界

`provider.oauth` 是独立于 `provider.register` 和 `net.fetch` 的高风险授权。它允许 `onProviderOAuth` 为同一插件声明的 provider 处理登录和刷新。宿主会在其密钥存储中加密每个凭据，绝不会把刷新令牌发送给渲染器或 Agent Runtime。插件回调可以读取该凭据，因为它实现了该 provider 的 OAuth 协议；但它不能读取其他 provider 的密钥，也不能调用通用密钥 API。通过宿主网络 API 发出的请求仍然需要 `net.fetch` 和 `manifest.net.domains`。插件入口代码不是操作系统沙盒，可以使用原始 Node API，因此获得此授权的插件必须是用户信任的代码。当登录被取消、插件卸载或宿主调用超时时，回调会收到中止信号。退出登录会清除凭据，并保留清单拥有的 provider 行。

Add Service 的 provider 目录同样由宿主渲染。它只读取已加载且拥有 `provider.register` 的插件的清单元数据，只包含已配置端点但尚未配置的 API-key provider，并把类别和 provider 名称渲染为文本。可选描述是悬停或键盘聚焦时显示的纯 tooltip 文本。选择器不会执行插件代码，也不会返回凭据。保存密钥会通过宿主现有的 provider 密钥路径存储；宿主在该显式保存后发现端点模型，当用户通过该 provider 发送请求时，provider 服务会收到密钥。

## 6. 路径安全

`fs.read` / `fs.write` / `fs.delete` 说明插件能不能碰文件；`manifest.fs`
说明能碰哪些（参见
[02-plugin-manifest-schema.md](/zh-CN/spec/07-plugins/02-plugin-manifest-schema) §5.2
与 ADR 0088）。每次 `pi.fs.*` 调用按固定顺序过四道门，
后面的门只能拒绝：

1. **权限** —— 既声明又授予。运行时取两者的交集，所以用户撤销的权限
   会真的失效，即使清单里还在要
2. **containment** —— 对 root 和目标都做 `realpath`，因此工作区里一个指向
   `~/.ssh` 的软链会在这里失败，而不是通过字符串比较。正在创建的路径
   按最近的已存在祖先解析，所以新建文件不会和逃逸无法区分。绝对路径
   和 `..` 一律拒绝；仅仅是不存在的路径报 `NOT_FOUND`，不算逃逸
3. **deny-list**，它压过一切 root、scope 和授权：
   - 凭证：`.env*`、`.npmrc`、`.netrc`、`.pypirc`、`.git-credentials`、
     `id_rsa*` 及同类、`*.pem`、`*.p12`、`*.pfx`、`*.keystore`
   - 任意深度的目录：`.git`、`.ssh`、`.aws`、`.gnupg`、`.kube`、`.docker`
   - 主机自己的数据目录，里面存着 provider key 和会话库
   - root 本身（对删除而言）
4. **声明的 scope**，否则走原生确认（§6.2）

`pi.fs.glob` 遵守同一套规则 —— 名字也是一种读取，所以被拒的路径和保留目录树
不会出现在结果里，匹配结果会按读取范围过滤，而 `node_modules` / `.git` /
`.venv` / `__pycache__` 永不遍历。

### 6.1 删除

删除是唯一一种用户无法靠重跑插件补回来的文件操作，因此有四重约束：

- **两档。** 带 `own: true` 时主机在插件数据目录里维护一份写入台账
  （路径 + mtime），允许插件删除自己写过的东西，不需要 scope、不需要弹窗。
  如果文件的 mtime 已经晚于记录值，说明用户之后改过，它就不再属于插件。
  删别的东西需要声明 `scope`。
- **系统回收站。** 删除走 `shell.trashItem`，绝不走 `rm`，因此某道门判断错了
  代价是用户去还原一下，而不是文件没了。主机不为此复制用户的任何数据。
- **永不递归。** 非空目录直接拒绝，而不是清空。
- **速率刹车。** 每个插件每滚动 60 秒 50 次删除 —— 因为 `recursive: false`
  只能约束单次调用，约束不了 `glob` 加一个循环。超过之后问用户一次，
  理由写的是速率而不是路径。

### 6.2 运行时同意

清单没有覆盖的访问会走到原生 `dialog.showMessageBox`：
**拒绝** / **允许一次** / **本会话允许**。会话授权覆盖所在目录，
存在内存里，随进程消失；什么都不持久化，而速率刹车的弹窗根本不提供
会话选项。没有同意服务的主机一律拒绝 —— 问不了就绝不能假设「是」。
拒绝和授权都会记入审计。

### 6.3 用户选定的 root

`pi.fs.requestDirectory()` 打开原生目录选择器；在返回的目录里插件不需要
清单 scope，因为用户刚亲手指了它。containment 和 deny-list 在那里依然生效。
句柄只存在于内存中，随进程消失，所以插件拥有无限的可达范围和零常驻权力 ——
和浏览器 File System Access API 的模型一样。

### 6.4 拖放文件授权

沙盒化的插件面板可以通过宿主 preload 的 `getDroppedFilePath` 将用户拖放的 `File` 解析为本地路径。preload 会在页面代码运行前把该路径报告给面板宿主。`fs.registerDropped(path)` 会消费其中一个短生命周期、绑定发送者的报告，并返回仅存在于内存中的 `grantId`。该授权只覆盖那一个规范化的常规文件，用于 `fs.stat` 和 `fs.readRange`；它不会改变 `manifest.fs`，不会授予目录，也不允许写入、打开、显示或删除。授权随插件进程结束而失效，且永不持久化。受保护路径、凭据、符号链接替换和拒绝列表在注册时以及之后每次读取时仍然生效。

## 7. Agent 安全性

- 插件工具名称采用命名空间，以避免使用冻结强制前缀 `plugin_<pluginIdSafe>_<toolName>` (D015) 发生冲突
- 工具执行超时
- 用户可以一键禁用工具
- 提示注入 API 默认情况下是高风险的，需要显式许可

## 7.1 到达代理的技能和 MCP 工具

两个表面都可以让插件改变代理知道或可以做的事情，所以两者都是
在到达模型之前有界：

**技能** (`agent.prompt.inject`) — 系统提示符仅携带目录
（id、名称、一行描述，上限为 240 个字符）；按需读取正文
通过内置的 `Skill` 工具。一个插件最多可以教授 32 个技能，每个技能
文档最多 128KB。未经许可，技能将被简单地跳过：
清单仍然有效，没有任何提示。

**MCP 工具** (`mcp.server.local` / `mcp.server.remote`) — 已发现的工具是
与手写插件工具注册在相同的 `plugin_*` 命名空间下
因此继承工具超时、审计跟踪和每个插件禁用
转变。它们始终在 `risk: "medium"` 处注册：它们的架构和
描述来自第三方服务器，因此主机无法信任
自我声明的风险水平。服务器的目录被完整注册——数量只受 §8.1 中的
协议护栏约束——而每个插件最多接入 8 个服务器。

插件工具默认在 Plan/Goal 中隐藏并拒绝。运行时工具注册可通过非空 `planSafeActions`
显式加入，只有 `args.action` 位于该列表时才允许执行。有 schema action enum 时会校验取值。
清单描述符应与运行时注册保持一致，真正执行的工具由运行时注册决定。
`risk: "low"`、会话授权和 `auto` 不能代替该声明。宿主策略与插件执行器都会校验，
执行器对越界 action 返回 `PERMISSION_DENIED`。该列表是作者的只读承诺，不是副作用沙盒（ADR 0211）。

## 8. 网络和外部链接

- 默认情况下不授予 `net.fetch`
- `openExternal` 应确认。主机解析 URL，只打开 `http:`、`https:` 和 `mailto:`
  （D330 / ADR 0168）；其他 scheme 以 `INVALID_ARGUMENT` 失败，不会到达
  `shell.openExternal`。`fs.openDefault` 和 `fs.reveal` 是独立能力：二者都只接受已经通过插件
  `fs.read` 策略检查的现有 root-relative 文件，用于明确的文件查看操作，不允许任意 URL 或绝对
  路径打开；`fs.reveal` 只请求操作系统文件管理器选中该文件。
- 禁止插件静默下载和执行二进制文件（MVP 中根本没有这样做）

### 8.0 出网白名单

一个权限没法表达「读得宽但什么都漏不出去」，所以范围放在清单里：
`net.domains` 是每个插件唯一的一份主机名白名单，主机掌握的每一条出网路径
都听它的。

- **面板 session。** `sandbox: true` 去掉的是 Node，不是网络，所以面板以前
  是一个完整的浏览器，而且从不经过 `net.fetch`。现在该 session 跑一个
  `webRequest` 过滤器，拒绝所有设备权限（唯一例外是获得 `ui.microphone` 的插件
  发起的纯音频麦克风请求，见 §8.2），并禁止 `window.open` —— 否则它会造出一个
  不受过滤的窗口。该 session 是每个插件一个的持久化分区
  （`persist:pi-plugin-<pluginId>`），由插件的面板窗口和停靠视图共用，两者应用同一个
  过滤器。`file:`、`data:`、`blob:`、`devtools:`、`chrome-extension:` 和只读的
  主题资源 scheme 不属于网络请求，会直接放行
- **`pi.net.fetch`。** 检查白名单并手工跟随重定向，因为一个被允许的主机
  30x 跳到未声明的主机上，就会把请求带出去。宿主共享的逐跳循环同时负责默认
  传输和注入的单跳传输。`redirect: "error"` 遇到 3xx 直接拒绝、不访问目标；
  `manual` 返回原始响应。默认仍是 `follow`，每一跳都重新检查。能力探测和错误码
  见 [API 契约](/zh-CN/spec/07-plugins/03-plugin-api#网)
- **远程 MCP 端点。** 同样听这份列表，而不是只看它自己的权限。HTTP 端点可以
  位于可信局域网，但明文 HTTP 不加密，配置或插件权限审查时会明确提示。
  MCP 客户端手动跟随重定向，最多允许五次 HTTP(S) 跳转，并在每一跳之前重新
  检查白名单。
- **`pi.net.websocket`。** 目标主机不在 `manifest.net.domains` 里的 `ws://` 或
  `wss://` 会在出网卡点处被拒绝，传输根本不会被要求去打开任何东西；而且持有
  套接字的是宿主、不是插件，所以插件卸载、被禁用或崩溃时，宿主会关闭它仍
  持有的每个套接字。套接字按插件设上限（4 个），入站和出站帧都封顶 1 MiB，
  超大帧会关闭连接而不是被缓冲，超过 4 MiB 的发送队列会被拒绝而不是继续
  增长。帧只会送达持有它的那个插件。

列表缺失、为空或非法就完全不放行出网，而裸 `*` 无法通过 `validateManifest()`，
免得有人靠声明绕出去：`pi-plugin check` 会报错，宿主也会拒绝加载该插件。
host-core 安装器不读取 `net.domains`，所以这样的包能装上，但随后加载失败。正是这一点让一个宽松的 `fs.read` 范围变得可以接受（§6）。

仍然敞着、单独跟踪的：`agent.prompt.inject`（技能文本可以让一个有 shell
能力的 Agent 替它搬运）、`shell.openExternal`、`bus.publish` 转给一个有网络
能力的插件，以及插件进程里的原生 `fetch` —— 最后一项需要 ADR 0008 D009
的沙箱化插件运行时。`pi.net.fetch` 并不会缩小这些缺口：宿主只负责套用白名单、
手工跟随重定向并审计这次调用，它从不重试、不限流、也不重新发起请求 —— 上游的
`429` 会带着服务器给出的 `Retry-After` 原样到达插件，插件怎么处理是插件自己
的策略。

## 8.1 MCP 服务器出口和凭证

MCP 服务器是 `net.fetch` 旁边的第二个出口路径，因此它是声明性的
并且是可审查的而不是编程的——插件无法打开连接
清单未命名：

- `transport: "stdio"` 生成本地可执行文件 (`mcp.server.local`)。
  `command` 必须是裸 PATH 名称或插件相对路径；绝对路径在验证时被拒绝。
  子进程拿到最小环境——声明的 `env` 条目、共享白名单（`child-process-env.ts`），
  以及 `npx`/`uvx` 需要的工具链键（`PATHEXT`、`ComSpec`、`FNM_DIR` 等）。
  Unix 上 PATH 是 login-shell PATH（D600）。裸 `npx`/`uvx` 会解析到真实二进制：
  官方 Windows Node 走 `node.exe` + `npx-cli.js`，其余 `.cmd` 经 `cmd.exe`
  以引号字面参数启动（D624）。provider key 和其它宿主状态仍然不会穿越。
- `transport: "http"` 到达远程端点 (`mcp.server.remote`)。`url` 可以使用
  `http` 或 `https`；非回环 HTTP 不加密，只应在可信网络中使用。插件端点还
  必须被 `manifest.net.domains` 覆盖。工具参数会离开机器，这就是为什么权限
  文案必须明确说明。
- `env` 和 `headers` 值**仅**通过插件自己的设置进行解析
  `{ "setting": "<key>" }`。宿主环境永远不会被穿越，并且
  清单中的字面秘密是审查气味，而不是受支持的模式
  （D018）。
- 连接预算：完成 `initialize` 需要 10 秒，每个 `tools/call` 需要 100 秒，每条
  stdio 线 4MB。远程 HTTP 请求采用其对应操作的预算；完成握手后，后续工具调用不会继续受 10 秒握手预算限制。`tools/list` 在 §8.1 的每服务器护栏下跟进到最后一页
  ——2048 个工具、100 页、重复或畸形游标、整轮遍历 30 秒——突破任一护栏的服务器会被
  拒绝，而不是贡献其目录的一个前缀，因为 MCP 工具是以延迟加载的按需条目
  （`ToolSearch` 之后）而非常驻列表的形式到达模型的。服务器按需连接，
  并在插件卸载或禁用时关闭。
  停止调用方会话会取消该会话正在执行的 MCP 请求，并向服务器发送 `notifications/cancelled`；共享连接及其他会话的调用保持有效。请求超时后同样会发送取消通知；`initialize` 请求从不取消。

## 8.2 桌面控制与设备访问

`desktop.control` 把本地 MCP 控制平面暴露的那份已审查操作目录（ADR 0203 /
D370）交给插件：项目、会话、Agent 和工作区操作，每一项都标记为 `read`、
`write` 或 `dangerous`。plugin-only 例外涵盖六个 `session/collaboration/*`
操作：它们可以经由插件网关调用，却被刻意排除在 MCP 可见目录之外，因为它们
需要已认证的插件调用上下文，且渲染器没有任何变更通道。插件看到的是 id、描述和
风险等级，绝不会看到 Electron 通道名或 MCP bearer token；每一次调用都经过与
MCP 调用相同的 IPC 校验、生命周期检查、完成事件和审计条目。

`dangerous` 操作由用户拍板，而不是由调用者。控制器的 `confirm: true` 只是
插件的知会（MCP 也是同样处理，D372）。在此之后，宿主弹出一个原生对话框，
点名目录中的操作 id、目录描述和一段有界的参数预览，并刻意不显示任何由插件
或其背后模型撰写的文本，因此一份被提示注入的转录本无法把 `session/delete`
重新包装成无害的东西。Escape 和关闭对话框都视为拒绝。没有对话框服务的
无头宿主会直接拒绝所有 dangerous 操作。

`ui.microphone` 只在插件的隔离面板 session 内允许 `media` 权限，且仅限音频。
摄像头和其他所有设备权限仍被拒绝，插件也拿不到任何原生句柄：采集始终由
页面持有。

`audio.capture.background` 和 `audio.playback.background` 把关一个可以调用的
表面：十个 `pi.audio.*` 方法都存在于插件宿主进程中，并保留各自的权限要求，
但这条分支没有设备后端，所以获得授权的调用会以带错误码的 `UNSUPPORTED`
拒绝并记入审计（`audio.<method>`、`ok: false`），不会打开任何设备（两个同步
注册辅助函数 `onInputFrame` / `offInputFrame` 改为抛出同一个错误码，而不是
注册一个永远不会触发的处理器）。等宿主服务落地后，设备由宿主持有：插件只
交换 PCM16 帧，永远拿不到 `MediaStream`、设备句柄、操作系统设备路径或 Node
流，每个插件只允许一条输入流；禁用、卸载、崩溃或撤销权限会停止采集并丢弃
已排队的播放，而不会留下孤立的设备或计时器。

`keyboard.globalShortcut` 已实现，并且始终留在宿主的注册模型之内。宿主持有
Electron 的 `globalShortcut`；插件永远拿不到键盘钩子、`before-input-event`、
原始输入设备或按键事件流，所以不存在键盘记录器形状的表面，也无法看到用户
按下的键。插件只能把加速键映射到自己已注册的一条命令；被操作系统保留、被
PI-Desktop 自己当前占用（默认是 `Alt+Space` 与 `Alt+Shift+W`；用户改绑后
即可释放给插件）或已被另一个插件持有的
加速键会被拒绝，返回 `SHORTCUT_CONFLICT` / `SHORTCUT_UNAVAILABLE` /
`INVALID_ACCELERATOR` / `LIMIT_EXCEEDED`（每个插件最多 8 条），而不是被抢走。
一次触发只运行那一条命令。注册、注销和触发的审计会记录插件 id 与结果 ——
注册和触发还会记录加速键与命令 —— 绝不记录用户输入。每条条目都在禁用、
卸载和崩溃时释放。

四种能力一律失败即关闭：未声明或未授予权限时，调用在触达任何设备、加速键
或套接字之前就会被拒绝并记入审计。

## 9. 审计和应急响应

用户应该能够：
- 查看插件权限
- 查看插件错误日志
- 一键禁用
- 一键卸载

主机应该能够：
- 出现异常时自动禁用插件
- 保证主应用程序可以启动

## 10. 安全验收

1. 没有 `fs.write` 权限写入文件失败，`manifest.fs.write.scope` 之外的写入
   会问用户
2. 没有 `fs.delete` 权限删除文件失败；删除永不递归、落进系统回收站，
   并在滚动一分钟内超过 50 次后被打断
3.禁用插件后，其工具不再可见
4. 插件无法读取 API 键
5.插件面板无法调用任意主机IPC
6.插件未捕获的异常不会导致应用程序退出
7. 带有 `@import` 或远程 `url()` 的主题 CSS 文件被拒绝，并禁用
   提供的插件将应用程序返回到 `system` 主题
8. 发布到未声明的主题失败，发布者永远不会收到它的消息
   自己的留言
9. 声明绝对路径 `command` 的 MCP 服务器会在 manifest 校验时失败；非回环的
   明文 HTTP URL 只有在主机声明于 `manifest.net.domains` 且 UI 显示未加密连接
   警告时才可接受
10. 未声明 Plan 安全操作或 action 越界的插件工具，无论风险或授权如何，都在 Plan/Goal 中拒绝


## 11. 实施情况

目前执行情况：

1. `PluginRuntime` 中的默认拒绝权限检查，取「已声明 ∩ 已授予」的交集，
   所以被撤销的权限会真的失效
2. 插件 fs API 有对软链安全的 containment 加一份无条件 deny-list，每种文件
   模式的可达范围由 `manifest.fs` 限定，范围之外落到原生确认（§6）
3.面板窗口使用沙盒preload+隔离会话分区
4. 插件仍然无法访问 Secrets/host DB
5. Marketplace/package 安装需要在 UI 中明确接受权限
6.自动更新拒绝静默权限扩展
7. 插件主程序在每个插件专用的 `utilityProcess` (ADR 0008) 中运行，环境来自
   共享白名单 `child-process-env.ts`（PATH、工具链目录、`HOME` / `USER` /
   `USERPROFILE`，不含 provider key）；所有 `pi.*` 调用都跨越白名单 + 权限网关
   在主机中，插件崩溃只会破坏该插件
8. 贡献的主题 CSS 在到达主进程之前会在主进程中进行清理
   渲染器（§3.1）
9. 总线路由由主机拥有，并具有声明的主题和硬上限（§5.1）
10. MCP 服务器仅从以下位置声明、权限控制和提供凭证：
插件设置（§8.1）
11. 出网被限制在 `manifest.net.domains` 之内，覆盖主机掌握的每一个卡点（§8.0）
12. 插件的删除进系统回收站、不递归，并有速率刹车（§6.1）
13. `manifest.main` 和 `ui.panel` 在安装时被校验为相对路径，并在宿主加载
    它们之前，以与技能和主题 CSS 相同的插件目录内 containment 进行解析
14. 来自插件的 `dangerous` 桌面操作，在插件自己的 `confirm: true` 之后，
    还需要用户在宿主拥有的原生对话框中作答；对话框只显示目录文本（§8.2）
15. `ui.microphone` 只授予音频采集，且仅限隔离面板 session 内（§8.2）
16. `keyboard.globalShortcut` 由宿主持有：注册表拒绝被操作系统保留、宿主
    自己占用或属于其他插件的加速键，快捷键只能运行持有插件自己的命令，
    每条条目都与插件的命令和工具走同一条清理路径（§8.2）

`audio.capture.background` 和 `audio.playback.background` 已声明并且存在于
插件 API 中：这些方法由这两个权限把关，获得授权的调用会以带错误码的
`UNSUPPORTED` 拒绝并记入审计，因为当前宿主还没有设备后端，所以没有任何东西
能到达设备。
`net.websocket` 已实现：连接由宿主持有、经过白名单检查、有界，并随插件一起
释放（§8.0）。

尚未强制执行：

- 插件进程内的能力沙箱（Node 内置模块在那里仍然可达，所以 `fs.*` 权限
  把的是插件 API，不是进程）。这是真正还剩下的缺口：§6 和 §8.0 里的一切
  约束的是一个按规矩用 API 的插件，不是一个绕过 API 的插件（ADR 0008 D009）
- CPU/内存限制
- 签名验证（仅对包进行 sha256 检查）
- 声明的清单权限整体授予。安装审核没有逐项开关，授权缺少任何一项声明权限时
  安装器会拒绝（`PLUGIN_PERMISSION_DENIED: missing grant for <permission>`）；
  没有已记录授权的加载直接使用声明的权限集合
- `userSelected` root 不跨重启保留，插件每个会话都得重新问一次

### Fetch redirect policy

The host owns the same redirect loop for default and injected single-hop
transports. `error` refuses every 3xx with REDIRECT_DISALLOWED; `manual` returns
it without contacting its target. Default follow retains per-hop egress checks.
See [the source API contract](/spec/07-plugins/03-plugin-api#net) for capability
detection, deadline semantics and compatibility. No mode expands network grants.
