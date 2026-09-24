# 本地语音输入

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/23-voice-input) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

## 范围

本地语音输入是 Composer 的可选离线转写路径，默认关闭。它与
[`20-speech.md`](/zh-CN/spec/03-runtime/20-speech) 中的宿主
`speech/*` 能力分开：宿主语音仍是 IPC/插件能力，本功能负责桌面应用的
麦克风采集、本地模型管理和草稿插入。

下载所选模型后，本功能不需要 provider 账户、API key 或网络转写服务。

## 归属与拓扑

```text
Composer / 设置
        ↓ preload bridge
渲染器 voice IPC 封装
        ↓ 已校验的 Electron IPC
Electron 主进程 VoiceService
        ├─ PvRecorderBackend（麦克风）
        ├─ VoiceController（生命周期与取消）
        └─ ModelManager → transcribe-cpp（本地推理）
```

原始音频和转写引擎留在主进程。渲染器只能通过 preload bridge 收到有限的
状态、进度和最终文本。

## 持久化设置

`AppSettings.voice` 包含：

| 字段 | 含义 |
|---|---|
| `enabled` | 是否显示 Composer 麦克风控件，默认 `false` |
| `deviceId` | 输入设备，`null` 表示系统默认设备 |
| `languages` | 转写使用的有序语言代码，默认 `zh`、`en` |
| `chineseVariant` | `simplified`、`traditional-taiwan` 或 `traditional-hong-kong` |
| `modelId` | 不可变本地模型目录中的 ID |

主进程 IPC 边界只接受已知字段，校验类型和长度，并拒绝格式错误的模型 ID
与设置。

## IPC 合约

preload bridge 提供以下调用：

| 操作 | 用途 |
|---|---|
| `voiceStart` | 准备模型并开始采集 |
| `voiceStop` | 停止采集并转写 PCM |
| `voiceCancel` | 取消准备、采集或转写 |
| `voiceGetState` | 读取当前生命周期状态 |
| `voiceGetDevices` | 列出输入设备 |
| `voiceGetModels` | 列出模型目录及本地状态 |
| `voiceDownloadModel` / `voiceDeleteModel` | 管理一个模型工件 |
| `voiceUpdateSettings` | 更新已校验的语音设置 |
| `voiceCheckPermission` / `voiceRequestPermission` | 检查或请求麦克风权限 |

事件为 `voiceStateChanged` 与 `voiceModelProgress`。渲染器会在交给 UI 前再次
运行时校验事件载荷。

## 录音生命周期

控制器状态包括 `idle`、`preparing`、`ready`、`starting`、`listening`、
`transcribing`、`done`、`error` 和 `cancelling`。

监听时报告时长和有限范围的音量。停止后返回文本、录音时长、转写时长和语言。
取消会递增操作代数、终止当前工作、清理采集/流状态，并阻止较晚到达的准备或
转写结果修改 UI。

同一时间只能有一个录音操作。模型按需加载，内存中只保留一个模型；销毁服务时
释放采集、转写和模型资源。

## 模型目录与存储

模型目录是不可变的应用数据。每个模型固定 Hugging Face 仓库、40 位提交 revision、
文件名、预期字节数和 64 位 SHA-256。当前包含 Whisper Large V3 Turbo、Whisper
Small、Whisper Medium 和 SenseVoice Small GGUF 工件。

模型缓存位于应用数据目录的 `voice-models/<modelId>/<filename>`。下载先写入
`.partial` 文件，支持背压和取消，并在 SHA-256 校验通过后原子重命名。失败或取消
会删除临时文件，不会把临时文件视为已安装模型。

## 用户体验

设置中的“语音输入”页提供启用开关、麦克风权限、设备、语言、中文变体，以及模型
下载/删除控制。只有启用后 Composer 才显示麦克风按钮。录音浮层展示准备、监听
时长/音量、转写、取消和错误状态。成功结果插入当前草稿，取消不插入任何内容。

## 安全与兼容性

- 麦克风权限由桌面主进程显式申请和持有。
- 原始音频、模型文件和 provider 凭据不会发送到渲染器或远程转写服务。
- 来自渲染器的不可信输入在主进程边界进行校验。
- 原有 `AppSettings.speech` 和宿主 `speech/*` IPC 行为保持不变；本地语音输入
  使用独立的 `AppSettings.voice` 命名空间。
