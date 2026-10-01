# 实时语音 v1

> **翻译说明：** 本页与[英文源规格](/spec/03-runtime/live-voice)对应。代码、协议字段和标识符保留原文；如翻译与英文事实存在差异，以英文版本为准。

## 范围

实时语音是可选、由应用管理的实时音频通路，与本地听写和 Host Speech 分开，默认关闭。v1 支持三种明确绑定：

| Adapter | 凭证所有者 | 传输方式 |
|---|---|---|
| Codex Live | 通过 `VendorOAuth.resolveAuth` 使用现有 Codex Provider 行 | Renderer WebRTC，由 Main 进程完成 SDP 协商 |
| Gemini Live | Google Generative AI API Key Provider | Main WebSocket 与 Renderer PCM 端口 |
| OpenAI Realtime | 配置了 endpoint 的 API Key Provider | Main WebSocket 与 Renderer PCM 端口；GA 和 compat-v1 使用独立 profile |


独立作用域的 Live Work 通话也可以解决绑定会话唯一一个待回答的 AskTool 提问，但只能从该提问自己提供的选项标签中选择；权限与 Plan/Goal 审批仍然只在桌面 UI 中决定（见[实时语音工作会话接入](live-work-session.md)与 [ADR 0315](../../../adr/0315-live-voice-spoken-asktool-answers.md)）。
公开设置为 `liveVoice: { enabled, selectedBindingId?, bindings }`。它只包含 Provider ID、模型/音色选择和协议 profile，不保存凭证。现有 `voice` 和 `speech` 设置保持原义。持久化 JSON 由 Host Core 所有；它会将 Live 设置与其他设置合并。

没有工作绑定的纯语音 Live profile 不会创建 Agent turn、调用 AgentHost 或 MCP、访问工作区文件、执行模型生成的函数、保存录音或持久化字幕。字幕只保存在本次通话的有界 Renderer 内存缓冲区中。除非用户明确开启独立作用域的 Live Work 通话，否则 Provider delegation/function-call 请求会被拒绝或导致协议错误；Live Work 的执行与权限合同见[实时语音工作会话接入](live-work-session.md)。

## 所有权与安全

Electron Main 管理唯一通话槽位、所选账号、凭证解析、Provider 撤销、麦克风租约、取消、协议适配器、网络传输和终态清理。Renderer 管理用户交互、WebRTC/PCM 媒体和临时字幕显示。IPC 从调用它的受信主 frame 推导所有者，payload 不能自行声明 owner。Live 事件只发送给拥有通话的 frame。

OAuth token 和 API key 留在 Main。SDP、音频和字幕内容不写入日志。Main 的 WebSocket endpoint 在连接前校验，并使用桌面网络代理配置；不支持的代理路由会被拒绝。PCM 端口仅属于一个已准备的通话，帧大小和 credit 都有上限，且不携带凭证。

Live 与 Dictation 共用 Main 进程的麦克风租约。本地 mute 会在 IPC 请求前门控采集；Main 也会独立拒绝静音或过期的采集 epoch。通话结束、Renderer 丢失、窗口隐藏/导航/崩溃、系统挂起/锁定、Provider 变更、功能关闭或应用退出时，都会停止媒体并关闭 adapter。如果无法确认 Renderer 已释放媒体，Main 会隔离麦克风租约，不会盲目复用。

## 通话与媒体

通话状态为 `preparing → acquiring-mic → negotiating/connecting → connected → closing → ended|failed`。request ID 让 prepare 幂等，并可在 call ID 返回前取消。启动、握手、heartbeat、中断确认和释放等待均有时限。每个 Desktop 实例同时只能有一个通话；后续通话需要用户明确发起，不会自动切换 Provider、模型或计费路径。

Codex Live 使用专用 Codex OAuth endpoint 和 WebRTC answer exchange；浏览器 data channel 只处理规范化协议事件和不支持 delegation 的响应。它不使用公共 GPT-Live session 事件。Gemini Live 在发送 16 kHz 单声道 PCM16 前会等待 `setupComplete`。Realtime 会等待 `session.updated`，使用 24 kHz 单声道 PCM16，并明确选择 GA 或 compat-v1 wire profile。用户可分别编辑每项绑定的模型和音色；默认值只是候选项，不代表账号有访问权限或服务可用。

PCM 采集使用 AudioWorklet，依据实际 `AudioContext.sampleRate` 进行有状态抗混叠重采样，并产生有界的 20 ms worklet 帧。PCM 输出由独立播放通路排队，记录每个 item 实际播放位置；中断会推进 playback epoch 并丢弃过期队列。如果浏览器阻止播放，通话面板会提供用户手势来恢复声音。输入音频不会回环到本地扬声器。

静音、插话和结束是不同操作。静音只门控新的输入，Provider 输出仍可播放。Codex 使用其原生全双工媒体行为；Gemini 中断时重置本地输出队列；Realtime 根据实际播放游标取消并截断当前响应。结束通话时，先停止本地 tracks、播放和端口，再释放租约。

## 设置与兼容性

Voice 在开发构建和打包构建中均向普通用户开放，不再要求开发者模式。实验标记用于提示可用性限制，不是访问门槛。实时语音仍默认关闭，开启设置不会开始采集麦克风。需要配置或恢复账号时，Composer 提供“打开设置”操作。云同步和 Remote Hosts 保留各自的开发构建限制。

账号列表明确区分加载中、可重试的加载失败和无兼容账号。加载失败不会清除已保存的绑定。设置页提供现有模型配置入口，用于登录和管理账号。通话错误区分缺少认证、账号访问被拒、协议不支持、网络/限流及麦克风故障，不显示服务响应内容或凭证。通话条会在本地化文案旁同时显示对应的 `LIVE_*` 错误码本身，因此没有专属文案的失败也能从截图或工单中定位；该错误码背后的原始原因不进入任何视图，只写入脱敏后的 `provider` 日志。通话条本身是该应用的一个独立、无边框、始终置顶的桌面窗口，不拥有通话：它的每次按键都转发给持有麦克风、媒体和按通话隔离工作的主窗口，且只显示主窗口推送的权威状态与错误码。

Voice 设置入口现在只展示实时语音：用户可绑定现有兼容 Provider、选择下次通话使用的绑定，以及设置模型、音色和 Realtime profile。通话进行中，当前绑定不可修改。关闭实时语音会结束通话。Provider 凭证继续由现有 Provider/secret 或 VendorOAuth 系统管理。旧的本地 Dictation 设置和 Composer 入口已隐藏；已有 `voice` 设置值及底层 Dictation 能力保持不变，不会因 UI 调整而删除或改写。旧设置中没有 `liveVoice` 时，会按关闭且无绑定处理。

Live DTO 与 IPC 合同位于 `packages/shared`。纯 wire 解析和 PCM 数学逻辑只从 `@pi-desktop/voice-runtime/live` 导出，不进入旧的本地转写运行时。Electron Main 保持编排角色，不接管凭证或存储所有权。

## 验证与限制

自动化覆盖 PCM 编码/重采样、Provider 消息解析、owner 检查、prepare/connect/mute/end、请求取消、活动绑定写保护、字幕上限、只拒绝 delegation 的行为，以及与 Dictation 的互斥。桌面 UI 测试和定向 Electron 进程测试在适用时覆盖用户路径。fixture 通过不能证明真实 Provider 访问权限或账号资格。

Codex endpoint、模型和音色细节依据所引用的 Piwin 快照，不承诺公共 API 稳定性。Gemini 与 OpenAI Realtime 需要兼容模型、账号和 endpoint。真实账号调用、麦克风权限提示和硬件播放须与自动化 fixture 结果分开报告；它们可能产生 Provider 用量，并需要用户明确授权。
